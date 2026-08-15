import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { getCoursePromptTemplateHandler, putCoursePromptTemplateHandler, deleteCoursePromptTemplateHandler } from "./promptTemplates";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;

vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

const getCourseScopedPromptTemplateMock = vi.fn();
const upsertCourseScopedPromptTemplateMock = vi.fn();
const deactivateCourseScopedPromptTemplateMock = vi.fn();
vi.mock("../repositories/promptTemplates", () => ({
  getCourseScopedPromptTemplate: (...args: unknown[]) => getCourseScopedPromptTemplateMock(...args),
  upsertCourseScopedPromptTemplate: (...args: unknown[]) => upsertCourseScopedPromptTemplateMock(...args),
  deactivateCourseScopedPromptTemplate: (...args: unknown[]) => deactivateCourseScopedPromptTemplateMock(...args),
}));

function makeApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  app.get("/api/courses/:courseId/prompt-template", getCoursePromptTemplateHandler);
  app.put("/api/courses/:courseId/prompt-template", putCoursePromptTemplateHandler);
  app.delete("/api/courses/:courseId/prompt-template", deleteCoursePromptTemplateHandler);
  return app;
}

const instructorAuth = () =>
  fakeAuthContext({ memberships: [fakeMembership({ courseId: "c1", role: "instructor" })] });
const studentAuth = () => fakeAuthContext({ memberships: [fakeMembership({ courseId: "c1", role: "student" })] });

describe("getCoursePromptTemplateHandler", () => {
  beforeEach(() => {
    getCourseScopedPromptTemplateMock.mockReset();
  });

  it("403s a non-instructor", async () => {
    const app = makeApp(studentAuth());
    const res = await app.request("/api/courses/c1/prompt-template", {}, TEST_ENV);
    expect(res.status).toBe(403);
    expect(getCourseScopedPromptTemplateMock).not.toHaveBeenCalled();
  });

  it("403s when no authContext is present", async () => {
    const app = makeApp(undefined);
    const res = await app.request("/api/courses/c1/prompt-template", {}, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("returns promptTemplate: null when the course has no scoped template", async () => {
    getCourseScopedPromptTemplateMock.mockResolvedValue(null);
    const app = makeApp(instructorAuth());
    const res = await app.request("/api/courses/c1/prompt-template", {}, TEST_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ promptTemplate: null });
  });

  it("returns the course's scoped template, shaped for the editor", async () => {
    getCourseScopedPromptTemplateMock.mockResolvedValue({
      id: "pt-1",
      content: "Be a great tutor.",
      version: 2,
      composeWithParent: true,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const app = makeApp(instructorAuth());
    const res = await app.request("/api/courses/c1/prompt-template", {}, TEST_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      promptTemplate: {
        id: "pt-1",
        content: "Be a great tutor.",
        version: 2,
        composeWithParent: true,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
  });
});

describe("putCoursePromptTemplateHandler", () => {
  beforeEach(() => {
    upsertCourseScopedPromptTemplateMock.mockReset();
  });

  it("403s a non-instructor", async () => {
    const app = makeApp(studentAuth());
    const res = await app.request(
      "/api/courses/c1/prompt-template",
      { method: "PUT", body: JSON.stringify({ content: "x" }), headers: { "content-type": "application/json" } },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
    expect(upsertCourseScopedPromptTemplateMock).not.toHaveBeenCalled();
  });

  it("400s non-JSON bodies", async () => {
    const app = makeApp(instructorAuth());
    const res = await app.request(
      "/api/courses/c1/prompt-template",
      { method: "PUT", body: "not json", headers: { "content-type": "application/json" } },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("400s an empty content string", async () => {
    const app = makeApp(instructorAuth());
    const res = await app.request(
      "/api/courses/c1/prompt-template",
      { method: "PUT", body: JSON.stringify({ content: "   " }), headers: { "content-type": "application/json" } },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(upsertCourseScopedPromptTemplateMock).not.toHaveBeenCalled();
  });

  it("400s a non-boolean composeWithParent", async () => {
    const app = makeApp(instructorAuth());
    const res = await app.request(
      "/api/courses/c1/prompt-template",
      {
        method: "PUT",
        body: JSON.stringify({ content: "x", composeWithParent: "yes" }),
        headers: { "content-type": "application/json" },
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(upsertCourseScopedPromptTemplateMock).not.toHaveBeenCalled();
  });

  it("400s content over the length cap", async () => {
    const app = makeApp(instructorAuth());
    const res = await app.request(
      "/api/courses/c1/prompt-template",
      {
        method: "PUT",
        body: JSON.stringify({ content: "x".repeat(20_001) }),
        headers: { "content-type": "application/json" },
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(upsertCourseScopedPromptTemplateMock).not.toHaveBeenCalled();
  });

  it("upserts and defaults composeWithParent to false when omitted", async () => {
    upsertCourseScopedPromptTemplateMock.mockResolvedValue({ id: "pt-1", version: 1 });
    const app = makeApp(instructorAuth());
    const res = await app.request(
      "/api/courses/c1/prompt-template",
      { method: "PUT", body: JSON.stringify({ content: "Be great." }), headers: { "content-type": "application/json" } },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "pt-1", version: 1 });
    expect(upsertCourseScopedPromptTemplateMock).toHaveBeenCalledWith(expect.anything(), "c1", {
      content: "Be great.",
      composeWithParent: false,
    });
  });

  it("passes composeWithParent through when explicitly set", async () => {
    upsertCourseScopedPromptTemplateMock.mockResolvedValue({ id: "pt-2", version: 3 });
    const app = makeApp(instructorAuth());
    const res = await app.request(
      "/api/courses/c1/prompt-template",
      {
        method: "PUT",
        body: JSON.stringify({ content: "Be great.", composeWithParent: true }),
        headers: { "content-type": "application/json" },
      },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    expect(upsertCourseScopedPromptTemplateMock).toHaveBeenCalledWith(expect.anything(), "c1", {
      content: "Be great.",
      composeWithParent: true,
    });
  });
});

describe("deleteCoursePromptTemplateHandler", () => {
  beforeEach(() => {
    deactivateCourseScopedPromptTemplateMock.mockReset();
  });

  it("403s a non-instructor", async () => {
    const app = makeApp(studentAuth());
    const res = await app.request("/api/courses/c1/prompt-template", { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(403);
    expect(deactivateCourseScopedPromptTemplateMock).not.toHaveBeenCalled();
  });

  it("deactivates and returns 204", async () => {
    deactivateCourseScopedPromptTemplateMock.mockResolvedValue(undefined);
    const app = makeApp(instructorAuth());
    const res = await app.request("/api/courses/c1/prompt-template", { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(204);
    expect(deactivateCourseScopedPromptTemplateMock).toHaveBeenCalledWith(expect.anything(), "c1");
  });
});
