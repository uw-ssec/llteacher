import { CLEANUP_MAX_CHARS, CleanupError, proposeCleanup } from "../knowledge/cleanup";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { instructorScope } from "../utils/guards";
import { makeDb } from "../../db/client";
import { getCourseTitle } from "../repositories/courses";
import { deleteAllMaterials, deleteMaterialByDocumentPath, deleteMaterialsByDocumentPrefix } from "../repositories/materials";
import { storageFromEnv } from "../storage/objectStore";
import { logServerError } from "../utils/errors";
import { isValidConceptId } from "../knowledge/conceptId";
import {
  ConceptConflictError, ConceptExistsError, ConceptIdError, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, isValidDirectory, knowledgeServiceFromEnv,
  type Concept, type ConceptSummary,
} from "../knowledge/service";
import type { DocumentLinksPayload, KnowledgeDocumentListPayload, KnowledgeDocumentPayload } from "@llteacher/ui/api";

const DIR_RE = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
const RESOURCE_RE = /^llteacher:\/\/materials\/([0-9a-f-]{36})$/i;

const createSchema = z.object({
  path: z.string().min(1).max(400),
  kind: z.enum(["concept", "index"]),
  type: z.string().min(1).max(80).optional(),
  title: z.string().max(300).nullish(),
  description: z.string().max(1000).nullish(),
  body: z.string().default(""),
});
const updateSchema = z.object({ body: z.string(), expectedBody: z.string().optional() });

function toSummaryPayload(c: ConceptSummary) {
  return {
    id: c.id, path: c.id, kind: c.kind, type: c.type, title: c.title, description: c.description,
    tags: null, indexStatus: "indexed" as const,
    sourceMaterialId: c.resource ? (RESOURCE_RE.exec(c.resource)?.[1] ?? null) : null,
    updatedAt: c.updatedAt,
  };
}
function toDocumentPayload(c: Concept): KnowledgeDocumentPayload {
  return { ...toSummaryPayload(c), body: c.body, bodyOriginal: c.bodyOriginal ?? null, frontmatter: c.frontmatter, editedAt: null };
}
function conceptIdParam(c: Context<AppEnv>): string | null {
  const raw = c.req.param("documentId");
  if (!raw) return null;
  return isValidConceptId(raw) ? raw : null;
}
function idError(err: unknown) {
  return err instanceof ConceptIdError;
}

export async function listDocumentsHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);
  const documents = (await knowledgeServiceFromEnv(c.env).list(scope)).map(toSummaryPayload);
  return c.json({ documents } satisfies KnowledgeDocumentListPayload);
}

export async function createDocumentHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid document." }, 400);
  const input = parsed.data;
  const svc = knowledgeServiceFromEnv(c.env);
  try {
    if (input.kind === "index") {
      if (!DIR_RE.test(input.path)) return c.json({ error: "Folder names use lowercase letters, digits, and hyphens." }, 400);
      await svc.createDirectory(scope, input.path);
      return c.json({ id: `${input.path}/index`, path: `${input.path}/index`, kind: "index" }, 201);
    }
    if (!isValidConceptId(input.path)) return c.json({ error: "Paths use lowercase letters, digits, hyphens, and slashes; index and log are reserved." }, 400);
    if (!input.type) return c.json({ error: "A concept needs a type." }, 400);
    const created = await svc.create(scope, {
      id: input.path, type: input.type, title: input.title ?? input.path,
      description: input.description ?? "", body: input.body,
    });
    return c.json(toDocumentPayload(created), 201);
  } catch (err) {
    if (err instanceof ConceptExistsError) return c.json({ error: "A document already exists at that path." }, 409);
    if (idError(err)) return c.json({ error: "Invalid path." }, 400);
    throw err;
  }
}

export async function getDocumentHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);
  const id = conceptIdParam(c);
  if (!id) return c.json({ error: "Invalid document id." }, 400);
  const doc = await knowledgeServiceFromEnv(c.env).show(scope, id);
  return doc ? c.json(toDocumentPayload(doc)) : c.json({ error: "No such document." }, 404);
}

