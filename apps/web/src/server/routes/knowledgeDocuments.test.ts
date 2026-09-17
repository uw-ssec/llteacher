/* --------------------------------------------------------------------------
   #42: the knowledge document routes' request contract, rewritten over
   KnowledgeService (the OKF bundle on disk) rather than the retired
   Postgres tables.

   This file owns who is admitted, path/id validation at the HTTP boundary,
   and payload mapping from ConceptSummary/Concept to the console's wire
   shape. The service's own tests own bundle behaviour (okf CLI calls, index
   regeneration, locking); this file mocks the service entirely.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  cleanupDocumentHandler,
  createDocumentHandler,
  deleteDocumentHandler,
  documentLinksHandler,
  getDocumentHandler,
  listDocumentsHandler,
  searchKnowledgeHandler,
  updateDocumentHandler,
  downloadDocumentHandler,
  exportKnowledgeHandler,
} from "./knowledgeDocuments";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const cleanupMock = vi.hoisted(() => vi.fn());
vi.mock("../knowledge/cleanup", async (original) => ({ ...await original<typeof import("../knowledge/cleanup")>(), proposeCleanup: cleanupMock }));

const COURSE_ID = "11111111-2222-4333-8444-555555555555";
const TEST_ENV = { DATABASE_URL: "ignored" } as unknown as Env;

const svc = {
  list: vi.fn(), show: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(),
  createDirectory: vi.fn(), validate: vi.fn(), search: vi.fn(), readRaw: vi.fn(), exportBundle: vi.fn(),
};
vi.mock("../knowledge/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../knowledge/service")>();
  return { ...actual, knowledgeServiceFromEnv: () => svc };
});
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));
const getCourseTitle = vi.fn();
vi.mock("../repositories/courses", () => ({ getCourseTitle: (...a: unknown[]) => getCourseTitle(...a) }));

const CONCEPT = {
  id: "lectures/module-1/intro", kind: "concept" as const, type: "lecture", title: "Intro", description: "Markets",
  resource: "llteacher://materials/33333333-3333-4333-8333-333333333333", updatedAt: "2026-09-15T00:00:00.000Z",
  body: "# Intro", frontmatter: { type: "lecture" }, outbound: ["syllabus"], inbound: [],
};
const ENC = encodeURIComponent(CONCEPT.id);

beforeEach(() => {
  vi.clearAllMocks();
  svc.list.mockResolvedValue([CONCEPT]);
  svc.show.mockResolvedValue(CONCEPT);
  svc.create.mockResolvedValue(CONCEPT);
  svc.update.mockResolvedValue(CONCEPT);
  svc.remove.mockResolvedValue(true);
  svc.createDirectory.mockResolvedValue(undefined);
  svc.validate.mockResolvedValue({ conceptCount: 1, brokenLinks: [], orphans: [], isConformant: true });
  svc.search.mockResolvedValue([]);
});

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
  a.post("/api/courses/:courseId/knowledge/documents/:documentId/cleanup", cleanupDocumentHandler);
  a.get("/api/courses/:courseId/knowledge/documents", listDocumentsHandler);
  a.post("/api/courses/:courseId/knowledge/documents", createDocumentHandler);
  a.get("/api/courses/:courseId/knowledge/documents/:documentId", getDocumentHandler);
  a.put("/api/courses/:courseId/knowledge/documents/:documentId", updateDocumentHandler);
  a.delete("/api/courses/:courseId/knowledge/documents/:documentId", deleteDocumentHandler);
  a.get("/api/courses/:courseId/knowledge/documents/:documentId/links", documentLinksHandler);
  a.get("/api/courses/:courseId/knowledge/search", searchKnowledgeHandler);
  a.get("/api/courses/:courseId/knowledge/documents/:documentId/download", downloadDocumentHandler);
  a.get("/api/courses/:courseId/knowledge/export", exportKnowledgeHandler);
  return a;
}
function app() {
  return appWith("instructor");
}

const base = `/api/courses/${COURSE_ID}/knowledge/documents`;

describe("knowledge document routes over the bundle", () => {
  it("rejects students", async () => {
    expect((await appWith("student").request(base, {}, TEST_ENV)).status).toBe(403);
  });
  it("lists concepts in the payload shape the console expects", async () => {
    const res = await app().request(base, {}, TEST_ENV);
    const body = (await res.json()) as { documents: unknown[] };
    expect(body.documents[0]).toMatchObject({
      id: CONCEPT.id, path: CONCEPT.id, kind: "concept", indexStatus: "indexed",
      sourceMaterialId: "33333333-3333-4333-8333-333333333333", tags: null,
    });
  });
  it("round-trips an encoded concept id in the URL", async () => {
    const res = await app().request(`${base}/${ENC}`, {}, TEST_ENV);
    expect(res.status).toBe(200);
    expect(svc.show).toHaveBeenCalledWith(COURSE_ID, CONCEPT.id);
    expect(((await res.json()) as { body: string }).body).toBe("# Intro");
  });
  it("404s an unknown concept and 400s a malformed id", async () => {
    svc.show.mockResolvedValue(null);
    expect((await app().request(`${base}/missing`, {}, TEST_ENV)).status).toBe(404);
    expect((await app().request(`${base}/${encodeURIComponent("Bad Id")}`, {}, TEST_ENV)).status).toBe(400);
  });
  it("creates a concept, requiring type", async () => {
    const ok = await app().request(base, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "notes/new", kind: "concept", type: "note", title: "New", description: "d", body: "b" }) }, TEST_ENV);
    expect(ok.status).toBe(201);
    expect(svc.create).toHaveBeenCalledWith(COURSE_ID, { id: "notes/new", type: "note", title: "New", description: "d", body: "b" });
    const noType = await app().request(base, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "notes/new", kind: "concept" }) }, TEST_ENV);
    expect(noType.status).toBe(400);
  });
  it("creates a folder through createDirectory", async () => {
    const res = await app().request(base, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "readings", kind: "index" }) }, TEST_ENV);
    expect(res.status).toBe(201);
    expect(svc.createDirectory).toHaveBeenCalledWith(COURSE_ID, "readings");
  });
  it("409s a duplicate and 400s reserved or invalid paths", async () => {
    const { ConceptExistsError } = await import("../knowledge/service");
    svc.create.mockRejectedValue(new ConceptExistsError("x"));
    const dup = await app().request(base, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "x", kind: "concept", type: "t" }) }, TEST_ENV);
    expect(dup.status).toBe(409);
    for (const path of ["index", "a/log", "Has Space", "../up"]) {
      const bad = await app().request(base, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, kind: "concept", type: "t" }) }, TEST_ENV);
      expect(bad.status).toBe(400);
    }
  });
  it("updates the body and deletes", async () => {
    const put = await app().request(`${base}/${ENC}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "new" }) }, TEST_ENV);
    expect(put.status).toBe(200);
    expect(svc.update).toHaveBeenCalledWith(COURSE_ID, CONCEPT.id, { body: "new" });
    const del = await app().request(`${base}/${ENC}`, { method: "DELETE" }, TEST_ENV);
    expect(del.status).toBe(204);
    svc.remove.mockResolvedValue(false);
    expect((await app().request(`${base}/${ENC}`, { method: "DELETE" }, TEST_ENV)).status).toBe(404);
  });
  it("reports links with broken ones from validate", async () => {
    svc.validate.mockResolvedValue({ conceptCount: 1, brokenLinks: [{ source: CONCEPT.id, target: "gone" }], orphans: [], isConformant: true });
    const res = await app().request(`${base}/${ENC}/links`, {}, TEST_ENV);
    const body = (await res.json()) as { outbound: unknown[]; backlinks: unknown[] };
    expect(body.outbound).toEqual(expect.arrayContaining([
      { rawHref: "syllabus", targetPath: "syllabus", resolvedDocumentId: "syllabus", isBroken: false },
      { rawHref: "gone", targetPath: "gone", resolvedDocumentId: null, isBroken: true },
    ]));
    expect(body.backlinks).toEqual([]);
  });
  it("passes a directory scope through to the service and rejects a bad one", async () => {
    svc.search.mockResolvedValue([]);
    const ok = await app().request(`/api/courses/${COURSE_ID}/knowledge/search?q=markets&dir=lectures%2Fmodule-1`, {}, TEST_ENV);
    expect(ok.status).toBe(200);
    expect(svc.search).toHaveBeenCalledWith(COURSE_ID, "markets", 8, "lectures/module-1");
    const bad = await app().request(`/api/courses/${COURSE_ID}/knowledge/search?q=markets&dir=..%2Fetc`, {}, TEST_ENV);
    expect(bad.status).toBe(400);
  });
  it("downloads one document as a Markdown attachment named after its last path segment", async () => {
    svc.readRaw.mockResolvedValue("---\ntitle: Intro\n---\n# Intro");
    const res = await app().request(`${base}/${ENC}/download`, {}, TEST_ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="intro.md"');
    expect(await res.text()).toContain("# Intro");
    expect(svc.readRaw).toHaveBeenCalledWith(COURSE_ID, CONCEPT.id);
    svc.readRaw.mockResolvedValue(null);
    expect((await app().request(`${base}/${ENC}/download`, {}, TEST_ENV)).status).toBe(404);
  });

  it("exports the bundle as a zip attachment", async () => {
    svc.exportBundle.mockResolvedValue(new Uint8Array([80, 75, 3, 4]));
    getCourseTitle.mockResolvedValue("STATS 311 · Autumn 2026");
    const res = await app().request(`/api/courses/${COURSE_ID}/knowledge/export`, {}, TEST_ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");
    // Course name, then the moment of download to the minute (UTC), so a
    // folder of these stays legible.
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="stats-311-autumn-2026-knowledge-\d{4}-\d{2}-\d{2}-\d{4}Z\.zip"$/,
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([80, 75, 3, 4]));
    getCourseTitle.mockResolvedValue(null);
    const unnamed = await app().request(`/api/courses/${COURSE_ID}/knowledge/export`, {}, TEST_ENV);
    expect(unnamed.headers.get("content-disposition")).toMatch(/^attachment; filename="course-11111111-knowledge-/);
    svc.exportBundle.mockResolvedValue(null);
    expect((await app().request(`/api/courses/${COURSE_ID}/knowledge/export`, {}, TEST_ENV)).status).toBe(404);
    expect((await appWith("student").request(`/api/courses/${COURSE_ID}/knowledge/export`, {}, TEST_ENV)).status).toBe(403);
  });

  it("searches with a clamped limit", async () => {
    svc.search.mockResolvedValue([{ conceptId: CONCEPT.id, title: "Intro", type: "lecture", description: "Markets", score: 2 }]);
    const res = await app().request(`/api/courses/${COURSE_ID}/knowledge/search?q=markets&limit=50`, {}, TEST_ENV);
    expect(res.status).toBe(200);
    expect(svc.search).toHaveBeenCalledWith(COURSE_ID, "markets", 20, undefined);
    expect(((await res.json()) as { hits: unknown[] }).hits).toHaveLength(1);
    expect((await app().request(`/api/courses/${COURSE_ID}/knowledge/search`, {}, TEST_ENV)).status).toBe(400);
  });
});

describe("cleanup proposals", () => {
  it("requires instructor access before invoking a model", async () => {
    const res = await appWith("student").request(`/api/courses/${COURSE_ID}/knowledge/documents/${ENC}/cleanup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "source" }) }, TEST_ENV);
    expect(res.status).toBe(403);
    expect(cleanupMock).not.toHaveBeenCalled();
  });
  it("proposes without saving and accepts the current editor draft", async () => {
    cleanupMock.mockResolvedValue({ body: "# Clean", warnings: [] });
    const res = await appWith().request(`/api/courses/${COURSE_ID}/knowledge/documents/${ENC}/cleanup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "unsaved draft" }) }, TEST_ENV);
    expect(res.status).toBe(200);
    expect(cleanupMock).toHaveBeenCalledWith("unsaved draft", TEST_ENV);
    expect(svc.update).not.toHaveBeenCalled();
  });
});
