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
   for the single-org path, or the smaller OVERDUE_SUBMISSION_BATCH_CANDIDATE_LIMIT
   for the batched path this file now uses (repositories/submissions.ts --
   see that constant's own doc comment for why the batched path needs a
   separate, smaller cap). On the neon-http driver every statement is
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
   in a SINGLE invocation, so the costs add. The cost model (pre-#437) was

       1 (listAllOrgScopes) + 1 per org attempted (its candidate SELECT)
         + 1 per candidate (its insert)

   Two orgs each carrying a full 500-row first-run backlog already exceed
   1000. Without this the 1001st fetch throws mid-loop, and -- before #414's
   per-org isolation -- killed the entire sweep, identically, every hour.

   Starvation, which is why the per-org cap was per-org in the first place:
   a shared budget consumed by whichever orgs come back first would
   permanently starve the tail. Answered by rotation rather than by dropping
   the budget -- see the offset in autoSubmitOverdueSections.

   #437: that cost model had a second-order consequence nobody had stated --
   "1 per org attempted" made the SELECT cost scale with TENANT COUNT, so a
   platform above ~899 organizations deferred the tail of the org list every
   run before any backlog was even considered, regardless of whether those
   orgs had a single candidate between them. The candidate SELECT is now
   batched across AUTO_SUBMIT_ORG_BATCH_SIZE organizations at once (one
   subrequest covers the whole batch -- findOverdueSubmissionCandidatesForOrgs),
   so the cost model is

       1 (listAllOrgScopes) + 1 per BATCH attempted (its candidate SELECT)
         + 1 per candidate (its insert, unchanged)

   which is what actually protects the budget now: it scales with backlog
   PER BATCH (at most AUTO_SUBMIT_ORG_BATCH_SIZE orgs' worth of inserts
   sharing one SELECT), not with how many tenants exist. A healthy platform
   of mostly-idle orgs now covers AUTO_SUBMIT_ORG_BATCH_SIZE times as many
   organizations per run as before, for the same budget -- the ~899-org
   ceiling this issue found is now, at the chosen batch size, an
   ~89,900-org one, and reaching it at all requires that many orgs to be
   idle for their SELECT cost to stay at 1-per-batch; a real backlog spends
   the same insert subrequests either way, so the two problems this budget
   protects against (a single invocation exceeding Cloudflare's cap, and one
   busy tenant starving the rest) are both still bounded exactly as before.

   #437 review (Important #2): an earlier version of this batching queried
   each batch with a PRE-DIVIDED per-org limit
   (floor(remaining-budget / batch-size)) so the batch's absolute worst case
   -- every org in it maxed out -- could never overspend. That protected the
   budget but silently gutted single-org throughput for the realistic mixed
   case this file's own docs describe ("two orgs each carrying a full
   500-row first-run backlog"): at defaults, the very first batch's
   pre-divided limit was floor(898/100) = 8, so a genuinely backlogged org
   sharing a batch with 99 idle ones now drained at ~8/run instead of the
   up-to-500/run the pre-#437 per-org loop gave whichever org came first --
   an unstated ~60x throughput regression for exactly the scenario the
   budget was introduced to handle safely, not to slow down. Fixed by
   allocating the budget PER CANDIDATE ACTUALLY CONSUMED, in org order,
   after the batch's SELECT returns each org's real (not pre-guessed)
   candidates -- see autoSubmitOverdueSectionsForScopes. An idle org ahead
   of a busy one in the same batch costs nothing, so the busy one still gets
   up to whatever the batch's query actually returned for it worth of the
   remaining budget, exactly as a lone org would pre-#437; only once the
   budget for inserts is actually exhausted does the rest of that batch (and
   every later one) get deferred.

   #437 review (a further, separate finding on the same fix): removing the
   budget-derived narrowing above also removed the only thing that had been
   bounding the batched SELECT's own result-set size -- see
   OVERDUE_SUBMISSION_BATCH_CANDIDATE_LIMIT (repositories/submissions.ts)
   for that fixed, budget-independent cap, and why it is deliberately
   smaller than the single-org path's OVERDUE_SUBMISSION_CANDIDATE_LIMIT.
   The two bounds are intentionally separate concerns: this constant caps
   INSERTS one invocation may attempt (a Cloudflare-subrequest-count bound,
   spent per candidate actually consumed); that one caps ROWS one SELECT may
   return (a query-payload/Worker-memory bound, fixed regardless of how much
   insert budget remains). Deriving either from the other is exactly what
   caused the two regressions found in review -- keeping them independent is
   the fix, not a coincidence of how the code happens to be organized. */
export const AUTO_SUBMIT_RUN_SUBREQUEST_BUDGET = 900;

/* #437: how many organizations one candidate SELECT covers.
 *
 * The tradeoff is narrower than it first looks, because #437 review's
 * Important #2 removed the other half of it: the query itself is no longer
 * shrunk by remaining run budget (see AUTO_SUBMIT_RUN_SUBREQUEST_BUDGET's
 * doc comment), so a larger batch does not reserve a larger worst-case
 * budget commitment up front -- the budget is spent per candidate actually
 * consumed, not per batch capacity. What batch size actually trades off:
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
  /* Spent on the org-list read that produced `orgScopes` -- listAllOrgScopes
     in production (autoSubmitOverdueSections below), nothing at all when a
     test calls this function directly with a hand-built list. Charged
     unconditionally anyway: this function's budget accounting is meant to
     model the real invocation's cost, and the one production caller always
     pays it, so a test bypassing the query should still see the same
     accounting production would. Everything below decrements from the same
     pool, so the bound is on the INVOCATION, which is what Cloudflare
     actually meters. */
  let subrequestsSpent = 1;

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

     #437 review (Important #2): the batch's SELECT is NOT shrunk by
     remaining budget -- it always asks for up to each org's standing
     per-BATCH candidate cap (findOverdueSubmissionCandidatesForOrgs's own
     default, OVERDUE_SUBMISSION_BATCH_CANDIDATE_LIMIT -- deliberately
     smaller than the single-org path's OVERDUE_SUBMISSION_CANDIDATE_LIMIT;
     see that constant's doc comment for why), regardless of how much run
     budget is left. Only the INSERT side is budget-limited, and it's
     limited per CANDIDATE ACTUALLY CONSUMED as the inner loop below walks
     the batch in order, not per org upfront -- see
     AUTO_SUBMIT_RUN_SUBREQUEST_BUDGET's doc comment for why an earlier,
     pre-divided version of this silently regressed single-org throughput,
     and for why the SELECT's own result-set size is a separate bound from
     the insert budget rather than derived from it. */
  let i = 0;
  outer: while (i < rotatedScopes.length) {
    const remaining = AUTO_SUBMIT_RUN_SUBREQUEST_BUDGET - subrequestsSpent;
    // One for the batch's SELECT, one for at least a single insert; below
    // that there is no useful work left to start.
    if (remaining < 2) {
      total.orgsDeferred = rotatedScopes.length - i;
      break;
    }

    const batchSize = Math.min(AUTO_SUBMIT_ORG_BATCH_SIZE, rotatedScopes.length - i);
    const batchScopes = rotatedScopes.slice(i, i + batchSize);

    try {
      // One subrequest, whatever the batch size -- this is the entire point
      // of #437's batching. Requested at the full per-org cap (the
      // function's own default), not narrowed by remaining run budget: see
      // the comment above this loop for why that narrowing was removed.
      const candidatesByOrg = await findOverdueSubmissionCandidatesForOrgs(db, batchScopes);
      subrequestsSpent += 1;

      // Walk the batch IN ORDER, spending the run's remaining insert budget
      // on whichever org needs it, as it's actually needed -- not divided
      // evenly up front. An idle org ahead of a busy one costs nothing, so
      // the busy one still gets up to the full remaining budget, exactly as
      // a lone org would have pre-#437.
      for (let j = 0; j < batchScopes.length; j++) {
        const budgetForInserts = AUTO_SUBMIT_RUN_SUBREQUEST_BUDGET - subrequestsSpent;
        if (budgetForInserts < 1) {
          // Nothing left to spend on an insert. Everything from here on --
          // the rest of THIS batch, and every batch after it -- is
          // deferred to the next run, same as the outer `remaining < 2`
          // check above but discovered mid-batch instead of between them.
          total.orgsDeferred = rotatedScopes.length - (i + j);
          break outer;
        }
        const scope = batchScopes[j]!;
        // Sliced to what the run can still afford, not to a pre-guessed
        // share -- an org whose real candidates (already capped at
        // OVERDUE_SUBMISSION_BATCH_CANDIDATE_LIMIT by the query itself)
        // exceed this is not "deferred" (its SELECT already ran, and this
        // run genuinely worked some of it); the untouched remainder is
        // simply still there, unconsumed, for the next run -- the same
        // self-draining property both candidate-limit constants rely on.
        const candidates = (candidatesByOrg.get(scope) ?? []).slice(0, budgetForInserts);
        const orgSummary = await submitCandidates(db, scope, candidates);
        total.candidates += orgSummary.candidates;
        total.submitted += orgSummary.submitted;
        total.skipped += orgSummary.skipped;
        total.failed += orgSummary.failed;
        // One insert attempted per candidate. Candidates the org did not
        // have cost nothing, so a healthy platform of mostly-idle orgs
        // spends ~1 per BATCH (not per org) and reaches all of them.
        subrequestsSpent += orgSummary.candidates;
      }
    } catch (err) {
      /* #414's per-org isolation is now per-BATCH for the SELECT: a failure
         here (a transient neon-http error, a statement timeout on a slow
         backlog SELECT) takes out every org in this batch's coverage for
         this run, but -- as before -- does not escape the loop, so the next
         batch is still attempted and the summary line below still emits.
         Smaller batches trade some of this run's coverage-per-failure for a
         higher org-count ceiling; AUTO_SUBMIT_ORG_BATCH_SIZE is the knob if
         that tradeoff needs to move. */
      total.orgsFailed += batchScopes.length;
      // The SELECT was still attempted and still cost a subrequest.
      subrequestsSpent += 1;
      logServerError(AUTO_SUBMIT_LOG_CONTEXT, err, {
        organizationIds: batchScopes,
        batchSize: batchScopes.length,
      });
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
    organizationsSwept: orgScopes.length - total.orgsDeferred,
    subrequestsSpent,
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
