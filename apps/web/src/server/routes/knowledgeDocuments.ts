import { CLEANUP_MAX_CHARS, CleanupError, proposeCleanup } from "../knowledge/cleanup";
import type { Context } from "hono";
import { Effect } from "effect";
import { z } from "zod";
import type { AppEnv } from "../context";
import { instructorScope } from "../utils/guards";
import type { CourseScope } from "../repositories/scope";
import { getCourseTitle, getKnowledgeInstructionParts, setKnowledgeInstruction, setKnowledgeInstructionDefault } from "../repositories/courses";
import { getOrgScopeForCourse } from "../repositories/organizations";
import { KNOWLEDGE_INSTRUCTION } from "../../lib/prompts";
import { deleteAllMaterials, deleteMaterialByDocumentPath, deleteMaterialsByDocumentPrefix } from "../repositories/materials";
import { storageFromEnv } from "../storage/objectStore";
import { logServerError } from "../utils/errors";
import { isValidConceptId } from "../knowledge/conceptId";
import {
  ConceptConflictError, ConceptExistsError, ConceptIdError, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, isValidDirectory, knowledgeServiceFromEnv,
  type Concept, type ConceptSummary, type KnowledgeService,
} from "../knowledge/service";
import { BadRequest, Conflict, Forbidden, NotFound } from "../effect/errors";
import { effectHandler } from "../effect/http";
import { external, query } from "../effect/services";
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
function conceptIdParam(c: Context<AppEnv>): Effect.Effect<string, BadRequest> {
  const raw = c.req.param("documentId");
  return raw && isValidConceptId(raw)
    ? Effect.succeed(raw)
    : Effect.fail(new BadRequest({ message: "Invalid document id." }));
}

/** instructorScope() as a typed refusal. */
function requireInstructorScope(c: Context<AppEnv>): Effect.Effect<CourseScope, Forbidden> {
  const scope = instructorScope(c);
  return scope ? Effect.succeed(scope) : Effect.fail(new Forbidden({ message: "Not permitted." }));
}

type ErrorClass = abstract new (...args: any[]) => Error;

/** One call to the knowledge service. Building the service is inside the
 *  call: KnowledgeNotConfiguredError (KNOWLEDGE_ROOT unset), like an okf CLI
 *  failure (OkfError), a write-lock timeout (WriteLockTimeoutError) or a
 *  persistence fault, is an ExternalServiceError -- logged, answered 503. */
function knowledge<A, const Expected extends readonly ErrorClass[] = []>(
  c: Context<AppEnv>,
  operation: string,
  run: (svc: KnowledgeService) => Promise<A>,
  expected?: Expected,
) {
  return external("knowledge", operation, async () => run(knowledgeServiceFromEnv(c.env)), expected);
}

export const listDocumentsHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const concepts = yield* knowledge(c, "list", (svc) => svc.list(scope));
  const documents = concepts.map(toSummaryPayload);
  return c.json({ documents } satisfies KnowledgeDocumentListPayload);
}));

export const createDocumentHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const parsed = createSchema.safeParse(yield* Effect.promise(() => c.req.json().catch(() => null)));
  if (!parsed.success) return yield* new BadRequest({ message: "Invalid document." });
  const input = parsed.data;
  const invalidPath = () => Effect.fail(new BadRequest({ message: "Invalid path." }));
  if (input.kind === "index") {
    if (!DIR_RE.test(input.path)) {
      return yield* new BadRequest({ message: "Folder names use lowercase letters, digits, and hyphens." });
    }
    yield* knowledge(c, "createDirectory", (svc) => svc.createDirectory(scope, input.path), [ConceptIdError]).pipe(
      Effect.catchTags({ ConceptIdError: invalidPath }),
    );
    return c.json({ id: `${input.path}/index`, path: `${input.path}/index`, kind: "index" }, 201);
  }
  if (!isValidConceptId(input.path)) {
    return yield* new BadRequest({ message: "Paths use lowercase letters, digits, hyphens, and slashes; index and log are reserved." });
  }
  const type = input.type;
  if (!type) return yield* new BadRequest({ message: "A concept needs a type." });
  const created = yield* knowledge(
    c,
    "create",
    (svc) => svc.create(scope, {
      id: input.path, type, title: input.title ?? input.path,
      description: input.description ?? "", body: input.body,
    }),
    [ConceptExistsError, ConceptIdError],
  ).pipe(Effect.catchTags({
    ConceptExistsError: () => Effect.fail(new Conflict({ message: "A document already exists at that path." })),
    ConceptIdError: invalidPath,
  }));
  return c.json(toDocumentPayload(created), 201);
}));

