import { describe, it, expect, vi } from "vitest";
import { Hono, type Context } from "hono";
import {
  requireRole,
  requireCourseMember,
  requireInstructorOf,
  requireGraderOf,
  releaseGatePostureOf,
} from "./guards";
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
    // The handler consults the gate, as its posture claims -- so the
    // admission tests below exercise the compliant path and the #208
    // suite at the bottom of this file owns the non-compliant one.
    requireGraderOf("gates-unreleased")(async (c) => {
      c.get("authContext")!.canViewDraftsIn(c.req.param("courseId")!);
      return c.json({ ok: true });
    }),
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

/* --------------------------------------------------------------------------
   #208: the release-gate pairing, at the guard level.

   requireGraderOf admits a TA; a TA holds no draft access unless granted.
   The check that enforces that lives in the route body, so the guard cannot
   perform it -- but it can observe whether the handler performed it, and say
   so when a route registered "gates-unreleased" answers successfully having
   never asked. That is what these pin.
   -------------------------------------------------------------------------- */
describe("requireGraderOf release-gate instrumentation (#208)", () => {
  function graderApp(
    posture: Parameters<typeof requireGraderOf>[0],
    handler: (c: Context<AppEnv>) => Response | Promise<Response>,
  ) {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set(
        "authContext",
        fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "ta" })] }),
      );
      await next();
    });
    app.get("/api/g/:courseId", requireGraderOf(posture)(handler));
    return app;
  }

  it("stamps the declared posture on the guarded handler", () => {
    const guarded = requireGraderOf("no-unreleased-content")(async (c) => c.json({}));
    expect(releaseGatePostureOf(guarded)).toBe("no-unreleased-content");
    expect(releaseGatePostureOf(async () => new Response())).toBeUndefined();
  });

  it("records the consultation and does not warn when the handler gates", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = graderApp("gates-unreleased", (c) => {
      c.get("authContext")!.canViewDraftsIn("course-a");
      return c.json({ ok: true });
    });
    expect((await app.request("/api/g/course-a")).status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("warns when a gates-unreleased route answers 2xx without consulting the gate", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = graderApp("gates-unreleased", (c) => c.json({ leaked: true }));
    // Still 200: this is a diagnostic, not a gate. Turning a working route
    // into a 503 on a suspicion would be the worse failure -- see the
    // comment on the check in guards.ts.
    expect((await app.request("/api/g/course-a")).status).toBe(200);
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0])).toContain("canViewDraftsIn");
    spy.mockRestore();
  });

  it("does not warn when the handler refuses before reaching the gate", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A 404/403 short-circuit legitimately returns without gating -- there
    // is nothing to withhold from a response that withheld everything.
    const app = graderApp("gates-unreleased", (c) => c.json({ error: "Not found" }, 404));
    expect((await app.request("/api/g/course-a")).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("leaves no-unreleased-content routes uninstrumented", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = graderApp("no-unreleased-content", (c) => c.json({ ok: true }));
    expect((await app.request("/api/g/course-a")).status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
