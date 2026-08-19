import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { listLlmModelsHandler } from "./llmModels";
import { LLMOXIE_DEFAULT_BASE_URL } from "../../lib/ai";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const GATEWAY_KEY = "gateway-secret-value";

const ENV = {
  DATABASE_URL: "ignored",
  LLMOXIE_API_KEY: GATEWAY_KEY,
} as Env;

function makeApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  app.get("/api/courses/:courseId/llm-models", listLlmModelsHandler);
  return app;
}

const instructor = () =>
  fakeAuthContext({ memberships: [fakeMembership({ courseId: "c1", role: "instructor" })] });

describe("listLlmModelsHandler", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("403s a non-instructor", async () => {
    const auth = fakeAuthContext({ memberships: [fakeMembership({ courseId: "c1", role: "student" })] });
    const res = await makeApp(auth).request("/api/courses/c1/llm-models", {}, ENV);
    expect(res.status).toBe(403);
  });

  it("returns the gateway's model ids, sorted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ object: "list", data: [{ id: "gpt-4o" }, { id: "claude-sonnet" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await makeApp(instructor()).request("/api/courses/c1/llm-models", {}, ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: ["claude-sonnet", "gpt-4o"] });
  });

  /* The whole reason this route exists server-side: the instructor must be
     able to use the gateway without the key ever being reachable by them. */
  it("never puts the gateway key in the response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), { status: 200 }),
      ),
    );
    const res = await makeApp(instructor()).request("/api/courses/c1/llm-models", {}, ENV);
    expect(await res.text()).not.toContain(GATEWAY_KEY);
  });

  it("sends the key as a bearer token to the default gateway host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await makeApp(instructor()).request("/api/courses/c1/llm-models", {}, ENV);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${LLMOXIE_DEFAULT_BASE_URL}/models`);
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${GATEWAY_KEY}`,
    });
  });

  it("honours LLMOXIE_BASE_URL over the compiled-in default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await makeApp(instructor()).request(
      "/api/courses/c1/llm-models",
      {},
      { ...ENV, LLMOXIE_BASE_URL: "https://staging-gateway.example/v1" } as Env,
    );
    expect(fetchMock.mock.calls[0]![0]).toBe("https://staging-gateway.example/v1/models");
  });

  it("503s with no key configured, rather than calling the gateway", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await makeApp(instructor()).request(
      "/api/courses/c1/llm-models",
      {},
      { DATABASE_URL: "ignored" } as Env,
    );
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /* An upstream error body can carry gateway detail an instructor has no
     business seeing -- the same information-disclosure shape the audit
     flagged on the chat stream's forwarded provider errors. */
  it("does not forward the upstream error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("internal gateway detail: upstream account xyz over quota", { status: 429 }),
      ),
    );
    const res = await makeApp(instructor()).request("/api/courses/c1/llm-models", {}, ENV);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("upstream account xyz");
  });

  it("502s when the gateway is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const res = await makeApp(instructor()).request("/api/courses/c1/llm-models", {}, ENV);
    expect(res.status).toBe(502);
  });

  it("502s on a response with no data array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ object: "list" }), { status: 200 })),
    );
    const res = await makeApp(instructor()).request("/api/courses/c1/llm-models", {}, ENV);
    expect(res.status).toBe(502);
  });

  it("drops malformed entries rather than failing the whole list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "" }, {}, null, "nope"] }),
          { status: 200 },
        ),
      ),
    );
    const res = await makeApp(instructor()).request("/api/courses/c1/llm-models", {}, ENV);
    expect(await res.json()).toEqual({ models: ["gpt-4o"] });
  });
});
