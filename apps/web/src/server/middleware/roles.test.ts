import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { Hono } from "hono";
import { rolesMiddleware, type AuthContext } from "./roles";
import type { SessionPayload } from "../../lib/session";
import type { AppEnv } from "../context";
import type { BlindIndex } from "../../db/types/encrypted";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { SuperAdminService } from "../../lib/services/SuperAdminService";

/** Real crypto, not mocked: rolesMiddleware now loads the identity cipher to
 *  check super-admin status (#316), and the whole point of that check is
 *  the blind-index equality it performs -- a mocked cipher would just
 *  assert that this test calls a mock, not that a super admin is actually
 *  recognized. One fixed key pair for the whole file, matching
 *  courseMemberships.test.ts's (repository) real-cipher convention. */
const TEST_ENV = {
  DATABASE_URL: "ignored",
  ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
} as Env;

let superAdminBlindIndex: BlindIndex;
let nonAdminBlindIndex: BlindIndex;
beforeAll(async () => {
  const cipher = new IdentityCipher(await loadIdentityCipherKeys(TEST_ENV));
  superAdminBlindIndex = await cipher.computeBlindIndex(
    IdentityCipher.normalizeEmail(SuperAdminService.SUPER_ADMIN_EMAILS[0]!),
  );
  nonAdminBlindIndex = await cipher.computeBlindIndex(IdentityCipher.normalizeEmail("student@uw.edu"));
});

const DEFAULT_MEMBERSHIPS = [
  { id: "m1", userId: "u1", courseId: "course-a", role: "instructor" },
  { id: "m2", userId: "u1", courseId: "course-b", role: "student" },
];

/** Mutable so the #172 capability suite below can swap in TA memberships
 *  with specific flag combinations. Reset in beforeEach. */
let MEMBERSHIPS: Array<Record<string, unknown>> = DEFAULT_MEMBERSHIPS;

let findManyCalls = 0;
let findFirstCalls = 0;
let orgAdminRows: { organizationId: string }[] = [];
let userRow:
  | { isActive: boolean; sessionEpoch: number; emailBlindIndex: BlindIndex; platformInstructorGrantedAt: Date | null }
  | undefined;
vi.mock("../../db/client", () => ({
  makeDb: () => ({
    query: {
      courseMemberships: {
        findMany: async () => {
          findManyCalls++;
          return MEMBERSHIPS;
        },
      },
      users: {
        findFirst: async () => {
          findFirstCalls++;
          return userRow;
        },
      },
      // #367: no Org Admin grants unless a test sets them.
      organizationMemberships: {
        findMany: async () => orgAdminRows,
      },
    },
  }),
}));

function sessionFor(sessionEpoch: number): SessionPayload {
  return { userId: "u1", workosUserId: "w1", sessionEpoch, issuedAt: 0, expiresAt: 0 };
}

function buildApp(sessionEpoch = 0) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("session", sessionFor(sessionEpoch));
    await next();
  });
  app.use("*", rolesMiddleware);
  app.get("/api/x", (c) => {
    const authContext = c.get("authContext") as AuthContext;
    return c.json({
      hasInstructor: authContext.hasRole("instructor"),
      isInstructorOfA: authContext.isInstructorOf("course-a"),
      isInstructorOfB: authContext.isInstructorOf("course-b"),
      isMemberOfB: authContext.isMemberOf("course-b"),
      isMemberOfC: authContext.isMemberOf("course-c"),
    });
  });
  return app;
}

