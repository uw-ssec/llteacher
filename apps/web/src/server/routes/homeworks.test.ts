import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import {
  listHomeworksHandler,
  createHomeworkHandler,
  getHomeworkDetailHandler,
  updateHomeworkHandler,
  deleteHomeworkHandler,
  publishHomeworkHandler,
  updateHomeworkHideHandler,
} from "./homeworks";
import { auditEvents } from "../../db/schema";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;

const findManyHomeworks = vi.fn();
const insertHomework = vi.fn();
const findFirstHomework = vi.fn();
const findManySections = vi.fn();
// #165: getHomeworkById now also fetches widgets -- defaults to empty so
// every existing test (none of which cares about widgets) is unaffected;
// tests that do care call .mockReset().mockResolvedValue([...]) themselves.
const findManyWidgets = vi.fn().mockResolvedValue([]);
// listHomeworksForCourse's section-count query (Task 23) is a plain
// `db.select({...}).from(sections).where(...).groupBy(...)` chain, not a
// db.query.*.findMany call -- faked separately from the two above.
const selectSectionCounts = vi.fn();
// publishHomeworkHandler's audit write (Task 24, #94/#147): mirrors
// profile.test.ts's convention -- db.insert(auditEvents, ...) is captured
// into auditInserts, and getOrgScopesForUser's selectDistinct chain is fed
// by dbOrgScopesForUser. Reset explicitly (assigned to `[]`) inside any test
// that asserts on them; other tests are unaffected by the default `[]`.
let auditInserts: Record<string, unknown>[] = [];
let auditInsertError: Error | null = null;
let dbOrgScopesForUser: string[] = [];
vi.mock("../../db/client", () => ({
  makeDb: () => ({
    query: {
      homeworks: {
        findMany: (...args: unknown[]) => findManyHomeworks(...args),
        findFirst: (...args: unknown[]) => findFirstHomework(...args),
      },
      sections: { findMany: (...args: unknown[]) => findManySections(...args) },
      homeworkProgressWidgets: { findMany: (...args: unknown[]) => findManyWidgets(...args) },
    },
    insert: (...args: unknown[]) => {
      const [table] = args;
      if (table === auditEvents) {
        return {
          values: (v: Record<string, unknown>) => {
            if (auditInsertError) throw auditInsertError;
            auditInserts.push(v);
            return { returning: async () => [{ id: "audit-1", ...v }] };
          },
        };
      }
      return insertHomework(...args);
    },
    select: (...args: unknown[]) => selectSectionCounts(...args),
    selectDistinct: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => dbOrgScopesForUser.map((organizationId) => ({ organizationId })),
        }),
      }),
    }),
  }),
}));

// updateHomeworkHandler's constraint-violation (422) and unresolvable-cycle
// paths originate deep inside updateHomework's transaction/batch logic
// (planSectionDiff + resolveSectionWrites) -- reaching them through the
// db-client mock above would mean simulating that whole internal call
// graph. Mocking the repository function directly instead lets each test
// drive updateHomework's return/throw contract in one line, while
// `importOriginal` keeps every other exported repository function (used by
// the handlers above) running against their real implementation over the
// already-mocked db client. homeworkHasStudentActivity (Task 24) is mocked
// the same way -- its real implementation is a select/innerJoin/where/limit
// chain, not worth faking through the db-client mock above.
const updateHomeworkMock = vi.fn();
const deleteHomeworkMock = vi.fn();
const publishHomeworkMock = vi.fn();
const hideHomeworkMock = vi.fn();
const homeworkHasStudentActivityMock = vi.fn();
vi.mock("../repositories/homeworks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/homeworks")>();
  return {
    ...actual,
    updateHomework: (...args: unknown[]) => updateHomeworkMock(...args),
    deleteHomework: (...args: unknown[]) => deleteHomeworkMock(...args),
    updateHomeworkPublishState: (...args: unknown[]) => publishHomeworkMock(...args),
    updateHomeworkHideState: (...args: unknown[]) => hideHomeworkMock(...args),
    homeworkHasStudentActivity: (...args: unknown[]) => homeworkHasStudentActivityMock(...args),
  };
});

