import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { listLlmConfigsHandler } from "./llmConfigs";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;

vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

const getOrgScopeForCourseMock = vi.fn();
vi.mock("../repositories/organizations", () => ({
  getOrgScopeForCourse: (...args: unknown[]) => getOrgScopeForCourseMock(...args),
}));

const listLlmConfigsForOrgMock = vi.fn();
vi.mock("../repositories/llmConfigs", () => ({
  listLlmConfigsForOrg: (...args: unknown[]) => listLlmConfigsForOrgMock(...args),
}));

function makeApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  app.get("/api/courses/:courseId/llm-configs", listLlmConfigsHandler);
  return app;
}

describe("listLlmConfigsHandler", () => {
  beforeEach(() => {
    getOrgScopeForCourseMock.mockReset();
    listLlmConfigsForOrgMock.mockReset();
  });

  it("403s a non-instructor", async () => {
    const auth = fakeAuthContext({ memberships: [fakeMembership({ courseId: "c1", role: "student" })] });
    const app = makeApp(auth);
    const res = await app.request("/api/courses/c1/llm-configs", {}, TEST_ENV);
    expect(res.status).toBe(403);
    expect(getOrgScopeForCourseMock).not.toHaveBeenCalled();
  });

  it("403s when no authContext is present", async () => {
    const app = makeApp(undefined);
    const res = await app.request("/api/courses/c1/llm-configs", {}, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("returns only active configs, shaped for the picker (id/provider/modelName/isDefault)", async () => {
    const auth = fakeAuthContext({ memberships: [fakeMembership({ courseId: "c1", role: "instructor" })] });
    getOrgScopeForCourseMock.mockResolvedValue("org-1");
    listLlmConfigsForOrgMock.mockResolvedValue([
      { id: "cfg-1", provider: "llmoxie", modelName: "gpt-5.3-codex", isDefault: true, isActive: true, temperature: 0.7 },
      { id: "cfg-2", provider: "openrouter", modelName: "google/gemma-4-31b-it:free", isDefault: false, isActive: false },
    ]);
    const app = makeApp(auth);
    const res = await app.request("/api/courses/c1/llm-configs", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      llmConfigs: [{ id: "cfg-1", provider: "llmoxie", modelName: "gpt-5.3-codex", isDefault: true }],
    });
  });

  it("excludes an active config whose provider has no client factory (#325: selectable != working)", async () => {
    const auth = fakeAuthContext({ memberships: [fakeMembership({ courseId: "c1", role: "instructor" })] });
    getOrgScopeForCourseMock.mockResolvedValue("org-1");
    listLlmConfigsForOrgMock.mockResolvedValue([
      { id: "cfg-1", provider: "llmoxie", modelName: "gpt-5.3-codex", isDefault: false, isActive: true },
      { id: "cfg-2", provider: "openai", modelName: "gpt-4o", isDefault: true, isActive: true },
      { id: "cfg-3", provider: "anthropic", modelName: "claude-4", isDefault: false, isActive: true },
      { id: "cfg-4", provider: "claude_for_education", modelName: "claude-4-edu", isDefault: false, isActive: true },
      { id: "cfg-5", provider: "local", modelName: "local-model", isDefault: false, isActive: true },
    ]);
    const app = makeApp(auth);
    const res = await app.request("/api/courses/c1/llm-configs", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      llmConfigs: [{ id: "cfg-1", provider: "llmoxie", modelName: "gpt-5.3-codex", isDefault: false }],
    });
  });

  it("403s when the course has no resolvable org scope", async () => {
    const auth = fakeAuthContext({ memberships: [fakeMembership({ courseId: "c1", role: "instructor" })] });
    getOrgScopeForCourseMock.mockResolvedValue(null);
    const app = makeApp(auth);
    const res = await app.request("/api/courses/c1/llm-configs", {}, TEST_ENV);
    expect(res.status).toBe(403);
    expect(listLlmConfigsForOrgMock).not.toHaveBeenCalled();
  });
});
