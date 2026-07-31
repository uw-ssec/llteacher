import { describe, it, expect } from "vitest";
import app from "./index";

const ENV = {
  ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  WORKOS_API_KEY: "sk_test_x",
  WORKOS_CLIENT_ID: "client_x",
} as unknown as Env;

describe("app composition", () => {
  it("does not require a session for /api/auth/login", async () => {
    const res = await app.request("/api/auth/login", {}, ENV);
    expect(res.status).not.toBe(401);
  });

  it("gates every other /api/* route behind a session, including pre-existing ones", async () => {
    // This is the intended M1 behavior (issue #8 + epic #13 acceptance
    // criteria): the whole point of this epic is that fixture-identity
    // routes like /api/hello and /api/chat stop being anonymous.
    const helloRes = await app.request("/api/hello", {}, ENV);
    expect(helloRes.status).toBe(401);

    const chatRes = await app.request("/api/chat", { method: "POST" }, ENV);
    expect(chatRes.status).toBe(401);
  });
});
