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
   Design decision 3 -- bounded per invocation (final review).

   Each org's candidate read is capped at OVERDUE_SUBMISSION_CANDIDATE_LIMIT
   (repositories/submissions.ts). On the neon-http driver every statement is
   a Cloudflare subrequest and the loop below inserts one at a time, so the
   candidate count is the invocation's subrequest count; the first
   production run, which has no lower bound on due date, would otherwise
   have tried to sweep the whole historical backlog at once and then failed
   identically every hour, since nothing here marks a candidate "seen".
   That same absence of bookkeeping is what makes the cap safe: a candidate
   this run does not reach is untouched, so the next hourly run takes it.

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
import {
  findOverdueSubmissionCandidates,
  insertAutoSubmission,
  OVERDUE_SUBMISSION_CANDIDATE_LIMIT,
} from "../repositories/submissions";
import type { OrgScope } from "../repositories/scope";
import { logServerError, logServerInfo } from "../utils/errors";

export const AUTO_SUBMIT_LOG_CONTEXT = "job.autoSubmitOverdue";

/** What one ORGANIZATION's sweep produced. Run-level facts (which orgs
 *  failed, which were deferred) are deliberately not on this shape -- a
 *  single org has no opinion about them, and folding them in here is what
 *  made `autoSubmitOverdueSectionsForOrg`'s own return value start
 *  describing things it does not know. */
