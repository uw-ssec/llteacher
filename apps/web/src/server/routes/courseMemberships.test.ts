import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  addCourseTasHandler,
  listCourseTasHandler,
  removeCourseTaHandler,
  updateTaCapabilitiesHandler,
  MAX_TAS_PER_REQUEST,
} from "./courseMemberships";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;

// A real UUID: the PATCH route validates the path param's shape (SEC-003).
const MEMBERSHIP_ID = "11111111-2222-4333-8444-555555555555";

const listCourseTasMock = vi.fn();
const setTaCapabilitiesMock = vi.fn();
const addTasByNetidMock = vi.fn();
const removeCourseTaMock = vi.fn();
const getOrgScopeForCourseMock = vi.fn();
const auditBestEffortMock = vi.fn();

vi.mock("../repositories/courseMemberships", () => ({
  listCourseTas: (...a: unknown[]) => listCourseTasMock(...a),
  setTaCapabilities: (...a: unknown[]) => setTaCapabilitiesMock(...a),
  addTasByNetid: (...a: unknown[]) => addTasByNetidMock(...a),
  removeCourseTa: (...a: unknown[]) => removeCourseTaMock(...a),
}));
vi.mock("../repositories/organizations", () => ({
  getOrgScopeForCourse: (...a: unknown[]) => getOrgScopeForCourseMock(...a),
}));
vi.mock("../utils/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/audit")>()),
  auditBestEffort: (...a: unknown[]) => auditBestEffortMock(...a),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));
// listCourseTas decrypts identities (#172 audit, USE-001), so the handler
// now builds a cipher; stub the key load rather than the cipher itself.
vi.mock("../../lib/secrets-loader", () => ({ loadIdentityCipherKeys: async () => ({}) }));
vi.mock("../../lib/crypto/identity-cipher", () => ({ IdentityCipher: class {} }));

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  app.get("/api/courses/:courseId/tas", (c) => listCourseTasHandler(c));
  app.patch("/api/courses/:courseId/tas/:membershipId/capabilities", (c) =>
    updateTaCapabilitiesHandler(c),
  );
  app.post("/api/courses/:courseId/tas", (c) => addCourseTasHandler(c));
  app.delete("/api/courses/:courseId/tas/:membershipId", (c) => removeCourseTaHandler(c));
  return app;
}

const instructorOfA = () =>
  fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })] });
const taOfA = () =>
  fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "ta" })] });