// #161: getOrgScopeForCourse/llmConfigBelongsToOrg are real DB queries in
// production; mocked directly (same rationale as the homeworks repository
// mocks above) so PATCH tests drive the org-scope-check contract without
// simulating db.query.courses/db.select against the shared db-client mock.
// Defaults to "belongs" so every pre-existing llmConfigId test (written
// before #161) keeps passing unmodified; tests that need the rejection path
// override the return value explicitly.
// Pre-existing TS2556 fix (unrelated to #166/#164/#165): a zero-arg mock
// signature can't be called via `mock(...args)` where args is a plain
// unknown[] (not a tuple) -- TS can't verify the spread matches a fixed
// zero-arity function. The rest param below accepts and ignores whatever
// is spread in, same runtime behavior as before.
const getOrgScopeForCourseMock = vi.fn(async (..._args: unknown[]) => "org-a");
const llmConfigBelongsToOrgMock = vi.fn(async (..._args: unknown[]) => true);
vi.mock("../repositories/organizations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/organizations")>();
  return { ...actual, getOrgScopeForCourse: (...args: unknown[]) => getOrgScopeForCourseMock(...args) };
});
vi.mock("../repositories/llmConfigs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/llmConfigs")>();
  return { ...actual, llmConfigBelongsToOrg: (...args: unknown[]) => llmConfigBelongsToOrgMock(...args) };
});

// Derives hasRole/isMemberOf/isInstructorOf from `memberships` the same way
// rolesMiddleware does in production, so a test that sets `memberships` gets
// consistent predicates for free -- callers can still override any
// individual predicate to test a mismatch (e.g. isInstructorOf true but no
// matching membership row).
function fakeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  const memberships = overrides.memberships ?? [];
  return {
    session: { userId: "u1", workosUserId: "w1", sessionEpoch: 0, issuedAt: 0, expiresAt: 0 },
    memberships,
    hasRole: (role) => memberships.some((m) => m.role === role),
    isMemberOf: (courseId) => memberships.some((m) => m.courseId === courseId),
    isInstructorOf: (courseId) =>
      memberships.some((m) => m.courseId === courseId && (m.role === "instructor" || m.role === "admin")),
    ...overrides,
  };
}

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  app.get("/api/courses/:courseId/homeworks", (c) => listHomeworksHandler(c));
  app.post("/api/courses/:courseId/homeworks", (c) => createHomeworkHandler(c));
  app.get("/api/courses/:courseId/homeworks/:homeworkId", (c) => getHomeworkDetailHandler(c));
  app.patch("/api/courses/:courseId/homeworks/:homeworkId", (c) => updateHomeworkHandler(c));
  app.delete("/api/courses/:courseId/homeworks/:homeworkId", (c) => deleteHomeworkHandler(c));
  app.patch("/api/courses/:courseId/homeworks/:homeworkId/publish", (c) => publishHomeworkHandler(c));
  app.patch("/api/courses/:courseId/homeworks/:homeworkId/hide", (c) => updateHomeworkHideHandler(c));
  return app;
}