describe("rolesMiddleware", () => {
  beforeEach(() => {
    findManyCalls = 0;
    findFirstCalls = 0;
    userRow = { isActive: true, sessionEpoch: 0, emailBlindIndex: nonAdminBlindIndex, platformInstructorGrantedAt: null };
    MEMBERSHIPS = DEFAULT_MEMBERSHIPS;
    orgAdminRows = [];
  });

  // #367: org-level authority comes from organization_memberships, and is
  // NOT implied by being an instructor of a course in the organization.
  it("exposes isOrgAdminOf from Org Admin grants only", async () => {
    const probe = async () => {
      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("session", sessionFor(0));
        await next();
      });
      app.use("*", rolesMiddleware);
      app.get("/api/x", (c) => {
        const ctx = c.get("authContext")!;
        return c.json({ orgA: ctx.isOrgAdminOf("org-a"), orgB: ctx.isOrgAdminOf("org-b") });
      });
      return (await app.request("/api/x", {}, TEST_ENV)).json();
    };
    // An instructor (DEFAULT_MEMBERSHIPS) with no grant: no org authority.
    expect(await probe()).toEqual({ orgA: false, orgB: false });
    orgAdminRows = [{ organizationId: "org-a" }];
    expect(await probe()).toEqual({ orgA: true, orgB: false });
  });

  it("resolves memberships and exposes role-check helpers", async () => {
    const res = await buildApp().request("/api/x", {}, TEST_ENV);
    const body = await res.json();
    expect(body).toEqual({
      hasInstructor: true,
      isInstructorOfA: true,
      isInstructorOfB: false,
      isMemberOfB: true,
      isMemberOfC: false,
    });
  });

  it("queries memberships and the user row exactly once per request", async () => {
    await buildApp().request("/api/x", {}, TEST_ENV);
    expect(findManyCalls).toBe(1);
    expect(findFirstCalls).toBe(1);
  });

  it("no-ops when there is no session", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", rolesMiddleware);
    app.get("/api/x", (c) => c.json({ authContext: c.get("authContext") ?? null }));
    const res = await app.request("/api/x", {}, TEST_ENV);
    const body = (await res.json()) as { authContext: unknown };
    expect(body.authContext).toBeNull();
  });

  it("skips the membership query on PUBLIC_API_PATHS (e.g. logout) even with a session present", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("session", sessionFor(0));
      await next();
    });
    app.use("*", rolesMiddleware);
    app.post("/api/auth/logout", (c) => c.json({ authContext: c.get("authContext") ?? null }));

    const res = await app.request(
      "/api/auth/logout",
      { method: "POST" },
      TEST_ENV,
    );
    const body = (await res.json()) as { authContext: unknown };

    expect(body.authContext).toBeNull();
    expect(findManyCalls).toBe(0);
    expect(findFirstCalls).toBe(0);
  });

  // #95: a WorkOS deprovisioning webhook flips is_active to false and bumps
  // session_epoch. Both need their own test -- either condition alone must
  // revoke an otherwise-cryptographically-valid cookie.
  it("returns 401 when the user row is deactivated (is_active = false)", async () => {
    userRow = { isActive: false, sessionEpoch: 0, emailBlindIndex: nonAdminBlindIndex, platformInstructorGrantedAt: null };
    const res = await buildApp(0).request("/api/x", {}, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it("returns 401 when the cookie's sessionEpoch is behind the user row's current epoch", async () => {
    userRow = { isActive: true, sessionEpoch: 3, emailBlindIndex: nonAdminBlindIndex, platformInstructorGrantedAt: null };
    const res = await buildApp(2).request("/api/x", {}, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it("returns 401 when the user row no longer exists", async () => {
    userRow = undefined;
    const res = await buildApp(0).request("/api/x", {}, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it("allows the request through when sessionEpoch matches and the account is active", async () => {
    userRow = { isActive: true, sessionEpoch: 5, emailBlindIndex: nonAdminBlindIndex, platformInstructorGrantedAt: null };
    const res = await buildApp(5).request("/api/x", {}, TEST_ENV);
    expect(res.status).toBe(200);
  });
});

/** #172: the capability predicates. These are the security boundary between
 *  "a TA may grade" and "a TA may see the answer key / unreleased work", so
 *  every role x flag combination is asserted rather than sampled. */
function buildCapabilityApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("session", sessionFor(0));
    await next();
  });
  app.use("*", rolesMiddleware);
  app.get("/api/caps", (c) => {
    const authContext = c.get("authContext") as AuthContext;
    return c.json({
      isGrader: authContext.isGraderOf("course-a"),
      isInstructor: authContext.isInstructorOf("course-a"),
      solutions: authContext.canViewSolutionsIn("course-a"),
      drafts: authContext.canViewDraftsIn("course-a"),
    });
  });
  return app;
}

async function capsFor(membership: Record<string, unknown>) {
  MEMBERSHIPS = [{ id: "m1", userId: "u1", courseId: "course-a", ...membership }];
  const res = await buildCapabilityApp().request("/api/caps", {}, TEST_ENV);
  return (await res.json()) as Record<string, boolean>;
}

describe("AuthContext capability predicates (#172)", () => {
  beforeEach(() => {
    userRow = { isActive: true, sessionEpoch: 0, emailBlindIndex: nonAdminBlindIndex, platformInstructorGrantedAt: null };
    MEMBERSHIPS = DEFAULT_MEMBERSHIPS;
  });

  it("an instructor holds every capability regardless of the stored flags", async () => {
    // Flags explicitly false: an instructor must not be gated by columns
    // that only exist to describe a TA's grant.
    expect(
      await capsFor({ role: "instructor", canViewSolutions: false, canViewDrafts: false }),
    ).toEqual({ isGrader: true, isInstructor: true, solutions: true, drafts: true });
  });

  it("an admin holds every capability regardless of the stored flags", async () => {
    expect(await capsFor({ role: "admin", canViewSolutions: false, canViewDrafts: false })).toEqual({
      isGrader: true,
      isInstructor: true,
      solutions: true,
      drafts: true,
    });
  });

  it("a TA grades but sees neither solutions nor drafts by default", async () => {
    expect(await capsFor({ role: "ta", canViewSolutions: false, canViewDrafts: false })).toEqual({
      isGrader: true,
      isInstructor: false,
      solutions: false,
      drafts: false,
    });
  });

  it("a TA's capabilities are granted independently of each other", async () => {
    expect(await capsFor({ role: "ta", canViewSolutions: true, canViewDrafts: false })).toEqual({
      isGrader: true,
      isInstructor: false,
      solutions: true,
      drafts: false,
    });
    expect(await capsFor({ role: "ta", canViewSolutions: false, canViewDrafts: true })).toEqual({
      isGrader: true,
      isInstructor: false,
      solutions: false,
      drafts: true,
    });
  });

  it("granting a TA every capability still does not make them an instructor", async () => {
    expect(await capsFor({ role: "ta", canViewSolutions: true, canViewDrafts: true })).toEqual({
      isGrader: true,
      isInstructor: false,
      solutions: true,
      drafts: true,
    });
  });

  it("a student holds nothing, even with the flags somehow set", async () => {
    // The columns are meaningless on a non-TA row; assert they are ignored
    // rather than trusted, so a stray write can't widen a student's access.
    expect(await capsFor({ role: "student", canViewSolutions: true, canViewDrafts: true })).toEqual({
      isGrader: false,
      isInstructor: false,
      solutions: false,
      drafts: false,
    });
  });

  it("an observer holds nothing, even with the flags somehow set", async () => {
    expect(await capsFor({ role: "observer", canViewSolutions: true, canViewDrafts: true })).toEqual({
      isGrader: false,
      isInstructor: false,
      solutions: false,
      drafts: false,
    });
  });

  it("capabilities never leak across courses", async () => {
    MEMBERSHIPS = [
      { id: "m1", userId: "u1", courseId: "course-b", role: "ta", canViewSolutions: true, canViewDrafts: true },
    ];
    const res = await buildCapabilityApp().request("/api/caps", {}, TEST_ENV);
    expect(await res.json()).toEqual({
      isGrader: false,
      isInstructor: false,
      solutions: false,
      drafts: false,
    });
  });
});

/** Regression guard for the reliability audit's find-vs-some finding.
 *
 *  The audit observed that `capability()` resolved a course's membership with
 *  `.find()` while `isInstructorOf`/`isGraderOf` scanned with their own
 *  `.some()` condition. Those agree only while
 *  course_memberships_user_course_uq holds one row per (user, course) -- true
 *  today, which is why the finding was not a live bug. But it made the
 *  predicates' agreement a property of the schema rather than of the code.
 *
 *  Every course-scoped predicate now resolves the membership once and
 *  describes that row, so they agree by construction. These tests feed the
 *  middleware duplicate rows the database currently forbids: the point is not
 *  that this state is reachable, it is that the predicates stay mutually
 *  consistent if it ever becomes reachable. Under the old split they would
 *  not have. */
describe("course-scoped predicates describe one membership (#172 audit)", () => {
  beforeEach(() => {
    userRow = { isActive: true, sessionEpoch: 0, emailBlindIndex: nonAdminBlindIndex, platformInstructorGrantedAt: null };
    MEMBERSHIPS = DEFAULT_MEMBERSHIPS;
  });

  it("stays self-consistent when two rows exist for the same course", async () => {
    // Row order deliberately puts the narrower role first: a per-predicate
    // `.some()` would answer isInstructorOf=true off row 2 while the
    // capability lookup read row 1, reporting an instructor with no access
    // to their own course's solutions.
    MEMBERSHIPS = [
      { id: "m1", userId: "u1", courseId: "course-a", role: "ta", canViewSolutions: false, canViewDrafts: false },
      { id: "m2", userId: "u1", courseId: "course-a", role: "instructor", canViewSolutions: false, canViewDrafts: false },
    ];
    const res = await buildCapabilityApp().request("/api/caps", {}, TEST_ENV);
    const caps = (await res.json()) as Record<string, boolean>;

    // Whichever row wins, the answers must come from that one row: an
    // instructor holds every capability, a TA without grants holds none.
    // The forbidden outcome is a mix -- isInstructor true with solutions
    // false, or vice versa.
    expect(caps.solutions).toBe(caps.isInstructor);
    expect(caps.drafts).toBe(caps.isInstructor);
    if (caps.isInstructor) expect(caps.isGrader).toBe(true);
  });

  it("resolves the same row for every predicate, in either row order", async () => {
    const ordered = [
      { id: "m2", userId: "u1", courseId: "course-a", role: "instructor", canViewSolutions: false, canViewDrafts: false },
      { id: "m1", userId: "u1", courseId: "course-a", role: "ta", canViewSolutions: false, canViewDrafts: false },
    ];
    MEMBERSHIPS = ordered;
    const res = await buildCapabilityApp().request("/api/caps", {}, TEST_ENV);
    const caps = (await res.json()) as Record<string, boolean>;
    // Instructor row first: every predicate must read it.
    expect(caps).toEqual({ isGrader: true, isInstructor: true, solutions: true, drafts: true });
  });
});

/** #316: a configured super admin gets full elevated access everywhere,
 *  even holding zero real course_memberships -- this is the whole point of
 *  the bypass (grant instructor console access before any course exists
 *  for them, per the issue's discussion). hasRole is the one deliberate
 *  exception: it gates student-action routes, and a super admin
 *  impersonating a student is out of scope. */
function buildSuperAdminApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("session", sessionFor(0));
    await next();
  });
  app.use("*", rolesMiddleware);
  app.get("/api/x", (c) => {
    const authContext = c.get("authContext") as AuthContext;
    return c.json({
      isSuperAdmin: authContext.isSuperAdmin,
      hasInstructor: authContext.hasRole("instructor"),
      isMemberOf: authContext.isMemberOf("course-nobody-has-ever-heard-of"),
      isInstructorOf: authContext.isInstructorOf("course-nobody-has-ever-heard-of"),
      isGraderOf: authContext.isGraderOf("course-nobody-has-ever-heard-of"),
      solutions: authContext.canViewSolutionsIn("course-nobody-has-ever-heard-of"),
      drafts: authContext.canViewDraftsIn("course-nobody-has-ever-heard-of"),
    });
  });
  return app;
}

describe("super admin bypass (#316)", () => {
  beforeEach(() => {
    MEMBERSHIPS = [];
  });

  it("grants full elevated access on a course held via zero real memberships", async () => {
    userRow = { isActive: true, sessionEpoch: 0, emailBlindIndex: superAdminBlindIndex, platformInstructorGrantedAt: null };
    const res = await buildSuperAdminApp().request("/api/x", {}, TEST_ENV);
    expect(await res.json()).toEqual({
      isSuperAdmin: true,
      hasInstructor: false,
      isMemberOf: true,
      isInstructorOf: true,
      isGraderOf: true,
      solutions: true,
      drafts: true,
    });
  });

  it("does not widen access for a non-super-admin with zero memberships", async () => {
    userRow = { isActive: true, sessionEpoch: 0, emailBlindIndex: nonAdminBlindIndex, platformInstructorGrantedAt: null };
    const res = await buildSuperAdminApp().request("/api/x", {}, TEST_ENV);
    expect(await res.json()).toEqual({
      isSuperAdmin: false,
      hasInstructor: false,
      isMemberOf: false,
      isInstructorOf: false,
      isGraderOf: false,
      solutions: false,
      drafts: false,
    });
  });
});

/** #316: platformInstructorGrantedAt is a fact about the resolved user row
 *  (not a blind-index check), and -- unlike isSuperAdmin -- deliberately
 *  does NOT widen any course-scoped predicate. It only flips a flag the
 *  client uses to admit someone past its console-wide gate. If this ever
 *  widened isInstructorOf the way isSuperAdmin does, every granted
 *  instructor would silently become a de facto super admin on every course
 *  in every org -- exactly the scope creep the design deliberately avoids. */
describe("platform instructor grant (#316)", () => {
  beforeEach(() => {
    MEMBERSHIPS = [];
  });

  it("does NOT widen course access for a platform instructor with zero real memberships", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("session", sessionFor(0));
      await next();
    });
    app.use("*", rolesMiddleware);
    app.get("/api/x", (c) => {
      const authContext = c.get("authContext") as AuthContext;
      return c.json({
        isSuperAdmin: authContext.isSuperAdmin,
        isPlatformInstructor: authContext.isPlatformInstructor,
        hasInstructor: authContext.hasRole("instructor"),
        isMemberOf: authContext.isMemberOf("course-nobody-has-ever-heard-of"),
        isInstructorOf: authContext.isInstructorOf("course-nobody-has-ever-heard-of"),
        isGraderOf: authContext.isGraderOf("course-nobody-has-ever-heard-of"),
        solutions: authContext.canViewSolutionsIn("course-nobody-has-ever-heard-of"),
        drafts: authContext.canViewDraftsIn("course-nobody-has-ever-heard-of"),
      });
    });

    userRow = {
      isActive: true,
      sessionEpoch: 0,
      emailBlindIndex: nonAdminBlindIndex,
      platformInstructorGrantedAt: new Date(),
    };
    const res = await app.request("/api/x", {}, TEST_ENV);
    expect(await res.json()).toEqual({
      isSuperAdmin: false,
      isPlatformInstructor: true,
      hasInstructor: false,
      isMemberOf: false,
      isInstructorOf: false,
      isGraderOf: false,
      solutions: false,
      drafts: false,
    });
  });

  it("is false when platformInstructorGrantedAt is null", async () => {
    userRow = { isActive: true, sessionEpoch: 0, emailBlindIndex: nonAdminBlindIndex, platformInstructorGrantedAt: null };
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("session", sessionFor(0));
      await next();
    });
    app.use("*", rolesMiddleware);
    app.get("/api/x", (c) =>
      c.json({ isPlatformInstructor: (c.get("authContext") as AuthContext).isPlatformInstructor }),
    );
    const res = await app.request("/api/x", {}, TEST_ENV);
    expect(await res.json()).toEqual({ isPlatformInstructor: false });
  });
});