function patch(authContext: AuthContext | undefined, body: unknown, membershipId = MEMBERSHIP_ID) {
  return buildApp(authContext).request(
    `/api/courses/course-a/tas/${membershipId}/capabilities`,
    { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    TEST_ENV,
  );
}

beforeEach(() => {
  listCourseTasMock.mockReset().mockResolvedValue([]);
  setTaCapabilitiesMock.mockReset().mockResolvedValue({
    membershipId: MEMBERSHIP_ID,
    userId: "u-ta",
    canViewSolutions: true,
    canViewDrafts: false,
  });
  getOrgScopeForCourseMock.mockReset().mockResolvedValue("org-1");
  auditBestEffortMock.mockReset().mockResolvedValue(undefined);
  addTasByNetidMock.mockReset().mockResolvedValue([]);
  removeCourseTaMock.mockReset().mockResolvedValue({
    membershipId: MEMBERSHIP_ID,
    userId: "u-ta",
  });
});

describe("GET /api/courses/:courseId/tas", () => {
  it("returns the course's TAs for an instructor", async () => {
    listCourseTasMock.mockResolvedValue([
      {
        membershipId: MEMBERSHIP_ID,
        userId: "u-ta",
        displayName: "Ada Lovelace",
        email: "ada@uw.edu",
        canViewSolutions: false,
        canViewDrafts: true,
      },
    ]);
    const res = await buildApp(instructorOfA()).request("/api/courses/course-a/tas", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tas: unknown[] };
    expect(body.tas).toHaveLength(1);
  });

  // #172: granting is authoring-tier -- a TA must not be able to read, and
  // therefore edit, the capability roster (their own included).
  it("denies a TA of the same course", async () => {
    const res = await buildApp(taOfA()).request("/api/courses/course-a/tas", {}, TEST_ENV);
    expect(res.status).toBe(403);
    expect(listCourseTasMock).not.toHaveBeenCalled();
  });

  it("denies an instructor of a different course", async () => {
    const other = fakeAuthContext({
      memberships: [fakeMembership({ courseId: "course-b", role: "instructor" })],
    });
    const res = await buildApp(other).request("/api/courses/course-a/tas", {}, TEST_ENV);
    expect(res.status).toBe(403);
    expect(listCourseTasMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/courses/:courseId/tas/:membershipId/capabilities", () => {
  it("updates a single capability and echoes the persisted row", async () => {
    const res = await patch(instructorOfA(), { canViewSolutions: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      membershipId: MEMBERSHIP_ID,
      userId: "u-ta",
      canViewSolutions: true,
      canViewDrafts: false,
    });
  });

  it("denies a TA attempting to widen their own access", async () => {
    const res = await patch(taOfA(), { canViewSolutions: true });
    expect(res.status).toBe(403);
    expect(setTaCapabilitiesMock).not.toHaveBeenCalled();
  });

  it("404s when the repository reports no matching TA membership", async () => {
    setTaCapabilitiesMock.mockResolvedValue(null);
    const res = await patch(instructorOfA(), { canViewDrafts: true });
    expect(res.status).toBe(404);
  });

  // Non-boolean values must not be coerced into a grant -- an uncontrolled
  // checkbox posting "" or "on" is the failure mode this guards.
  it.each<{ value: unknown; label: string }>([
    { value: "", label: "empty string" },
    { value: "on", label: "checkbox string" },
    { value: 1, label: "number" },
    { value: null, label: "null" },
  ])("rejects $label for canViewSolutions with 400", async ({ value }) => {
    const res = await patch(instructorOfA(), { canViewSolutions: value });
    expect(res.status).toBe(400);
    expect(setTaCapabilitiesMock).not.toHaveBeenCalled();
  });

  it("rejects a body naming neither capability with 400", async () => {
    const res = await patch(instructorOfA(), {});
    expect(res.status).toBe(400);
    expect(setTaCapabilitiesMock).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON rather than a 503", async () => {
    const res = await buildApp(instructorOfA()).request(
      `/api/courses/course-a/tas/${MEMBERSHIP_ID}/capabilities`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: "{not json" },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("audits the change against the affected TA, not the acting instructor", async () => {
    await patch(instructorOfA(), { canViewSolutions: true });
    expect(auditBestEffortMock).toHaveBeenCalledTimes(1);
    const [, scopes, input] = auditBestEffortMock.mock.calls[0]!;
    // #172 audit (SEC-002): exactly the course's own org, not every org the
    // acting instructor belongs to.
    expect(scopes).toEqual(["org-1"]);
    expect(input).toMatchObject({
      action: "membership.ta_capabilities_updated",
      targetId: "u-ta",
      actorUserId: "u1",
    });
  });

  it("still succeeds when the audit write fails", async () => {
    auditBestEffortMock.mockRejectedValue(new Error("audit down"));
    const res = await patch(instructorOfA(), { canViewSolutions: true });
    expect(res.status).toBe(200);
  });
});

/** #206 (#172 re-audit, SEC-020): the shape check SEC-003 added was never
 *  pinned by a test. Deleting it left all 14 tests in this file green,
 *  because every one of them uses a valid UUID and the file only *commented*
 *  that the route validates. */
describe("PATCH .../tas/:membershipId/capabilities — path param shape (#172, SEC-020)", () => {
  it.each(["not-a-uuid", "1", "'; DROP TABLE course_memberships; --", "../../etc/passwd"])(
    "returns 404, never 503, for membershipId %j",
    async (bad) => {
      const res = await buildApp(
        fakeAuthContext({
          memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })],
        }),
      ).request(
        `/api/courses/course-a/tas/${encodeURIComponent(bad)}/capabilities`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ canViewSolutions: true }),
        },
        TEST_ENV,
      );
      // 503 is what an unvalidated param produces: Postgres raises
      // `invalid input syntax for type uuid`, app.onError maps any throw to
      // a generic 503, and a permanent client error reports itself as a
      // backend outage.
      expect(res.status).toBe(404);
      // Identical to the genuine-miss body, so a malformed id is not an
      // existence oracle.
      expect(((await res.json()) as { error: string }).error).toBe(
        "That teaching assistant is no longer in this course.",
      );
      expect(setTaCapabilitiesMock).not.toHaveBeenCalled();
    },
  );
});

/* --------------------------------------------------------------------------
   #210: POST /tas and DELETE /tas/:membershipId.

   Both are requireInstructorOf at the route table (routeGuards.test.ts pins
   that), and both re-check defensively here so a direct call fails closed.
   What this file owns is the request contract: what shapes are refused, what
   a partly-failing batch answers with, and what reaches the audit log.
   -------------------------------------------------------------------------- */
