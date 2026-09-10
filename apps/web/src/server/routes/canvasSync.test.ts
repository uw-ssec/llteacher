/* --------------------------------------------------------------------------
   #74: the course-link and sync routes.

   CanvasRosterSyncService.test.ts owns the sync algorithm itself against a
   real Postgres. This file owns the request contract around it: course
   scoping, the "no credential yet" / "not linked yet" guidance messages,
   and that a sync failure is reported (502 + a stored error) rather than
   thrown as an unhandled 503.
   -------------------------------------------------------------------------- */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  getCanvasSyncStatusHandler,
  linkCanvasCourseHandler,
  listCanvasCoursesHandler,
  syncCanvasCourseHandler,
} from "./canvasSync";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const getDecryptedMock = vi.fn();
const getOrgScopeForCourseMock = vi.fn();
const getLmsIntegrationMock = vi.fn();
const linkCanvasCourseMock = vi.fn();
const markCourseSyncedMock = vi.fn();
const updateSyncStatusMock = vi.fn();
const auditBestEffortMock = vi.fn();
const listCanvasCoursesMock = vi.fn();
const syncCanvasRosterMock = vi.fn();

vi.mock("../repositories/organizationCredentials", () => ({
  getDecryptedCanvasCredential: (...a: unknown[]) => getDecryptedMock(...a),
}));
vi.mock("../repositories/organizations", () => ({
  getOrgScopeForCourse: (...a: unknown[]) => getOrgScopeForCourseMock(...a),
}));
vi.mock("../repositories/lmsIntegrations", () => ({
  getLmsIntegrationForCourse: (...a: unknown[]) => getLmsIntegrationMock(...a),
  linkCanvasCourse: (...a: unknown[]) => linkCanvasCourseMock(...a),
  markCourseSynced: (...a: unknown[]) => markCourseSyncedMock(...a),
  updateSyncStatus: (...a: unknown[]) => updateSyncStatusMock(...a),
}));
vi.mock("../utils/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/audit")>()),
  auditBestEffort: (...a: unknown[]) => auditBestEffortMock(...a),
}));
vi.mock("../../lib/canvas-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/canvas-api")>()),
  listCanvasCourses: (...a: unknown[]) => listCanvasCoursesMock(...a),
}));
vi.mock("../../lib/services/CanvasRosterSyncService", () => ({
  syncCanvasRoster: (...a: unknown[]) => syncCanvasRosterMock(...a),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

const TEST_ENV = {
  DATABASE_URL: "ignored",
  ENCRYPTION_KEY: Buffer.from(new Uint8Array(32)).toString("base64"),
  BLIND_INDEX_KEY: Buffer.from(new Uint8Array(32)).toString("base64"),
} as Env;

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  const base = "/api/courses/:courseId/canvas";
  app.get(`${base}/courses`, (c) => listCanvasCoursesHandler(c));
  app.get(`${base}/status`, (c) => getCanvasSyncStatusHandler(c));
  app.put(`${base}/link`, (c) => linkCanvasCourseHandler(c));
  app.post(`${base}/sync`, (c) => syncCanvasCourseHandler(c));
  return app;
}

const instructorOfA = () =>
  fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })] });
const taOfA = () => fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "ta" })] });

const url = (suffix: string) => `/api/courses/course-a/canvas${suffix}`;
const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const CREDENTIAL = { id: "cred-1", token: "tok", canvasBaseUrl: "https://uw.instructure.com" };
const INTEGRATION = {
  id: "lms-1",
  canvasCourseId: "canvas-course-1",
  apiCredentialId: "cred-1",
  lastSyncStatus: "success" as const,
  lastSyncCounts: { added: 1, updated: 0, removed: 0 },
  lastSyncErrorMessage: null,
  lastSyncedAt: "2026-09-10T00:00:00.000Z",
};

beforeEach(() => {
  getDecryptedMock.mockReset().mockResolvedValue(CREDENTIAL);
  getOrgScopeForCourseMock.mockReset().mockResolvedValue("org-1");
  getLmsIntegrationMock.mockReset().mockResolvedValue(INTEGRATION);
  linkCanvasCourseMock.mockReset().mockResolvedValue({ outcome: "linked", lmsIntegrationId: "lms-1" });
  markCourseSyncedMock.mockReset().mockResolvedValue(undefined);
  updateSyncStatusMock.mockReset().mockResolvedValue(undefined);
  auditBestEffortMock.mockReset().mockResolvedValue(undefined);
  listCanvasCoursesMock.mockReset().mockResolvedValue([
    { canvasCourseId: "canvas-course-1", name: "STATS 311", courseCode: "STATS 311 A", term: "Fall" },
  ]);
  syncCanvasRosterMock.mockReset().mockResolvedValue({ added: 1, updated: 0, removed: 0, errors: [] });
});

describe("Canvas sync authorization (#74)", () => {
  const cases: [string, RequestInit | undefined, string][] = [
    ["GET courses", undefined, url("/courses")],
    ["GET status", undefined, url("/status")],
    ["PUT link", json("PUT", { canvasCourseId: "c1" }), url("/link")],
    ["POST sync", { method: "POST" }, url("/sync")],
  ];
  for (const [label, init, path] of cases) {
    it(`denies a TA on ${label}`, async () => {
      expect((await buildApp(taOfA()).request(path, init, TEST_ENV)).status).toBe(403);
    });
  }
});

