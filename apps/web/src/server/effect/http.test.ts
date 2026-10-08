import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { Context, Effect } from "effect";
import type { AppEnv } from "../context";
import {
  IdempotencyKeyConflictError,
  PromptTemplateConflictError,
  TenancyMismatchError,
} from "../repositories/errors";
import { SectionNotFoundError } from "../repositories/sectionConversations";
import { SERVICE_UNAVAILABLE_MESSAGE } from "../utils/errors";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";
import {
  BadRequest,
  classifyDatabaseFailure,
  Conflict,
  DatabaseError,
  ExternalServiceError,
  Forbidden,
  NotFound,
  Unauthorized,
} from "./errors";
import { effectHandler, requireAuthContext, requireCourseAccess, type HttpError } from "./http";
import { Database, external, query } from "./services";

const fakeDb = { marker: "db" };
vi.mock("../../db/client", () => ({ makeDb: () => fakeDb }));

const ENV = { DATABASE_URL: "postgres://unused" } as Env;

function appFor(handler: ReturnType<typeof effectHandler>, authContext?: AppEnv["Variables"]["authContext"]) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  app.get("/api/courses/:courseId/thing", handler);
  return app;
}

async function respond(error: HttpError) {
  const res = await appFor(effectHandler(() => Effect.fail(error))).request("/api/courses/c1/thing", {}, ENV);
  return { status: res.status, body: await res.json() };
}

describe("errorResponse: one status per typed failure", () => {
  it.each([
    [new Unauthorized(), 401, { error: "Unauthorized" }],
    [new Forbidden({ message: "Course access denied" }), 403, { error: "Course access denied" }],
    [new BadRequest({ message: "limit must be an integer" }), 400, { error: "limit must be an integer" }],
    [new NotFound({ message: "Conversation not found" }), 404, { error: "Conversation not found" }],
    [new Conflict({ message: "Already exists" }), 409, { error: "Already exists" }],
    [new Conflict({ message: "Busy", code: "in_progress" }), 409, { error: "Busy", code: "in_progress" }],
    [new TenancyMismatchError("owner not in scope"), 404, { error: "Not found" }],
    [new IdempotencyKeyConflictError("reused id"), 409, { error: "reused id", code: "duplicate_message" }],
    [new PromptTemplateConflictError("lost race"), 409, { error: "lost race" }],
  ] as const)("%s", async (error, status, body) => {
    expect(await respond(error)).toEqual({ status, body });
  });

  it("answers dependency failures with the generic 503 and logs the classified cause", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cause = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" });

    const db = await respond(new DatabaseError({ operation: "listThings", reason: "unavailable", cause }));
    expect(db).toEqual({ status: 503, body: { error: SERVICE_UNAVAILABLE_MESSAGE } });
    expect(JSON.stringify(db.body)).not.toContain("10.0.0.1");
    const dbLine = JSON.parse(log.mock.calls[0]![0] as string);
    expect(dbLine).toMatchObject({
      level: "error",
      tag: "DatabaseError",
      operation: "listThings",
      reason: "unavailable",
      message: "connect ECONNREFUSED 10.0.0.1:5432",
    });

    const ext = await respond(new ExternalServiceError({ service: "workos", operation: "authenticate", cause: new Error("boom") }));
    expect(ext.status).toBe(503);
    expect(JSON.parse(log.mock.calls[1]![0] as string)).toMatchObject({ tag: "ExternalServiceError", service: "workos" });
  });

  it("does not log request outcomes: they are the response", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await respond(new NotFound({ message: "x" }));
    expect(log).not.toHaveBeenCalled();
  });
});

describe("effectHandler", () => {
  it("returns the handler's Response on success", async () => {
    const res = await appFor(effectHandler((c) => Effect.succeed(c.json({ ok: true })))).request("/api/courses/c1/thing", {}, ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("answers a defect (a thrown bug) with 503 and logs it as a Defect", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = effectHandler(() => Effect.sync(() => {
      throw new TypeError("cannot read properties of undefined");
    }));
    const res = await appFor(handler).request("/api/courses/c1/thing", {}, ENV);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: SERVICE_UNAVAILABLE_MESSAGE });
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ tag: "Defect", message: "cannot read properties of undefined" });
  });

  it("provides the Database service built from the request's bindings", async () => {
    const handler = effectHandler((c) => Effect.gen(function* () {
      const db = yield* Database;
      return c.json({ same: db === (fakeDb as unknown) });
    }));
    const res = await appFor(handler).request("/api/courses/c1/thing", {}, ENV);
    expect(await res.json()).toEqual({ same: true });
  });
});

