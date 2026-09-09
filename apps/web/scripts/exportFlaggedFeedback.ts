#!/usr/bin/env -S npx tsx
/* --------------------------------------------------------------------------
   #90: export student-flagged tutor responses into #89's eval-set shape.

   The issue's own requirement is "flagged examples exportable into the
   tutor-behavior eval set -- the feedback loop that improves prompts",
   with an explicit "keep it lightweight" constraint: a script or documented
   manual step is enough, not a full automated pipeline (#89 itself is a
   standalone, non-CI-wired workspace for exactly this kind of deliberate,
   human-triggered workflow -- see evals/README.md's "run this on a prompt
   change, not every PR").

   What this script does NOT do, on purpose:
     - It does not run in CI, in `npm test`, or on any schedule. It is a
       one-off, human-triggered command, the same posture as
       `npm run tutor:eval` itself.
     - It does not merge exported rows into the CURATED
       datasets/tutor-behavior-probes.json automatically. It writes to a
       separate staging file (datasets/flagged-feedback-export.json) that a
       human reviews -- filling in/confirming `solution`, choosing a real
       `category`, and running the existing PII scan -- before hand-merging
       any of it into the real dataset. Silently auto-merging raw student
       data (even with responseSnapshot already stripped of anything beyond
       the tutor's own reply) into a dataset that ships with the repo would
       skip the one review step #89's own pii-scan.test.ts exists to gate.
       (#90 final-review fix: that staging file carries verbatim
       `studentMessage`/`comment` text, so it's gitignored -- see
       .gitignore's own comment -- and pii-scan.test.ts now scans it
       directly, whenever it exists locally, not just the curated dataset
       it eventually gets merged into.)
     - It does not attempt to guess which of #89's six adversarial
       categories (solution_extraction, roleplay_jailbreak, ...) a flagged
       response belongs to -- a REAL flagged exchange is a different kind of
       example than a hand-authored adversarial probe. Exported rows carry
       category "student_flagged" so `npm run tutor:eval`'s per-category
       aggregation (a plain Record<string, ...> keyed off whatever strings
       appear in the dataset, not a closed enum) groups them together
       without a code change, and a human re-categorizes on merge if a row
       genuinely fits one of the six.

   Usage:
     DATABASE_URL=... npx tsx scripts/exportFlaggedFeedback.ts [--course <courseId>] [--limit <n>] [--since <ISO date>]

   Idempotent: re-running only appends flags not already present in the
   staging file (keyed by `flagged-<response_feedback.id>`), so this can be
   run repeatedly (e.g. weekly) without producing duplicate entries.

   Server-hardening audit fix, Minor #5 (Performance+Scalability, found
   independently by both dimensions): the main query used to have no LIMIT
   at all -- fine the day #90 shipped with a handful of flags, not as a
   forever assumption for a script meant to be re-run "e.g. weekly" against
   a growing table. `--limit` (default DEFAULT_EXPORT_LIMIT below) and
   `--since` bound it, same optional-flag shape `--course` above already
   established. This is an offline/manual script (not a hot request path,
   no Worker subrequest budget to respect), so both are simple `indexOf`
   flag parsing, not a real CLI parser.
   -------------------------------------------------------------------------- */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Db } from "../src/db/client";
import * as schema from "../src/db/schema";
import {
  responseFeedback,
  messages,
  conversations,
  sections,
  sectionSolutions,
  homeworks,
} from "../src/db/schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STAGING_PATH = path.join(__dirname, "..", "..", "..", "evals", "datasets", "flagged-feedback-export.json");

interface ExportedProbe {
  id: string;
  category: "student_flagged";
  homeworkTitle: string;
  sectionTitle: string;
  sectionContent: string;
  /** Empty when the section has no sectionSolutions row yet -- see the
   *  module doc comment above: a human fills this in during review, since
   *  scoreAnswerLeakage needs a real reference solution to be meaningful. */
  solution: string;
  studentMessage: string;
  notes: string;
}

/** Shared by both `responseSnapshot` (the flagged tutor reply) and each
 *  preceding user message below -- both are the same jsonb `parts` shape
 *  (messages.parts / response_feedback.response_snapshot), and used to be
 *  extracted via two separately hand-copied filter/map chains. */
export function extractText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter(
      (p): p is { type: "text"; text: string } =>
        typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text" &&
        typeof (p as { text?: unknown }).text === "string",
    )
    .map((p) => p.text)
    .join("\n");
}

