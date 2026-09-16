/* --------------------------------------------------------------------------
   #31/#40/#42: the materials routes' request contract.

   The repository suite (repositories/materials.test.ts) owns the data
   invariants against a real Postgres. This file owns who is admitted, which
   bodies are refused and with what sentence, and how upload/reingest/delete
   wire into extraction (knowledge/extract/job.ts) and the knowledge service.
   Extraction's own state machine (pending -> processing -> ready | failed,
   concept-id disambiguation, unsupported formats) is unit-tested in its own
   right at knowledge/extract/job.test.ts; here extractMaterial and
   scheduleExtraction are mocked so this file stays about the HTTP contract.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  listMaterialsHandler,
  uploadMaterialHandler,
  deleteMaterialHandler,
  reingestMaterialHandler,
} from "./materials";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";
import { memoryObjectStore, StorageError } from "../storage/objectStore";

const COURSE_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_MATERIAL_ID = "22222222-3333-4444-8555-666666666666";
const TEST_ENV = { DATABASE_URL: "ignored" } as unknown as Env;

const store = memoryObjectStore();

vi.mock("../storage/objectStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage/objectStore")>();
  return { ...actual, storageFromEnv: () => store };
});

const scheduleExtraction = vi.fn();
const extractMaterial = vi.fn();
vi.mock("../knowledge/extract/job", () => ({
  scheduleExtraction: (...a: unknown[]) => scheduleExtraction(...a),
  extractMaterial: (...a: unknown[]) => extractMaterial(...a),
}));

const knowledgeRemove = vi.fn();
vi.mock("../knowledge/service", () => ({
  knowledgeServiceFromEnv: () => ({ remove: (...a: unknown[]) => knowledgeRemove(...a) }),
}));

const listMaterialsForCourse = vi.fn();
const insertMaterial = vi.fn();
const deleteMaterial = vi.fn();
const getMaterialForReingest = vi.fn();
const setMaterialStatus = vi.fn();
const setMaterialStorageKey = vi.fn();
const setMaterialDocumentPath = vi.fn();

vi.mock("../repositories/materials", () => ({
  listMaterialsForCourse: (...args: unknown[]) => listMaterialsForCourse(...args),
  insertMaterial: (...args: unknown[]) => insertMaterial(...args),
  deleteMaterial: (...args: unknown[]) => deleteMaterial(...args),
  getMaterialForReingest: (...args: unknown[]) => getMaterialForReingest(...args),
  setMaterialStatus: (...args: unknown[]) => setMaterialStatus(...args),
  setMaterialStorageKey: (...args: unknown[]) => setMaterialStorageKey(...args),
  setMaterialDocumentPath: (...args: unknown[]) => setMaterialDocumentPath(...args),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

function appWith(role: "instructor" | "student") {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set(
      "authContext",
      fakeAuthContext({ memberships: [fakeMembership({ courseId: COURSE_ID, role })] }),
    );
    await next();
  });
  app.get("/api/courses/:courseId/materials", listMaterialsHandler);
  app.post("/api/courses/:courseId/materials", uploadMaterialHandler);
  app.delete("/api/courses/:courseId/materials/:materialId", deleteMaterialHandler);
  app.post("/api/courses/:courseId/materials/:materialId/reingest", reingestMaterialHandler);
  return app;
}

function upload(name: string, body: string, type = "text/plain") {
  const form = new FormData();
  form.set("file", new File([body], name, { type }));
  return { method: "POST", body: form };
}

beforeEach(() => {
  vi.clearAllMocks();
  listMaterialsForCourse.mockResolvedValue([]);
  insertMaterial.mockResolvedValue({ id: "mat-1" });
  extractMaterial.mockResolvedValue({ status: "ready", documentPath: "lecture1" });
});

describe("materials routes", () => {
  it("lists materials for an instructor", async () => {
    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ materials: [] });
  });

  it("refuses a non-member course id", async () => {
    const other = "99999999-2222-4333-8444-555555555555";
    const res = await appWith("instructor").request(
      `/api/courses/${other}/materials`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("rejects a request with no file field", async () => {
    // No `file` entry at all -- distinct from an empty or disallowed one --
    // is the shape a hand-built request or a broken form submits.
    const form = new FormData();
    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      { method: "POST", body: form },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/no file/i);
    expect(insertMaterial).not.toHaveBeenCalled();
  });

  it("rejects a disallowed extension", async () => {
    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      upload("evil.exe", "MZ"),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/file type/i);
    expect(insertMaterial).not.toHaveBeenCalled();
  });

  it("rejects a file over the size cap", async () => {
    const huge = "x".repeat(26 * 1024 * 1024);
    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      upload("big.txt", huge),
      TEST_ENV,
    );
    expect(res.status).toBe(413);
    expect(insertMaterial).not.toHaveBeenCalled();
  });

  it("accepts an upload, stores it pending, and schedules extraction off the request path", async () => {
    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      upload("lecture1.vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello.", "text/vtt"),
      TEST_ENV,
    );
    // Every successful upload answers 201 pending now: extraction runs after
    // the handler returns (scheduleExtraction, below), so nothing here yet
    // knows whether the format is supported or the concept write will land.
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "mat-1", status: "pending" });
    expect(insertMaterial).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      expect.objectContaining({ sourceType: "transcript", status: "pending", relativePath: null }),
    );
    expect(setMaterialStorageKey).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      "mat-1",
      expect.any(String),
    );
    expect(scheduleExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: COURSE_ID,
        materialId: "mat-1",
        filename: "lecture1.vtt",
        relativePath: null,
        existingDocumentPath: null,
      }),
    );
  });

  it("accepts a valid relativePath and forwards it to the insert and the scheduled extraction", async () => {
    const form = new FormData();
    form.set("file", new File(["hi"], "lecture1.vtt", { type: "text/vtt" }));
    form.set("relativePath", "Module 1/lecture1.vtt");
    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      { method: "POST", body: form },
      TEST_ENV,
    );
    expect(res.status).toBe(201);
    expect(insertMaterial).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      expect.objectContaining({ relativePath: "Module 1/lecture1.vtt" }),
    );
    expect(scheduleExtraction).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: "Module 1/lecture1.vtt" }),
    );
  });

  it("rejects a relativePath that escapes with ..", async () => {
    const form = new FormData();
    form.set("file", new File(["hi"], "lecture1.vtt", { type: "text/vtt" }));
    form.set("relativePath", "../x");
    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      { method: "POST", body: form },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(insertMaterial).not.toHaveBeenCalled();
    expect(scheduleExtraction).not.toHaveBeenCalled();
  });

  it("reports a retryable storage failure as 503, not a dead end", async () => {
    // Neon answers 503 SlowDown when throttling. An instructor who sees
    // "could not store the uploaded file" has no reason to retry; this
    // asserts the distinction StorageError exists to carry.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const busy = new StorageError("put", 503);
    vi.spyOn(store, "put").mockRejectedValueOnce(busy);

    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      upload("lecture1.vtt", "WEBVTT", "text/vtt"),
      TEST_ENV,
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/try uploading again/i);
    expect(scheduleExtraction).not.toHaveBeenCalled();
  });

  it("reports a permanent storage failure as 502 and removes the orphaned row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(store, "put").mockRejectedValueOnce(new StorageError("put", 403));

    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      upload("lecture1.vtt", "WEBVTT", "text/vtt"),
      TEST_ENV,
    );
    expect(res.status).toBe(502);
    expect(deleteMaterial).toHaveBeenCalledWith(expect.anything(), COURSE_ID, "mat-1");
    expect(scheduleExtraction).not.toHaveBeenCalled();
  });

  it("refuses to delete a material belonging to another course", async () => {
    deleteMaterial.mockResolvedValue(null);
    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials/${OTHER_MATERIAL_ID}`,
      { method: "DELETE" },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("deletes a material and removes its stored object", async () => {
    deleteMaterial.mockResolvedValue({ storageKey: "courses/c/materials/m/a.pdf", documentPath: null });
    const removed = vi.spyOn(store, "delete");

    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials/mat-1`,
      { method: "DELETE" },
      TEST_ENV,
    );
    expect(res.status).toBe(204);
    expect(removed).toHaveBeenCalledWith("courses/c/materials/m/a.pdf");
    expect(knowledgeRemove).not.toHaveBeenCalled();
  });

  it("also removes the associated concept when a material has one", async () => {
    deleteMaterial.mockResolvedValue({ storageKey: null, documentPath: "n" });

    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials/mat-1`,
      { method: "DELETE" },
      TEST_ENV,
    );
    expect(res.status).toBe(204);
    expect(knowledgeRemove).toHaveBeenCalledWith(COURSE_ID, "n");
  });

  it("does not admit a student to delete", async () => {
    const res = await appWith("student").request(
      `/api/courses/${COURSE_ID}/materials/mat-1`,
      { method: "DELETE" },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
    expect(deleteMaterial).not.toHaveBeenCalled();
  });

  it("still returns 204 when the row is gone but the stored object cannot be removed", async () => {
    // The row is the source of truth and it is already deleted; a storage
    // hiccup on the best-effort cleanup must not turn a completed delete
    // into a client-visible failure.
    vi.spyOn(console, "error").mockImplementation(() => {});
    deleteMaterial.mockResolvedValue({ storageKey: "courses/c/materials/m/a.pdf", documentPath: null });
    vi.spyOn(store, "delete").mockRejectedValueOnce(new StorageError("delete", 500));

    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials/mat-1`,
      { method: "DELETE" },
      TEST_ENV,
    );
    expect(res.status).toBe(204);
  });

  it("still returns 204 when the concept removal fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    deleteMaterial.mockResolvedValue({ storageKey: null, documentPath: "n" });
    knowledgeRemove.mockRejectedValueOnce(new Error("concept locked"));

    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials/mat-1`,
      { method: "DELETE" },
      TEST_ENV,
    );
    expect(res.status).toBe(204);
  });

  it("does not admit a student", async () => {
    const res = await appWith("student").request(
      `/api/courses/${COURSE_ID}/materials`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("re-reports pending for a format the pipeline still cannot extract", async () => {
    getMaterialForReingest.mockResolvedValue({
      id: "m2",
      originalFilename: "paper.pdf",
      storageKey: "courses/c/materials/m2/paper.pdf",
      relativePath: null,
      documentPath: null,
    });
    await store.put(
      "courses/c/materials/m2/paper.pdf",
      new TextEncoder().encode("%PDF").buffer,
      {},
    );
    extractMaterial.mockResolvedValue({ status: "pending", documentPath: null });

    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials/m2/reingest`,
      { method: "POST" },
      TEST_ENV,
    );
    expect(await res.json()).toEqual({ status: "pending", documentCreated: false });
    expect(extractMaterial).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: COURSE_ID,
        materialId: "m2",
        filename: "paper.pdf",
        relativePath: null,
        existingDocumentPath: null,
      }),
    );
  });

  it("marks a material failed when its stored file has gone missing", async () => {
    getMaterialForReingest.mockResolvedValue({
      id: "m3",
      originalFilename: "a.vtt",
      storageKey: "courses/c/materials/m3/missing.vtt",
      relativePath: null,
      documentPath: null,
    });
    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials/m3/reingest`,
      { method: "POST" },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
    expect(setMaterialStatus).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      "m3",
      "failed",
      "The stored file is missing.",
    );
    expect(extractMaterial).not.toHaveBeenCalled();
  });

  it("passes the existing document path through to extractMaterial and reports it unchanged on an idempotent reingest", async () => {
    getMaterialForReingest.mockResolvedValue({
      id: "m4",
      originalFilename: "lecture1.vtt",
      storageKey: "courses/c/materials/m4/lecture1.vtt",
      relativePath: null,
      documentPath: "lecture1",
    });
    await store.put(
      "courses/c/materials/m4/lecture1.vtt",
      new TextEncoder().encode("WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nUpdated.").buffer,
      {},
    );
    extractMaterial.mockResolvedValue({ status: "ready", documentPath: "lecture1" });

    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials/m4/reingest`,
      { method: "POST" },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", documentCreated: false });
    expect(extractMaterial).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "lecture1.vtt",
        existingDocumentPath: "lecture1",
      }),
    );
  });

  it("reports documentCreated when reingest derives a document path for the first time", async () => {
    getMaterialForReingest.mockResolvedValue({
      id: "m6",
      originalFilename: "syllabus.txt",
      storageKey: "courses/c/materials/m6/syllabus.txt",
      relativePath: null,
      documentPath: null,
    });
    await store.put(
      "courses/c/materials/m6/syllabus.txt",
      new TextEncoder().encode("Weeks").buffer,
      {},
    );
    extractMaterial.mockResolvedValue({ status: "ready", documentPath: "syllabus" });

    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials/m6/reingest`,
      { method: "POST" },
      TEST_ENV,
    );
    expect(await res.json()).toEqual({ status: "ready", documentCreated: true });
  });

  it("reports a failed reingest without pretending the write happened", async () => {
    getMaterialForReingest.mockResolvedValue({
      id: "m5",
      originalFilename: "lecture1.vtt",
      storageKey: "courses/c/materials/m5/lecture1.vtt",
      relativePath: null,
      documentPath: "lecture1",
    });
    await store.put(
      "courses/c/materials/m5/lecture1.vtt",
      new TextEncoder().encode("WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nUpdated.").buffer,
      {},
    );
    extractMaterial.mockResolvedValue({ status: "failed", documentPath: "lecture1" });

    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials/m5/reingest`,
      { method: "POST" },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "failed", documentCreated: false });
  });

  it("does not admit a student to reingest", async () => {
    // The other three handlers each have their own "does not admit a
    // student" case; reingest shares the same scopeOf() gate and deserves
    // the same direct check rather than relying on family resemblance.
    const res = await appWith("student").request(
      `/api/courses/${COURSE_ID}/materials/m2/reingest`,
      { method: "POST" },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
    expect(getMaterialForReingest).not.toHaveBeenCalled();
    expect(extractMaterial).not.toHaveBeenCalled();
  });
});
