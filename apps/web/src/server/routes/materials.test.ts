/* --------------------------------------------------------------------------
   #31/#42: the materials routes' request contract.

   The repository suite (repositories/materials.test.ts) owns the data
   invariants against a real Postgres. This file owns who is admitted, which
   bodies are refused and with what sentence, the tiered-ingestion outcome
   reaching the client, and the retryable/permanent storage-failure split.
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

const listMaterialsForCourse = vi.fn();
const createDocument = vi.fn();
const insertMaterial = vi.fn();
const deleteMaterial = vi.fn();
const getMaterialForReingest = vi.fn();
const setMaterialStatus = vi.fn();
const setMaterialStorageKey = vi.fn();

vi.mock("../repositories/materials", () => ({
  listMaterialsForCourse: (...args: unknown[]) => listMaterialsForCourse(...args),
  insertMaterial: (...args: unknown[]) => insertMaterial(...args),
  deleteMaterial: (...args: unknown[]) => deleteMaterial(...args),
  getMaterialForReingest: (...args: unknown[]) => getMaterialForReingest(...args),
  setMaterialStatus: (...args: unknown[]) => setMaterialStatus(...args),
  setMaterialStorageKey: (...args: unknown[]) => setMaterialStorageKey(...args),
}));
vi.mock("../repositories/knowledgeDocuments", () => ({
  createDocument: (...args: unknown[]) => createDocument(...args),
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
  createDocument.mockResolvedValue({ id: "doc-1", path: "lecture1" });
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

  it("stores a transcript and creates a ready document", async () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello.";
    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      upload("lecture1.vtt", vtt, "text/vtt"),
      TEST_ENV,
    );
    expect(res.status).toBe(201);
    // Insert is pessimistic now (Finding 2): the row is always written
    // pending first, and only upgraded to ready once the bytes are stored
    // and the document exists -- see "only claims ready once the bytes are
    // stored and the document exists" below for that upgrade itself.
    expect(insertMaterial).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      expect.objectContaining({ sourceType: "transcript", status: "pending" }),
    );
    expect(createDocument).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      expect.objectContaining({ type: "transcript", body: "Hello." }),
    );
  });

  it("holds a PDF at pending and creates no document", async () => {
    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      upload("paper.pdf", "%PDF-1.7", "application/pdf"),
      TEST_ENV,
    );
    expect(res.status).toBe(201);
    expect(insertMaterial).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      expect.objectContaining({ status: "pending" }),
    );
    expect(createDocument).not.toHaveBeenCalled();
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
  });

  it("reports a permanent storage failure as 502", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(store, "put").mockRejectedValueOnce(new StorageError("put", 403));

    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      upload("lecture1.vtt", "WEBVTT", "text/vtt"),
      TEST_ENV,
    );
    expect(res.status).toBe(502);
  });

  it("only claims ready once the bytes are stored and the document exists", async () => {
    // The row is written pending first and upgraded afterwards, so a failure
    // anywhere in between leaves a status that is still true.
    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      upload("lecture1.vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello.", "text/vtt"),
      TEST_ENV,
    );
    expect(res.status).toBe(201);
    expect(insertMaterial).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      expect.objectContaining({ status: "pending" }),
    );
    expect(setMaterialStatus).toHaveBeenCalledWith(
      expect.anything(), COURSE_ID, "mat-1", "ready", null,
    );
  });

  it("leaves the material pending when storing the bytes fails", async () => {
    // The upgrade to ready must not have happened: nothing may claim the
    // tutor can use content that was never stored.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(store, "put").mockRejectedValueOnce(new StorageError("put", 403));

    await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      upload("lecture1.vtt", "WEBVTT", "text/vtt"),
      TEST_ENV,
    );
    expect(setMaterialStatus).not.toHaveBeenCalledWith(
      expect.anything(), COURSE_ID, expect.anything(), "ready", null,
    );
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
    deleteMaterial.mockResolvedValue({ storageKey: "courses/c/materials/m/a.pdf" });
    const removed = vi.spyOn(store, "delete");

    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials/mat-1`,
      { method: "DELETE" },
      TEST_ENV,
    );
    expect(res.status).toBe(204);
    expect(removed).toHaveBeenCalledWith("courses/c/materials/m/a.pdf");
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
    deleteMaterial.mockResolvedValue({ storageKey: "courses/c/materials/m/a.pdf" });
    vi.spyOn(store, "delete").mockRejectedValueOnce(new StorageError("delete", 500));

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
    });
    await store.put(
      "courses/c/materials/m2/paper.pdf",
      new TextEncoder().encode("%PDF").buffer,
      {},
    );

    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials/m2/reingest`,
      { method: "POST" },
      TEST_ENV,
    );
    expect(await res.json()).toEqual({ status: "pending", documentCreated: false });
    expect(createDocument).not.toHaveBeenCalled();
  });

  it("marks a material failed when its stored file has gone missing", async () => {
    getMaterialForReingest.mockResolvedValue({
      id: "m3",
      originalFilename: "a.vtt",
      storageKey: "courses/c/materials/m3/missing.vtt",
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
  });
});
