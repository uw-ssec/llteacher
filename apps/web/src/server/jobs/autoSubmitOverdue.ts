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
   records work the student really did -- a non-teacher-test conversation on
   a past-due section that the student has actually written at least one
   message in -- never grades it, and never touches a homework the
   instructor has hidden, unpublished, or expired. An instructor who does
   not want it has the existing lever: hide or expire the homework, which
   removes it from the candidate set.

   That "written at least one message in" clause is load-bearing for this
   decision, not incidental (#167 review). A live conversation alone does
   not mean work happened: since #318 the client eagerly creates one the
   moment a student selects a section, so "clicked in, read the greeting,
   left" would otherwise have produced a submission -- a green cell on the
   instructor grid for reading a greeting, which is the inverse of the
   problem this job exists to fix. The predicate lives in the candidate
   query (findOverdueSubmissionCandidates, repositories/submissions.ts).

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
   organizations (listAllOrgScopes, the single platform-wide read, which
   hands back OrgScopes rather than raw ids) and runs
   autoSubmitOverdueSectionsForOrg once per org. Every statement that
   follows takes that scope and is filtered by it, so no query can return or
   write a row belonging to another tenant, and one org's failure cannot
   abort another org's work.

   The data access itself lives in repositories/ (findOverdueSubmissionCandidates,
   insertAutoSubmission, listAllOrgScopes), not here -- ARCHITECTURE.md's
   "Routes and Repositories" rule is about keeping tenancy scoping in one
   layer, and a background job needs that guard more than a route does, not
   less: it has no authenticated caller whose membership would have narrowed
   a forgotten WHERE clause by accident. What is left in this file is
   orchestration: iterate, count, log.
   -------------------------------------------------------------------------- */

import type { Db } from "../../db/client";
import { listAllOrgScopes } from "../repositories/organizations";
import { findOverdueSubmissionCandidates, insertAutoSubmission } from "../repositories/submissions";
import type { OrgScope } from "../repositories/scope";
import { logServerError, logServerInfo } from "../utils/errors";

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

function emptySummary(): AutoSubmitRunSummary {
  return { candidates: 0, submitted: 0, skipped: 0, failed: 0 };
}

/** Runs the sweep for exactly one organization. Exported so the tenancy
 *  boundary is directly testable, and so a future operator-triggered
 *  single-org run has something to call. */
export async function autoSubmitOverdueSectionsForOrg(
  db: Db,
  scope: OrgScope,
): Promise<AutoSubmitRunSummary> {
  const candidates = await findOverdueSubmissionCandidates(db, scope);
  const summary = { ...emptySummary(), candidates: candidates.length };

  for (const candidate of candidates) {
    try {
      // insertAutoSubmission is ON CONFLICT DO NOTHING, so a candidate that
      // was submitted between the query above and this write is reported as
      // skipped rather than duplicated or thrown -- see its own doc comment
      // for why idempotency belongs in the database rather than in a prior
      // existence check here.
      const inserted = await insertAutoSubmission(db, scope, candidate);
      if (inserted) summary.submitted++;
      else summary.skipped++;
    } catch (err) {
      // Per-candidate, not per-run: one row failing (a conversation deleted
      // mid-run, so its FK no longer resolves) must not cost every other
      // student in the org their submission. Logged individually because
      // the run summary's `failed` count alone would not say which row --
      // and nothing about a candidate is consumed by a failed attempt, so
      // the next scheduled run simply picks it up again.
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
  // The one platform-wide read in the whole job, and it returns scopes
  // rather than ids -- so everything past this line is per-tenant by
  // construction, not by remembering to add a WHERE clause.
  const orgScopes = await listAllOrgScopes(db);

  const total = emptySummary();
  for (const scope of orgScopes) {
    const orgSummary = await autoSubmitOverdueSectionsForOrg(db, scope);
    total.candidates += orgSummary.candidates;
    total.submitted += orgSummary.submitted;
    total.skipped += orgSummary.skipped;
    total.failed += orgSummary.failed;
  }

  logServerInfo(AUTO_SUBMIT_LOG_CONTEXT, "auto-submit sweep complete", {
    organizations: orgScopes.length,
    ...total,
    durationMs: Date.now() - startedAt,
  });
  return total;
}
