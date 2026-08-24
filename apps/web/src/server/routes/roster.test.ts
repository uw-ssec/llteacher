/* --------------------------------------------------------------------------
   #32 / #86: the roster routes.

   repositories/roster.test.ts owns the provisioning semantics against a real
   Postgres. This file owns the request contract -- who is admitted, what a
   preview promises, and how a partly-failing import reports itself.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  addRosterMemberHandler,
  importRosterHandler,
  listRosterHandler,
  removeRosterMemberHandler,
} from "./roster";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;
const MEMBERSHIP_ID = "11111111-2222-4333-8444-555555555555";

const listMock = vi.fn();
const upsertMock = vi.fn();
const upsertBatchMock = vi.fn();
const previewBatchMock = vi.fn();
const removeMock = vi.fn();
const allowedDomainsMock = vi.fn();
const getOrgScopeForCourseMock = vi.fn();
const auditBestEffortMock = vi.fn();

vi.mock("../repositories/roster", () => ({
  listCourseRoster: (...a: unknown[]) => listMock(...a),
  upsertCourseMember: (...a: unknown[]) => upsertMock(...a),
  // #355: the import path is batched -- one call for the whole file rather
  // than one per row. The single-entry `upsertCourseMember` remains the
  // manual-add door.
  upsertCourseMembers: (...a: unknown[]) => upsertBatchMock(...a),
  previewCourseMembers: (...a: unknown[]) => previewBatchMock(...a),
  removeCourseMember: (...a: unknown[]) => removeMock(...a),
  allowedDomainsForCourse: (...a: unknown[]) => allowedDomainsMock(...a),
}));
vi.mock("../repositories/organizations", () => ({
  getOrgScopeForCourse: (...a: unknown[]) => getOrgScopeForCourseMock(...a),
}));
vi.mock("../utils/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/audit")>()),
  auditBestEffort: (...a: unknown[]) => auditBestEffortMock(...a),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));
vi.mock("../../lib/secrets-loader", () => ({ loadIdentityCipherKeys: async () => ({}) }));
vi.mock("../../lib/crypto/identity-cipher", () => ({
  IdentityCipher: class {
    static normalizeEmail(e: string) {
      return e.trim().toLowerCase();
    }
  },
}));

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  app.get("/api/courses/:courseId/roster", (c) => listRosterHandler(c));
  app.post("/api/courses/:courseId/roster", (c) => addRosterMemberHandler(c));
  app.post("/api/courses/:courseId/roster/import", (c) => importRosterHandler(c));
  app.delete("/api/courses/:courseId/roster/:membershipId", (c) => removeRosterMemberHandler(c));
  return app;
}

const instructorOfA = () =>
  fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })] });
const taOfA = () =>
  fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "ta" })] });

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  listMock.mockReset().mockResolvedValue({ members: [], total: 0 });
  upsertMock.mockReset().mockResolvedValue({ email: "a@uw.edu", status: "added", membershipId: MEMBERSHIP_ID });
  removeMock.mockReset().mockResolvedValue({ outcome: "removed", membershipId: MEMBERSHIP_ID, userId: "u1" });
  upsertBatchMock.mockReset().mockImplementation(async (_db, _scope, _cipher, entries) =>
    (entries as { email: string }[]).map((e) => ({
      email: e.email,
      status: "added",
      membershipId: MEMBERSHIP_ID,
    })),
  );
  previewBatchMock.mockReset().mockImplementation(async (_db, _scope, _cipher, entries) =>
    (entries as { email: string }[]).map((e) => ({ email: e.email, status: "added" })),
  );
  allowedDomainsMock.mockReset().mockResolvedValue(["uw.edu"]);
  getOrgScopeForCourseMock.mockReset().mockResolvedValue("org-1");
  auditBestEffortMock.mockReset().mockResolvedValue(undefined);
});

describe("roster authorization (#32)", () => {
  const cases: [string, RequestInit | undefined, string][] = [
    ["GET list", undefined, "/api/courses/course-a/roster"],
    ["POST add", json("POST", { email: "a@uw.edu" }), "/api/courses/course-a/roster"],
    ["POST import", json("POST", { csv: "email\na@uw.edu" }), "/api/courses/course-a/roster/import"],
    ["DELETE remove", { method: "DELETE" }, `/api/courses/course-a/roster/${MEMBERSHIP_ID}`],
  ];

  for (const [label, init, path] of cases) {
    it(`denies a TA on ${label}`, async () => {
      // A TA reads student work; they do not decide who is in the class.
      expect((await buildApp(taOfA()).request(path, init, TEST_ENV)).status).toBe(403);
    });
    it(`denies an instructor of another course on ${label}`, async () => {
      const other = fakeAuthContext({
        memberships: [fakeMembership({ courseId: "course-z", role: "instructor" })],
      });
      expect((await buildApp(other).request(path, init, TEST_ENV)).status).toBe(403);
    });
  }
});

describe("POST /roster -- manual add (#32)", () => {
  const post = (body: unknown) =>
    buildApp(instructorOfA()).request("/api/courses/course-a/roster", json("POST", body), TEST_ENV);

  it("defaults to the student role", async () => {
    await post({ email: "a@uw.edu" });
    expect(upsertMock.mock.calls[0]![3]).toMatchObject({ role: "student" });
  });

  it("accepts the spreadsheet vocabulary instructors actually write", async () => {
    for (const [written, expected] of [
      ["TA", "ta"],
      ["Teaching Assistant", "ta"],
      ["Student", "student"],
      ["auditor", "observer"],
    ] as const) {
      upsertMock.mockClear();
      await post({ email: "a@uw.edu", role: written });
      expect(upsertMock.mock.calls[0]![3]).toMatchObject({ role: expected });
    }
  });

  it("refuses to enrol someone as instructor from this surface", async () => {
    // Co-instructor authority hands over publishing, granting and removal.
    // It should not be reachable by typing a word into a field.
    const res = await post({ email: "a@uw.edu", role: "instructor" });
    expect(res.status).toBe(400);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("reports a disallowed domain as a 400 with the reason", async () => {
    upsertMock.mockResolvedValue({
      email: "a@gmail.com",
      status: "disallowed_domain",
      message: 'Domain "gmail.com" is not allowed. Allowed domains: uw.edu',
    });
    const res = await post({ email: "a@gmail.com" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/not allowed/);
  });

  it("reports a role conflict as a 409 naming the current role", async () => {
    upsertMock.mockResolvedValue({ email: "a@uw.edu", status: "role_conflict", existingRole: "ta" });
    const res = await post({ email: "a@uw.edu" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/already on this course as ta/i);
  });

  it("audits an add against the course's org only", async () => {
    await post({ email: "a@uw.edu" });
    expect(auditBestEffortMock.mock.calls[0]![1]).toEqual(["org-1"]);
    expect(auditBestEffortMock.mock.calls[0]![2].action).toBe("membership.roster_member_added");
    // The membership, not the address: a raw email in an org-scoped audit
    // log is directly identifying.
    expect(String(auditBestEffortMock.mock.calls[0]![2].targetId)).not.toContain("@");
  });

  it("does not audit a no-op", async () => {
    upsertMock.mockResolvedValue({ email: "a@uw.edu", status: "already_enrolled", membershipId: MEMBERSHIP_ID });
    await post({ email: "a@uw.edu" });
    expect(auditBestEffortMock).not.toHaveBeenCalled();
  });
});

describe("POST /roster/import (#86)", () => {
  const importCsv = (body: unknown) =>
    buildApp(instructorOfA()).request(
      "/api/courses/course-a/roster/import",
      json("POST", body),
      TEST_ENV,
    );

  it("defaults to a preview and writes nothing", async () => {
    // Wrong in the safe direction: an instructor sees rows to confirm.
    // Wrong the other way writes a file they only meant to look at.
    const res = await importCsv({ csv: "email\nada@uw.edu\n" });
    const body = (await res.json()) as { preview: boolean };
    expect(body.preview).toBe(true);
    expect(previewBatchMock).toHaveBeenCalledTimes(1);
    expect(upsertBatchMock).not.toHaveBeenCalled();
  });

  it("resolves the whole file in ONE call, not one per row (#355)", async () => {
    // The scalability invariant: a 300-student import must not issue 300
    // sequential round trips, which exceeded the Worker subrequest cap.
    const csv = ["email", ...Array.from({ length: 50 }, (_, i) => `s${i}@uw.edu`)].join("\n");
    await importCsv({ csv, preview: false });
    expect(upsertBatchMock).toHaveBeenCalledTimes(1);
    expect((upsertBatchMock.mock.calls[0]![3] as unknown[]).length).toBe(50);
  });

  it("commits only when preview is explicitly false", async () => {
    await importCsv({ csv: "email\nada@uw.edu\n", preview: false });
    expect(upsertBatchMock).toHaveBeenCalledTimes(1);
    expect(previewBatchMock).not.toHaveBeenCalled();
  });

  it("isolates per-row failures so valid rows still land", async () => {
    // An all-or-nothing import of an 80-row file with four typos is a file
    // the instructor cannot use.
    upsertBatchMock.mockResolvedValue([
      { email: "ada@uw.edu", status: "added", membershipId: "m1" },
      { email: "bad@gmail.com", status: "disallowed_domain", message: "no" },
      { email: "grace@uw.edu", status: "added", membershipId: "m2" },
    ]);
    const res = await importCsv({
      csv: "email\nada@uw.edu\nbad@gmail.com\ngrace@uw.edu\n",
      preview: false,
    });
    const body = (await res.json()) as { rows: { line: number; status: string }[]; added: number; failed: number };
    expect(body.added).toBe(2);
    expect(body.failed).toBe(1);
    // Line numbers so the instructor can find the row in their spreadsheet.
    expect(body.rows.map((r) => [r.line, r.status])).toEqual([
      [1, "added"],
      [2, "disallowed_domain"],
      [3, "added"],
    ]);
  });

  it("flags a within-file duplicate rather than silently collapsing it", async () => {
    // The same address twice usually means two different people were pasted
    // onto one line, and the instructor needs to look.
    const res = await importCsv({ csv: "email\nada@uw.edu\nADA@uw.edu\n", preview: false });
    const body = (await res.json()) as { rows: { status: string }[] };
    expect(body.rows[1]!.status).toBe("duplicate_row");
    // A duplicate never reaches the batch -- it is caught in the local pass.
    expect((upsertBatchMock.mock.calls[0]![3] as unknown[]).length).toBe(1);
  });

  it("names an unrecognised role rather than defaulting it", async () => {
    const res = await importCsv({ csv: "email,role\nada@uw.edu,wizard\n", preview: false });
    const body = (await res.json()) as { rows: { status: string; message: string }[] };
    expect(body.rows[0]!.status).toBe("role_conflict");
    expect(body.rows[0]!.message).toMatch(/wizard/);
    // An unparseable role never reaches the batch either.
    expect(upsertBatchMock).not.toHaveBeenCalled();
  });

  it("rejects a file with no rows, and one with no email column", async () => {
    expect((await importCsv({ csv: "email\n" })).status).toBe(400);
    expect((await importCsv({ csv: "name\nAda\n" })).status).toBe(400);
  });

  it("rejects an oversized body before parsing it", async () => {
    const res = await importCsv({ csv: "x".repeat(1024 * 1024 + 1) });
    expect(res.status).toBe(400);
  });

  it("writes one audit event for the whole import, not one per row", async () => {
    // A 200-row file would otherwise bury every other event in the org's
    // log for that day.
    await importCsv({ csv: "email\na@uw.edu\nb@uw.edu\nc@uw.edu\n", preview: false });
    expect(auditBestEffortMock).toHaveBeenCalledTimes(1);
    expect(auditBestEffortMock.mock.calls[0]![2].action).toBe("membership.roster_imported");
  });

  it("does not audit a preview, which changed nothing", async () => {
    await importCsv({ csv: "email\na@uw.edu\n" });
    expect(auditBestEffortMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /roster/:membershipId (#32)", () => {
  const del = (id = MEMBERSHIP_ID) =>
    buildApp(instructorOfA()).request(
      `/api/courses/course-a/roster/${id}`,
      { method: "DELETE" },
      TEST_ENV,
    );

  it("removes and audits", async () => {
    expect((await del()).status).toBe(200);
    expect(auditBestEffortMock.mock.calls[0]![2].action).toBe("membership.roster_member_removed");
  });

  it("refuses to remove an instructor with a 409 and a next step", async () => {
    // A course with no instructor has nobody who can add one back -- and
    // this route is reachable by an instructor on their own membership.
    removeMock.mockResolvedValue({ outcome: "is_instructor" });
    const res = await del();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/program administrator/i);
  });

  it("404s a malformed id without reaching the database", async () => {
    expect((await del("not-a-uuid")).status).toBe(404);
    expect(removeMock).not.toHaveBeenCalled();
  });
});
