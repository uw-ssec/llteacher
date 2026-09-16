import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { runOkf } from "./okfCli";
import { withWriteLock } from "./writeLock";
import { isValidConceptId } from "./conceptId";
import { parseFrontmatter, setFrontmatterKeys } from "./frontmatter";
import { parseLinks } from "./parseLinks";
import { appendLogEntry, type IndexEntry } from "./bundle";

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

// The parent directory of a concept id, in the "" (root) / "a/b" shape every
// index-regenerating call expects -- path.posix.dirname("a") is ".", not "",
// so that has to be normalised at every call site. Centralised here after the
// fix-review found remove() computing this inline while create()'s new
// rollback path needed the identical logic.
function parentDirOf(conceptId: string): string {
  const dir = path.posix.dirname(conceptId);
  return dir === "." ? "" : dir;
}

// Matches how okf 0.1.5 itself derives a directory's index.md heading from
// the directory name on disk (confirmed by creating `module-1/intro` against
// the real binary and inspecting the auto-generated `module-1/index.md`):
// the hyphen is kept as-is and only the first letter is capitalised
// (`module-1` -> `Module-1`, `readings` -> `Readings`). Matching okf exactly
// here means a directory's index.md heading looks the same whether okf
// itself first wrote it or this service later regenerated it (on a
// create-rollback or a delete).
function directoryHeading(directory: string): string {
  const last = directory.split("/").pop() ?? directory;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

// Renders the entry lines only (no heading), sorted by path, one
// `* [title](path.md) - description` bullet per entry with the ` - ...`
// suffix omitted when there is no description -- matches okf 0.1.5's own
// index.md bullet format byte-for-byte (relative basename href, no blank
// line before the first bullet). Shared by renderOkfIndex (non-root
// directories) and regenerateIndex's root branch, which needs the bullets
// without a heading line since it preserves okf's own frontmatter+heading
// prefix instead.
function renderIndexBody(entries: IndexEntry[]): string {
  const lines = [...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((entry) => {
      const label = entry.title ?? entry.path;
      const suffix = entry.description ? ` - ${entry.description}` : "";
      return `* [${label}](${entry.path}.md)${suffix}`;
    });
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
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

  // Every write path needs ensureCourseDir() before it can take the lock (see
  // above) and then takes the same per-course lock, so centralise both here
  // instead of repeating the pair at each of the five write methods.
  private async withCourseLock<T>(courseId: string, fn: () => Promise<T>): Promise<T> {
    await this.ensureCourseDir(courseId);
    return withWriteLock(this.lockPath(courseId), fn);
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
    if (!(await exists(dir))) return [];
    const n = Math.min(Math.max(1, Math.floor(limit)), SEARCH_LIMIT_MAX);
    const rows = await runOkf<OkfSearchRow[] | null>(this.binary, ["search", q, dir, "--limit", String(n)]);
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
    return this.withCourseLock(courseId, async () => {
      await this.ensureBundle(courseId);
      if (await exists(file)) throw new ConceptExistsError(input.id);
      await runOkf(this.binary, [
        "create", input.id, dir,
        "--type", input.type, "--title", input.title, "--desc", input.description,
      ]);
      try {
        if (input.body.trim() !== "") {
          await runOkf(this.binary, ["update", input.id, dir, "--body", input.body]);
        }
        const keys: Record<string, string> = { status: "generated" };
        if (input.resource) keys.resource = input.resource;
        const raw = await fs.readFile(file, "utf8");
        await fs.writeFile(file, setFrontmatterKeys(raw, keys));
      } catch (err) {
        // okf create already landed the concept file on disk (and, for a
        // nested id, its own directory index.md). Leaving that file behind
        // after a failure here would make ConceptExistsError block every
        // retry of this same id forever, so roll the partial create back.
        await fs.unlink(file).catch(() => {});
        await this.regenerateIndex(courseId, parentDirOf(input.id));
        throw err;
      }
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
    return this.withCourseLock(courseId, async () => {
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
    await this.withCourseLock(courseId, async () => {
      await this.ensureBundle(courseId);
      await runOkf(this.binary, ["relate", from, to, dir, "--desc", context]);
    });
  }

  async remove(courseId: string, conceptId: string): Promise<boolean> {
    const file = this.conceptFile(courseId, conceptId);
    const dir = this.bundleDir(courseId);
    return this.withCourseLock(courseId, async () => {
      if (!(await exists(file))) return false;
      await fs.unlink(file);
      await this.regenerateIndex(courseId, parentDirOf(conceptId));
      await this.appendLog(dir, `**Deletion**: Removed concept \`${conceptId}.md\`.`);
      return true;
    });
  }

  async createDirectory(courseId: string, directory: string): Promise<void> {
    if (!DIR_RE.test(directory)) throw new ConceptIdError(`Invalid directory: ${directory}`);
    const dir = this.bundleDir(courseId);
    await this.withCourseLock(courseId, async () => {
      await this.ensureBundle(courseId);
      const target = path.join(dir, directory);
      await fs.mkdir(target, { recursive: true });
      const indexFile = path.join(target, "index.md");
      if (!(await exists(indexFile))) {
        await fs.writeFile(indexFile, this.renderOkfIndex(directoryHeading(directory), []));
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

  // Renders a non-root directory's index.md exactly as okf 0.1.5 writes one:
  // `# ${heading}` (single hash) followed directly by one bullet per entry,
  // no blank line in between. Hrefs are relative basenames (`two.md`), not
  // bundle-absolute paths, matching what okf itself emits.
  private renderOkfIndex(heading: string, entries: IndexEntry[]): string {
    return `# ${heading}\n${renderIndexBody(entries)}`;
  }

  // Rebuilds directory/index.md from the concept files that remain in
  // `directory` after a create-rollback or a delete.
  //
  // Non-root: the file is fully overwritten with renderOkfIndex output.
  //
  // Root: okf owns the root index.md's frontmatter block and heading
  // (`---\nokf_version: "0.2"\n---\n\n# Knowledge Base\n`, confirmed against
  // the real 0.1.5 binary), and DOES list root-level concepts underneath
  // that heading -- an earlier version of this method skipped the root
  // entirely, which left a dead bullet behind after removing a root concept.
  // So the root case reads the existing index.md, keeps everything through
  // the first line starting with "# " untouched, and replaces only what
  // follows with the current root-level entries. If no such heading line is
  // found (e.g. index.md is missing or was never okf-authored), whatever
  // frontmatter is present is kept and "# Knowledge Base" is appended before
  // the entries.
  private async regenerateIndex(courseId: string, directory: string): Promise<void> {
    const dir = this.bundleDir(courseId);
    const target = path.join(dir, directory);
    const entries: IndexEntry[] = [];
    for (const name of await fs.readdir(target).catch(() => [] as string[])) {
      if (!name.endsWith(".md") || name === "index.md" || name === "log.md") continue;
      const { frontmatter } = parseFrontmatter(await fs.readFile(path.join(target, name), "utf8"));
      entries.push({
        path: name.replace(/\.md$/, ""),
        title: frontmatter.title ?? null,
        description: frontmatter.description ?? null,
      });
    }

    const indexFile = path.join(target, "index.md");
    if (directory === "") {
      const existing = await fs.readFile(indexFile, "utf8").catch(() => "");
      const lines = existing.split("\n");
      const headingIdx = lines.findIndex((line) => line.startsWith("# "));
      const prefix =
        headingIdx >= 0
          ? `${lines.slice(0, headingIdx + 1).join("\n")}\n`
          : existing.trim() === ""
            ? "# Knowledge Base\n"
            : `${existing.replace(/\s+$/, "")}\n\n# Knowledge Base\n`;
      await fs.writeFile(indexFile, prefix + renderIndexBody(entries));
      return;
    }

    await fs.writeFile(indexFile, this.renderOkfIndex(directoryHeading(directory), entries));
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