export async function updateDocumentHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);
  const id = conceptIdParam(c);
  if (!id) return c.json({ error: "Invalid document id." }, 400);
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid document body." }, 400);
  try {
    const updated = await knowledgeServiceFromEnv(c.env).update(scope, id, parsed.data);
    return updated ? c.json(toDocumentPayload(updated)) : c.json({ error: "No such document." }, 404);
  } catch (err) {
    if (err instanceof ConceptConflictError) return c.json({ error: err.message }, 409);
    throw err;
  }
}

export async function deleteDocumentHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);
  const id = conceptIdParam(c);
  if (!id) return c.json({ error: "Invalid document id." }, 400);
  const removed = await knowledgeServiceFromEnv(c.env).remove(scope, id);
  if (!removed) return c.json({ error: "No such document." }, 404);
  // ?withUpload=1: take the upload that produced this document with it, so
  // it does not sit at "ready" pointing at nothing, ready to be re-extracted
  // by a Retry. The default keeps it, for an instructor who wants to redo
  // the extraction later.
  if (flag(c.req.query("withUpload"))) {
    const material = await deleteMaterialByDocumentPath(makeDb(c.env.DATABASE_URL), scope, id);
    await dropStoredFiles(c, material ? [material] : []);
  }
  return c.body(null, 204);
}

function flag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/** Best effort: a stored file that will not delete is logged, not fatal --
 *  the rows are already gone and the console has nothing left to show. */
async function dropStoredFiles(c: Context<AppEnv>, rows: Array<{ storageKey: string | null }>): Promise<void> {
  const store = storageFromEnv(c.env);
  for (const row of rows) {
    if (!row.storageKey) continue;
    try {
      await store.delete(row.storageKey);
    } catch (error) {
      logServerError("knowledge.delete.storage", error);
    }
  }
}

/** A folder and everything under it. `?withUploads=1` also removes the
 *  uploads whose documents lived there. */
export async function deleteDirectoryHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);
  const directory = decodeURIComponent(c.req.param("directory") ?? "");
  if (!isValidDirectory(directory)) return c.json({ error: "Invalid directory." }, 400);
  const result = await knowledgeServiceFromEnv(c.env).removeDirectory(scope, directory);
  if (!result) return c.json({ error: "No such folder." }, 404);
  let uploads = 0;
  if (flag(c.req.query("withUploads"))) {
    const rows = await deleteMaterialsByDocumentPrefix(makeDb(c.env.DATABASE_URL), scope, `${directory}/`);
    await dropStoredFiles(c, rows);
    uploads = rows.length;
  }
  return c.json({ documents: result.removed.length, uploads });
}

const DELETE_PHRASE = "DELETE";

/** The whole knowledge base. Guarded by a typed phrase in the body, because
 *  it is the one action here the console cannot undo. */
export async function deleteKnowledgeBaseHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);
  const parsed = z
    .object({ confirm: z.string(), withUploads: z.boolean().optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || parsed.data.confirm !== DELETE_PHRASE) {
    return c.json({ error: `Type ${DELETE_PHRASE} to confirm.` }, 400);
  }
  const result = await knowledgeServiceFromEnv(c.env).removeBundle(scope);
  if (!result) return c.json({ error: "This course has no knowledge base yet." }, 404);
  let uploads = 0;
  if (parsed.data.withUploads) {
    const rows = await deleteAllMaterials(makeDb(c.env.DATABASE_URL), scope);
    await dropStoredFiles(c, rows);
    uploads = rows.length;
  }
  return c.json({ documents: result.removed, uploads });
}

