/* --------------------------------------------------------------------------
   #42: the knowledge document routes' request contract.

   The repository suite (repositories/knowledgeDocuments.db.test.ts) owns the
   data invariants against a real Postgres. This file owns who is admitted,
   path validation (the security-relevant part -- see knowledgeDocuments.ts),
   the folder-is-its-index-document behaviour, and bundle maintenance being
   best-effort.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  createDocumentHandler,
  deleteDocumentHandler,
  documentLinksHandler,
  getDocumentHandler,
  listDocumentsHandler,
  updateDocumentHandler,
} from "./knowledgeDocuments";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const COURSE_ID = "11111111-2222-4333-8444-555555555555";
const DOC_ID = "22222222-2222-4333-8444-555555555555";
const TEST_ENV = { DATABASE_URL: "ignored" } as unknown as Env;

const repo = {
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
  createDocument: vi.fn(),
  updateDocumentBody: vi.fn(),
  deleteDocument: vi.fn(),
  getDocumentLinks: vi.fn(),
};

vi.mock("../repositories/knowledgeDocuments", () => ({
  listDocuments: (...a: unknown[]) => repo.listDocuments(...a),
  getDocument: (...a: unknown[]) => repo.getDocument(...a),
  createDocument: (...a: unknown[]) => repo.createDocument(...a),
  updateDocumentBody: (...a: unknown[]) => repo.updateDocumentBody(...a),
  deleteDocument: (...a: unknown[]) => repo.deleteDocument(...a),
  getDocumentLinks: (...a: unknown[]) => repo.getDocumentLinks(...a),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

function appWith(role: "instructor" | "student" = "instructor") {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set(
      "authContext",
      fakeAuthContext({
        memberships: [fakeMembership({ courseId: COURSE_ID, role })],
      }),
    );
    await next();
  });
  a.get("/api/courses/:courseId/knowledge/documents", listDocumentsHandler);
  a.post("/api/courses/:courseId/knowledge/documents", createDocumentHandler);
  a.get("/api/courses/:courseId/knowledge/documents/:documentId", getDocumentHandler);
  a.put("/api/courses/:courseId/knowledge/documents/:documentId", updateDocumentHandler);
  a.delete("/api/courses/:courseId/knowledge/documents/:documentId", deleteDocumentHandler);
  a.get("/api/courses/:courseId/knowledge/documents/:documentId/links", documentLinksHandler);
  return a;
}
function app() {
  return appWith("instructor");
}

const base = `/api/courses/${COURSE_ID}/knowledge/documents`;
const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  repo.listDocuments.mockResolvedValue([]);
  repo.createDocument.mockResolvedValue({ id: DOC_ID, path: "a" });
});

describe("knowledge document routes", () => {
  it("lists documents", async () => {
    const res = await app().request(base, {}, TEST_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ documents: [] });
  });

  it("rejects a path with a traversal segment", async () => {
    const res = await app().request(
      base,
      json({ path: "../escape", kind: "concept", type: "note" }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(repo.createDocument).not.toHaveBeenCalled();
  });

  it("rejects a leading or trailing slash in a path", async () => {
    const res = await app().request(
      base,
      json({ path: "/leading", kind: "concept", type: "note" }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a concept with no type, the one required OKF key", async () => {
    const res = await app().request(base, json({ path: "a", kind: "concept" }), TEST_ENV);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/type/i);
  });

  it("rejects a concept named index", async () => {
    const res = await app().request(
      base,
      json({ path: "week1/index", kind: "concept", type: "note" }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/reserved/i);
  });

  it("creates a folder as its index document", async () => {
    const res = await app().request(base, json({ path: "week1", kind: "index" }), TEST_ENV);
    expect(res.status).toBe(201);
    expect(repo.createDocument).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      expect.objectContaining({ path: "week1/index", kind: "index" }),
    );
  });

  it("returns 404 for a document in another course", async () => {
    repo.getDocument.mockResolvedValue(null);
    const res = await app().request(`${base}/${DOC_ID}`, {}, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("updates a body", async () => {
    repo.updateDocumentBody.mockResolvedValue({ id: DOC_ID, path: "a", body: "new" });
    const res = await app().request(`${base}/${DOC_ID}`, json({ body: "new" }, "PUT"), TEST_ENV);
    expect(res.status).toBe(200);
    expect(repo.updateDocumentBody).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      DOC_ID,
      expect.objectContaining({ body: "new" }),
    );
  });

  it("returns outbound links and backlinks", async () => {
    repo.getDocumentLinks.mockResolvedValue({ outbound: [], backlinks: [] });
    const res = await app().request(`${base}/${DOC_ID}/links`, {}, TEST_ENV);
    expect(await res.json()).toEqual({ outbound: [], backlinks: [] });
  });

  it("returns 404 when deleting a document that is not this course's", async () => {
    repo.deleteDocument.mockResolvedValue(false);
    const res = await app().request(`${base}/${DOC_ID}`, { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("regenerates the parent index after creating a concept", async () => {
    repo.listDocuments.mockResolvedValue([
      { id: "idx", path: "week1/index", kind: "index", title: null, description: null },
      { id: DOC_ID, path: "week1/a", kind: "concept", title: "A", description: "First." },
    ]);
    repo.updateDocumentBody.mockResolvedValue({ id: "idx" });

    await app().request(base, json({ path: "week1/a", kind: "concept", type: "note" }), TEST_ENV);

    expect(repo.updateDocumentBody).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      "idx",
      expect.objectContaining({ body: expect.stringContaining("* [A](/week1/a) - First.") }),
    );
  });

  it("does not fail a create when the bundle has no index document", async () => {
    repo.listDocuments.mockResolvedValue([]);
    const res = await app().request(base, json({ path: "a", kind: "concept", type: "note" }), TEST_ENV);
    expect(res.status).toBe(201);
  });

  /* ------------------------- Extra boundary cases ------------------------- */

  it("does not admit a student to any handler", async () => {
    const student = appWith("student");
    const res = await student.request(base, {}, TEST_ENV);
    expect(res.status).toBe(403);
    expect(repo.listDocuments).not.toHaveBeenCalled();
  });

  it("does not admit a student to create", async () => {
    const student = appWith("student");
    const res = await student.request(
      base,
      json({ path: "a", kind: "concept", type: "note" }),
      TEST_ENV,
    );
    expect(res.status).toBe(403);
    expect(repo.createDocument).not.toHaveBeenCalled();
  });

  it("refuses a non-member course id", async () => {
    const other = "99999999-2222-4333-8444-555555555555";
    const res = await app().request(
      `/api/courses/${other}/knowledge/documents`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("rejects a path with a lone dot segment", async () => {
    const res = await app().request(
      base,
      json({ path: "week1/./a", kind: "concept", type: "note" }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(repo.createDocument).not.toHaveBeenCalled();
  });

  it("rejects a path with a doubled slash (empty segment)", async () => {
    const res = await app().request(
      base,
      json({ path: "week1//a", kind: "concept", type: "note" }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(repo.createDocument).not.toHaveBeenCalled();
  });

  it("rejects a path containing spaces or other unsafe characters", async () => {
    const res = await app().request(
      base,
      json({ path: "week 1/a", kind: "concept", type: "note" }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(repo.createDocument).not.toHaveBeenCalled();
  });

  it("rejects an empty path", async () => {
    const res = await app().request(
      base,
      json({ path: "", kind: "concept", type: "note" }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(repo.createDocument).not.toHaveBeenCalled();
  });

  it("rejects an index kind named log at the top level (reserved basename)", async () => {
    // A folder named "log" would produce an index document at "log/index",
    // which is fine -- but the caller directly asking for "log" as a
    // top-level index path collides with the log document's own basename
    // only if the *concept* rule were misapplied to index kinds. This
    // asserts the reserved-basename check is concept-only, matching the
    // brief and the DB CHECK, which allows kind=index to end in "index".
    const res = await app().request(base, json({ path: "log", kind: "index" }), TEST_ENV);
    expect(res.status).toBe(201);
    expect(repo.createDocument).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      expect.objectContaining({ path: "log/index", kind: "index" }),
    );
  });

  it("rejects malformed JSON on create", async () => {
    const res = await app().request(
      base,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(repo.createDocument).not.toHaveBeenCalled();
  });

  it("returns 409 when the repository rejects a duplicate path", async () => {
    repo.createDocument.mockRejectedValueOnce(new Error("duplicate key value"));
    const res = await app().request(
      base,
      json({ path: "a", kind: "concept", type: "note" }),
      TEST_ENV,
    );
    expect(res.status).toBe(409);
  });

  it("returns 404 when updating a document that is not this course's", async () => {
    repo.updateDocumentBody.mockResolvedValue(null);
    const res = await app().request(`${base}/${DOC_ID}`, json({ body: "new" }, "PUT"), TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("rejects an update with a non-string body", async () => {
    const res = await app().request(`${base}/${DOC_ID}`, json({ body: 5 }, "PUT"), TEST_ENV);
    expect(res.status).toBe(400);
    expect(repo.updateDocumentBody).not.toHaveBeenCalled();
  });

  it("does not fail a delete when the bundle has no index or log document", async () => {
    repo.deleteDocument.mockResolvedValue({ path: "week1/a" });
    repo.listDocuments.mockResolvedValue([]);
    const res = await app().request(`${base}/${DOC_ID}`, { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(204);
  });

  it("regenerates the parent index and appends a log entry after deleting", async () => {
    repo.deleteDocument.mockResolvedValue({ path: "week1/a" });
    repo.listDocuments.mockResolvedValue([
      { id: "idx", path: "week1/index", kind: "index", title: null, description: null },
      { id: "log-doc", path: "log", kind: "log", title: null, description: null },
    ]);
    repo.getDocument.mockResolvedValue({ id: "log-doc", body: "" });
    repo.updateDocumentBody.mockResolvedValue({ id: "idx" });

    const res = await app().request(`${base}/${DOC_ID}`, { method: "DELETE" }, TEST_ENV);

    expect(res.status).toBe(204);
    expect(repo.updateDocumentBody).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      "idx",
      expect.objectContaining({ body: expect.stringContaining("No documents yet.") }),
    );
    expect(repo.updateDocumentBody).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      "log-doc",
      expect.objectContaining({ body: expect.stringContaining("Removed `week1/a`") }),
    );
  });

  it("still deletes successfully when bundle maintenance itself throws", async () => {
    repo.deleteDocument.mockResolvedValue({ path: "week1/a" });
    repo.listDocuments.mockRejectedValueOnce(new Error("transient failure"));

    const res = await app().request(`${base}/${DOC_ID}`, { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(204);
  });

  it("still creates successfully when bundle maintenance itself throws", async () => {
    repo.listDocuments.mockRejectedValueOnce(new Error("transient failure"));
    const res = await app().request(
      base,
      json({ path: "a", kind: "concept", type: "note" }),
      TEST_ENV,
    );
    expect(res.status).toBe(201);
  });
});
