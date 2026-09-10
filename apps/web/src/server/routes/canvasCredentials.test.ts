/* --------------------------------------------------------------------------
   #73: the Canvas credential routes.

   The repository suite (repositories/organizationCredentials.test.ts) owns
   the encryption round-trip and the upsert semantics against a real
   Postgres. This file owns the request contract: who is admitted, which
   bodies are refused and with what sentence, and -- the one thing that
   matters most here -- that no response from this file ever carries the
   plaintext token.
   -------------------------------------------------------------------------- */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  deleteCanvasCredentialHandler,
  getCanvasCredentialHandler,
  setCanvasCredentialHandler,
  validateCanvasCredentialHandler,
} from "./canvasCredentials";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const getSummaryMock = vi.fn();
const setCredentialMock = vi.fn();
const deleteCredentialMock = vi.fn();
const getDecryptedMock = vi.fn();
const getOrgScopeForCourseMock = vi.fn();
const auditBestEffortMock = vi.fn();
const validateCanvasTokenMock = vi.fn();

vi.mock("../repositories/organizationCredentials", () => ({
  getCanvasCredentialSummary: (...a: unknown[]) => getSummaryMock(...a),
  setCanvasCredential: (...a: unknown[]) => setCredentialMock(...a),
  deleteCanvasCredential: (...a: unknown[]) => deleteCredentialMock(...a),
  getDecryptedCanvasCredential: (...a: unknown[]) => getDecryptedMock(...a),
}));
vi.mock("../repositories/organizations", () => ({
  getOrgScopeForCourse: (...a: unknown[]) => getOrgScopeForCourseMock(...a),
}));
vi.mock("../utils/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/audit")>()),
  auditBestEffort: (...a: unknown[]) => auditBestEffortMock(...a),
}));
vi.mock("../../lib/canvas-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/canvas-api")>()),
  validateCanvasToken: (...a: unknown[]) => validateCanvasTokenMock(...a),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

const TEST_ENV = {
  DATABASE_URL: "ignored",
  ENCRYPTION_KEY: Buffer.from(new Uint8Array(32)).toString("base64"),
  BLIND_INDEX_KEY: Buffer.from(new Uint8Array(32)).toString("base64"),
} as Env;

const SUMMARY = {
  id: "cred-1",
  maskedToken: "ab••••yz",
  canvasBaseUrl: "https://uw.instructure.com",
  expiresAt: null,
  rotatedAt: "2026-09-10T00:00:00.000Z",
};

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  const base = "/api/courses/:courseId/canvas/credential";
  app.get(base, (c) => getCanvasCredentialHandler(c));
  app.put(base, (c) => setCanvasCredentialHandler(c));
  app.delete(base, (c) => deleteCanvasCredentialHandler(c));
  app.post(`${base}/validate`, (c) => validateCanvasCredentialHandler(c));
  return app;
}

const instructorOfA = () =>
  fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })] });
const taOfA = () => fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "ta" })] });

const url = (suffix = "") => `/api/courses/course-a/canvas/credential${suffix}`;
const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  getSummaryMock.mockReset().mockResolvedValue(SUMMARY);
  setCredentialMock.mockReset().mockResolvedValue({ id: "cred-1" });
  deleteCredentialMock.mockReset().mockResolvedValue({ deleted: true, id: "cred-1" });
  getDecryptedMock.mockReset().mockResolvedValue({
    id: "cred-1",
    token: "super-secret-canvas-token",
    canvasBaseUrl: "https://uw.instructure.com",
  });
  getOrgScopeForCourseMock.mockReset().mockResolvedValue("org-1");
  auditBestEffortMock.mockReset().mockResolvedValue(undefined);
  validateCanvasTokenMock.mockReset().mockResolvedValue({ ok: true, canvasUserId: "1", name: "Lauren" });
});

describe("Canvas credential authorization (#73)", () => {
  const cases: [string, RequestInit | undefined, string][] = [
    ["GET", undefined, url()],
    ["PUT", json("PUT", { token: "t", canvasBaseUrl: "https://uw.instructure.com" }), url()],
    ["DELETE", { method: "DELETE" }, url()],
    ["POST validate", { method: "POST" }, url("/validate")],
  ];

  for (const [label, init, path] of cases) {
    it(`denies a TA on ${label}`, async () => {
      const res = await buildApp(taOfA()).request(path, init, TEST_ENV);
      expect(res.status).toBe(403);
    });

    it(`denies an unauthenticated caller on ${label}`, async () => {
      const res = await buildApp(undefined).request(path, init, TEST_ENV);
      expect(res.status).toBe(403);
    });
  }
});

describe("GET credential", () => {
  it("returns the masked summary", async () => {
    const res = await buildApp(instructorOfA()).request(url(), {}, TEST_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ credential: SUMMARY });
  });

  it("returns credential: null when none is set", async () => {
    getSummaryMock.mockResolvedValue(null);
    const res = await buildApp(instructorOfA()).request(url(), {}, TEST_ENV);
    expect(await res.json()).toEqual({ credential: null });
  });
});