describe("GET /api/courses/:courseId/homeworks", () => {
  it("denies a non-member with 403", async () => {
    findManyHomeworks.mockReset();
    const res = await buildApp(fakeAuthContext()).request(
      "/api/courses/course-a/homeworks",
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(403);
    expect(findManyHomeworks).not.toHaveBeenCalled();
  });

  it("allows a course member and lists that course's homeworks", async () => {
    findManyHomeworks.mockReset().mockResolvedValue([
      {
        id: "hw1",
        title: "HW 1",
        description: "d",
        dueDate: new Date("2020-01-02"),
        llmConfigId: null,
        publishedAt: new Date("2020-01-01"),
        releasedAt: new Date("2020-01-01"),
        isHidden: false,
        expiresAt: null,
      },
    ]);
    selectSectionCounts.mockReset().mockReturnValue({
      from: () => ({ where: () => ({ groupBy: async () => [{ homeworkId: "hw1", count: 2 }] }) }),
    });
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { homeworks: { status: string; sectionCount: number }[] };
    expect(body.homeworks).toHaveLength(1);
    // Task 23: status is derived (deriveHomeworkStatus), not a raw DB column
    // -- the fixture's dueDate has already passed, so "past_due" here proves
    // it's not just echoing some raw `status` field that doesn't even exist
    // on the row.
    expect(body.homeworks[0].status).toBe("past_due");
    expect(body.homeworks[0].sectionCount).toBe(2);
  });

  it("denies access to a different course than the one the user is a member of (cross-course)", async () => {
    findManyHomeworks.mockReset();
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-b" }),
    ).request("/api/courses/course-a/homeworks", {}, TEST_ENV);
    expect(res.status).toBe(403);
  });

  // Finding 4 (Phase 7 final review): the list endpoint is guarded by
  // requireCourseMember() (any role) but never filtered draft/scheduled
  // homeworks out for non-instructors -- apps/web's student-facing
  // studentHomeworks.ts already does this filtering; this list endpoint
  // must match that policy.
  function mixedStatusHomeworks() {
    findManyHomeworks.mockReset().mockResolvedValue([
      // draft: publishedAt null
      {
        id: "hw-draft", title: "Draft HW", description: "d",
        dueDate: new Date("2099-01-02"), llmConfigId: null, publishedAt: null, releasedAt: null,
        isHidden: false, expiresAt: null,
      },
      // scheduled: releasedAt in the future
      {
        id: "hw-scheduled", title: "Scheduled HW", description: "d",
        dueDate: new Date("2099-01-02"), llmConfigId: null,
        publishedAt: new Date("2020-01-01"), releasedAt: new Date("2099-01-01"),
        isHidden: false, expiresAt: null,
      },
      // active: released in the past, due in the future
      {
        id: "hw-active", title: "Active HW", description: "d",
        dueDate: new Date("2099-01-02"), llmConfigId: null,
        publishedAt: new Date("2020-01-01"), releasedAt: new Date("2020-01-01"),
        isHidden: false, expiresAt: null,
      },
      // hidden: published+active, but is_hidden true (#166)
      {
        id: "hw-hidden", title: "Hidden HW", description: "d",
        dueDate: new Date("2099-01-02"), llmConfigId: null,
        publishedAt: new Date("2020-01-01"), releasedAt: new Date("2020-01-01"),
        isHidden: true, expiresAt: null,
      },
    ]);
    selectSectionCounts.mockReset().mockReturnValue({
      from: () => ({ where: () => ({ groupBy: async () => [] }) }),
    });
  }

  it("filters draft/scheduled/hidden homeworks out for a non-instructor (student)", async () => {
    mixedStatusHomeworks();
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: () => false }),
    ).request("/api/courses/course-a/homeworks", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { homeworks: { id: string }[] };
    expect(body.homeworks.map((h) => h.id)).toEqual(["hw-active"]);
  });

  it("returns every homework unfiltered for an instructor, including hidden", async () => {
    mixedStatusHomeworks();
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { homeworks: { id: string }[] };
    expect(body.homeworks.map((h) => h.id)).toEqual(["hw-draft", "hw-scheduled", "hw-active", "hw-hidden"]);
  });
});

