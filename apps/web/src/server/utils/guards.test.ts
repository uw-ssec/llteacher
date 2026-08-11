import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requireRole, requireCourseMember, requireInstructorOf, requireGraderOf } from "./guards";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";


function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  app.get(
    "/api/instructor-only/:courseId",
    requireInstructorOf()(async (c) => c.json({ ok: true })),
  );
  app.get(
    "/api/member-only/:courseId",
    requireCourseMember()(async (c) => c.json({ ok: true })),
  );
  app.get(
    "/api/role-only",
    requireRole(["instructor", "admin"])(async (c) => c.json({ ok: true })),
  );
  app.get(
    "/api/grader-only/:courseId",
    requireGraderOf()(async (c) => c.json({ ok: true })),
  );
  return app;
}

/** #172: requireGraderOf is strictly wider than requireInstructorOf --
 *  it admits `ta`. The pairs below assert both halves of that: the same
 *  membership that passes the grading guard must still fail the authoring
 *  one, which is the whole point of splitting them. */
describe("requireGraderOf", () => {
  it("allows a TA of the course", async () => {
    const app = buildApp(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "ta" })] }),
    );
    expect((await app.request("/api/grader-only/course-a")).status).toBe(200);
  });

  it("still denies that same TA the instructor-only route", async () => {
    const app = buildApp(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "ta" })] }),
    );
    expect((await app.request("/api/instructor-only/course-a")).status).toBe(403);
  });

  it("allows an instructor and an admin", async () => {
    for (const role of ["instructor", "admin"] as const) {
      const app = buildApp(
        fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role })] }),
      );
      expect((await app.request("/api/grader-only/course-a")).status).toBe(200);
    }
  });

  it("denies a student and an observer", async () => {
    for (const role of ["student", "observer"] as const) {
      const app = buildApp(
        fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role })] }),
      );
      expect((await app.request("/api/grader-only/course-a")).status).toBe(403);
    }
  });

  it("denies cross-course access -- a TA of course-b cannot grade course-a", async () => {
    const app = buildApp(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-b", role: "ta" })] }),
    );
    expect((await app.request("/api/grader-only/course-a")).status).toBe(403);
  });

  it("denies when there is no authContext at all", async () => {
    expect((await buildApp(undefined).request("/api/grader-only/course-a")).status).toBe(403);
  });
});

describe("requireInstructorOf", () => {
  it("allows an instructor of the course", async () => {
    const app = buildApp(fakeAuthContext({ isInstructorOf: (id) => id === "course-a" }));
    const res = await app.request("/api/instructor-only/course-a");
    expect(res.status).toBe(200);
  });

  it("denies a student", async () => {
    const app = buildApp(fakeAuthContext());
    const res = await app.request("/api/instructor-only/course-a");
    expect(res.status).toBe(403);
  });

  it("denies cross-course access", async () => {
    const app = buildApp(fakeAuthContext({ isInstructorOf: (id) => id === "course-b" }));
    const res = await app.request("/api/instructor-only/course-a");
    expect(res.status).toBe(403);
  });

  it("denies when there is no authContext at all", async () => {
    const app = buildApp(undefined);
    const res = await app.request("/api/instructor-only/course-a");
    expect(res.status).toBe(403);
  });
});

describe("requireCourseMember", () => {
  it("allows a member of the course", async () => {
    const app = buildApp(fakeAuthContext({ isMemberOf: (id) => id === "course-a" }));
    const res = await app.request("/api/member-only/course-a");
    expect(res.status).toBe(200);
  });

  it("denies a non-member", async () => {
    const app = buildApp(fakeAuthContext());
    const res = await app.request("/api/member-only/course-a");
    expect(res.status).toBe(403);
  });
});

describe("requireRole", () => {
  it("allows any of the listed roles", async () => {
    const app = buildApp(fakeAuthContext({ hasRole: (r) => r === "admin" }));
    const res = await app.request("/api/role-only");
    expect(res.status).toBe(200);
  });

  it("denies when none of the listed roles match", async () => {
    const app = buildApp(fakeAuthContext());
    const res = await app.request("/api/role-only");
    expect(res.status).toBe(403);
  });
});