describe("PUT credential", () => {
  it("sets the credential and audits the change, echoing only the masked summary", async () => {
    // beforeEach's default (getSummaryMock resolves SUMMARY) means a
    // credential already exists, so this exercises the "replace" path --
    // see the dedicated "first-ever set" test below for the other branch.
    const res = await buildApp(instructorOfA()).request(
      url(),
      json("PUT", { token: "raw-plaintext-token", canvasBaseUrl: "https://uw.instructure.com" }),
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(bodyText).not.toContain("raw-plaintext-token");
    expect(JSON.parse(bodyText)).toEqual({ credential: SUMMARY });

    expect(setCredentialMock).toHaveBeenCalledWith(
      {},
      expect.anything(),
      "org-1",
      expect.objectContaining({ token: "raw-plaintext-token", canvasBaseUrl: "https://uw.instructure.com" }),
    );
    expect(auditBestEffortMock).toHaveBeenCalledWith(
      {},
      ["org-1"],
      expect.objectContaining({ action: "credential.canvas_token_replaced" }),
    );
  });

  it("audits a first-ever entry as 'set', not 'replaced'", async () => {
    getSummaryMock.mockResolvedValueOnce(null).mockResolvedValue(SUMMARY);
    const res = await buildApp(instructorOfA()).request(
      url(),
      json("PUT", { token: "raw-plaintext-token", canvasBaseUrl: "https://uw.instructure.com" }),
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    expect(auditBestEffortMock).toHaveBeenCalledWith(
      {},
      ["org-1"],
      expect.objectContaining({ action: "credential.canvas_token_set" }),
    );
  });

  it("accepts and forwards an expiry date", async () => {
    await buildApp(instructorOfA()).request(
      url(),
      json("PUT", { token: "t", canvasBaseUrl: "https://uw.instructure.com", expiresAt: "2026-12-01" }),
      TEST_ENV,
    );
    expect(setCredentialMock).toHaveBeenCalledWith(
      {},
      expect.anything(),
      "org-1",
      expect.objectContaining({ expiresAt: new Date("2026-12-01") }),
    );
  });

  it("rejects an unparseable expiry date", async () => {
    const res = await buildApp(instructorOfA()).request(
      url(),
      json("PUT", { token: "t", canvasBaseUrl: "https://uw.instructure.com", expiresAt: "not a date" }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("normalizes a trailing slash off the base URL", async () => {
    await buildApp(instructorOfA()).request(
      url(),
      json("PUT", { token: "t", canvasBaseUrl: "https://uw.instructure.com/" }),
      TEST_ENV,
    );
    expect(setCredentialMock).toHaveBeenCalledWith(
      {},
      expect.anything(),
      "org-1",
      expect.objectContaining({ canvasBaseUrl: "https://uw.instructure.com" }),
    );
  });

  it("rejects an empty token", async () => {
    const res = await buildApp(instructorOfA()).request(
      url(),
      json("PUT", { token: "  ", canvasBaseUrl: "https://uw.instructure.com" }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(setCredentialMock).not.toHaveBeenCalled();
  });

  it("rejects a non-https base URL", async () => {
    const res = await buildApp(instructorOfA()).request(
      url(),
      json("PUT", { token: "t", canvasBaseUrl: "http://uw.instructure.com" }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a base URL with a path", async () => {
    const res = await buildApp(instructorOfA()).request(
      url(),
      json("PUT", { token: "t", canvasBaseUrl: "https://uw.instructure.com/courses" }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a malformed URL", async () => {
    const res = await buildApp(instructorOfA()).request(
      url(),
      json("PUT", { token: "t", canvasBaseUrl: "not a url" }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });
});

describe("DELETE credential", () => {
  it("deletes and audits", async () => {
    const res = await buildApp(instructorOfA()).request(url(), { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ credential: null });
    expect(auditBestEffortMock).toHaveBeenCalledWith(
      {},
      ["org-1"],
      expect.objectContaining({ action: "credential.canvas_token_deleted" }),
    );
  });

  it("404s when there is nothing to delete", async () => {
    deleteCredentialMock.mockResolvedValue({ deleted: false });
    const res = await buildApp(instructorOfA()).request(url(), { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(404);
  });
});

describe("POST validate", () => {
  it("reports ok:true and audits when the token works", async () => {
    const res = await buildApp(instructorOfA()).request(url("/validate"), { method: "POST" }, TEST_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, canvasUserId: "1", name: "Lauren" });
    expect(auditBestEffortMock).toHaveBeenCalledWith(
      {},
      ["org-1"],
      expect.objectContaining({ action: "credential.canvas_token_validated" }),
    );
    // The plaintext token from getDecryptedCanvasCredential's mock must
    // never appear in what this handler sends back.
    expect(JSON.stringify(await (await buildApp(instructorOfA()).request(url("/validate"), { method: "POST" }, TEST_ENV)).json())).not.toContain(
      "super-secret-canvas-token",
    );
  });

  it("reports ok:false (200, not an error status) when Canvas rejects the token", async () => {
    validateCanvasTokenMock.mockResolvedValue({ ok: false, status: 401, message: "Canvas rejected this token." });
    const res = await buildApp(instructorOfA()).request(url("/validate"), { method: "POST" }, TEST_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, message: "Canvas rejected this token." });
  });

  it("404s when no credential is on file", async () => {
    getDecryptedMock.mockResolvedValue(null);
    const res = await buildApp(instructorOfA()).request(url("/validate"), { method: "POST" }, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("reports ok:false on a transport failure instead of throwing", async () => {
    validateCanvasTokenMock.mockRejectedValue(new Error("network down"));
    const res = await buildApp(instructorOfA()).request(url("/validate"), { method: "POST" }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});
