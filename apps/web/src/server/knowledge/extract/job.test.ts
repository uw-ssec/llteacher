import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractMaterial } from "./job";
import { unsafeCourseScope } from "../../repositories/scope";

const setMaterialStatus = vi.fn();
const setMaterialDocumentPath = vi.fn();
vi.mock("../../repositories/materials", () => ({
  setMaterialStatus: (...a: unknown[]) => setMaterialStatus(...a),
  setMaterialDocumentPath: (...a: unknown[]) => setMaterialDocumentPath(...a),
}));

const knowledge = { create: vi.fn(), update: vi.fn(), show: vi.fn() };
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const base = { db: {} as never, courseId: unsafeCourseScope("c1"), materialId: "m1", knowledge: knowledge as never, existingDocumentPath: null };

beforeEach(() => {
  vi.clearAllMocks();
  knowledge.create.mockResolvedValue({ id: "x" });
  knowledge.update.mockResolvedValue({ id: "x" });
});

describe("extractMaterial", () => {
  it("moves pending -> processing -> ready and creates the concept at the derived id", async () => {
    const out = await extractMaterial({ ...base, filename: "Lecture 2.md", relativePath: "Uploaded Lectures/Module 1/Lecture 2.md", bytes: enc("# L2\n\nBody") });
    expect(setMaterialStatus.mock.calls[0]!.slice(2)).toEqual(["m1", "processing", null]);
    expect(knowledge.create).toHaveBeenCalledWith("c1", expect.objectContaining({
      id: "uploaded-lectures/module-1/lecture-2", type: "note", body: "# L2\n\nBody", resource: "llteacher://materials/m1",
    }));
    expect(setMaterialDocumentPath).toHaveBeenCalledWith(expect.anything(), "c1", "m1", "uploaded-lectures/module-1/lecture-2");
    expect(setMaterialStatus.mock.calls.at(-1)!.slice(2)).toEqual(["m1", "ready", null]);
    expect(out).toEqual({ status: "ready", documentPath: "uploaded-lectures/module-1/lecture-2" });
  });
  it("disambiguates a taken id with a numeric suffix", async () => {
    const { ConceptExistsError } = await import("../service");
    knowledge.create.mockRejectedValueOnce(new ConceptExistsError("syllabus")).mockResolvedValueOnce({ id: "syllabus-2" });
    const out = await extractMaterial({ ...base, filename: "syllabus.txt", relativePath: null, bytes: enc("Weeks") });
    expect(knowledge.create.mock.calls[1]![1]).toMatchObject({ id: "syllabus-2" });
    expect(out.documentPath).toBe("syllabus-2");
  });
  it("updates the existing concept on reingest", async () => {
    const out = await extractMaterial({ ...base, filename: "n.txt", relativePath: null, bytes: enc("new"), existingDocumentPath: "n" });
    expect(knowledge.update).toHaveBeenCalledWith("c1", "n", { body: "new" });
    expect(knowledge.create).not.toHaveBeenCalled();
    expect(out).toEqual({ status: "ready", documentPath: "n" });
  });
  it("leaves an unsupported format at pending with the reason", async () => {
    const out = await extractMaterial({ ...base, filename: "talk.mp3", relativePath: null, bytes: enc("") });
    expect(setMaterialStatus.mock.calls.at(-1)!.slice(2)).toEqual(["m1", "pending", expect.stringMatching(/not supported/)]);
    expect(knowledge.create).not.toHaveBeenCalled();
    expect(out.status).toBe("pending");
  });
  it("marks failed when the knowledge write throws", async () => {
    knowledge.create.mockRejectedValue(new Error("disk full"));
    const out = await extractMaterial({ ...base, filename: "n.txt", relativePath: null, bytes: enc("x") });
    expect(setMaterialStatus.mock.calls.at(-1)!.slice(2)).toEqual(["m1", "failed", expect.stringContaining("could not be saved")]);
    expect(out.status).toBe("failed");
  });
});
