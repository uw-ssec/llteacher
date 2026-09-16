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
  createDocumentHandler,
  deleteDocumentHandler,
  documentLinksHandler,
  getDocumentHandler,
  listDocumentsHandler,
  searchKnowledgeHandler,
  updateDocumentHandler,
} from "./knowledgeDocuments";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const COURSE_ID = "11111111-2222-4333-8444-555555555555";
const TEST_ENV = { DATABASE_URL: "ignored" } as unknown as Env;

const svc = {
  list: vi.fn(), show: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(),
  createDirectory: vi.fn(), validate: vi.fn(), search: vi.fn(),
};
vi.mock("../knowledge/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../knowledge/service")>();
  return { ...actual, knowledgeServiceFromEnv: () => svc };
});
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

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
  a.get("/api/courses/:courseId/knowledge/documents", listDocumentsHandler);
  a.post("/api/courses/:courseId/knowledge/documents", createDocumentHandler);
  a.get("/api/courses/:courseId/knowledge/documents/:documentId", getDocumentHandler);
  a.put("/api/courses/:courseId/knowledge/documents/:documentId", updateDocumentHandler);
  a.delete("/api/courses/:courseId/knowledge/documents/:documentId", deleteDocumentHandler);
  a.get("/api/courses/:courseId/knowledge/documents/:documentId/links", documentLinksHandler);
  a.get("/api/courses/:courseId/knowledge/search", searchKnowledgeHandler);
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
  it("searches with a clamped limit", async () => {
    svc.search.mockResolvedValue([{ conceptId: CONCEPT.id, title: "Intro", type: "lecture", description: "Markets", score: 2 }]);
    const res = await app().request(`/api/courses/${COURSE_ID}/knowledge/search?q=markets&limit=50`, {}, TEST_ENV);
    expect(res.status).toBe(200);
    expect(svc.search).toHaveBeenCalledWith(COURSE_ID, "markets", 20);
    expect(((await res.json()) as { hits: unknown[] }).hits).toHaveLength(1);
    expect((await app().request(`/api/courses/${COURSE_ID}/knowledge/search`, {}, TEST_ENV)).status).toBe(400);
  });
});
