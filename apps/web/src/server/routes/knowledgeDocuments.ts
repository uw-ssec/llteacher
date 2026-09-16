import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { instructorScope } from "../utils/guards";
import { isValidConceptId } from "../knowledge/conceptId";
import {
  ConceptExistsError, ConceptIdError, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, knowledgeServiceFromEnv,
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
const updateSchema = z.object({ body: z.string() });

function toSummaryPayload(c: ConceptSummary) {
  return {
    id: c.id, path: c.id, kind: c.kind, type: c.type, title: c.title, description: c.description,
    tags: null, indexStatus: "indexed" as const,
    sourceMaterialId: c.resource ? (RESOURCE_RE.exec(c.resource)?.[1] ?? null) : null,
    updatedAt: c.updatedAt,
  };
}
function toDocumentPayload(c: Concept): KnowledgeDocumentPayload {
  return { ...toSummaryPayload(c), body: c.body, bodyOriginal: null, frontmatter: c.frontmatter, editedAt: null };
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
  const updated = await knowledgeServiceFromEnv(c.env).update(scope, id, { body: parsed.data.body });
  return updated ? c.json(toDocumentPayload(updated)) : c.json({ error: "No such document." }, 404);
}

export async function deleteDocumentHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);
  const id = conceptIdParam(c);
  if (!id) return c.json({ error: "Invalid document id." }, 400);
  const removed = await knowledgeServiceFromEnv(c.env).remove(scope, id);
  return removed ? c.body(null, 204) : c.json({ error: "No such document." }, 404);
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
  const hits = await knowledgeServiceFromEnv(c.env).search(scope, q, limit);
  return c.json({ hits });
}