/** The message directly preceding each flagged one, in conversation order --
 *  the "studentMessage" a Probe needs. A row with no earlier user turn to
 *  find keys to "" (not a throw) -- the export still proceeds with an empty
 *  field a human fills in, rather than dropping the flag from the export
 *  entirely.
 *
 *  Server-hardening audit fix, Minor #5: replaces the old N+1 (one
 *  `findPrecedingStudentMessage` round trip PER flagged row) with a single
 *  batched query, the same convention repositories/submissions.ts's
 *  findOverdueSubmissionCandidatesForOrgs already established for this
 *  repo's other "many rows, one lookup each" shape -- fetch the full
 *  candidate set for every conversation this export touches in ONE query
 *  (`conversationId IN (...)`), then do the actual per-row "closest
 *  preceding" selection in memory instead of asking Postgres once per row.
 *  Offline/manual script, not a hot path -- and this run's own row set is
 *  already bounded by DEFAULT_EXPORT_LIMIT/`--limit`, so "every user
 *  message in every touched conversation, held in memory" is a small,
 *  acceptable cost next to N separate round trips. Keyed by
 *  response_feedback.id (each flagged row is unique -- see ExportedProbe's
 *  own `id`), not by (conversationId, seq): simpler, and side-steps having
 *  to reason about whether that pair could ever collide. */
/** The actual "batching logic" Minor #5 is about, pulled out as a pure
 *  function (no `db`, no `await`) so it's directly unit-testable without a
 *  real or mocked database connection: given the flat, ALREADY-FETCHED
 *  batch of every user message across every touched conversation (ordered
 *  ascending by seq, as findPrecedingStudentMessages's own query below
 *  fetches it), pick each row's own immediately-preceding message and
 *  return the per-row map. Exported for exportFlaggedFeedback.test.ts. */
export function selectPrecedingMessages(
  rows: { id: string; conversationId: string; messageSeq: number }[],
  userMessagesByConversationAsc: { conversationId: string; seq: number; parts: unknown }[],
): Map<string, string> {
  const byConversation = new Map<string, { seq: number; parts: unknown }[]>();
  for (const m of userMessagesByConversationAsc) {
    const list = byConversation.get(m.conversationId);
    if (list) list.push(m);
    else byConversation.set(m.conversationId, [m]);
  }

  const out = new Map<string, string>();
  for (const row of rows) {
    const candidates = byConversation.get(row.conversationId) ?? [];
    // Ascending by seq -- the last candidate strictly before this row's own
    // messageSeq is the immediately preceding student turn.
    let preceding: { seq: number; parts: unknown } | undefined;
    for (const m of candidates) {
      if (m.seq >= row.messageSeq) break;
      preceding = m;
    }
    out.set(row.id, preceding ? extractText(preceding.parts) : "");
  }
  return out;
}

async function findPrecedingStudentMessages(
  db: Db,
  rows: { id: string; conversationId: string; messageSeq: number }[],
): Promise<Map<string, string>> {
  const conversationIds = [...new Set(rows.map((r) => r.conversationId))];
  if (conversationIds.length === 0) return new Map();

  const userMessages = await db
    .select({ conversationId: messages.conversationId, seq: messages.seq, parts: messages.parts })
    .from(messages)
    .where(and(inArray(messages.conversationId, conversationIds), eq(messages.role, "user")))
    .orderBy(asc(messages.seq));

  return selectPrecedingMessages(rows, userMessages);
}

/** Server-hardening audit fix, Minor #5: DEFAULT_EXPORT_LIMIT bounds the
 *  main query the same way OVERDUE_SUBMISSION_CANDIDATE_LIMIT bounds
 *  submissions.ts's own unbounded-until-now candidate read -- a safety cap
 *  on this script's own result-set size, not a real product limit (a
 *  weekly export of the most recent 1000 flags comfortably covers this
 *  pilot's actual volume; `--since`/`--limit` exist for the rare run that
 *  needs more or a narrower window). */
const DEFAULT_EXPORT_LIMIT = 1000;

