/* --------------------------------------------------------------------------
   #167: auto-submit overdue sections.

   The first background job in this system. A student who was working a
   section when its homework's due date passed stays `in_progress_overdue`
   forever (deriveSectionStatus, repositories/studentHomeworks.ts) and reads
   as "never submitted" on the instructor dashboard, which understates work
   actually done. This sweep closes that: a past-due section with a live
   conversation and no submission gets one, marked `source: 'auto'` so
   nobody mistakes it for the student having pressed submit.

   ---------------------------------------------------------------------------
   Design decision 1 -- platform-wide, not per-course opt-in.

   Nothing in the schema is a cheap attachment point for a per-course
   toggle: `courses` (db/schema/identity.ts) has no settings blob and no
   feature-flag column, only purpose-built ones (`llm_config_id`,
   `is_active`). A per-course opt-in would therefore mean a new column or a
   new course-settings table, plus an admin surface to set it, plus a
   default-value decision for every existing course -- disproportionate to
   one job, and speculative until an instructor actually asks to opt out.

   The behavior is also conservative enough not to need a gate: it only ever
   records work the student really did (an active, non-teacher-test
   conversation on a section whose deadline has passed), never grades it,
   and never touches a homework the instructor has hidden, unpublished, or
   expired. An instructor who does not want it has the existing lever --
   hide or expire the homework, which removes it from the candidate set.

   ---------------------------------------------------------------------------
   Design decision 2 -- Cloudflare Cron Trigger.

   This app deploys as a Cloudflare Worker (apps/web/wrangler.jsonc, `npm
   run deploy` = migrate + `wrangler deploy`); there is no AWS/EventBridge
   infrastructure in the tree despite #167's own note gesturing at it as a
   future target. The native mechanism is a Cron Trigger firing the Worker's
   `scheduled()` export, which is what server/index.ts now wires -- no new
   runtime, no new deploy target, and the schedule itself is one line of
   already-reviewed config rather than an admin screen.

   ---------------------------------------------------------------------------
   Tenancy.

   The epic's cross-cutting invariant (#30) is that every query is org- or
   course-scoped. A "sweep the whole platform" job is the one shape that can
   quietly violate it, so the sweep is not one global query: it enumerates
   organizations and runs autoSubmitOverdueSectionsForOrg once per org, and
   every statement inside that function is filtered by that OrgScope. No
   query in this file can return or write a row belonging to another tenant,
   and one org's failure cannot abort another org's work.
   -------------------------------------------------------------------------- */

import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  conversations,
  courses,
  homeworks,
  organizations,
  sections,
  submissions,
} from "../../db/schema";
import { deriveHomeworkStatus } from "../repositories/homeworks";
import { type OrgScope, unsafeOrgScope } from "../repositories/scope";
import { logServerError, logServerInfo } from "../utils/errors";

/** Log context label -- one value, so a run summary and its per-row failures
 *  are greppable together (`"context":"job.autoSubmitOverdue"`). */
export const AUTO_SUBMIT_LOG_CONTEXT = "job.autoSubmitOverdue";

export interface AutoSubmitRunSummary {
  /** Rows that satisfied every structural condition AND whose homework is
   *  currently `past_due` -- i.e. what this run tried to submit. */
  candidates: number;
  /** Submissions actually created by this run. */
  submitted: number;
  /** Candidates whose insert hit an existing submission and did nothing.
   *  Non-zero means a student (or an overlapping run) submitted between
   *  this run's read and its write -- the expected, harmless outcome of the
   *  race, not an error. */
  skipped: number;
  /** Candidates whose insert threw. Each one is logged individually; the
   *  run continues. */
  failed: number;
}

/** One row the sweep may act on. `sectionId` is non-null by construction --
 *  the query filters `kind = 'section'`, and conversations_kind_section_chk
 *  makes section_id NOT NULL for that kind. */
interface AutoSubmitCandidate {
  conversationId: string;
  userId: string;
  sectionId: string;
}

function emptySummary(): AutoSubmitRunSummary {
  return { candidates: 0, submitted: 0, skipped: 0, failed: 0 };
}

/** Every (conversation, user, section) in `scope` that this run should
 *  submit for.
 *
 *  The structural conditions are SQL predicates; the release-state one is
 *  not. Whether a homework counts as "past due" is `deriveHomeworkStatus`'s
 *  answer, not a raw `due_date < now()` comparison -- repositories/
 *  homeworks.ts's own doc comment names the gates that must key on the
 *  derived status precisely so a new status (#166 added `hidden` a
 *  milestone ago) reaches all of them from one edit. Hand-writing the
 *  published/released/hidden/expired predicate in SQL here would make this
 *  the sixth gate that can silently drift from it. The SQL has already
 *  narrowed to "has a live conversation and no submission", which is a
 *  small set, so deriving in JS costs nothing worth the drift risk.
 *
 *  Excluded by the SQL, each for a reason the manual path also enforces:
 *    - soft-deleted conversations (a restart voids its submission and
 *      soft-deletes the conversation; the fresh one is the live attempt)
 *    - `tutor` conversations -- not submittable at all, and structurally
 *      impossible to submit anyway (#128's composite FK)
 *    - teacher-test conversations -- submitSection refuses these (#242);
 *      an instructor trying out their own prompt is not student work
 *    - anything with an existing submission for that (user, section) */
