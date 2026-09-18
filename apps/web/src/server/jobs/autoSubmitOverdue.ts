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
   Design decision 2 -- explicit Node job command.

   The Node deployment invokes this sweep through `npm run
   node:run-overdue-job`, a dedicated command rather than a web-request
   handler. Scheduler configuration and process lifecycle belong to
   deployment code, keeping this function focused on selecting and submitting
   eligible sections exactly once.

   ---------------------------------------------------------------------------
   Design decision 3 -- bounded database payloads, complete ECS runs.

   Each org's candidate read is capped at OVERDUE_SUBMISSION_CANDIDATE_LIMIT
   for the single-org path, or the smaller OVERDUE_SUBMISSION_BATCH_CANDIDATE_LIMIT
   for the batched path this file now uses (repositories/submissions.ts --
   see that constant's own doc comment for why the batched path needs a
   separate, smaller cap). The job now runs as a dedicated ECS task rather
   than a Cloudflare Worker, so there is no invocation-wide subrequest
   budget. Every organization batch is processed in one scheduled run while
   the fixed per-query caps continue to bound database result processing.

   ---------------------------------------------------------------------------
   Tenancy.

   The epic's cross-cutting invariant (#30) is that every query is org- or
   course-scoped. A "sweep the whole platform" job is the one shape that can
   quietly violate it, so the sweep is not one global, unscoped query: it
   enumerates organizations (listAllOrgScopes, the single platform-wide
   read, which hands back OrgScopes rather than raw ids) and every candidate
   SELECT after it still takes an explicit organization filter -- `= scope`
   for one org (autoSubmitOverdueSectionsForOrg), or `IN (...scopes)` for a
   batch of them (#437, findOverdueSubmissionCandidatesForOrgs, used by the
   run-level loop). Batching which organizations share one SELECT is an
   optimization on top of this invariant, not a relaxation of it: the WHERE
   clause still names every org it may touch, so no query can return or
   write a row belonging to a tenant outside that explicit list, and the
   insert phase remains per-organization, so one org's failure still cannot
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
  findOverdueSubmissionCandidatesForOrgs,
  insertAutoSubmission,
  OVERDUE_SUBMISSION_CANDIDATE_LIMIT,
  type OverdueSubmissionCandidate,
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
   *  a failed candidate SELECT, not a failed row. #437: the SELECT is now
   *  batched, so a failure here counts every organization sharing that
   *  batch's SELECT, not just one; each failure is logged (with the whole
   *  batch's org ids) and the sweep moves to the next batch. Non-zero means
   *  this run covered less than the platform. */
  orgsFailed: number;
  /** Retained for log/consumer compatibility. ECS runs do not defer orgs. */
  orgsDeferred: number;
}

function emptyOrgSummary(): AutoSubmitOrgSummary {
  return { candidates: 0, submitted: 0, skipped: 0, failed: 0 };
}

function emptyRunSummary(): AutoSubmitRunSummary {
  return { ...emptyOrgSummary(), orgsFailed: 0, orgsDeferred: 0 };
}

/* #437: how many organizations one candidate SELECT covers.
 *
 * What batch size trades off:
 *
 * - Larger raises the org-reach ceiling (fewer batches needed to cover the
 *   whole platform, so fewer SELECT subrequests on a healthy, mostly-idle
 *   platform).
 * - Larger also raises the blast radius of one SELECT failure (#414/#437:
 *   a batch's candidate-read failure now takes out every org sharing that
 *   query, counted in orgsFailed) and the size of a single query's `IN
 *   (...)` list and pre-release-state-filter result set.
 *
 * A batch size in the high tens to low hundreds keeps both of those
 * secondary costs modest while still moving the org-count ceiling by two
 * orders of magnitude. 100 is chosen as a round number in that range --
 * there is no existing batch-size convention elsewhere in this codebase to
 * match (checked: no other job or repository function batches a query this
 * way), and nothing here is sensitive to the exact value; it can move if a
 * real platform's org count, failure-blast-radius tolerance, or backlog
 * shape argues for a different one. */
export const AUTO_SUBMIT_ORG_BATCH_SIZE = 100;

/** The insert phase, shared by the single-org entry point below and by
 *  autoSubmitOverdueSections's batched loop: given candidates already read
 *  (by whichever query fetched them), attempt one insert each and count the
 *  outcomes. Factored out by #437 so batching the SELECT (one query can now
 *  return candidates for many orgs at once) does not have to duplicate the
 *  per-candidate insert/error handling below, which is unchanged from
 *  before batching existed. */