describe("POST /api/courses/:courseId/tas (#210)", () => {
  const post = (app: ReturnType<typeof buildApp>, body: unknown) =>
    app.request(
      "/api/courses/course-a/tas",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      TEST_ENV,
    );

  it("denies a TA of the same course", async () => {
    // Recruiting another TA is authoring-tier authority: a TA must not be
    // able to widen who can read student work, their own access included.
    const res = await post(buildApp(taOfA()), { netids: ["ada"] });
    expect(res.status).toBe(403);
    expect(addTasByNetidMock).not.toHaveBeenCalled();
  });

  it("denies an instructor of a different course", async () => {
    const other = fakeAuthContext({
      memberships: [fakeMembership({ courseId: "course-z", role: "instructor" })],
    });
    expect((await post(buildApp(other), { netids: ["ada"] })).status).toBe(403);
    expect(addTasByNetidMock).not.toHaveBeenCalled();
  });

  it("answers 200 with per-NetID results even when every entry failed", async () => {
    // The request succeeded; it is the individual NetIDs that did not
    // resolve. Collapsing eight independent outcomes into one status code is
    // the shape #210 exists to reject.
    addTasByNetidMock.mockResolvedValue([
      { netid: "nope one", status: "invalid_netid" },
      { netid: "bob", status: "role_conflict", existingRole: "student" },
    ]);
    const res = await post(buildApp(instructorOfA()), { netids: ["nope one", "bob"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { netid: "nope one", status: "invalid_netid" },
        { netid: "bob", status: "role_conflict", existingRole: "student" },
      ],
    });
  });

  for (const [label, body] of [
    ["a non-array netids", { netids: "ada" }],
    ["a non-string entry", { netids: ["ada", 7] }],
    ["an empty list", { netids: [] }],
  ] as const) {
    it(`rejects ${label} with a 400`, async () => {
      expect((await post(buildApp(instructorOfA()), body)).status).toBe(400);
      expect(addTasByNetidMock).not.toHaveBeenCalled();
    });
  }

  it("rejects a batch over the cap rather than silently truncating it", async () => {
    // Adding the first 100 of 500 pasted NetIDs and reporting success would
    // be worse than refusing.
    const netids = Array.from({ length: MAX_TAS_PER_REQUEST + 1 }, (_, i) => `t${i}`);
    const res = await post(buildApp(instructorOfA()), { netids });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(String(MAX_TAS_PER_REQUEST));
    expect(addTasByNetidMock).not.toHaveBeenCalled();
  });

  it("audits only the entries that changed something, against the course's org", async () => {
    addTasByNetidMock.mockResolvedValue([
      { netid: "ada", status: "added", membershipId: MEMBERSHIP_ID },
      { netid: "grace", status: "restored", membershipId: "m-2" },
      { netid: "bob", status: "already_ta", membershipId: "m-3" },
      { netid: "nope one", status: "invalid_netid" },
    ]);
    await post(buildApp(instructorOfA()), { netids: ["ada", "grace", "bob", "nope one"] });

    // already_ta and invalid_netid wrote nothing, so they are not events.
    expect(auditBestEffortMock).toHaveBeenCalledTimes(2);
    for (const call of auditBestEffortMock.mock.calls) {
      // SEC-002: the course's org only, never a fan-out across every org the
      // acting instructor belongs to.
      expect(call[1]).toEqual(["org-1"]);
      expect(call[2].action).toBe("membership.course_ta_added");
      // The membership id, not the NetID -- a NetID is directly identifying
      // and the audit log is org-scoped storage.
      expect(String(call[2].targetId)).not.toContain("ada");
    }
  });

  it("still reports the memberships when the audit write fails", async () => {
    // Best-effort (#147): an audit outage must not fail memberships that
    // already exist in the database.
    addTasByNetidMock.mockResolvedValue([
      { netid: "ada", status: "added", membershipId: MEMBERSHIP_ID },
    ]);
    getOrgScopeForCourseMock.mockRejectedValue(new Error("audit down"));
    const res = await post(buildApp(instructorOfA()), { netids: ["ada"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { status: string }[] };
    expect(body.results[0]!.status).toBe("added");
  });
});

describe("DELETE /api/courses/:courseId/tas/:membershipId (#210)", () => {
  const del = (app: ReturnType<typeof buildApp>, id = MEMBERSHIP_ID) =>
    app.request(`/api/courses/course-a/tas/${id}`, { method: "DELETE" }, TEST_ENV);

  it("denies a TA of the same course", async () => {
    expect((await del(buildApp(taOfA()))).status).toBe(403);
    expect(removeCourseTaMock).not.toHaveBeenCalled();
  });

  it("removes the TA and audits it against the course's org", async () => {
    const res = await del(buildApp(instructorOfA()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ membershipId: MEMBERSHIP_ID });
    expect(auditBestEffortMock).toHaveBeenCalledTimes(1);
    expect(auditBestEffortMock.mock.calls[0][1]).toEqual(["org-1"]);
    expect(auditBestEffortMock.mock.calls[0][2].action).toBe("membership.course_ta_removed");
  });

  it("404s a malformed membership id without reaching the database", async () => {
    // SEC-003: a non-UUID would otherwise reach a uuid-typed comparison and
    // surface as a 503 for a permanently malformed request.
    const res = await del(buildApp(instructorOfA()), "not-a-uuid");
    expect(res.status).toBe(404);
    expect(removeCourseTaMock).not.toHaveBeenCalled();
  });

  it("404s when the repository matched nothing, without saying why", async () => {
    // "no such id", "another course", "not a TA" and "already removed" are
    // deliberately indistinguishable, so a probing caller learns nothing.
    removeCourseTaMock.mockResolvedValue(null);
    const res = await del(buildApp(instructorOfA()));
    expect(res.status).toBe(404);
    expect(auditBestEffortMock).not.toHaveBeenCalled();
  });
});
