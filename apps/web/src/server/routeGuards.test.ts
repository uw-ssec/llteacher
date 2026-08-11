/* --------------------------------------------------------------------------
   Route-table guard assignment (#172 audit FUN-003, rewritten after the
   re-audit's FUN-100 / MNT-016).

   What this pins: which guard index.ts wraps each route in. Nothing else.
   Every handler is replaced by a spy that returns 200, so the ONLY thing
   that can produce a 403 here is a guard, and the only thing that can call a
   handler is a guard that admitted the request.

   Why it needs its own file and its own mocks:

   Two earlier attempts at this test were too weak, in the same way. The
   first asserted `not.toBe(403)`; a re-audit mutation run showed 9 of 11
   guard assignments could be reverted with the whole suite green. The second
   asserted the exact status per persona against the real handlers -- better,
   catching 4 more -- but four mutations still survived, because those
   routes' handlers each carry a defensive re-check that returns the SAME 403
   the guard would. Status alone cannot distinguish "the guard refused" from
   "the guard admitted and the handler refused", and it is precisely that
   distinction a guard test exists to make.

   Asserting the handler was never invoked is what closes it. It also means
   this file stops depending on incidental 503s from a thin db stub.

   The defensive re-checks stay, and stay valuable -- they are what makes
   each handler safe to call directly, as the per-route suites do. They just
   can't be the thing that proves the route table is right.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "hono";
import {
  SESSION_COOKIE_NAME,
  createSessionPayload,
  loadSessionKey,
  sealSession,
} from "../lib/session";

const SESSION_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

const ENV = {
  ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  WORKOS_API_KEY: "sk_test_x",
  WORKOS_CLIENT_ID: "client_x",
  SESSION_SECRET,
  DATABASE_URL: "ignored",
} as unknown as Env;

/** One spy per handler #172 touches. `ok` is what a guard admitting the
 *  request looks like; there is no path to 200 that does not go through a
 *  guard first. */
const ok = (name: string) => vi.fn((c: Context) => c.json({ handler: name }, 200));

const handlers = {
  listHomeworks: ok("listHomeworks"),
  createHomework: ok("createHomework"),
  getHomeworkDetail: ok("getHomeworkDetail"),
  updateHomework: ok("updateHomework"),
  deleteHomework: ok("deleteHomework"),
  publishHomework: ok("publishHomework"),
  updateHomeworkHide: ok("updateHomeworkHide"),
  getHomeworkSubmissions: ok("getHomeworkSubmissions"),
  getSectionAnswer: ok("getSectionAnswer"),
  listCourseTas: ok("listCourseTas"),
  updateTaCapabilities: ok("updateTaCapabilities"),
};

vi.mock("./routes/homeworks", () => ({
  listHomeworksHandler: (c: Context) => handlers.listHomeworks(c),
  createHomeworkHandler: (c: Context) => handlers.createHomework(c),
  getHomeworkDetailHandler: (c: Context) => handlers.getHomeworkDetail(c),
  updateHomeworkHandler: (c: Context) => handlers.updateHomework(c),
  deleteHomeworkHandler: (c: Context) => handlers.deleteHomework(c),
  publishHomeworkHandler: (c: Context) => handlers.publishHomework(c),
  updateHomeworkHideHandler: (c: Context) => handlers.updateHomeworkHide(c),
}));
vi.mock("./routes/submissions", () => ({
  getHomeworkSubmissionsHandler: (c: Context) => handlers.getHomeworkSubmissions(c),
  submitSectionHandler: (c: Context) => c.json({}, 200),
}));
vi.mock("./routes/sectionAnswers", () => ({
  getSectionAnswerHandler: (c: Context) => handlers.getSectionAnswer(c),
  submitSectionAnswerHandler: (c: Context) => c.json({}, 200),
}));
vi.mock("./routes/courseMemberships", () => ({
  listCourseTasHandler: (c: Context) => handlers.listCourseTas(c),
  updateTaCapabilitiesHandler: (c: Context) => handlers.updateTaCapabilities(c),
}));

const findMany = vi.fn();
const findFirst = vi.fn();
vi.mock("../db/client", () => ({
  makeDb: () => ({
    query: {
      courseMemberships: { findMany: (...args: unknown[]) => findMany(...args) },
      users: { findFirst: (...args: unknown[]) => findFirst(...args) },
    },
  }),
}));

// Imported after the mocks above are registered.
const { default: app } = await import("./index");

beforeEach(() => {
  findMany.mockReset();
  findFirst.mockReset().mockResolvedValue({ isActive: true, sessionEpoch: 0 });
  for (const spy of Object.values(handlers)) spy.mockClear();
});

const membership = (role: string, courseId = "course-a") => ({
  id: "m-1",
  userId: "u1",
  courseId,
  role,
  canViewSolutions: false,
  canViewDrafts: false,
});

const PERSONAS = {
  ta: [membership("ta")],
  student: [membership("student")],
  instructor: [membership("instructor")],
  admin: [membership("admin")],
  /** Only membership is in a DIFFERENT course -- proves each guard is
   *  course-scoped, not merely role-scoped. */
  "other-course-instructor": [membership("instructor", "course-z")],
} as const;

type Persona = keyof typeof PERSONAS;

const HW = "11111111-2222-4333-8444-555555555555";
const SEC = "11111111-2222-4333-8444-555555555556";
const STU = "11111111-2222-4333-8444-555555555557";

