import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeCleanup, proposeCleanup } from "./cleanup";
afterEach(() => vi.unstubAllGlobals());
const env = { LLMOXIE_BASE_URL: "https://gateway.test/v1", LLMOXIE_API_KEY: "secret" } as Env;
function reply(body: string, status = "completed") {
  return new Response(JSON.stringify({ status, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ body, warnings: [] }) }] }] }));
}
describe("Markdown cleanup", () => {
  it("normalizes tables and preserves math", () => {
    const result = normalizeCleanup("Price $50 and $x^2$", "# Price\n\n| Item | Price |\n|---|---|\n| Steel | $50 |\n\n$x^2$", []);
    expect(result.body).toContain("| Steel");
    expect(result.body).toContain("$x^2$");
    expect(result.warnings).toEqual([]);
  });
  it("flags changed numbers and preserves ambiguity notices", () => {
    const result = normalizeCleanup("Steel 50", "Steel 60", ["Unclear columns"]);
    expect(result.warnings).toHaveLength(2);
  });
  it("requests Mini low effort without storing source data", async () => {
    const mock = vi.fn(async () => reply("# Heading\n\nText")); vi.stubGlobal("fetch", mock);
    expect((await proposeCleanup("Heading\nText", env)).body).toContain("# Heading");
    const request = JSON.parse((mock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(request).toMatchObject({ model: "gpt-5.4-mini", store: false, reasoning: { effort: "low" } });
  });
  it("rejects incomplete output", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply("partial", "incomplete")));
    await expect(proposeCleanup("source", env)).rejects.toThrow("incomplete or invalid");
  });
  it("does not expose upstream errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret", { status: 401 })));
    await expect(proposeCleanup("source", env)).rejects.toThrow("HTTP 401");
  });
  it("rejects oversize input before calling the gateway", async () => {
    const mock = vi.fn(); vi.stubGlobal("fetch", mock);
    await expect(proposeCleanup("x".repeat(60_001), env)).rejects.toThrow("60,000");
    expect(mock).not.toHaveBeenCalled();
  });
});
