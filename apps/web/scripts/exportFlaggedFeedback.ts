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
     DATABASE_URL=... npx tsx scripts/exportFlaggedFeedback.ts [--course <courseId>]

   Idempotent: re-running only appends flags not already present in the
   staging file (keyed by `flagged-<response_feedback.id>`), so this can be
   run repeatedly (e.g. weekly) without producing duplicate entries.
   -------------------------------------------------------------------------- */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, lt, desc, isNotNull } from "drizzle-orm";
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

/** The message directly preceding the flagged one, in conversation order --
 *  the "studentMessage" a Probe needs. Returns "" (not a throw) when the
 *  flagged message itself has already been cleared (messageId is null,
 *  response_feedback's own ON DELETE SET NULL) or there is no earlier user
 *  turn to find -- either way the export still proceeds with an empty
 *  field a human fills in, rather than dropping the flag from the export
 *  entirely. */
async function findPrecedingStudentMessage(
  db: Db,
  conversationId: string,
  beforeSeq: number,
): Promise<string> {
  const [row] = await db
    .select({ parts: messages.parts })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "user"), lt(messages.seq, beforeSeq)))
    .orderBy(desc(messages.seq))
    .limit(1);
  if (!row) return "";
  const parts = row.parts;
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

async function exportFlaggedFeedback(db: Db, courseId: string | undefined): Promise<ExportedProbe[]> {
  const conditions = [isNotNull(responseFeedback.messageId)];
  if (courseId) conditions.push(eq(conversations.courseId, courseId));

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
    .where(and(...conditions));

  const out: ExportedProbe[] = [];
  for (const row of rows) {
    const studentMessage = await findPrecedingStudentMessage(db, row.conversationId, row.messageSeq);
    const responseText = Array.isArray(row.responseSnapshot)
      ? row.responseSnapshot
          .filter(
            (p): p is { type: "text"; text: string } =>
              typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text" &&
              typeof (p as { text?: unknown }).text === "string",
          )
          .map((p) => p.text)
          .join("\n")
      : "";
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
    const exported = await exportFlaggedFeedback(db, courseId);

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
          "`npm test --workspace=evals` (datasets/pii-scan.test.ts) against the merged file.",
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