describe("GET courses (course picker)", () => {
  it("lists courses visible to the org's stored token", async () => {
    const res = await buildApp(instructorOfA()).request(url("/courses"), {}, TEST_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      courses: [{ canvasCourseId: "canvas-course-1", name: "STATS 311", courseCode: "STATS 311 A", term: "Fall" }],
    });
  });

  it("guides the instructor to set up a token first when none exists", async () => {
    getDecryptedMock.mockResolvedValue(null);
    const res = await buildApp(instructorOfA()).request(url("/courses"), {}, TEST_ENV);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Canvas API token/i);
  });

  it("reports a 503 with an actionable message when Canvas can't be reached", async () => {
    listCanvasCoursesMock.mockRejectedValue(new Error("boom"));
    const res = await buildApp(instructorOfA()).request(url("/courses"), {}, TEST_ENV);
    expect(res.status).toBe(503);
  });
});

describe("GET status", () => {
  it("returns idle defaults when no lms_integrations row exists yet", async () => {
    getLmsIntegrationMock.mockResolvedValue(null);
    const res = await buildApp(instructorOfA()).request(url("/status"), {}, TEST_ENV);
    expect(await res.json()).toEqual({
      canvasCourseId: null,
      lastSyncStatus: "idle",
      lastSyncCounts: null,
      lastSyncErrorMessage: null,
      lastSyncedAt: null,
    });
  });

  it("returns the stored status", async () => {
    const res = await buildApp(instructorOfA()).request(url("/status"), {}, TEST_ENV);
    const body = await res.json();
    expect(body).toMatchObject({ canvasCourseId: "canvas-course-1", lastSyncStatus: "success" });
  });
});

describe("PUT link", () => {
  it("links and audits", async () => {
    const res = await buildApp(instructorOfA()).request(
      url("/link"),
      json("PUT", { canvasCourseId: "canvas-course-1" }),
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lmsIntegrationId: "lms-1", canvasCourseId: "canvas-course-1" });
    expect(auditBestEffortMock).toHaveBeenCalledWith(
      {},
      ["org-1"],
      expect.objectContaining({ action: "lms_integration.canvas_course_linked" }),
    );
  });

  it("409s when another course already claims that Canvas course", async () => {
    linkCanvasCourseMock.mockResolvedValue({ outcome: "canvas_course_already_linked" });
    const res = await buildApp(instructorOfA()).request(
      url("/link"),
      json("PUT", { canvasCourseId: "canvas-course-1" }),
      TEST_ENV,
    );
    expect(res.status).toBe(409);
  });

  it("requires a token to already be on file", async () => {
    getDecryptedMock.mockResolvedValue(null);
    const res = await buildApp(instructorOfA()).request(
      url("/link"),
      json("PUT", { canvasCourseId: "c1" }),
      TEST_ENV,
    );
    expect(res.status).toBe(409);
    expect(linkCanvasCourseMock).not.toHaveBeenCalled();
  });

  it("rejects a missing canvasCourseId", async () => {
    const res = await buildApp(instructorOfA()).request(url("/link"), json("PUT", {}), TEST_ENV);
    expect(res.status).toBe(400);
  });
});

describe("POST sync", () => {
  it("runs the sync, records success status, and audits", async () => {
    const res = await buildApp(instructorOfA()).request(url("/sync"), { method: "POST" }, TEST_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 1, updated: 0, removed: 0, errors: [] });
    expect(updateSyncStatusMock).toHaveBeenCalledWith(
      {},
      "lms-1",
      expect.objectContaining({ status: "success", counts: { added: 1, updated: 0, removed: 0 } }),
    );
    expect(markCourseSyncedMock).toHaveBeenCalled();
    expect(auditBestEffortMock).toHaveBeenCalledWith(
      {},
      ["org-1"],
      expect.objectContaining({ action: "lms_integration.canvas_sync_completed" }),
    );
  });

  it("requires the course to be linked first", async () => {
    getLmsIntegrationMock.mockResolvedValue(null);
    const res = await buildApp(instructorOfA()).request(url("/sync"), { method: "POST" }, TEST_ENV);
    expect(res.status).toBe(409);
    expect(syncCanvasRosterMock).not.toHaveBeenCalled();
  });

  it("records an error status and returns 502 (not an unhandled 503) when the sync throws", async () => {
    syncCanvasRosterMock.mockRejectedValue(new Error("Canvas API request failed (500)"));
    const res = await buildApp(instructorOfA()).request(url("/sync"), { method: "POST" }, TEST_ENV);
    expect(res.status).toBe(502);
    expect(updateSyncStatusMock).toHaveBeenCalledWith(
      {},
      "lms-1",
      expect.objectContaining({ status: "error" }),
    );
    expect(markCourseSyncedMock).not.toHaveBeenCalled();
    expect(auditBestEffortMock).toHaveBeenCalledWith(
      {},
      ["org-1"],
      expect.objectContaining({ action: "lms_integration.canvas_sync_failed" }),
    );
  });
});
