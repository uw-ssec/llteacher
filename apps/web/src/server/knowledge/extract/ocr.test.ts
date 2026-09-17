import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribePage, transcribePdf, OCR_MAX_PAGES } from "./ocr";
const options = { baseUrl: "https://gateway.test/v1/", apiKey: "private", model: "gpt-5.4-mini" };
const completed = (text: string) => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }] }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("GPT-5.4 mini OCR", () => {
  it("uses high-detail image input with low effort and no response storage", async () => {
    const fetch = vi.fn().mockResolvedValue(completed("GDP = 42"));
    vi.stubGlobal("fetch", fetch);
    expect(await transcribePage(new Uint8Array([1,2]), options, new AbortController().signal)).toBe("GDP = 42");
    expect(fetch.mock.calls[0][0]).toBe("https://gateway.test/v1/responses");
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: "gpt-5.4-mini", reasoning: { effort: "low" }, store: false });
    expect(body.input[0].content[1]).toMatchObject({ type: "input_image", detail: "high", image_url: "data:image/png;base64,AQI=" });
  });
  it.each(["incomplete", "failed"])("rejects %s output instead of publishing partial text", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status, output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }] }))));
    await expect(transcribePage(new Uint8Array(), options, new AbortController().signal)).rejects.toThrow("incomplete page");
  });
  it("rejects empty output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completed("  ")));
    await expect(transcribePage(new Uint8Array(), options, new AbortController().signal)).rejects.toThrow("empty page");
  });
  it("reports unavailable models without forwarding upstream bodies or credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private credential", { status: 400 })));
    await expect(transcribePage(new Uint8Array(), options, new AbortController().signal)).rejects.toThrow("HTTP 400");
  });
  it("retries throttling and then returns a complete page", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 429 })).mockResolvedValueOnce(completed("Recovered"));
    vi.stubGlobal("fetch", fetch);
    const result = transcribePage(new Uint8Array(), options, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe("Recovered");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("checks page limits before rendering or transmitting content", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(transcribePdf(new ArrayBuffer(0), OCR_MAX_PAGES + 1, options)).rejects.toThrow("Split the PDF");
    expect(fetch).not.toHaveBeenCalled();
  });
});