export const getDocumentHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const id = yield* conceptIdParam(c);
  const doc = yield* knowledge(c, "show", (svc) => svc.show(scope, id));
  return doc ? c.json(toDocumentPayload(doc)) : yield* new NotFound({ message: "No such document." });
}));

export const updateDocumentHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const id = yield* conceptIdParam(c);
  const parsed = updateSchema.safeParse(yield* Effect.promise(() => c.req.json().catch(() => null)));
  if (!parsed.success) return yield* new BadRequest({ message: "Invalid document body." });
  const updated = yield* knowledge(c, "update", (svc) => svc.update(scope, id, parsed.data), [ConceptConflictError]).pipe(
    Effect.catchTags({
      ConceptConflictError: (err) => Effect.fail(new Conflict({ message: err.message })),
    }),
  );
  return updated ? c.json(toDocumentPayload(updated)) : yield* new NotFound({ message: "No such document." });
}));

export const deleteDocumentHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const id = yield* conceptIdParam(c);
  const removed = yield* knowledge(c, "remove", (svc) => svc.remove(scope, id));
  if (!removed) return yield* new NotFound({ message: "No such document." });
  // ?withUpload=1: take the upload that produced this document with it, so
  // it does not sit at "ready" pointing at nothing, ready to be re-extracted
  // by a Retry. The default keeps it, for an instructor who wants to redo
  // the extraction later.
  if (flag(c.req.query("withUpload"))) {
    const material = yield* query("deleteMaterialByDocumentPath", async (db) => deleteMaterialByDocumentPath(db, scope, id));
    yield* dropStoredFiles(c, material ? [material] : []);
  }
  return c.body(null, 204);
}));

function flag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/** Best effort: a stored file that will not delete is logged, not fatal --
 *  the rows are already gone and the console has nothing left to show.
 *  The store is built per row, inside the guarded call, so an unconfigured
 *  store (StorageNotConfiguredError) is logged like any other storage
 *  failure rather than failing a delete that already happened. */
function dropStoredFiles(c: Context<AppEnv>, rows: Array<{ storageKey: string | null }>): Effect.Effect<void> {
  return Effect.forEach(rows, (row) => {
    const storageKey = row.storageKey;
    if (!storageKey) return Effect.void;
    return external("storage", "deleteMaterial", async () => storageFromEnv(c.env).delete(storageKey)).pipe(
      Effect.catchTag("ExternalServiceError", (error) =>
        Effect.sync(() => logServerError("knowledge.delete.storage", error.cause))),
    );
  }, { discard: true });
}

/** A folder and everything under it. `?withUploads=1` also removes the
 *  uploads whose documents lived there. */
export const deleteDirectoryHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const invalidDirectory = () => new BadRequest({ message: "Invalid directory." });
  // Hono has already decoded the param once; a literal "%" left over (sent
  // as %25) makes this second decode throw URIError. That is a malformed
  // path, not an outage.
  const directory = yield* Effect.try({
    try: () => decodeURIComponent(c.req.param("directory") ?? ""),
    catch: invalidDirectory,
  });
  if (!isValidDirectory(directory)) return yield* invalidDirectory();
  const result = yield* knowledge(c, "removeDirectory", (svc) => svc.removeDirectory(scope, directory));
  if (!result) return yield* new NotFound({ message: "No such folder." });
  let uploads = 0;
  if (flag(c.req.query("withUploads"))) {
    const rows = yield* query(
      "deleteMaterialsByDocumentPrefix",
      async (db) => deleteMaterialsByDocumentPrefix(db, scope, `${directory}/`),
    );
    yield* dropStoredFiles(c, rows);
    uploads = rows.length;
  }
  return c.json({ documents: result.removed.length, uploads });
}));

const DELETE_PHRASE = "DELETE";

/** The whole knowledge base. Guarded by a typed phrase in the body, because
 *  it is the one action here the console cannot undo. */
export const deleteKnowledgeBaseHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const parsed = z
    .object({ confirm: z.string(), withUploads: z.boolean().optional() })
    .safeParse(yield* Effect.promise(() => c.req.json().catch(() => null)));
  if (!parsed.success || parsed.data.confirm !== DELETE_PHRASE) {
    return yield* new BadRequest({ message: `Type ${DELETE_PHRASE} to confirm.` });
  }
  const result = yield* knowledge(c, "removeBundle", (svc) => svc.removeBundle(scope));
  if (!result) return yield* new NotFound({ message: "This course has no knowledge base yet." });
  let uploads = 0;
  if (parsed.data.withUploads) {
    const rows = yield* query("deleteAllMaterials", async (db) => deleteAllMaterials(db, scope));
    yield* dropStoredFiles(c, rows);
    uploads = rows.length;
  }
  return c.json({ documents: result.removed, uploads });
}));

export const documentLinksHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const id = yield* conceptIdParam(c);
  const doc = yield* knowledge(c, "show", (svc) => svc.show(scope, id));
  if (!doc) return yield* new NotFound({ message: "No such document." });
  const report = yield* knowledge(c, "validate", (svc) => svc.validate(scope));
  const broken = report.brokenLinks.filter((b) => b.source === id).map((b) => b.target);
  const payload: DocumentLinksPayload = {
    outbound: [
      ...doc.outbound.map((t) => ({ rawHref: t, targetPath: t, resolvedDocumentId: t, isBroken: false })),
      ...broken.map((t) => ({ rawHref: t, targetPath: t, resolvedDocumentId: null, isBroken: true })),
    ],
    backlinks: doc.inbound.map((s) => ({ sourceDocumentId: s, sourcePath: s })),
  };
  return c.json(payload);
}));

export const searchKnowledgeHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const q = (c.req.query("q") ?? "").trim();
  if (q === "") return yield* new BadRequest({ message: "q is required." });
  const limitRaw = Number(c.req.query("limit") ?? SEARCH_LIMIT_DEFAULT);
  const limit = Number.isInteger(limitRaw) ? Math.min(SEARCH_LIMIT_MAX, Math.max(1, limitRaw)) : SEARCH_LIMIT_DEFAULT;
  const dirRaw = (c.req.query("dir") ?? "").trim();
  if (dirRaw !== "" && !isValidDirectory(dirRaw)) return yield* new BadRequest({ message: "Invalid dir." });
  const dir = dirRaw === "" ? undefined : dirRaw;
  const hits = yield* knowledge(c, "search", (svc) => svc.search(scope, q, limit, dir));
  return c.json({ hits });
}));

export const cleanupDocumentHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const id = yield* conceptIdParam(c);
  const parsed = z.object({ body: z.string().min(1).max(CLEANUP_MAX_CHARS) })
    .safeParse(yield* Effect.promise(() => c.req.json().catch(() => null)));
  if (!parsed.success || !parsed.data.body.trim()) {
    return yield* new BadRequest({ message: "Cleanup supports nonempty documents up to 60,000 characters." });
  }
  const doc = yield* knowledge(c, "show", (svc) => svc.show(scope, id, { includeInbound: false }));
  if (!doc) return yield* new NotFound({ message: "No such document." });
  // CleanupError is every way the model call can fail (unreachable, non-2xx,
  // invalid output); its message is written for the instructor. 502 is not
  // one of the bridge's request outcomes, so it stays a Response.
  return yield* external("llm", "proposeCleanup", () => proposeCleanup(parsed.data.body, c.env), [CleanupError]).pipe(
    Effect.map((proposal) => c.json(proposal)),
    Effect.catchTag("CleanupError", (err) => Effect.succeed(c.json({ error: err.message }, 502))),
  );
}));

/** One document as a Markdown attachment. Named after the last path segment
 *  so "lectures/module-1/intro" saves as intro.md; the folder is what the
 *  instructor was already looking at. */
export const downloadDocumentHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const id = yield* conceptIdParam(c);
  const raw = yield* knowledge(c, "readRaw", (svc) => svc.readRaw(scope, id));
  if (raw === null) return yield* new NotFound({ message: "No such document." });
  const name = `${id.split("/").pop() ?? id}.md`;
  return c.body(raw, 200, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": `attachment; filename="${name}"`,
    "Cache-Control": "no-store",
  });
}));