describe("POST /api/courses/:courseId/homeworks", () => {
  it("denies a student with 403", async () => {
    insertHomework.mockReset();
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: () => false }),
    ).request(
      "/api/courses/course-a/homeworks",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New HW", description: "desc", dueDate: "2026-12-01" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
    expect(insertHomework).not.toHaveBeenCalled();
  });

  it("denies an instructor of a different course (cross-course) with 403", async () => {
    insertHomework.mockReset();
    const res = await buildApp(
      fakeAuthContext({ isInstructorOf: (id) => id === "course-b" }),
    ).request(
      "/api/courses/course-a/homeworks",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New HW", description: "desc", dueDate: "2026-12-01" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("allows the instructor of the course to create a homework", async () => {
    insertHomework.mockReset().mockReturnValue({
      values: () => ({ returning: async () => [{ id: "hw-new" }] }),
    });
    const membership = { id: "membership-1", userId: "u1", courseId: "course-a", role: "instructor" } as unknown as AuthContext["memberships"][number];
    const res = await buildApp(
      fakeAuthContext({
        isInstructorOf: (id) => id === "course-a",
        memberships: [membership],
      }),
    ).request(
      "/api/courses/course-a/homeworks",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New HW", description: "desc", dueDate: "2026-12-01" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("hw-new");
  });

  it("returns 400 when required fields are missing", async () => {
    const membership = { id: "membership-1", userId: "u1", courseId: "course-a", role: "instructor" } as unknown as AuthContext["memberships"][number];
    const res = await buildApp(
      fakeAuthContext({ isInstructorOf: (id) => id === "course-a", memberships: [membership] }),
    ).request(
      "/api/courses/course-a/homeworks",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 (not 503) for an unparseable dueDate", async () => {
    insertHomework.mockReset();
    const membership = { id: "membership-1", userId: "u1", courseId: "course-a", role: "instructor" } as unknown as AuthContext["memberships"][number];
    const res = await buildApp(
      fakeAuthContext({ isInstructorOf: (id) => id === "course-a", memberships: [membership] }),
    ).request(
      "/api/courses/course-a/homeworks",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New HW", description: "desc", dueDate: "banana" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(insertHomework).not.toHaveBeenCalled();
  });

  it("returns 400 (not 503) for a malformed JSON body", async () => {
    insertHomework.mockReset();
    const membership = { id: "membership-1", userId: "u1", courseId: "course-a", role: "instructor" } as unknown as AuthContext["memberships"][number];
    const res = await buildApp(
      fakeAuthContext({ isInstructorOf: (id) => id === "course-a", memberships: [membership] }),
    ).request(
      "/api/courses/course-a/homeworks",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(insertHomework).not.toHaveBeenCalled();
  });

  it("returns 403 (not an unguarded throw) when authContext is missing -- guard-composition regression coverage", async () => {
    insertHomework.mockReset();
    const res = await buildApp(undefined).request(
      "/api/courses/course-a/homeworks",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New HW", description: "desc", dueDate: "2026-12-01" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
    expect(insertHomework).not.toHaveBeenCalled();
  });
});

describe("GET /api/courses/:courseId/homeworks/:homeworkId", () => {
  it("denies a non-member with 403", async () => {
    const res = await buildApp(fakeAuthContext()).request(
      "/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when the homework isn't found in this course scope", async () => {
    findFirstHomework.mockReset().mockResolvedValue(undefined);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("returns sections + status for a course member (student payload has no editableBy)", async () => {
    findFirstHomework.mockReset().mockResolvedValue({
      // dueDate is deliberately in the past (not 2099) -- deriveHomeworkStatus
      // (Task 3) returns "past_due" only when dueDate has already passed;
      // publishedAt/releasedAt in the past alone would otherwise yield "active".
      id: "hw-1", courseId: "course-a", title: "HW1", description: "d",
      dueDate: new Date("2020-01-02"), llmConfigId: null, publishedAt: new Date("2020-01-01"), releasedAt: new Date("2020-01-01"),
      isHidden: false, expiresAt: null,
    });
    findManySections.mockReset().mockResolvedValue([
      { id: "s1", title: "Sec 1", content: "c1", order: 1, solution: null, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: () => false }),
    ).request("/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { editableBy?: boolean; status: string; sections: unknown[] };
    expect(body.editableBy).toBeUndefined();
    expect(body.status).toBe("past_due");
    expect(body.sections).toHaveLength(1);
  });

  it("sets editableBy=true for an instructor of the course", async () => {
    findFirstHomework.mockReset().mockResolvedValue({
      id: "hw-1", courseId: "course-a", title: "HW1", description: "d",
      dueDate: new Date("2099-01-01"), llmConfigId: null, publishedAt: null, releasedAt: null,
      isHidden: false, expiresAt: null,
    });
    findManySections.mockReset().mockResolvedValue([]);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV);
    const body = (await res.json()) as { editableBy?: boolean };
    expect(body.editableBy).toBe(true);
  });

  // #155: solution content must never reach a non-instructor caller.
  it("nulls out a section's solution for a student member, even when a solution row exists", async () => {
    findFirstHomework.mockReset().mockResolvedValue({
      id: "hw-1", courseId: "course-a", title: "HW1", description: "d",
      dueDate: new Date("2020-01-02"), llmConfigId: null, publishedAt: new Date("2020-01-01"), releasedAt: new Date("2020-01-01"),
      isHidden: false, expiresAt: null,
    });
    findManySections.mockReset().mockResolvedValue([
      { id: "s1", title: "Sec 1", content: "c1", order: 1, solution: { id: "sol-1", content: "the answer is 42" }, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: () => false }),
    ).request("/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sections: Array<{ solution: unknown }> };
    expect(body.sections[0]!.solution).toBeNull();
  });

  it("still returns the full solution content for an instructor", async () => {
    findFirstHomework.mockReset().mockResolvedValue({
      id: "hw-1", courseId: "course-a", title: "HW1", description: "d",
      dueDate: new Date("2020-01-02"), llmConfigId: null, publishedAt: new Date("2020-01-01"), releasedAt: new Date("2020-01-01"),
      isHidden: false, expiresAt: null,
    });
    findManySections.mockReset().mockResolvedValue([
      { id: "s1", title: "Sec 1", content: "c1", order: 1, solution: { id: "sol-1", content: "the answer is 42" }, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sections: Array<{ solution: { content: string } | null }> };
    expect(body.sections[0]!.solution).toEqual({ id: "sol-1", content: "the answer is 42" });
  });

  // #156: draft/scheduled homeworks must 404 (not 403, so a guessed UUID
  // can't be confirmed real) for anyone who isn't an instructor.
  it("404s a student member for a draft homework (publishedAt null)", async () => {
    findFirstHomework.mockReset().mockResolvedValue({
      id: "hw-1", courseId: "course-a", title: "HW1", description: "d",
      dueDate: new Date("2099-01-01"), llmConfigId: null, publishedAt: null, releasedAt: null,
      isHidden: false, expiresAt: null,
    });
    findManySections.mockReset().mockResolvedValue([]);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: () => false }),
    ).request("/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("404s a student member for a scheduled homework (releasedAt in the future)", async () => {
    findFirstHomework.mockReset().mockResolvedValue({
      id: "hw-1", courseId: "course-a", title: "HW1", description: "d",
      dueDate: new Date("2099-01-01"), llmConfigId: null, publishedAt: new Date("2020-01-01"), releasedAt: new Date("2099-01-01"),
      isHidden: false, expiresAt: null,
    });
    findManySections.mockReset().mockResolvedValue([]);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: () => false }),
    ).request("/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV);
    expect(res.status).toBe(404);
  });

  // #166: hidden is the same 404-not-403 gate as draft/scheduled for a
  // non-instructor, even though the homework is otherwise published+active.
  it("404s a student member for a hidden homework", async () => {
    findFirstHomework.mockReset().mockResolvedValue({
      id: "hw-1", courseId: "course-a", title: "HW1", description: "d",
      dueDate: new Date("2099-01-01"), llmConfigId: null, publishedAt: new Date("2020-01-01"), releasedAt: new Date("2020-01-01"),
      isHidden: true, expiresAt: null,
    });
    findManySections.mockReset().mockResolvedValue([]);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: () => false }),
    ).request("/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("still returns a hidden homework normally for an instructor", async () => {
    findFirstHomework.mockReset().mockResolvedValue({
      id: "hw-1", courseId: "course-a", title: "HW1", description: "d",
      dueDate: new Date("2099-01-01"), llmConfigId: null, publishedAt: new Date("2020-01-01"), releasedAt: new Date("2020-01-01"),
      isHidden: true, expiresAt: null,
    });
    findManySections.mockReset().mockResolvedValue([]);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("hidden");
  });

  it("still returns a draft homework normally for an instructor", async () => {
    findFirstHomework.mockReset().mockResolvedValue({
      id: "hw-1", courseId: "course-a", title: "HW1", description: "d",
      dueDate: new Date("2099-01-01"), llmConfigId: null, publishedAt: null, releasedAt: null,
      isHidden: false, expiresAt: null,
    });
    findManySections.mockReset().mockResolvedValue([]);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("draft");
  });

  it("still returns a scheduled homework normally for an instructor", async () => {
    findFirstHomework.mockReset().mockResolvedValue({
      id: "hw-1", courseId: "course-a", title: "HW1", description: "d",
      dueDate: new Date("2099-01-01"), llmConfigId: null, publishedAt: new Date("2020-01-01"), releasedAt: new Date("2099-01-01"),
      isHidden: false, expiresAt: null,
    });
    findManySections.mockReset().mockResolvedValue([]);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("scheduled");
  });
});

describe("PATCH /api/courses/:courseId/homeworks/:homeworkId", () => {
  it("denies a non-instructor with 403", async () => {
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: () => false }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sections: [] }),
    }, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("returns 404 when updateHomework resolves null (not found in scope)", async () => {
    updateHomeworkMock.mockReset().mockResolvedValue(null);
    const res = await buildApp(
      // isMemberOf must also hold, matching createHomeworkHandler's tests
      // above -- courseScopeFromAuthContext (used by both handlers) mints a
      // scope from isMemberOf, not isInstructorOf; in production a course
      // membership row is what backs both predicates, but the fakeAuthContext
      // test double lets them diverge, so each override must be set explicitly.
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    }, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("returns 422 with a friendly message when the diff violates the order constraint", async () => {
    updateHomeworkMock.mockReset().mockRejectedValue(new Error("duplicate order 1 in incoming sections"));
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sections: [{ title: "A", content: "a", order: 1 }, { title: "B", content: "b", order: 1 }] }),
    }, TEST_ENV);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/order/i);
  });

  it("applies a valid update and returns 200", async () => {
    updateHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1" });
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Updated" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
  });

  // C1: an uncontrolled <select> (apps/admin's HomeworkForm) always sends a
  // string, never `undefined`, for its "(course/org default)" option -- that
  // arrives here as `""`. Without normalization this reaches updateHomework's
  // `!== undefined` guard and Postgres throws on `UPDATE ... SET
  // llm_config_id = ''` against a uuid column, which becomes a generic 503.
  it("normalizes llmConfigId: '' to null and returns 200 (not 503)", async () => {
    updateHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", llmConfigId: null });
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ llmConfigId: "" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { llmConfigId: string | null };
    expect(body.llmConfigId).toBeNull();
    expect(updateHomeworkMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "hw-1",
      expect.objectContaining({ llmConfigId: null }),
    );
  });

  it("rejects a non-UUID llmConfigId with 400", async () => {
    updateHomeworkMock.mockReset();
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ llmConfigId: "not-a-uuid" }),
    }, TEST_ENV);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/uuid/i);
    expect(updateHomeworkMock).not.toHaveBeenCalled();
  });

  it("still applies a valid UUID llmConfigId that belongs to the course's org (regression check)", async () => {
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";
    updateHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", llmConfigId: validUuid });
    llmConfigBelongsToOrgMock.mockClear().mockResolvedValue(true);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ llmConfigId: validUuid }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    expect(updateHomeworkMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "hw-1",
      expect.objectContaining({ llmConfigId: validUuid }),
    );
  });

  // #161: the FK on homeworks.llm_config_id only requires the row to exist
  // somewhere, not that it belongs to this course's tenant.
  it("rejects a well-formed llmConfigId that belongs to a different org with 400", async () => {
    const otherOrgUuid = "123e4567-e89b-12d3-a456-426614174000";
    updateHomeworkMock.mockReset();
    llmConfigBelongsToOrgMock.mockClear().mockResolvedValue(false);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ llmConfigId: otherOrgUuid }),
    }, TEST_ENV);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/organization/i);
    expect(updateHomeworkMock).not.toHaveBeenCalled();
  });

  it("skips the org-scope check entirely when llmConfigId is not present in the request", async () => {
    updateHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1" });
    llmConfigBelongsToOrgMock.mockClear();
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Updated" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    expect(llmConfigBelongsToOrgMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/courses/:courseId/homeworks/:homeworkId", () => {
  it("denies a non-instructor with 403", async () => {
    const res = await buildApp(
      fakeAuthContext({ isInstructorOf: () => false }),
    ).request("/api/courses/course-a/homeworks/hw-1", { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("returns 404 when not found in scope", async () => {
    deleteHomeworkMock.mockReset().mockResolvedValue(null);
    const res = await buildApp(
      // isMemberOf must also be true -- courseScopeFromAuthContext requires
      // it independent of isInstructorOf (same gap found and fixed in Tasks
      // 5/6's test fixtures; fixed proactively here before dispatch).
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("deletes and returns 204", async () => {
    deleteHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1" });
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(204);
  });
});

describe("PATCH /api/courses/:courseId/homeworks/:homeworkId/publish", () => {
  it("denies a non-instructor with 403", async () => {
    const res = await buildApp(fakeAuthContext({ isInstructorOf: () => false })).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publish: true }) },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("rejects a past releasedAt with 400", async () => {
    const res = await buildApp(fakeAuthContext({ isInstructorOf: (id) => id === "course-a" })).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ publish: true, releasedAt: "2020-01-01T00:00:00Z" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("publishes immediately when releasedAt is omitted", async () => {
    publishHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", publishedAt: new Date(), releasedAt: new Date() });
    // isMemberOf required alongside isInstructorOf -- this test reaches
    // courseScopeFromAuthContext (the 400/past-releasedAt test above does
    // not, since that check runs before scope minting). Same gap found in
    // Tasks 5/6/7; fixed proactively here before dispatch.
    const res = await buildApp(fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" })).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publish: true }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
  });

  it("un-publishes (draft) when publish=false", async () => {
    // publishedAt: null -- not currently published, so Task 24's
    // unpublish-with-activity gate (which only fires for a *currently
    // published* homework) never engages here.
    findFirstHomework.mockReset().mockResolvedValue({
      id: "hw-1", courseId: "course-a", title: "t", description: "d",
      dueDate: new Date("2099-01-01"), llmConfigId: null, publishedAt: null, releasedAt: null,
      isHidden: false, expiresAt: null,
    });
    findManySections.mockReset().mockResolvedValue([]);
    publishHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", publishedAt: null, releasedAt: null });
    const res = await buildApp(fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" })).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publish: false }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
  });

  // Finding 1 (Phase 7 final review): an uncontrolled <input
  // type="datetime-local"> in apps/admin's HomeworkForm sends "" for an
  // untouched releasedAt field, never undefined -- this "" must not reach
  // `new Date("")` (Invalid Date) and 400 an unpublish. releasedAt is also
  // irrelevant to unpublish entirely (updateHomeworkPublishState ignores it
  // whenever publish is false), so a re-sent past releasedAt must not 400
  // either.
  it("unpublishes a never-released homework when releasedAt is '' (not undefined)", async () => {
    findFirstHomework.mockReset().mockResolvedValue({
      id: "hw-1", courseId: "course-a", title: "t", description: "d",
      dueDate: new Date("2099-01-01"), llmConfigId: null, publishedAt: null, releasedAt: null,
      isHidden: false, expiresAt: null,
    });
    findManySections.mockReset().mockResolvedValue([]);
    publishHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", publishedAt: null, releasedAt: null });
    const res = await buildApp(fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" })).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publish: false, releasedAt: "" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
  });

  it("unpublishes an already-released homework when re-sending its own unchanged past releasedAt", async () => {
    findFirstHomework.mockReset().mockResolvedValue({
      id: "hw-1", courseId: "course-a", title: "t", description: "d",
      dueDate: new Date("2099-01-01"), llmConfigId: null,
      publishedAt: new Date("2020-01-01"), releasedAt: new Date("2020-01-01"),
      isHidden: false, expiresAt: null,
    });
    findManySections.mockReset().mockResolvedValue([]);
    homeworkHasStudentActivityMock.mockReset().mockResolvedValue(false);
    publishHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", publishedAt: null, releasedAt: null });
    const res = await buildApp(fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" })).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ publish: false, releasedAt: "2020-01-01T00:00:00.000Z" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
  });

  it("publishes immediately when releasedAt is '' (leave-at-default), same as omitted", async () => {
    publishHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", publishedAt: new Date(), releasedAt: new Date() });
    const res = await buildApp(fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" })).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publish: true, releasedAt: "" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
  });

  // Task 24 (#94): unpublish-with-activity confirmation gate.
  function mockCurrentlyPublishedHomework() {
    findFirstHomework.mockReset().mockResolvedValue({
      id: "hw-1", courseId: "course-a", title: "t", description: "d",
      dueDate: new Date("2099-01-01"), llmConfigId: null,
      publishedAt: new Date("2020-01-01"), releasedAt: new Date("2020-01-01"),
      isHidden: false, expiresAt: null,
    });
    findManySections.mockReset().mockResolvedValue([]);
  }

  it("returns 409 with hasStudentActivity when unpublishing a currently-published homework with existing activity, without confirm", async () => {
    mockCurrentlyPublishedHomework();
    homeworkHasStudentActivityMock.mockReset().mockResolvedValue(true);
    publishHomeworkMock.mockReset();

    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publish: false }) },
      TEST_ENV,
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { hasStudentActivity: boolean };
    expect(body.hasStudentActivity).toBe(true);
    expect(publishHomeworkMock).not.toHaveBeenCalled();
  });

  it("unpublishes a currently-published homework with existing activity when confirm: true", async () => {
    mockCurrentlyPublishedHomework();
    homeworkHasStudentActivityMock.mockReset().mockResolvedValue(true);
    publishHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", publishedAt: null, releasedAt: null });

    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ publish: false, confirm: true }),
      },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { hadExistingActivity?: boolean };
    expect(body.hadExistingActivity).toBe(true);
    expect(publishHomeworkMock).toHaveBeenCalledOnce();
  });

  it("unpublishes a currently-published homework with zero activity without needing confirm", async () => {
    mockCurrentlyPublishedHomework();
    homeworkHasStudentActivityMock.mockReset().mockResolvedValue(false);
    publishHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", publishedAt: null, releasedAt: null });

    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publish: false }) },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    expect(publishHomeworkMock).toHaveBeenCalledOnce();
  });

  it("publishing (publish: true) never triggers the activity check, even with existing activity", async () => {
    homeworkHasStudentActivityMock.mockReset().mockResolvedValue(true);
    publishHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", publishedAt: new Date(), releasedAt: new Date() });

    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publish: true }) },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    expect(homeworkHasStudentActivityMock).not.toHaveBeenCalled();
  });

  // Task 24 (#94, #147): publish/unpublish transitions are audited.
  it("audits homework.unpublished exactly once on a successful unpublish", async () => {
    mockCurrentlyPublishedHomework();
    homeworkHasStudentActivityMock.mockReset().mockResolvedValue(false);
    publishHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", publishedAt: null, releasedAt: null });
    dbOrgScopesForUser = ["org-a"];
    auditInserts = [];

    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publish: false }) },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({
      actorUserId: "u1", action: "homework.unpublished", targetType: "homework", targetId: "hw-1",
    });
  });

  it("audits homework.published exactly once on a successful publish", async () => {
    publishHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", publishedAt: new Date(), releasedAt: new Date() });
    dbOrgScopesForUser = ["org-a"];
    auditInserts = [];

    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publish: true }) },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({
      actorUserId: "u1", action: "homework.published", targetType: "homework", targetId: "hw-1",
    });
  });
});