type HandlerName = keyof typeof handlers;

/** Every route #172 touches, with the exact set of personas its guard must
 *  admit. Written as "who gets in", so a widened guard fails on an
 *  unexpected admission and a narrowed one fails on a missing admission --
 *  both directions, for every route. */
const ROUTES: { method: string; path: string; handler: HandlerName; admits: Persona[] }[] = [
  // Any member of the course, students included. These two are the rows the
  // re-audit found silently revertible: narrowing either to requireGraderOf
  // locks every student out of their own homework list and detail.
  { method: "GET", path: "/api/courses/course-a/homeworks", handler: "listHomeworks",
    admits: ["ta", "student", "instructor", "admin"] },
  { method: "GET", path: `/api/courses/course-a/homeworks/${HW}`, handler: "getHomeworkDetail",
    admits: ["ta", "student", "instructor", "admin"] },

  // Grading reads: grader tier. A TA belongs here; a student does not.
  { method: "GET", path: `/api/courses/course-a/homeworks/${HW}/submissions`, handler: "getHomeworkSubmissions",
    admits: ["ta", "instructor", "admin"] },
  { method: "GET", path: `/api/courses/course-a/sections/${SEC}/answers/${STU}`, handler: "getSectionAnswer",
    admits: ["ta", "instructor", "admin"] },

  // Authoring: author tier only. A TA is a grader, not an author.
  { method: "POST", path: "/api/courses/course-a/homeworks", handler: "createHomework",
    admits: ["instructor", "admin"] },
  { method: "PATCH", path: `/api/courses/course-a/homeworks/${HW}`, handler: "updateHomework",
    admits: ["instructor", "admin"] },
  { method: "DELETE", path: `/api/courses/course-a/homeworks/${HW}`, handler: "deleteHomework",
    admits: ["instructor", "admin"] },
  { method: "PATCH", path: `/api/courses/course-a/homeworks/${HW}/publish`, handler: "publishHomework",
    admits: ["instructor", "admin"] },
  { method: "PATCH", path: `/api/courses/course-a/homeworks/${HW}/hide`, handler: "updateHomeworkHide",
    admits: ["instructor", "admin"] },

  // Granting is authoring-tier authority: a TA must not read the roster of
  // grants or widen one, their own included.
  { method: "GET", path: "/api/courses/course-a/tas", handler: "listCourseTas",
    admits: ["instructor", "admin"] },
  { method: "PATCH", path: `/api/courses/course-a/tas/${HW}/capabilities`, handler: "updateTaCapabilities",
    admits: ["instructor", "admin"] },
];

async function requestAs(persona: Persona, method: string, path: string) {
  findMany.mockResolvedValue(PERSONAS[persona]);
  const key = await loadSessionKey(ENV);
  const sealed = await sealSession(createSessionPayload("u1", "w1", 0), key);
  return app.request(path, { method, headers: { cookie: `${SESSION_COOKIE_NAME}=${sealed}` } }, ENV);
}

describe("route table guard assignment (#172)", () => {
  for (const route of ROUTES) {
    for (const persona of Object.keys(PERSONAS) as Persona[]) {
      const shouldAdmit = route.admits.includes(persona);
      it(`${route.method} ${route.path} ${shouldAdmit ? "admits" : "refuses"} ${persona}`, async () => {
        const res = await requestAs(persona, route.method, route.path);
        const spy = handlers[route.handler];
        if (shouldAdmit) {
          expect(res.status).toBe(200);
          expect(spy).toHaveBeenCalledTimes(1);
        } else {
          expect(res.status).toBe(403);
          // The assertion that actually pins the guard: a refused request
          // must not reach the handler at all. Without this, a widened guard
          // is invisible whenever the handler's own defensive re-check
          // returns the same 403.
          expect(spy).not.toHaveBeenCalled();
        }
      });
    }
  }

  /** #201 (#172 re-audit, MNT-031): these two used to derive a value from the
   *  ROUTES literal above and compare it to a hardcoded copy of that same
   *  literal -- no request issued, nothing awaited, so neither could fail for
   *  any reason except someone editing the fixture. They now drive the real
   *  route table and count what the guards actually did, which is the claim
   *  they were always meant to make. */
  it("admits a student to exactly two routes in the whole table", async () => {
    const admitted: string[] = [];
    for (const route of ROUTES) {
      const res = await requestAs("student", route.method, route.path);
      if (res.status === 200) admitted.push(`${route.method} ${route.path}`);
    }
    // A student reads homeworks. They touch nothing else here -- not the
    // submissions dashboard, not a peer's answer, not the grant roster.
    expect(admitted).toEqual([
      "GET /api/courses/course-a/homeworks",
      `GET /api/courses/course-a/homeworks/${HW}`,
    ]);
  });

  it("gives a TA exactly two routes more than a student, both grading reads", async () => {
    const reach = async (persona: Persona) => {
      const out: HandlerName[] = [];
      for (const route of ROUTES) {
        const res = await requestAs(persona, route.method, route.path);
        if (res.status === 200) out.push(route.handler);
      }
      return out;
    };
    const student = await reach("student");
    const ta = await reach("ta");

    // The TA's entire additional reach over a student, measured rather than
    // restated: the two grading reads, and no authoring or granting route.
    expect(ta.filter((h) => !student.includes(h))).toEqual([
      "getHomeworkSubmissions",
      "getSectionAnswer",
    ]);
  });
});