/** "<course>-knowledge-<YYYY-MM-DD>-<HHMM>Z": the course by name and the
 *  moment of download to the minute (UTC, marked as such), so a folder of
 *  these stays legible without opening any of them. */
function exportBaseName(scope: CourseScope) {
  return query("getCourseTitle", async (db) => getCourseTitle(db, scope)).pipe(Effect.map((title) => {
    const slug = title
      ? title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      : "";
    const course = slug || `course-${scope.slice(0, 8)}`;
    const now = new Date();
    const stamp = `${now.toISOString().slice(0, 10)}-${now.toISOString().slice(11, 13)}${now.toISOString().slice(14, 16)}Z`;
    return `${course}-knowledge-${stamp}`;
  }));
}

/** The whole bundle as a zip of its Markdown files. Originals are not
 *  included: pulling every stored upload through the server per request is
 *  a queued job, not a click. */
export const exportKnowledgeHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const zip = yield* knowledge(c, "exportBundle", (svc) => svc.exportBundle(scope));
  if (zip === null) return yield* new NotFound({ message: "This course has no knowledge base yet." });
  const name = `${yield* exportBaseName(scope)}.zip`;
  return c.body(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer, 200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${name}"`,
    "Cache-Control": "no-store",
  });
}));

/** Cap on the instructor's own instruction: it is one paragraph in the
 *  system prompt, not a second prompt. */
export const KNOWLEDGE_INSTRUCTION_MAX_CHARS = 2000;

/** Both layers plus the resolved default, so the console can show what
 *  "reset" would restore and offer "set as default" honestly. */
function instructionPayload(parts: { instruction: string | null; orgDefault: string | null }) {
  return {
    instruction: parts.instruction,
    orgDefault: parts.orgDefault,
    default: parts.orgDefault ?? KNOWLEDGE_INSTRUCTION,
    builtin: KNOWLEDGE_INSTRUCTION,
    maxChars: KNOWLEDGE_INSTRUCTION_MAX_CHARS,
  };
}

const instructionBody = z.object({ instruction: z.string().max(KNOWLEDGE_INSTRUCTION_MAX_CHARS).nullable() });

const invalidInstruction = () =>
  new BadRequest({ message: `The instruction must be text of at most ${KNOWLEDGE_INSTRUCTION_MAX_CHARS} characters.` });

export const getKnowledgeInstructionHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const parts = yield* query("getKnowledgeInstructionParts", async (db) => getKnowledgeInstructionParts(db, scope));
  return c.json(instructionPayload(parts));
}));

/** Null or blank means "back to the default". The guard sentence is not
 *  stored here; the prompt assembly appends it whatever this says. */
export const putKnowledgeInstructionHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const parsed = instructionBody.safeParse(yield* Effect.promise(() => c.req.json().catch(() => null)));
  if (!parsed.success) return yield* invalidInstruction();
  const text = parsed.data.instruction?.trim() || null;
  yield* query("setKnowledgeInstruction", async (db) => setKnowledgeInstruction(db, scope, text));
  const parts = yield* query("getKnowledgeInstructionParts", async (db) => getKnowledgeInstructionParts(db, scope));
  return c.json(instructionPayload(parts));
}));

/** Makes the given text the default for every course in the organisation
 *  that has no text of its own. Null clears it back to the built-in. */
export const putKnowledgeInstructionDefaultHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const orgScope = yield* query("getOrgScopeForCourse", async (db) => getOrgScopeForCourse(db, scope));
  if (!orgScope) return yield* new Forbidden({ message: "Not permitted." });
  const parsed = instructionBody.safeParse(yield* Effect.promise(() => c.req.json().catch(() => null)));
  if (!parsed.success) return yield* invalidInstruction();
  const text = parsed.data.instruction?.trim() || null;
  yield* query("setKnowledgeInstructionDefault", async (db) => setKnowledgeInstructionDefault(db, orgScope, text));
  const parts = yield* query("getKnowledgeInstructionParts", async (db) => getKnowledgeInstructionParts(db, scope));
  return c.json(instructionPayload(parts));
}));
