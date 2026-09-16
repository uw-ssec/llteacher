import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { runOkf, OkfError } from "./okfCli";
import { withWriteLock } from "./writeLock";
import { isValidConceptId } from "./conceptId";
import { parseFrontmatter, setFrontmatterKeys } from "./frontmatter";
import { parseLinks } from "./parseLinks";
import { appendLogEntry, renderIndex, type IndexEntry } from "./bundle";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIR_RE = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
export const SEARCH_LIMIT_DEFAULT = 8;
export const SEARCH_LIMIT_MAX = 20;

export class ConceptIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConceptIdError";
  }
}
export class ConceptExistsError extends Error {
  constructor(id: string) {
    super(`A concept already exists at ${id}`);
    this.name = "ConceptExistsError";
  }
}

export interface ConceptSummary {
  id: string;
  kind: "concept" | "index" | "log";
  type: string | null;
  title: string | null;
  description: string | null;
  resource: string | null;
  updatedAt: string;
}
export interface SearchHit { conceptId: string; title: string; type: string; description: string; score: number }
export interface Concept extends ConceptSummary {
  body: string;
  frontmatter: Record<string, string>;
  outbound: string[];
  inbound: string[];
}
export interface CreateConcept { id: string; type: string; title: string; description: string; body: string; resource?: string }
export interface ValidationReport {
  conceptCount: number;
  brokenLinks: Array<{ source: string; target: string }>;
  orphans: string[];
  isConformant: boolean;
}

export interface KnowledgeService {
  ensureBundle(courseId: string): Promise<void>;
  list(courseId: string): Promise<ConceptSummary[]>;
  search(courseId: string, query: string, limit?: number): Promise<SearchHit[]>;
  show(courseId: string, conceptId: string): Promise<Concept | null>;
  create(courseId: string, input: CreateConcept): Promise<Concept>;
  update(courseId: string, conceptId: string, patch: { body?: string; title?: string; description?: string }): Promise<Concept | null>;
  relate(courseId: string, from: string, to: string, context: string): Promise<void>;
  remove(courseId: string, conceptId: string): Promise<boolean>;
  createDirectory(courseId: string, directory: string): Promise<void>;
  validate(courseId: string): Promise<ValidationReport>;
}

interface OkfSearchRow { concept_id: string; title: string; type: string; description: string; score: number }
interface OkfValidate {
  concept_count: number;
  // Confirmed against okf 0.1.5 by running `okf validate --json` on a
  // bundle with one broken link: the field names are `source_concept` and
  // `target_href` (both carry a ".md" suffix), not the `source`/`target`
  // guessed before verifying.
  broken_links: Array<{ source_concept: string; target_href: string }> | null;
  orphans: string[] | null;
  is_conformant: boolean;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function kindOf(id: string): ConceptSummary["kind"] {
  const base = id.split("/").pop();
  if (id === "log") return "log";
  if (base === "index") return "index";
  return "concept";
}

export class OkfKnowledgeService implements KnowledgeService {
  private readonly root: string;
  private readonly binary: string;

  constructor(opts: { root: string; binary: string }) {
    this.root = realpathSync(opts.root);
    this.binary = opts.binary;
  }

  private courseDir(courseId: string): string {
    if (!UUID_RE.test(courseId)) throw new ConceptIdError("Invalid course id");
    return path.join(this.root, "courses", courseId.toLowerCase());
  }
  private bundleDir(courseId: string): string {
    return path.join(this.courseDir(courseId), "knowledge");
  }
  private lockPath(courseId: string): string {
    return path.join(this.courseDir(courseId), ".write.lock");
  }
  private conceptFile(courseId: string, conceptId: string): string {
    if (!isValidConceptId(conceptId)) throw new ConceptIdError(`Invalid concept id: ${conceptId}`);
    return path.join(this.bundleDir(courseId), `${conceptId}.md`);
  }

  // The write lock file lives at courses/{courseId}/.write.lock. withWriteLock
  // opens it with O_EXCL ("wx"), which requires the parent directory to
  // already exist -- it does not create one. ensureBundle() (which mkdirs
  // courses/{courseId}/knowledge, and so courses/{courseId} as an ancestor)
  // normally runs *inside* the locked callback, which is too late the very
  // first time a course is touched. So every write path must guarantee the
  // course directory exists before calling withWriteLock, not after.
  private async ensureCourseDir(courseId: string): Promise<void> {
    await fs.mkdir(this.courseDir(courseId), { recursive: true });
  }

  async ensureBundle(courseId: string): Promise<void> {
    const dir = this.bundleDir(courseId);
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.access(path.join(dir, "index.md"));
    } catch {
      await runOkf<string>(this.binary, ["init", dir], { json: false }); // init prints text, not JSON
    }
  }

