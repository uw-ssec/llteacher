import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { listCourseTasHandler, updateTaCapabilitiesHandler } from "./courseMemberships";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;

// A real UUID: the PATCH route validates the path param's shape (SEC-003).
const MEMBERSHIP_ID = "11111111-2222-4333-8444-555555555555";

const listCourseTasMock = vi.fn();
const setTaCapabilitiesMock = vi.fn();
const getOrgScopeForCourseMock = vi.fn();
const auditBestEffortMock = vi.fn();

vi.mock("../repositories/courseMemberships", () => ({
  listCourseTas: (...a: unknown[]) => listCourseTasMock(...a),
  setTaCapabilities: (...a: unknown[]) => setTaCapabilitiesMock(...a),
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