export async function documentLinksHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);
  const id = conceptIdParam(c);
  if (!id) return c.json({ error: "Invalid document id." }, 400);
  const svc = knowledgeServiceFromEnv(c.env);
  const doc = await svc.show(scope, id);
  if (!doc) return c.json({ error: "No such document." }, 404);
  const report = await svc.validate(scope);
  const broken = report.brokenLinks.filter((b) => b.source === id).map((b) => b.target);
  const payload: DocumentLinksPayload = {
    outbound: [
      ...doc.outbound.map((t) => ({ rawHref: t, targetPath: t, resolvedDocumentId: t, isBroken: false })),
      ...broken.map((t) => ({ rawHref: t, targetPath: t, resolvedDocumentId: null, isBroken: true })),
    ],
    backlinks: doc.inbound.map((s) => ({ sourceDocumentId: s, sourcePath: s })),
  };
  return c.json(payload);
}

export async function searchKnowledgeHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);
  const q = (c.req.query("q") ?? "").trim();
  if (q === "") return c.json({ error: "q is required." }, 400);
  const limitRaw = Number(c.req.query("limit") ?? SEARCH_LIMIT_DEFAULT);
  const limit = Number.isInteger(limitRaw) ? Math.min(SEARCH_LIMIT_MAX, Math.max(1, limitRaw)) : SEARCH_LIMIT_DEFAULT;
  const dirRaw = (c.req.query("dir") ?? "").trim();
  if (dirRaw !== "" && !isValidDirectory(dirRaw)) return c.json({ error: "Invalid dir." }, 400);
  const dir = dirRaw === "" ? undefined : dirRaw;
  const hits = await knowledgeServiceFromEnv(c.env).search(scope, q, limit, dir);
  return c.json({ hits });
}

export async function cleanupDocumentHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);
  const id = conceptIdParam(c);
  if (!id) return c.json({ error: "Invalid document id." }, 400);
  const parsed = z.object({ body: z.string().min(1).max(CLEANUP_MAX_CHARS) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || !parsed.data.body.trim()) return c.json({ error: "Cleanup supports nonempty documents up to 60,000 characters." }, 400);
  const doc = await knowledgeServiceFromEnv(c.env).show(scope, id, { includeInbound: false });
  if (!doc) return c.json({ error: "No such document." }, 404);
  try { return c.json(await proposeCleanup(parsed.data.body, c.env)); }
  catch (err) {
    if (err instanceof CleanupError) return c.json({ error: err.message }, 502);
    throw err;
  }
}

/** One document as a Markdown attachment. Named after the last path segment
 *  so "lectures/module-1/intro" saves as intro.md; the folder is what the
 *  instructor was already looking at. */
export async function downloadDocumentHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);
  const id = conceptIdParam(c);
  if (!id) return c.json({ error: "Invalid document id." }, 400);
  const raw = await knowledgeServiceFromEnv(c.env).readRaw(scope, id);
  if (raw === null) return c.json({ error: "No such document." }, 404);
  const name = `${id.split("/").pop() ?? id}.md`;
  return c.body(raw, 200, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": `attachment; filename="${name}"`,
    "Cache-Control": "no-store",
  });
}

/** "<course>-knowledge-<YYYY-MM-DD>-<HHMM>Z": the course by name and the
 *  moment of download to the minute (UTC, marked as such), so a folder of
 *  these stays legible without opening any of them. */
async function exportBaseName(c: Context<AppEnv>, scope: string): Promise<string> {
  const title = await getCourseTitle(makeDb(c.env.DATABASE_URL), scope);
  const slug = title
    ? title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    : "";
  const course = slug || `course-${scope.slice(0, 8)}`;
  const now = new Date();
  const stamp = `${now.toISOString().slice(0, 10)}-${now.toISOString().slice(11, 13)}${now.toISOString().slice(14, 16)}Z`;
  return `${course}-knowledge-${stamp}`;
}

/** The whole bundle as a zip of its Markdown files. Originals are not
 *  included: pulling every stored upload through the server per request is
 *  a queued job, not a click. */
export async function exportKnowledgeHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);
  const zip = await knowledgeServiceFromEnv(c.env).exportBundle(scope);
  if (zip === null) return c.json({ error: "This course has no knowledge base yet." }, 404);
  const name = `${await exportBaseName(c, scope)}.zip`;
  return c.body(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer, 200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${name}"`,
    "Cache-Control": "no-store",
  });
}