  async list(courseId: string): Promise<ConceptSummary[]> {
    const dir = this.bundleDir(courseId);
    try {
      await fs.access(dir);
    } catch {
      return [];
    }
    const files = await walkMarkdown(dir, "");
    const out: ConceptSummary[] = [];
    for (const rel of files) {
      const id = rel.replace(/\.md$/, "");
      const full = path.join(dir, rel);
      const [raw, stat] = await Promise.all([fs.readFile(full, "utf8"), fs.stat(full)]);
      const { frontmatter } = parseFrontmatter(raw);
      out.push({
        id,
        kind: kindOf(id),
        type: frontmatter.type ?? null,
        title: frontmatter.title ?? null,
        description: frontmatter.description ?? null,
        resource: frontmatter.resource ?? null,
        updatedAt: stat.mtime.toISOString(),
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async search(courseId: string, query: string, limit = SEARCH_LIMIT_DEFAULT): Promise<SearchHit[]> {
    const dir = this.bundleDir(courseId);
    const q = query.trim();
    if (q === "") return [];
    const n = Math.min(Math.max(1, Math.floor(limit)), SEARCH_LIMIT_MAX);
    const rows = await runOkf<OkfSearchRow[] | null>(this.binary, ["search", q, dir, "--limit", String(n)]).catch(
      (err) => {
        if (err instanceof OkfError && /no such file|not found|does not exist/i.test(err.stderr)) return null;
        throw err;
      },
    );
    return (rows ?? []).map((r) => ({
      conceptId: r.concept_id,
      title: r.title ?? r.concept_id,
      type: r.type ?? "",
      description: r.description ?? "",
      score: r.score,
    }));
  }

  async show(courseId: string, conceptId: string): Promise<Concept | null> {
    const file = this.conceptFile(courseId, conceptId);
    const dir = this.bundleDir(courseId);
    let raw: string;
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      [raw, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    } catch {
      return null;
    }
    const { frontmatter, body } = parseFrontmatter(raw);
    const outbound = await uniqueExisting(
      parseLinks(body, conceptId).map((l) => l.targetPath),
      dir,
    );
    const inbound = await this.inboundFor(courseId, conceptId);
    return {
      id: conceptId,
      kind: kindOf(conceptId),
      type: frontmatter.type ?? null,
      title: frontmatter.title ?? null,
      description: frontmatter.description ?? null,
      resource: frontmatter.resource ?? null,
      updatedAt: stat.mtime.toISOString(),
      body,
      frontmatter,
      outbound,
      inbound,
    };
  }

  private async inboundFor(courseId: string, conceptId: string): Promise<string[]> {
    const dir = this.bundleDir(courseId);
    const files = await walkMarkdown(dir, "");
    const sources: string[] = [];
    for (const rel of files) {
      const id = rel.replace(/\.md$/, "");
      if (id === conceptId || kindOf(id) !== "concept") continue;
      const { body } = parseFrontmatter(await fs.readFile(path.join(dir, rel), "utf8"));
      if (parseLinks(body, id).some((l) => l.targetPath === conceptId)) sources.push(id);
    }
    return sources.sort();
  }

  async create(courseId: string, input: CreateConcept): Promise<Concept> {
    const file = this.conceptFile(courseId, input.id);
    const dir = this.bundleDir(courseId);
    await this.ensureCourseDir(courseId);
    return withWriteLock(this.lockPath(courseId), async () => {
      await this.ensureBundle(courseId);
      if (await exists(file)) throw new ConceptExistsError(input.id);
      await runOkf(this.binary, [
        "create", input.id, dir,
        "--type", input.type, "--title", input.title, "--desc", input.description,
      ]);
      if (input.body.trim() !== "") {
        await runOkf(this.binary, ["update", input.id, dir, "--body", input.body]);
      }
      const keys: Record<string, string> = { status: "generated" };
      if (input.resource) keys.resource = input.resource;
      const raw = await fs.readFile(file, "utf8");
      await fs.writeFile(file, setFrontmatterKeys(raw, keys));
      const created = await this.show(courseId, input.id);
      if (!created) throw new Error(`okf create reported success but ${input.id} is missing`);
      return created;
    });
  }

  async update(
    courseId: string,
    conceptId: string,
    patch: { body?: string; title?: string; description?: string },
  ): Promise<Concept | null> {
    const file = this.conceptFile(courseId, conceptId);
    const dir = this.bundleDir(courseId);
    await this.ensureCourseDir(courseId);
    return withWriteLock(this.lockPath(courseId), async () => {
      if (!(await exists(file))) return null;
      const before = parseFrontmatter(await fs.readFile(file, "utf8")).frontmatter;
      const args = ["update", conceptId, dir];
      if (patch.body !== undefined) args.push("--body", patch.body);
      if (patch.title !== undefined) args.push("--title", patch.title);
      if (patch.description !== undefined) args.push("--desc", patch.description);
      if (args.length > 3) await runOkf(this.binary, args);
      // okf update preserves scalar extra keys today; re-assert the two the
      // app owns so a future okf that drops them cannot silently lose them.
      const keep: Record<string, string> = {};
      if (before.resource) keep.resource = before.resource;
      if (before.status) keep.status = before.status;
      if (Object.keys(keep).length > 0) {
        const raw = await fs.readFile(file, "utf8");
        await fs.writeFile(file, setFrontmatterKeys(raw, keep));
      }
      return this.show(courseId, conceptId);
    });
  }

  async relate(courseId: string, from: string, to: string, context: string): Promise<void> {
    this.conceptFile(courseId, from);
    this.conceptFile(courseId, to);
    const dir = this.bundleDir(courseId);
    await this.ensureCourseDir(courseId);
    await withWriteLock(this.lockPath(courseId), async () => {
      await runOkf(this.binary, ["relate", from, to, dir, "--desc", context]);
    });
  }

  async remove(courseId: string, conceptId: string): Promise<boolean> {
    const file = this.conceptFile(courseId, conceptId);
    const dir = this.bundleDir(courseId);
    await this.ensureCourseDir(courseId);
    return withWriteLock(this.lockPath(courseId), async () => {
      if (!(await exists(file))) return false;
      await fs.unlink(file);
      await this.regenerateIndex(courseId, path.posix.dirname(conceptId) === "." ? "" : path.posix.dirname(conceptId));
      await this.appendLog(dir, `**Deletion**: Removed concept \`${conceptId}.md\`.`);
      return true;
    });
  }

  async createDirectory(courseId: string, directory: string): Promise<void> {
    if (!DIR_RE.test(directory)) throw new ConceptIdError(`Invalid directory: ${directory}`);
    const dir = this.bundleDir(courseId);
    await this.ensureCourseDir(courseId);
    await withWriteLock(this.lockPath(courseId), async () => {
      await this.ensureBundle(courseId);
      const target = path.join(dir, directory);
      await fs.mkdir(target, { recursive: true });
      const indexFile = path.join(target, "index.md");
      if (!(await exists(indexFile))) {
        await fs.writeFile(indexFile, renderIndex(directory, []));
        await this.appendLog(dir, `**Creation**: Created directory \`${directory}/\`.`);
      }
    });
  }

  async validate(courseId: string): Promise<ValidationReport> {
    const dir = this.bundleDir(courseId);
    await this.ensureBundle(courseId);
    const r = await runOkf<OkfValidate>(this.binary, ["validate", dir]);
    return {
      conceptCount: r.concept_count,
      brokenLinks: (r.broken_links ?? []).map((b) => ({
        source: stripMd(b.source_concept),
        target: stripMd(b.target_href),
      })),
      orphans: r.orphans ?? [],
      isConformant: r.is_conformant,
    };
  }

  // Rebuilds directory/index.md from the concept files that remain in
  // `directory` after a create or delete. Entry paths are bundle-root
  // relative (e.g. "d/two", not "two") because renderIndex always emits a
  // bundle-absolute href (`/${entry.path}`, no directory prefix of its own
  // and no ".md" suffix) -- see bundle.ts. Passing just the file's basename
  // here would produce a link that resolves from the bundle root instead of
  // from `directory`, silently pointing at the wrong file for any nested
  // directory.
  private async regenerateIndex(courseId: string, directory: string): Promise<void> {
    const dir = this.bundleDir(courseId);
    const target = path.join(dir, directory);
    const entries: IndexEntry[] = [];
    for (const name of await fs.readdir(target).catch(() => [] as string[])) {
      if (!name.endsWith(".md") || name === "index.md" || name === "log.md") continue;
      const { frontmatter } = parseFrontmatter(await fs.readFile(path.join(target, name), "utf8"));
      const base = name.replace(/\.md$/, "");
      entries.push({
        path: directory === "" ? base : `${directory}/${base}`,
        title: frontmatter.title ?? null,
        description: frontmatter.description ?? null,
      });
    }
    if (directory === "") return; // okf owns the root index; it lists nothing per concept there
    await fs.writeFile(path.join(target, "index.md"), renderIndex(directory, entries));
  }

  private async appendLog(dir: string, message: string): Promise<void> {
    const logFile = path.join(dir, "log.md");
    const existing = await fs.readFile(logFile, "utf8").catch(() => "");
    await fs.writeFile(logFile, appendLogEntry(existing, today(), message));
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function stripMd(s: string): string {
  return s.replace(/\.md$/, "").replace(/^\//, "");
}

async function uniqueExisting(targets: string[], dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const t of [...new Set(targets)]) {
    if (isValidConceptId(t) && (await exists(path.join(dir, `${t}.md`)))) out.push(t);
  }
  return out.sort();
}

async function walkMarkdown(dir: string, rel: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const next = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walkMarkdown(dir, next)));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(next);
  }
  return out;
}

export function knowledgeServiceFromEnv(env: Env): KnowledgeService {
  return new OkfKnowledgeService({ root: env.KNOWLEDGE_ROOT, binary: env.OKF_BINARY ?? "okf" });
}
