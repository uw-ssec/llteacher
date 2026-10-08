import { describe, it, expect, vi } from "vitest";
import { hello } from "./hello";

// makeDb() itself is mocked too (not just createPing) -- hello.ts calls
// makeDb(c.env.DATABASE_URL) unconditionally before createPing, and the
// real @neondatabase/serverless neon() throws synchronously on a
// non-URL-shaped connection string, before createPing (mocked below) ever
// gets a chance to run.
vi.mock("../../db/client", () => ({
  makeDb: () => ({}),
}));

const createPingMock = vi.fn(async () => ({ id: "00000000-0000-0000-0000-000000000001", message: "mocked" }));
vi.mock("../repositories/pings", () => ({
  createPing: () => createPingMock(),
}));

describe("GET /api/hello", () => {
  it("returns a HelloResponse with mocked message and ping_id", async () => {
    const res = await hello.request("/", {}, { DATABASE_URL: "ignored" } as Env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      message: "mocked",
      ping_id: "00000000-0000-0000-0000-000000000001",
    });
  });

  it("returns a stub HelloResponse when DATABASE_URL is empty", async () => {
    const res = await hello.request("/", {}, { DATABASE_URL: "" } as Env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; ping_id: string };
    expect(body.message).toContain("stub");
    expect(body.ping_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("GET /api/hello -- database failure", () => {
  it("answers 503 when createPing fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    createPingMock.mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));
    const res = await hello.request("/", {}, { DATABASE_URL: "ignored" } as Env);
    expect(res.status).toBe(503);
    consoleSpy.mockRestore();
  });
});