export async function findAutoSubmitCandidates(
  db: Db,
  scope: OrgScope,
): Promise<AutoSubmitCandidate[]> {
  const rows = await db
    .select({
      conversationId: conversations.id,
      userId: conversations.ownerUserId,
      sectionId: conversations.sectionId,
      dueDate: homeworks.dueDate,
      publishedAt: homeworks.publishedAt,
      releasedAt: homeworks.releasedAt,
      isHidden: homeworks.isHidden,
      expiresAt: homeworks.expiresAt,
    })
    .from(conversations)
    .innerJoin(courses, eq(conversations.courseId, courses.id))
    .innerJoin(sections, eq(conversations.sectionId, sections.id))
    .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
    // The (user, section) pair, not conversation_id: that is the pair
    // submissions_user_section_uq caps (#128), and it is the honest
    // question -- a student who submitted, restarted, and started a new
    // conversation has no submission for the section any more (restart
    // deletes it, see restartSectionConversation), while one who submitted
    // and never restarted must not be submitted for again through a
    // different conversation row.
    .leftJoin(
      submissions,
      and(
        eq(submissions.userId, conversations.ownerUserId),
        eq(submissions.sectionId, conversations.sectionId),
      ),
    )
    .where(
      and(
        eq(courses.organizationId, scope),
        eq(conversations.kind, "section"),
        eq(conversations.isDeleted, false),
        eq(conversations.isTeacherTest, false),
        isNull(submissions.id),
      ),
    );

  return rows
    .filter((row) => deriveHomeworkStatus(row) === "past_due")
    .map((row) => ({
      conversationId: row.conversationId,
      userId: row.userId,
      // Non-null for kind = 'section' (see AutoSubmitCandidate).
      sectionId: row.sectionId!,
    }));
}

/** Runs the sweep for exactly one organization. Exported so the tenancy
 *  boundary is directly testable, and so a future operator-triggered
 *  single-org run has something to call. */
export async function autoSubmitOverdueSectionsForOrg(
  db: Db,
  scope: OrgScope,
): Promise<AutoSubmitRunSummary> {
  const candidates = await findAutoSubmitCandidates(db, scope);
  const summary = { ...emptySummary(), candidates: candidates.length };

  for (const candidate of candidates) {
    try {
      // Idempotency lives in the database, not in a prior existence check.
      // findAutoSubmitCandidates already filtered out anything submitted,
      // but that read and this write are not one transaction -- a student
      // pressing submit in between (or two overlapping cron invocations)
      // would make a check-then-insert produce either a duplicate or a
      // crash. ON CONFLICT DO NOTHING makes the insert itself the check:
      // re-running this job over the same state inserts nothing and throws
      // nothing. Same class of fix as #266/#273 elsewhere on this branch.
      //
      // Untargeted deliberately. `submissions` has two unique constraints
      // that mean the same thing here -- UNIQUE(conversation_id) and
      // submissions_user_section_uq -- and a re-run violates BOTH at once.
      // Naming one as the arbiter would leave the other free to raise, so
      // the bare form (any unique violation on this table means "already
      // submitted") is the correct one, not a lazier one.
      const [created] = await db
        .insert(submissions)
        .values({
          conversationId: candidate.conversationId,
          userId: candidate.userId,
          sectionId: candidate.sectionId,
          // Verified to be this org's, not taken on the caller's word: the
          // candidate query joined through courses and filtered on this
          // exact organization_id, so the denormalized column cannot be
          // written with another tenant's id.
          organizationId: scope,
          source: "auto",
          // submittedAt left to the column's own defaultNow(): the row
          // records when the submission was made, and there is no other
          // sensible value -- back-dating it to the due date would claim
          // the student submitted on time, which is the opposite of what
          // this row means.
        })
        .onConflictDoNothing()
        .returning({ id: submissions.id });

      if (created) summary.submitted++;
      else summary.skipped++;
    } catch (err) {
      // Per-candidate, not per-run: one row failing (a conversation deleted
      // mid-run, so the FK no longer resolves) must not cost every other
      // student in the org their submission. Logged individually because
      // the run summary's `failed` count alone would not say which row.
      summary.failed++;
      logServerError(AUTO_SUBMIT_LOG_CONTEXT, err, {
        organizationId: scope,
        conversationId: candidate.conversationId,
        sectionId: candidate.sectionId,
      });
    }
  }

  return summary;
}

/** The whole sweep: every organization, each scoped to itself.
 *
 *  Emits exactly one structured summary line (#275's logging pattern), so a
 *  run is countable and greppable without parsing per-row output. Per-row
 *  failures have already been logged individually at error level by the
 *  per-org pass. */
export async function autoSubmitOverdueSections(db: Db): Promise<AutoSubmitRunSummary> {
  const startedAt = Date.now();
  const orgs = await db.select({ id: organizations.id }).from(organizations);

  const total = emptySummary();
  for (const org of orgs) {
    // unsafeOrgScope is sound here in the sense scope.ts requires: the id
    // was just read back from `organizations`, not taken from a caller.
    const orgSummary = await autoSubmitOverdueSectionsForOrg(db, unsafeOrgScope(org.id));
    total.candidates += orgSummary.candidates;
    total.submitted += orgSummary.submitted;
    total.skipped += orgSummary.skipped;
    total.failed += orgSummary.failed;
  }

  logServerInfo(AUTO_SUBMIT_LOG_CONTEXT, "auto-submit sweep complete", {
    organizations: orgs.length,
    ...total,
    durationMs: Date.now() - startedAt,
  });
  return total;
}
