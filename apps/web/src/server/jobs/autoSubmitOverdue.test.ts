/* --------------------------------------------------------------------------
   #414 / #416 / #437: the sweep's ORCHESTRATION, with the data layer mocked.

   Deliberately not part of autoSubmitOverdue.db.test.ts. That suite exists
   because idempotency and concurrency are properties of a unique index and
   an ON CONFLICT clause, which a mocked db cannot evaluate. The properties
   here are the opposite shape: "one batch's failure does not abort the
   others," "the run stops before it exceeds the invocation's subrequest
   budget," and "the candidate SELECT is batched, so budget scales with
   backlog per batch rather than tenant count" (#437) are properties of the
   LOOP, and reproducing them against real Postgres would mean manufacturing
   a transient driver failure and seeding thousands of rows of backlog.
   Mocking the repository boundary states all three directly.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { unsafeOrgScope } from "../repositories/scope";
import type { OrgScope } from "../repositories/scope";
import type { OverdueSubmissionCandidate } from "../repositories/submissions";

const listAllOrgScopesMock = vi.fn();
const findOverdueSubmissionCandidatesMock = vi.fn();
const findOverdueSubmissionCandidatesForOrgsMock = vi.fn();
const insertAutoSubmissionMock = vi.fn();

vi.mock("../repositories/organizations", () => ({
  listAllOrgScopes: (...a: unknown[]) => listAllOrgScopesMock(...a),
}));

vi.mock("../repositories/submissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/submissions")>();
  return {
    ...actual,
    findOverdueSubmissionCandidates: (...a: unknown[]) => findOverdueSubmissionCandidatesMock(...a),
    findOverdueSubmissionCandidatesForOrgs: (...a: unknown[]) => findOverdueSubmissionCandidatesForOrgsMock(...a),
    insertAutoSubmission: (...a: unknown[]) => insertAutoSubmissionMock(...a),
  };
});

const {
  autoSubmitOverdueSections,
  AUTO_SUBMIT_RUN_SUBREQUEST_BUDGET,
  AUTO_SUBMIT_ORG_BATCH_SIZE,
} = await import("./autoSubmitOverdue");
const { OVERDUE_SUBMISSION_CANDIDATE_LIMIT } = await import("../repositories/submissions");

const db = {} as never;

function orgs(n: number): OrgScope[] {
  return Array.from({ length: n }, (_, i) => unsafeOrgScope(`00000000-0000-0000-0000-${String(i).padStart(12, "0")}`));
}

function candidates(n: number): OverdueSubmissionCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    conversationId: `conv-${i}`,
    userId: `user-${i}`,
    sectionId: `section-${i}`,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  insertAutoSubmissionMock.mockResolvedValue(true);
});

describe("#414 / #437: one batch's failure does not abort the sweep", () => {
  it("continues to the remaining batches when a candidate read throws, and counts the failure for that whole batch", async () => {
    // Three FULL batches of orgs (the middle one entirely failing), so the
    // failure's blast radius -- everything sharing that one SELECT -- is
    // visible, and so is the fact that the OTHER batches still ran.
    const batchSize = AUTO_SUBMIT_ORG_BATCH_SIZE;
    const orgCount = batchSize * 3;
    const allOrgs = orgs(orgCount);
    listAllOrgScopesMock.mockResolvedValue(allOrgs);

    findOverdueSubmissionCandidatesForOrgsMock.mockImplementation(
      async (_db: unknown, scopes: OrgScope[]) => {
        if (scopes[0] === allOrgs[batchSize]) throw new Error("neon blip");
        return new Map(scopes.map((scope) => [scope, candidates(1)]));
      },
    );

    const summary = await autoSubmitOverdueSections(db, { rotationOffset: 0 });

    // Exactly the failing batch is counted, not swallowed...
    expect(summary.orgsFailed).toBe(batchSize);
    // ...and both batches around it were still attempted -- before a fix
    // like #414's, a rejection escaping the loop would have killed the
    // sweep at the first failure and the third batch would never run.
    expect(findOverdueSubmissionCandidatesForOrgsMock).toHaveBeenCalledTimes(3);
    // The two healthy batches (2 * batchSize orgs, 1 candidate each) were
    // fully submitted.
    expect(summary.submitted).toBe(batchSize * 2);
  });

  it("does not reject, so scheduled() cannot re-throw a partial run as a total failure", async () => {
    listAllOrgScopesMock.mockResolvedValue(orgs(2));
    findOverdueSubmissionCandidatesForOrgsMock.mockRejectedValue(new Error("statement timeout"));

    await expect(autoSubmitOverdueSections(db)).resolves.toMatchObject({ orgsFailed: 2, submitted: 0 });
  });

  it("still emits the run summary when every batch failed", async () => {
    const infoSpy = vi.spyOn(await import("../utils/errors"), "logServerInfo");
    listAllOrgScopesMock.mockResolvedValue(orgs(2));
    findOverdueSubmissionCandidatesForOrgsMock.mockRejectedValue(new Error("down"));

    await autoSubmitOverdueSections(db);

    // A run that covered nothing has to be visible as such, rather than
    // producing no line at all the way the pre-#414 re-throw did.
    expect(infoSpy).toHaveBeenCalledWith(
      expect.any(String),
      "auto-submit sweep complete",
      expect.objectContaining({ orgsFailed: 2 }),
    );
    infoSpy.mockRestore();
  });
});

describe("#416 / #437: the run-level subrequest budget", () => {
  it("stops before exceeding the invocation budget instead of failing mid-loop", async () => {
    // Several batches' worth of organizations, every one carrying a full
    // first-run backlog (perOrgLimit candidates -- whatever the run loop
    // actually asks for) -- the failure shape this budget exists for, now
    // expressed per-batch instead of per-org.
    const orgCount = AUTO_SUBMIT_ORG_BATCH_SIZE * 3;
    listAllOrgScopesMock.mockResolvedValue(orgs(orgCount));
    findOverdueSubmissionCandidatesForOrgsMock.mockImplementation(
      async (_db: unknown, scopes: OrgScope[], perOrgLimit: number) =>
        new Map(scopes.map((scope) => [scope, candidates(Math.min(perOrgLimit, OVERDUE_SUBMISSION_CANDIDATE_LIMIT))])),
    );

    const summary = await autoSubmitOverdueSections(db);

    // The invariant that matters, counted the way Cloudflare counts it: one
    // fetch for the org list, one per candidate SELECT (now per BATCH, not
    // per org), one per insert.
    const spent =
      1 + findOverdueSubmissionCandidatesForOrgsMock.mock.calls.length + insertAutoSubmissionMock.mock.calls.length;
    expect(spent).toBeLessThanOrEqual(AUTO_SUBMIT_RUN_SUBREQUEST_BUDGET);

    // And the orgs it could not afford are reported as deferred, not
    // silently dropped and not attempted-then-crashed. "Covered" is summed
    // from the actual batch calls rather than assumed, since a batch can be
    // shrunk below AUTO_SUBMIT_ORG_BATCH_SIZE near the budget's edge.
    const covered = findOverdueSubmissionCandidatesForOrgsMock.mock.calls.reduce(
      (n: number, call: unknown[]) => n + (call[1] as OrgScope[]).length,
      0,
    );
    expect(summary.orgsDeferred).toBeGreaterThan(0);
    expect(summary.orgsDeferred).toBe(orgCount - covered);
  });

  it("reaches every org on a healthy, large platform -- the ~899-org ceiling #437 found is gone", async () => {
    // The whole point of batching: an idle org now costs a fraction of a
    // subrequest (its share of one SELECT per AUTO_SUBMIT_ORG_BATCH_SIZE
    // orgs) instead of a whole one. Before #437 this org count would have
    // deferred everything past ~899; batched, it comfortably fits.
    const orgCount = 5000;
    listAllOrgScopesMock.mockResolvedValue(orgs(orgCount));
    findOverdueSubmissionCandidatesForOrgsMock.mockResolvedValue(new Map());

    const summary = await autoSubmitOverdueSections(db);

    expect(summary.orgsDeferred).toBe(0);
    // One SELECT per batch, not per org.
    expect(findOverdueSubmissionCandidatesForOrgsMock).toHaveBeenCalledTimes(
      Math.ceil(orgCount / AUTO_SUBMIT_ORG_BATCH_SIZE),
    );
  });

  it("rotates the starting org by an injected offset, deterministically -- independent of org count or wall-clock time (#437)", async () => {
    // #437: the old version of this test derived the expected rotation from
    // real org count and vi.setSystemTime, which is exactly the coupling
    // the issue flagged as making the sweep non-deterministic to test. The
    // injected offset sidesteps org count and the clock entirely.
    const all = orgs(5);
    listAllOrgScopesMock.mockResolvedValue(all);
    findOverdueSubmissionCandidatesForOrgsMock.mockResolvedValue(new Map());

    const firstSweptAt = async (rotationOffset: number) => {
      findOverdueSubmissionCandidatesForOrgsMock.mockClear();
      await autoSubmitOverdueSections(db, { rotationOffset });
      const firstBatchScopes = findOverdueSubmissionCandidatesForOrgsMock.mock.calls[0]![1] as OrgScope[];
      return firstBatchScopes[0];
    };

    expect(await firstSweptAt(0)).toBe(all[0]);
    expect(await firstSweptAt(1)).toBe(all[1]);
    expect(await firstSweptAt(2)).toBe(all[2]);
    // Wraps modulo org count, and tolerates a negative offset the same way.
    expect(await firstSweptAt(5)).toBe(all[0]);
    expect(await firstSweptAt(-1)).toBe(all[4]);
  });

  it("falls back to the hourly clock-derived rotation when no offset is injected", async () => {
    // The production path still exists and still advances hourly -- the
    // injected offset above is an addition for tests, not a replacement.
    const all = orgs(3);
    listAllOrgScopesMock.mockResolvedValue(all);
    findOverdueSubmissionCandidatesForOrgsMock.mockResolvedValue(new Map());
    vi.useFakeTimers();

    const firstSweptAtHour = async (hoursSinceEpoch: number) => {
      vi.setSystemTime(new Date(hoursSinceEpoch * 3_600_000));
      findOverdueSubmissionCandidatesForOrgsMock.mockClear();
      await autoSubmitOverdueSections(db);
      const firstBatchScopes = findOverdueSubmissionCandidatesForOrgsMock.mock.calls[0]![1] as OrgScope[];
      return firstBatchScopes[0];
    };

    expect(await firstSweptAtHour(0)).toBe(all[0]);
    expect(await firstSweptAtHour(1)).toBe(all[1]);
    expect(await firstSweptAtHour(2)).toBe(all[2]);
  });

  it("does not divide by zero when the platform has no organizations", async () => {
    listAllOrgScopesMock.mockResolvedValue([]);
    await expect(autoSubmitOverdueSections(db)).resolves.toMatchObject({ candidates: 0, orgsDeferred: 0 });
    expect(findOverdueSubmissionCandidatesForOrgsMock).not.toHaveBeenCalled();
  });
});