async function exportFlaggedFeedback(
  db: Db,
  courseId: string | undefined,
  opts: { limit?: number; since?: Date } = {},
): Promise<ExportedProbe[]> {
  const limit = opts.limit ?? DEFAULT_EXPORT_LIMIT;
  const conditions = [isNotNull(responseFeedback.messageId)];
  if (courseId) conditions.push(eq(conversations.courseId, courseId));
  if (opts.since) conditions.push(gte(responseFeedback.flaggedAt, opts.since));

  const rows = await db
    .select({
      id: responseFeedback.id,
      reason: responseFeedback.reason,
      comment: responseFeedback.comment,
      responseSnapshot: responseFeedback.responseSnapshot,
      messageSeq: messages.seq,
      conversationId: responseFeedback.conversationId,
      sectionTitle: sections.title,
      sectionContent: sections.content,
      homeworkTitle: homeworks.title,
      solutionContent: sectionSolutions.content,
    })
    .from(responseFeedback)
    .innerJoin(conversations, eq(responseFeedback.conversationId, conversations.id))
    // messageId is only ever null after the message row itself is gone
    // (ON DELETE SET NULL) -- inner join is correct here because
    // isNotNull(messageId) is already a hard filter above; a row that
    // fails it is exactly the "message already cleared" case the module
    // doc comment describes, which this export skips rather than guesses
    // at.
    .innerJoin(messages, eq(responseFeedback.messageId, messages.id))
    .innerJoin(sections, eq(conversations.sectionId, sections.id))
    .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
    .leftJoin(sectionSolutions, eq(sections.id, sectionSolutions.sectionId))
    .where(and(...conditions))
    // Most-recently-flagged first, same "newest first" convention the
    // instructor dashboard's own listCourseFeedback query uses -- and the
    // one that makes `--limit` mean "the N most recent flags" rather than
    // an arbitrary, unordered N.
    .orderBy(desc(responseFeedback.flaggedAt))
    .limit(limit);

  const precedingByRowId = await findPrecedingStudentMessages(db, rows);

  const out: ExportedProbe[] = [];
  for (const row of rows) {
    const studentMessage = precedingByRowId.get(row.id) ?? "";
    const responseText = extractText(row.responseSnapshot);
    out.push({
      id: `flagged-${row.id}`,
      category: "student_flagged",
      homeworkTitle: row.homeworkTitle,
      sectionTitle: row.sectionTitle,
      sectionContent: row.sectionContent,
      solution: row.solutionContent ?? "",
      studentMessage: studentMessage || "(no preceding student message found)",
      notes:
        `Exported from a student flag (#90). Reason: ${row.reason}` +
        (row.comment ? `. Student comment: ${row.comment}` : ".") +
        ` Actual tutor response (for review, not a Probe field): ${responseText}` +
        (row.solutionContent ? "" : " -- NEEDS REVIEW: no section solution on file; fill in `solution` before scoring this probe."),
    });
  }
  return out;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  const courseArgIndex = process.argv.indexOf("--course");
  const courseId = courseArgIndex !== -1 ? process.argv[courseArgIndex + 1] : undefined;

  const limitArgIndex = process.argv.indexOf("--limit");
  const limit = limitArgIndex !== -1 ? Number(process.argv[limitArgIndex + 1]) : DEFAULT_EXPORT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    console.error("--limit must be a positive integer");
    process.exit(1);
  }

  const sinceArgIndex = process.argv.indexOf("--since");
  const sinceArg = sinceArgIndex !== -1 ? process.argv[sinceArgIndex + 1] : undefined;
  let since: Date | undefined;
  if (sinceArg !== undefined) {
    since = new Date(sinceArg);
    if (Number.isNaN(since.getTime())) {
      console.error("--since must be a valid ISO date");
      process.exit(1);
    }
  }

  // #90 review (Minor #8): owns the Pool directly (mirrors scripts/
  // migrate.ts's runMigrations) rather than going through makeNodeDb, which
  // returns only the opaque `Db` wrapper with no exposed close -- a
  // one-shot CLI script must close its connection explicitly or the
  // process never exits on its own (pg's Pool keeps a live TCP socket that
  // holds the event loop open). Cast the same way makeNodeDb itself does;
  // see that function's own doc comment for why the cast is safe.
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema }) as unknown as Db;
  try {
    const exported = await exportFlaggedFeedback(db, courseId, { limit, since });

    const existing: ExportedProbe[] = existsSync(STAGING_PATH)
      ? (JSON.parse(readFileSync(STAGING_PATH, "utf-8")) as ExportedProbe[])
      : [];
    const existingIds = new Set(existing.map((p) => p.id));
    const fresh = exported.filter((p) => !existingIds.has(p.id));

    const merged = [...existing, ...fresh];
    writeFileSync(STAGING_PATH, `${JSON.stringify(merged, null, 2)}\n`);

    console.log(`Exported ${exported.length} flagged response(s)${courseId ? ` for course ${courseId}` : ""}.`);
    console.log(`${fresh.length} new entr${fresh.length === 1 ? "y" : "ies"} appended to ${STAGING_PATH}.`);
    if (fresh.length > 0) {
      console.log(
        "Review each new entry before merging it into evals/datasets/tutor-behavior-probes.json: " +
          "confirm/author `solution`, add `finalAnswers` if a short leaked fragment alone would count as " +
          "a leak, pick a real category if one of the six adversarial types fits, and run " +
          "`npm test --workspace=evals` (datasets/pii-scan.test.ts, which now scans this staging file too, " +
          "in addition to tutor-behavior-probes.json) both before AND after merging.",
      );
    }
  } finally {
    await pool.end();
  }
}

// Only run when invoked directly (`npm run export-flagged-feedback` / `npx
// tsx scripts/exportFlaggedFeedback.ts`) -- same guard scripts/migrate.ts
// uses, needed now that exportFlaggedFeedback.test.ts imports this module's
// pure helpers (extractText, selectPrecedingMessages) directly. Without it,
// merely importing the file for its exports would also run `main()`, which
// exits the process when DATABASE_URL isn't set -- exactly the environment
// a unit test runs in.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
