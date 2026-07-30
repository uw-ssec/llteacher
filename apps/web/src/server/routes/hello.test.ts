import { describe, it, expect, vi } from "vitest";
import { hello } from "./hello";

vi.mock("../../db/client", () => ({
  makeDb: () => ({
    insert: () => ({
      values: () => ({
        returning: async () => [{ id: "00000000-0000-0000-0000-000000000001", message: "mocked" }],
      }),
    }),
  }),
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