export interface AutoSubmitOrgSummary {
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

/** The whole sweep: every org's totals, plus the two facts that only exist
 *  at run level. */
export interface AutoSubmitRunSummary extends AutoSubmitOrgSummary {
  /** #414: organizations whose sweep threw before producing a summary --
   *  a failed candidate SELECT, not a failed row. Each is logged
   *  individually and the sweep moves to the next org. Non-zero means this
   *  run covered less than the platform. */
  orgsFailed: number;
  /** #416: organizations this run did not reach, because the run-level
   *  subrequest budget was exhausted first. They are not skipped
   *  permanently -- the next run starts from a rotated offset. */
  orgsDeferred: number;
}

function emptyOrgSummary(): AutoSubmitOrgSummary {
  return { candidates: 0, submitted: 0, skipped: 0, failed: 0 };
}

function emptyRunSummary(): AutoSubmitRunSummary {
  return { ...emptyOrgSummary(), orgsFailed: 0, orgsDeferred: 0 };
}

/* #416: how many neon-http subrequests one invocation of the whole sweep may
   spend. Cloudflare allows 1000 per Worker invocation; this leaves headroom
   for the request's own overhead and for the platform-wide org read.

   Why a run-level budget is needed at all, given the per-org candidate cap:
   that cap bounds one org's inserts, but every org in the platform is swept
   in a SINGLE invocation, so the costs add. The cost model is

       1 (listAllOrgScopes) + 1 per org attempted (its candidate SELECT)
         + 1 per candidate (its insert)

   Two orgs each carrying a full 500-row first-run backlog already exceed
   1000. Without this the 1001st fetch throws mid-loop, and -- before #414's
   per-org isolation -- killed the entire sweep, identically, every hour.

   Starvation, which is why the per-org cap was per-org in the first place:
   a shared budget consumed by whichever orgs come back first would
   permanently starve the tail. Answered by rotation rather than by dropping
   the budget -- see the offset in autoSubmitOverdueSections. */
export const AUTO_SUBMIT_RUN_SUBREQUEST_BUDGET = 900;

/** Runs the sweep for exactly one organization. Exported so the tenancy
 *  boundary is directly testable, and so a future operator-triggered
 *  single-org run has something to call.
 *
 *  `limit` caps how many candidates this call may submit for; the default
 *  is the production one. It is a parameter rather than a constant read
 *  inside so that the bound's actual consequence -- that the remainder is
 *  still there for the next run -- is testable without seeding the
 *  production limit's worth of fixtures. */
export async function autoSubmitOverdueSectionsForOrg(
  db: Db,
  scope: OrgScope,
  limit: number = OVERDUE_SUBMISSION_CANDIDATE_LIMIT,
): Promise<AutoSubmitOrgSummary> {
  const candidates = await findOverdueSubmissionCandidates(db, scope, limit);
  const summary = { ...emptyOrgSummary(), candidates: candidates.length };

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

  const total = emptyRunSummary();
  /* Spent on the org read above. Everything below decrements from the same
     pool, so the bound is on the INVOCATION, which is what Cloudflare
     actually meters. */
  let subrequestsSpent = 1;

  /* #416 starvation guard: a fixed iteration order plus a shared budget
     would sweep the same prefix of organizations every hour and never reach
     the tail. Rotating the start offset by the hour means every org is
     first eventually, so a backlog anywhere on the platform drains instead
     of only the backlog at the front of the list.

     Derived from the clock rather than persisted, because the job holds no
     state between runs and a cron that fires hourly gives a naturally
     advancing offset for free. */
  const rotation = orgScopes.length > 0 ? Math.floor(startedAt / 3_600_000) % orgScopes.length : 0;

  for (let i = 0; i < orgScopes.length; i++) {
    const scope = orgScopes[(i + rotation) % orgScopes.length]!;

    /* The budget is spent BEFORE the org runs, by narrowing its candidate
       limit to what is left, rather than by reserving a full window and
       refusing the org outright. Reserving the worst case would defer
       healthy orgs that were going to cost one subrequest each: on a
       platform of 400 idle organizations the sweep would stop around the
       400th despite having spent almost nothing.

       This shape cannot overspend either. The org costs at most
       `1 + limit`, and limit is `remaining - 1`, so the post-call total is
       at most `spent + remaining` -- exactly the budget. */
    const remaining = AUTO_SUBMIT_RUN_SUBREQUEST_BUDGET - subrequestsSpent;
    // One for the SELECT, one for at least a single insert; below that
    // there is no useful work left to start.
    if (remaining < 2) {
      total.orgsDeferred = orgScopes.length - i;
      break;
    }
    const orgLimit = Math.min(OVERDUE_SUBMISSION_CANDIDATE_LIMIT, remaining - 1);

    try {
      const orgSummary = await autoSubmitOverdueSectionsForOrg(db, scope, orgLimit);
      total.candidates += orgSummary.candidates;
      total.submitted += orgSummary.submitted;
      total.skipped += orgSummary.skipped;
      total.failed += orgSummary.failed;
      // The SELECT, plus one insert attempted per candidate. Candidates the
      // org did not have cost nothing, so a healthy platform of mostly-idle
      // orgs spends ~1 per org and reaches all of them.
      subrequestsSpent += 1 + orgSummary.candidates;
    } catch (err) {
      /* #414: per-ORG isolation, not just per-row. Only insertAutoSubmission
         was wrapped before, so a failure in findOverdueSubmissionCandidates
         -- a transient neon-http error, a statement timeout on a slow
         backlog SELECT -- escaped this loop entirely and re-threw out of
         scheduled(). Every organization after it was silently skipped and
         the summary line below never emitted, so the run reported only
         "scheduled failed" while 28 of 30 tenants went unswept. Worse, a
         deterministic failure for one org (a SELECT that always times out)
         killed the sweep at the same place every hour, forever.

         This restores what the file's tenancy note has claimed all along:
         one org's failure cannot abort another org's work. */
      total.orgsFailed++;
      // The SELECT was still attempted and still cost a subrequest.
      subrequestsSpent += 1;
      logServerError(AUTO_SUBMIT_LOG_CONTEXT, err, { organizationId: scope });
    }
  }

  /* Emitted unconditionally, including on a partial run. A sweep that
     covered 2 of 30 orgs and one that covered all 30 have to be
     distinguishable from the logs alone -- `orgsFailed` and `orgsDeferred`
     are what make a partial run visible rather than inferred from a
     suspiciously low `submitted`. */
  logServerInfo(AUTO_SUBMIT_LOG_CONTEXT, "auto-submit sweep complete", {
    organizations: orgScopes.length,
    organizationsSwept: orgScopes.length - total.orgsDeferred,
    subrequestsSpent,
    ...total,
    durationMs: Date.now() - startedAt,
  });
  return total;
}
