import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractPdf } from "./pdf";
const mocks = vi.hoisted(() => ({ text: vi.fn(), ocr: vi.fn(), destroy: vi.fn() }));
vi.mock("unpdf", () => ({ getDocumentProxy: async () => ({ loadingTask: { destroy: mocks.destroy } }), extractText: mocks.text }));
vi.mock("./ocr", () => ({ transcribePdf: mocks.ocr }));
const options = { apiKey: "key", baseUrl: "https://gateway.test/v1", model: "gpt-5.4-mini" };
beforeEach(() => vi.resetAllMocks());
describe("PDF OCR fallback", () => {
  it("keeps PDFs with usable text on the free local extraction path", async () => {
    mocks.text.mockResolvedValue({ totalPages: 1, text: "GDP is the value of final goods and services." });
    expect(await extractPdf("reading.pdf", new ArrayBuffer(1), options)).toMatchObject({ kind: "extracted" });
    expect(mocks.ocr).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalled();
  });
  it("passes original scan bytes and page count to OCR", async () => {
    mocks.text.mockResolvedValue({ totalPages: 2, text: "" });
    mocks.ocr.mockResolvedValue("## Page 1\n\nGDP\n\n## Page 2\n\nInflation");
    const bytes = new ArrayBuffer(8);
    expect(await extractPdf("scan.pdf", bytes, options)).toMatchObject({ kind: "extracted", markdown: expect.stringContaining("## Page 2") });
    expect(mocks.ocr).toHaveBeenCalledWith(bytes, 2, options);
  });
  it("propagates a failed OCR page to the job rather than publishing partial content", async () => {
    mocks.text.mockResolvedValue({ totalPages: 2, text: "" });
    mocks.ocr.mockRejectedValue(new Error("page 2 failed"));
    await expect(extractPdf("scan.pdf", new ArrayBuffer(1), options)).rejects.toThrow("page 2 failed");
  });
});