async function submitCandidates(
  db: Db,
  scope: OrgScope,
  candidates: OverdueSubmissionCandidate[],
): Promise<AutoSubmitOrgSummary> {
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

/** Runs the sweep for exactly one organization. Exported so the tenancy
 *  boundary is directly testable, and so a future operator-triggered
 *  single-org run has something to call.
 *
 *  `limit` caps how many candidates this call may submit for; the default
 *  is the production one. It is a parameter rather than a constant read
 *  inside so that the bound's actual consequence -- that the remainder is
 *  still there for the next run -- is testable without seeding the
 *  production limit's worth of fixtures.
 *
 *  Still backed by the single-org candidate query (#437's batched sibling,
 *  findOverdueSubmissionCandidatesForOrgs, is used only by the run-level
 *  loop below) -- this function's whole purpose is to be callable for one
 *  organization in isolation, so batching its own query would buy it
 *  nothing. */
export async function autoSubmitOverdueSectionsForOrg(
  db: Db,
  scope: OrgScope,
  limit: number = OVERDUE_SUBMISSION_CANDIDATE_LIMIT,
): Promise<AutoSubmitOrgSummary> {
  const candidates = await findOverdueSubmissionCandidates(db, scope, limit);
  return submitCandidates(db, scope, candidates);
}

/** The whole sweep's loop, over a CALLER-SUPPLIED list of organizations
 *  (#437). Split out of autoSubmitOverdueSections so a test can hand it a
 *  small, deliberately-chosen `orgScopes` instead of whatever
 *  listAllOrgScopes(db) happens to return against a real, shared database --
 *  see that function's own doc comment for why the real query's result
 *  (org count, and therefore rotation) is not something a test should
 *  depend on. Production has exactly one caller: autoSubmitOverdueSections
 *  below, immediately after the platform-wide read.
 *
 *  `rotationOffset`, if given, replaces the clock-derived starting offset.
 *  The offset decides which organization the rotation starts from, and
 *  deriving it from `Date.now()` -- necessary in production, since the job
 *  holds no state between runs -- makes the platform-level sweep depend on
 *  both wall-clock time AND how many organizations exist, neither of which
 *  a test controls. Injecting the offset directly lets a test put a
 *  specific organization at the front of the rotation deterministically,
 *  independent of org count and independent of when the test happens to
 *  run.
 *
 *  Emits exactly one structured summary line (#275's logging pattern), so a
 *  run is countable and greppable without parsing per-row output. Per-row
 *  failures have already been logged individually at error level by
 *  submitCandidates. */
export async function autoSubmitOverdueSectionsForScopes(
  db: Db,
  orgScopes: OrgScope[],
  opts: { rotationOffset?: number } = {},
): Promise<AutoSubmitRunSummary> {
  const startedAt = Date.now();

  const total = emptyRunSummary();
  /* #416 starvation guard: a fixed iteration order plus a shared budget
     would sweep the same prefix of organizations every hour and never reach
     the tail. Rotating the start offset by the hour means every org is
     first eventually, so a backlog anywhere on the platform drains instead
     of only the backlog at the front of the list.

     Derived from the clock by default, because the job holds no state
     between runs and a cron that fires hourly gives a naturally advancing
     offset for free -- but a caller (a test, per #437) may supply the
     offset directly instead, e.g. to force a specific org to the front of
     the rotation without depending on org count or wall-clock time. Modulo
     twice (`((x % n) + n) % n`) so a negative offset still lands in range. */
  const rotation =
    orgScopes.length === 0
      ? 0
      : opts.rotationOffset !== undefined
        ? ((opts.rotationOffset % orgScopes.length) + orgScopes.length) % orgScopes.length
        : Math.floor(startedAt / 3_600_000) % orgScopes.length;
  const rotatedScopes = orgScopes.map((_, i) => orgScopes[(i + rotation) % orgScopes.length]!);

  /* #437: the candidate SELECT is issued once per BATCH of
     AUTO_SUBMIT_ORG_BATCH_SIZE organizations, not once per organization --
     see that constant's doc comment for why. The insert phase below stays
     per-organization, so #414's per-org failure isolation still applies to
     every WRITE; what changes is that a single SELECT failure now takes
     down the whole batch it covered (still logged, still non-fatal to the
     rest of the run) rather than just one org, which is the batching
     tradeoff stated on AUTO_SUBMIT_ORG_BATCH_SIZE.

     The query applies its fixed, per-org candidate cap independently to
     bound downstream processing without making later batches unreachable. */
  let i = 0;
  while (i < rotatedScopes.length) {
    const batchSize = Math.min(AUTO_SUBMIT_ORG_BATCH_SIZE, rotatedScopes.length - i);
    const batchScopes = rotatedScopes.slice(i, i + batchSize);

    /* Minor review fix: this try now wraps ONLY the SELECT, not the insert
       loop below it. Previously both lived in one try, and the catch
       unconditionally attributed the WHOLE batch to `orgsFailed` --
       correct only because nothing in the insert loop can currently throw
       (submitCandidates already catches every per-candidate error
       internally, see its own doc comment), so in practice every throw
       reaching that catch really did come from the SELECT. Narrowing here
       makes that true by construction rather than by accident: if the
       insert loop ever DID start throwing, the old shape would have
       double-counted already-successfully-submitted orgs in this batch as
       failed, silently overspending the run's failure budget. */
    let candidatesByOrg: Awaited<ReturnType<typeof findOverdueSubmissionCandidatesForOrgs>>;
    try {
      // One subrequest, whatever the batch size -- this is the entire point
      // of #437's batching. Requested at the full per-org cap (the
      // function's own default), not narrowed by remaining run budget: see
      // the comment above this loop for why that narrowing was removed.
      candidatesByOrg = await findOverdueSubmissionCandidatesForOrgs(db, batchScopes);
    } catch (err) {
      /* #414's per-org isolation is now per-BATCH for the SELECT: a failure
         here (a transient database error, a statement timeout on a slow
         backlog SELECT) takes out every org in this batch's coverage for
         this run, but -- as before -- does not escape the loop, so the next
         batch is still attempted and the summary line below still emits.
         Smaller batches trade some of this run's coverage-per-failure for a
         higher org-count ceiling; AUTO_SUBMIT_ORG_BATCH_SIZE is the knob if
         that tradeoff needs to move. */
      total.orgsFailed += batchScopes.length;
      // #437 field rename, same AUTO_SUBMIT_LOG_CONTEXT: this used to log a
      // single `organizationId` per per-org failure. It's now
      // `organizationIds` (plural, an array) plus `batchSize`, since one
      // failure now covers a whole batch of orgs, not one. Anything
      // external (a dashboard, an alert rule) still keyed on the old
      // singular field name will silently stop matching -- flagging here
      // for whoever owns observability for this job; no dual-logging added,
      // that's out of scope for this pass.
      logServerError(AUTO_SUBMIT_LOG_CONTEXT, err, {
        organizationIds: batchScopes,
        batchSize: batchScopes.length,
      });
      i += batchSize;
      continue;
    }

    // Keep writes per organization so one candidate failure remains isolated.
    for (let j = 0; j < batchScopes.length; j++) {
      const scope = batchScopes[j]!;
      const candidates = candidatesByOrg.get(scope) ?? [];
      const orgSummary = await submitCandidates(db, scope, candidates);
      total.candidates += orgSummary.candidates;
      total.submitted += orgSummary.submitted;
      total.skipped += orgSummary.skipped;
      total.failed += orgSummary.failed;
    }

    i += batchSize;
  }

  /* Emitted unconditionally, including on a partial run. A sweep that
     covered 2 of 30 orgs and one that covered all 30 have to be
     distinguishable from the logs alone -- `orgsFailed` and `orgsDeferred`
     are what make a partial run visible rather than inferred from a
     suspiciously low `submitted`. */
  logServerInfo(AUTO_SUBMIT_LOG_CONTEXT, "auto-submit sweep complete", {
    organizations: orgScopes.length,
    organizationsSwept: orgScopes.length,
    ...total,
    durationMs: Date.now() - startedAt,
  });
  return total;
}

/** The production entry point: the whole platform, resolved from the
 *  database. A thin wrapper over autoSubmitOverdueSectionsForScopes -- the
 *  one platform-wide read lives here (and only here) so that everything
 *  past it, including every test of the loop's own behavior, is per-tenant
 *  by construction rather than by remembering to add a WHERE clause. See
 *  autoSubmitOverdueSectionsForScopes's doc comment for `rotationOffset` and
 *  for why the loop itself takes `orgScopes` as a parameter instead of
 *  querying internally. */
export async function autoSubmitOverdueSections(
  db: Db,
  opts: { rotationOffset?: number } = {},
): Promise<AutoSubmitRunSummary> {
  const orgScopes = await listAllOrgScopes(db);
  return autoSubmitOverdueSectionsForScopes(db, orgScopes, opts);
}
