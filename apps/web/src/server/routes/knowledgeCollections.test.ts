/* --------------------------------------------------------------------------
   #42: the collection routes' request contract -- who is admitted, which
   bodies are refused and with what sentence, and the resolve endpoint's two
   load-bearing behaviours (the empty-resolution short circuit, and the
   course-scope tenancy check on attachment writes).

   The repository suite (repositories/knowledgeCollections.db.test.ts) owns
   the data invariants against a real Postgres. This file owns the HTTP
   surface.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  attachCollectionHandler,
  createCollectionHandler,
  deleteCollectionHandler,
  detachCollectionHandler,
  getCollectionItemsHandler,
  listAttachmentsHandler,
  listCollectionsHandler,
  resolveKnowledgeHandler,
  setCollectionItemsHandler,
  updateCollectionHandler,
} from "./knowledgeCollections";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const COURSE_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_COURSE_ID = "99999999-2222-4333-8444-555555555555";
const COL_ID = "33333333-2222-4333-8444-555555555555";
const ATTACHMENT_ID = "44444444-2222-4333-8444-555555555555";
const DOC_ID = "55555555-2222-4333-8444-555555555555";
const HOMEWORK_ID = "66666666-2222-4333-8444-555555555555";
const SECTION_ID = "77777777-2222-4333-8444-555555555555";
const LLM_CONFIG_ID = "88888888-2222-4333-8444-555555555555";
const TEST_ENV = { DATABASE_URL: "ignored" } as Env;

const repo = {
  listCollections: vi.fn(),
  createCollection: vi.fn(),
  updateCollection: vi.fn(),
  deleteCollection: vi.fn(),
  setCollectionItems: vi.fn(),
  getCollectionItems: vi.fn(),
  listAttachments: vi.fn(),
  attachCollection: vi.fn(),
  detachCollection: vi.fn(),
  homeworkBelongsToCourse: vi.fn(),
  sectionBelongsToCourse: vi.fn(),
  resolveForTarget: vi.fn(),
  listDocumentsInCollections: vi.fn(),
};

vi.mock("../repositories/knowledgeCollections", () => ({
  listCollections: (...a: unknown[]) => repo.listCollections(...a),
  createCollection: (...a: unknown[]) => repo.createCollection(...a),
  updateCollection: (...a: unknown[]) => repo.updateCollection(...a),
  deleteCollection: (...a: unknown[]) => repo.deleteCollection(...a),
  setCollectionItems: (...a: unknown[]) => repo.setCollectionItems(...a),
  getCollectionItems: (...a: unknown[]) => repo.getCollectionItems(...a),
  listAttachments: (...a: unknown[]) => repo.listAttachments(...a),
  attachCollection: (...a: unknown[]) => repo.attachCollection(...a),
  detachCollection: (...a: unknown[]) => repo.detachCollection(...a),
  homeworkBelongsToCourse: (...a: unknown[]) => repo.homeworkBelongsToCourse(...a),
  sectionBelongsToCourse: (...a: unknown[]) => repo.sectionBelongsToCourse(...a),
  resolveForTarget: (...a: unknown[]) => repo.resolveForTarget(...a),
  listDocumentsInCollections: (...a: unknown[]) => repo.listDocumentsInCollections(...a),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

function appWith(role: "instructor" | "student") {
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
  a.get("/api/courses/:courseId/knowledge/collections", listCollectionsHandler);
  a.post("/api/courses/:courseId/knowledge/collections", createCollectionHandler);
  a.put("/api/courses/:courseId/knowledge/collections/:collectionId", updateCollectionHandler);
  a.delete("/api/courses/:courseId/knowledge/collections/:collectionId", deleteCollectionHandler);
  a.get("/api/courses/:courseId/knowledge/collections/:collectionId/items", getCollectionItemsHandler);
  a.put("/api/courses/:courseId/knowledge/collections/:collectionId/items", setCollectionItemsHandler);
  a.get("/api/courses/:courseId/knowledge/attachments", listAttachmentsHandler);
  a.post("/api/courses/:courseId/knowledge/collections/:collectionId/attachments", attachCollectionHandler);
  a.delete("/api/courses/:courseId/knowledge/attachments/:attachmentId", detachCollectionHandler);
  a.get("/api/courses/:courseId/knowledge/resolve", resolveKnowledgeHandler);
  return a;
}

function app() {
  return appWith("instructor");
}

const base = `/api/courses/${COURSE_ID}/knowledge`;
const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  repo.listCollections.mockResolvedValue([]);
  repo.createCollection.mockResolvedValue({ id: COL_ID, name: "Week 1" });
  repo.updateCollection.mockResolvedValue({ id: COL_ID, name: "Week 1 (edited)" });
  repo.deleteCollection.mockResolvedValue(true);
  repo.setCollectionItems.mockResolvedValue(true);
  repo.getCollectionItems.mockResolvedValue([{ documentId: DOC_ID }, { directoryPath: "wk" }]);
  repo.listAttachments.mockResolvedValue([]);
  repo.attachCollection.mockResolvedValue(true);
  repo.detachCollection.mockResolvedValue(true);
  repo.homeworkBelongsToCourse.mockResolvedValue(true);
  repo.sectionBelongsToCourse.mockResolvedValue(true);
  repo.resolveForTarget.mockResolvedValue({ level: "course", collectionIds: [COL_ID] });
  repo.listDocumentsInCollections.mockResolvedValue([
    { id: "d1", path: "a", indexStatus: "pending" },
  ]);
});

describe("collection routes", () => {
  it("lists collections", async () => {
    const res = await app().request(`${base}/collections`, {}, TEST_ENV);
    expect(await res.json()).toEqual({ collections: [] });
  });

  it("rejects a nameless collection", async () => {
    const res = await app().request(`${base}/collections`, json({ name: "" }), TEST_ENV);
    expect(res.status).toBe(400);
    expect(repo.createCollection).not.toHaveBeenCalled();
  });

  it("creates a collection using the caller's membership id", async () => {
    const res = await app().request(`${base}/collections`, json({ name: "Week 1" }), TEST_ENV);
    expect(res.status).toBe(201);
    expect(repo.createCollection).toHaveBeenCalledWith(
      {},
      COURSE_ID,
      expect.objectContaining({ name: "Week 1", createdById: expect.any(String) }),
    );
  });

  it("reports a duplicate collection name as a conflict", async () => {
    repo.createCollection.mockRejectedValue(new Error("unique violation"));
    const res = await app().request(`${base}/collections`, json({ name: "Week 1" }), TEST_ENV);
    expect(res.status).toBe(409);
  });

  it("updates a collection", async () => {
    const res = await app().request(
      `${base}/collections/${COL_ID}`,
      json({ name: "Renamed" }, "PUT"),
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: COL_ID, name: "Week 1 (edited)" });
  });

  it("404s updating a collection owned by another course", async () => {
    repo.updateCollection.mockResolvedValue(null);
    const res = await app().request(
      `${base}/collections/${COL_ID}`,
      json({ name: "Renamed" }, "PUT"),
      TEST_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("deletes a collection", async () => {
    const res = await app().request(`${base}/collections/${COL_ID}`, { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(204);
  });

  it("404s deleting a collection that does not exist in this course", async () => {
    repo.deleteCollection.mockResolvedValue(false);
    const res = await app().request(`${base}/collections/${COL_ID}`, { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("gets a collection's items, documents and directories distinguished", async () => {
    const res = await app().request(`${base}/collections/${COL_ID}/items`, {}, TEST_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [{ documentId: DOC_ID }, { directoryPath: "wk" }],
    });
    expect(repo.getCollectionItems).toHaveBeenCalledWith({}, COURSE_ID, COL_ID);
  });

  it("404s getting items for a collection belonging to another course", async () => {
    repo.getCollectionItems.mockResolvedValue(null);
    const res = await app().request(`${base}/collections/${COL_ID}/items`, {}, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("rejects an item naming both a document and a directory", async () => {
    const res = await app().request(
      `${base}/collections/${COL_ID}/items`,
      json({ items: [{ documentId: "d1", directoryPath: "wk" }] }, "PUT"),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(repo.setCollectionItems).not.toHaveBeenCalled();
  });

  it("rejects an item naming neither a document nor a directory", async () => {
    const res = await app().request(
      `${base}/collections/${COL_ID}/items`,
      json({ items: [{}] }, "PUT"),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(repo.setCollectionItems).not.toHaveBeenCalled();
  });

  it("accepts a mixed set of document and directory items", async () => {
    const res = await app().request(
      `${base}/collections/${COL_ID}/items`,
      json({ items: [{ documentId: DOC_ID }, { directoryPath: "wk" }] }, "PUT"),
      TEST_ENV,
    );
    expect(res.status).toBe(204);
  });

  it("accepts an empty item list, clearing the collection", async () => {
    const res = await app().request(
      `${base}/collections/${COL_ID}/items`,
      json({ items: [] }, "PUT"),
      TEST_ENV,
    );
    expect(res.status).toBe(204);
    expect(repo.setCollectionItems).toHaveBeenCalledWith({}, COURSE_ID, COL_ID, []);
  });

  it("404s setting items on a foreign collection without writing", async () => {
    repo.setCollectionItems.mockResolvedValue(false);
    const res = await app().request(
      `${base}/collections/${COL_ID}/items`,
      json({ items: [{ documentId: DOC_ID }] }, "PUT"),
      TEST_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("lists attachments", async () => {
    const res = await app().request(`${base}/attachments`, {}, TEST_ENV);
    expect(await res.json()).toEqual({ attachments: [] });
  });

  it("rejects an attachment scope that names the wrong course", async () => {
    const res = await app().request(
      `${base}/collections/${COL_ID}/attachments`,
      json({ scope: { kind: "course", courseId: OTHER_COURSE_ID } }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(repo.attachCollection).not.toHaveBeenCalled();
  });

  it("accepts an attachment scope naming this course", async () => {
    const res = await app().request(
      `${base}/collections/${COL_ID}/attachments`,
      json({ scope: { kind: "course", courseId: COURSE_ID } }),
      TEST_ENV,
    );
    expect(res.status).toBe(204);
    expect(repo.attachCollection).toHaveBeenCalledWith({}, COURSE_ID, COL_ID, {
      kind: "course",
      courseId: COURSE_ID,
    });
  });

  it("accepts a homework-scoped attachment when the homework belongs to this course", async () => {
    const res = await app().request(
      `${base}/collections/${COL_ID}/attachments`,
      json({ scope: { kind: "homework", homeworkId: HOMEWORK_ID } }),
      TEST_ENV,
    );
    expect(res.status).toBe(204);
    expect(repo.homeworkBelongsToCourse).toHaveBeenCalledWith({}, COURSE_ID, HOMEWORK_ID);
    expect(repo.attachCollection).toHaveBeenCalledWith({}, COURSE_ID, COL_ID, {
      kind: "homework",
      homeworkId: HOMEWORK_ID,
    });
  });

  it("rejects a homework-scoped attachment when the homework belongs to a different course, without writing", async () => {
    repo.homeworkBelongsToCourse.mockResolvedValue(false);
    const res = await app().request(
      `${base}/collections/${COL_ID}/attachments`,
      json({ scope: { kind: "homework", homeworkId: HOMEWORK_ID } }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(repo.attachCollection).not.toHaveBeenCalled();
  });

  it("accepts a section-scoped attachment when the section belongs to this course", async () => {
    const res = await app().request(
      `${base}/collections/${COL_ID}/attachments`,
      json({ scope: { kind: "section", sectionId: SECTION_ID } }),
      TEST_ENV,
    );
    expect(res.status).toBe(204);
    expect(repo.sectionBelongsToCourse).toHaveBeenCalledWith({}, COURSE_ID, SECTION_ID);
    expect(repo.attachCollection).toHaveBeenCalledWith({}, COURSE_ID, COL_ID, {
      kind: "section",
      sectionId: SECTION_ID,
    });
  });

  it("rejects a section-scoped attachment when the section belongs to a different course, without writing", async () => {
    repo.sectionBelongsToCourse.mockResolvedValue(false);
    const res = await app().request(
      `${base}/collections/${COL_ID}/attachments`,
      json({ scope: { kind: "section", sectionId: SECTION_ID } }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(repo.attachCollection).not.toHaveBeenCalled();
  });

  // Pinned deliberately: llm_configs is organization-scoped, not
  // course-scoped, and a shared org-level tutor config legitimately attaches
  // to many courses. This must keep succeeding with NO course check -- a
  // "fix" that made this symmetric with homework/section would be wrong.
  it("accepts an llmConfig-scoped attachment with no course check at all", async () => {
    const res = await app().request(
      `${base}/collections/${COL_ID}/attachments`,
      json({ scope: { kind: "llmConfig", llmConfigId: LLM_CONFIG_ID } }),
      TEST_ENV,
    );
    expect(res.status).toBe(204);
    expect(repo.homeworkBelongsToCourse).not.toHaveBeenCalled();
    expect(repo.sectionBelongsToCourse).not.toHaveBeenCalled();
    expect(repo.attachCollection).toHaveBeenCalledWith({}, COURSE_ID, COL_ID, {
      kind: "llmConfig",
      llmConfigId: LLM_CONFIG_ID,
    });
  });

  it("rejects an attachment scope of an unknown kind", async () => {
    const res = await app().request(
      `${base}/collections/${COL_ID}/attachments`,
      json({ scope: { kind: "bogus", id: "x" } }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(repo.attachCollection).not.toHaveBeenCalled();
  });

  it("404s attaching a foreign collection without writing", async () => {
    repo.attachCollection.mockResolvedValue(false);
    const res = await app().request(
      `${base}/collections/${COL_ID}/attachments`,
      json({ scope: { kind: "course", courseId: COURSE_ID } }),
      TEST_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("detaches an attachment", async () => {
    const res = await app().request(
      `${base}/attachments/${ATTACHMENT_ID}`,
      { method: "DELETE" },
      TEST_ENV,
    );
    expect(res.status).toBe(204);
  });

  it("404s detaching an attachment that does not belong to this course", async () => {
    repo.detachCollection.mockResolvedValue(false);
    const res = await app().request(
      `${base}/attachments/${ATTACHMENT_ID}`,
      { method: "DELETE" },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("resolves and expands to documents", async () => {
    const res = await app().request(`${base}/resolve?homeworkId=hw-1`, {}, TEST_ENV);
    expect(await res.json()).toEqual({
      level: "course",
      collectionIds: [COL_ID],
      documents: [{ id: "d1", path: "a", indexStatus: "pending" }],
    });
    expect(repo.resolveForTarget).toHaveBeenCalledWith(
      {},
      COURSE_ID,
      expect.objectContaining({ courseId: COURSE_ID, homeworkId: "hw-1" }),
    );
  });

  it("returns an empty resolution without querying documents", async () => {
    repo.resolveForTarget.mockResolvedValue({ level: "none", collectionIds: [] });
    const res = await app().request(`${base}/resolve`, {}, TEST_ENV);
    expect(await res.json()).toEqual({ level: "none", collectionIds: [], documents: [] });
    expect(repo.listDocumentsInCollections).not.toHaveBeenCalled();
  });

  it("resolves with all four scope query params", async () => {
    repo.resolveForTarget.mockResolvedValue({ level: "section", collectionIds: [COL_ID] });
    const res = await app().request(
      `${base}/resolve?homeworkId=hw-1&sectionId=sec-1&llmConfigId=cfg-1`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    expect(repo.resolveForTarget).toHaveBeenCalledWith(
      {},
      COURSE_ID,
      expect.objectContaining({
        courseId: COURSE_ID,
        homeworkId: "hw-1",
        sectionId: "sec-1",
        llmConfigId: "cfg-1",
      }),
    );
  });
});

describe("collection routes reject non-instructors", () => {
  const routes: Array<[string, string, unknown?]> = [
    ["GET", `${base}/collections`],
    ["POST", `${base}/collections`, { name: "x" }],
    ["PUT", `${base}/collections/${COL_ID}`, { name: "x" }],
    ["DELETE", `${base}/collections/${COL_ID}`],
    ["GET", `${base}/collections/${COL_ID}/items`],
    ["PUT", `${base}/collections/${COL_ID}/items`, { items: [] }],
    ["GET", `${base}/attachments`],
    ["POST", `${base}/collections/${COL_ID}/attachments`, { scope: { kind: "course", courseId: COURSE_ID } }],
    ["DELETE", `${base}/attachments/${ATTACHMENT_ID}`],
    ["GET", `${base}/resolve`],
  ];

  it.each(routes)("%s %s -> 403 for a student", async (method, path, body) => {
    const res = await appWith("student").request(
      path,
      body === undefined
        ? { method }
        : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });
});