describe("query: declared refusals stay typed, everything else is a DatabaseError", () => {
  const run = <A, E>(effect: Effect.Effect<A, E, Database>) =>
    Effect.runPromise(Effect.flip(effect).pipe(Effect.provideService(Database, fakeDb as never)));

  it("keeps a declared refusal as itself", async () => {
    const refusal = new SectionNotFoundError();
    const error = await run(query("start", () => Promise.reject(refusal), [SectionNotFoundError]));
    expect(error).toBe(refusal);
    expect(error._tag).toBe("SectionNotFoundError");
  });

  it("turns an undeclared rejection into a DatabaseError with its reason", async () => {
    const unique = Object.assign(new Error("duplicate key"), { code: "23505" });
    const error = await run(query("insert", () => Promise.reject(unique), [SectionNotFoundError]));
    expect(error).toMatchObject({ _tag: "DatabaseError", operation: "insert", reason: "constraint", cause: unique });
  });

  it("passes the provided Database to the repository call", async () => {
    const seen = await Effect.runPromise(
      query("read", (db) => Promise.resolve(db)).pipe(Effect.provideService(Database, fakeDb as never)),
    );
    expect(seen).toBe(fakeDb);
  });
});

describe("external", () => {
  it("names the failing service", async () => {
    const error = await Effect.runPromise(Effect.flip(external("canvas", "listCourses", () => Promise.reject(new Error("502")))));
    expect(error).toMatchObject({ _tag: "ExternalServiceError", service: "canvas", operation: "listCourses" });
  });
});

describe("classifyDatabaseFailure", () => {
  it.each([
    [{ code: "ECONNREFUSED" }, "unavailable"],
    [{ code: "08006" }, "unavailable"],
    [{ code: "57P01" }, "unavailable"],
    [{ code: "53300" }, "unavailable"],
    [new Error("Connection terminated unexpectedly"), "unavailable"],
    [{ code: "23505" }, "constraint"],
    [{ code: "23503" }, "constraint"],
    [{ code: "42P01" }, "query"],
    ["not an object", "query"],
  ] as const)("%o -> %s", (cause, reason) => {
    expect(classifyDatabaseFailure(cause)).toBe(reason);
  });
});

describe("guards", () => {
  const member = fakeAuthContext({ memberships: [fakeMembership({ courseId: "c1", role: "student" })] });

  it("requireCourseAccess admits a member of the course in the path", async () => {
    const handler = effectHandler((c) => Effect.map(requireCourseAccess(c), ({ courseId, scope }) => c.json({ courseId, scoped: Boolean(scope) })));
    const res = await appFor(handler, member).request("/api/courses/c1/thing", {}, ENV);
    expect(await res.json()).toEqual({ courseId: "c1", scoped: true });
  });

  it("requireCourseAccess answers a non-member and a missing session with the same 403", async () => {
    const handler = effectHandler((c) => Effect.map(requireCourseAccess(c), () => c.json({})));
    const outsider = fakeAuthContext({ memberships: [fakeMembership({ courseId: "c2", role: "student" })] });
    for (const auth of [outsider, undefined]) {
      const res = await appFor(handler, auth).request("/api/courses/c1/thing", {}, ENV);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Course access denied" });
    }
  });

  it("requireAuthContext fails closed with 401", async () => {
    const handler = effectHandler((c) => Effect.map(requireAuthContext(c), () => c.json({})));
    const res = await appFor(handler).request("/api/courses/c1/thing", {}, ENV);
    expect(res.status).toBe(401);
  });
});

// Compile-time guarantees. `tsc -b` checks this file; each @ts-expect-error
// fails the build if the line below it ever starts compiling.
describe("type-level contract", () => {
  it("rejects a handler that leaves a repository refusal untranslated", () => {
    const untranslated = () => query("start", () => Promise.resolve(1), [SectionNotFoundError]).pipe(Effect.as(new Response()));
    // @ts-expect-error SectionNotFoundError is not an HttpError
    effectHandler(untranslated);

    const translated = () => untranslated().pipe(
      Effect.catchTag("SectionNotFoundError", () => Effect.fail(new NotFound({ message: "Section not found" }))),
    );
    effectHandler(translated);
  });

  it("rejects a handler that requires a service the bridge does not provide", () => {
    class Mailer extends Context.Service<Mailer, { send: () => void }>()("test/Mailer") {}
    const needsMailer = () => Effect.gen(function* () {
      yield* Mailer;
      return new Response();
    });
    // @ts-expect-error Mailer is not a RequestServices member
    effectHandler(needsMailer);
  });
});