// #166
describe("PATCH /api/courses/:courseId/homeworks/:homeworkId/hide", () => {
  it("denies a non-instructor with 403", async () => {
    const res = await buildApp(fakeAuthContext({ isInstructorOf: () => false })).request(
      "/api/courses/course-a/homeworks/hw-1/hide",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isHidden: true }) },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when isHidden is missing/non-boolean", async () => {
    const res = await buildApp(fakeAuthContext({ isInstructorOf: (id) => id === "course-a" })).request(
      "/api/courses/course-a/homeworks/hw-1/hide",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid expiresAt", async () => {
    const res = await buildApp(fakeAuthContext({ isInstructorOf: (id) => id === "course-a" })).request(
      "/api/courses/course-a/homeworks/hw-1/hide",
      {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ isHidden: false, expiresAt: "banana" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("hides a homework and audits homework.hidden exactly once", async () => {
    hideHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", isHidden: true, expiresAt: null });
    dbOrgScopesForUser = ["org-a"];
    auditInserts = [];

    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request(
      "/api/courses/course-a/homeworks/hw-1/hide",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isHidden: true }) },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { isHidden: boolean; expiresAt: string | null };
    expect(body).toEqual({ id: "hw-1", isHidden: true, expiresAt: null });
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({
      actorUserId: "u1", action: "homework.hidden", targetType: "homework", targetId: "hw-1",
    });
  });

  it("unhides a homework and audits homework.unhidden exactly once", async () => {
    hideHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", isHidden: false, expiresAt: null });
    dbOrgScopesForUser = ["org-a"];
    auditInserts = [];

    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request(
      "/api/courses/course-a/homeworks/hw-1/hide",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isHidden: false }) },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    expect(auditInserts[0]).toMatchObject({ action: "homework.unhidden" });
  });

  it("returns 404 when the homework isn't found in this course scope", async () => {
    hideHomeworkMock.mockReset().mockResolvedValue(null);
    const res = await buildApp(fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" })).request(
      "/api/courses/course-a/homeworks/hw-1/hide",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isHidden: true }) },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("treats expiresAt: '' the same as null (explicit clear)", async () => {
    hideHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", isHidden: false, expiresAt: null });
    const res = await buildApp(fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" })).request(
      "/api/courses/course-a/homeworks/hw-1/hide",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isHidden: false, expiresAt: "" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    expect(hideHomeworkMock).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), "hw-1", { isHidden: false, expiresAt: null },
    );
  });
});
