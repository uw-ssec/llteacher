/* --------------------------------------------------------------------------
   #414 / #416: the sweep's ORCHESTRATION, with the data layer mocked.

   Deliberately not part of autoSubmitOverdue.db.test.ts. That suite exists
   because idempotency and concurrency are properties of a unique index and
   an ON CONFLICT clause, which a mocked db cannot evaluate. The two
   properties here are the opposite shape: "one org's failure does not abort
   the others" and "the run stops before it exceeds the invocation's
   subrequest budget" are properties of the LOOP, and reproducing them
   against real Postgres would mean manufacturing a transient driver failure
   and seeding ~900 rows of backlog. Mocking the repository boundary states
   both directly.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { unsafeOrgScope } from "../repositories/scope";
import type { OrgScope } from "../repositories/scope";
import type { OverdueSubmissionCandidate } from "../repositories/submissions";

const listAllOrgScopesMock = vi.fn();
const findOverdueSubmissionCandidatesMock = vi.fn();
const insertAutoSubmissionMock = vi.fn();

vi.mock("../repositories/organizations", () => ({
  listAllOrgScopes: (...a: unknown[]) => listAllOrgScopesMock(...a),
}));

vi.mock("../repositories/submissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/submissions")>();
  return {
    ...actual,
    findOverdueSubmissionCandidates: (...a: unknown[]) => findOverdueSubmissionCandidatesMock(...a),
    insertAutoSubmission: (...a: unknown[]) => insertAutoSubmissionMock(...a),
  };
});

const { autoSubmitOverdueSections, AUTO_SUBMIT_RUN_SUBREQUEST_BUDGET } = await import("./autoSubmitOverdue");
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

describe("#414: one organization's failure does not abort the sweep", () => {
  it("continues to the remaining orgs when a candidate read throws, and counts the failure", async () => {
    const [orgA, orgB, orgC] = orgs(3);
    listAllOrgScopesMock.mockResolvedValue([orgA, orgB, orgC]);
    // Rotation is derived from the clock; pin it so orgA is genuinely first.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    findOverdueSubmissionCandidatesMock.mockImplementation(async (_db: unknown, scope: OrgScope) => {
      if (scope === orgB) throw new Error("neon blip");
      return candidates(1);
    });

    const summary = await autoSubmitOverdueSections(db);

    // The failing org is counted, not swallowed...
    expect(summary.orgsFailed).toBe(1);
    // ...and the org AFTER it was still swept, which is the whole point:
    // before this fix the rejection escaped the loop and orgC never ran.
    expect(findOverdueSubmissionCandidatesMock).toHaveBeenCalledTimes(3);
    expect(summary.submitted).toBe(2);
  });

  it("does not reject, so scheduled() cannot re-throw a partial run as a total failure", async () => {
    listAllOrgScopesMock.mockResolvedValue(orgs(2));
    findOverdueSubmissionCandidatesMock.mockRejectedValue(new Error("statement timeout"));

    await expect(autoSubmitOverdueSections(db)).resolves.toMatchObject({ orgsFailed: 2, submitted: 0 });
  });

  it("still emits the run summary when every org failed", async () => {
    const infoSpy = vi.spyOn(await import("../utils/errors"), "logServerInfo");
    listAllOrgScopesMock.mockResolvedValue(orgs(2));
    findOverdueSubmissionCandidatesMock.mockRejectedValue(new Error("down"));

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

describe("#416: the run-level subrequest budget", () => {
  it("stops before exceeding the invocation budget instead of failing mid-loop", async () => {
    // Ten organizations each carrying a full first-run backlog. Two alone
    // exceed Cloudflare's 1000-subrequest invocation cap, which is the
    // failure this budget exists for.
    const orgCount = 10;
    listAllOrgScopesMock.mockResolvedValue(orgs(orgCount));
    // Faithful to the real repository: it returns at most `limit` rows.
    findOverdueSubmissionCandidatesMock.mockImplementation(async (_db: unknown, _scope: OrgScope, limit: number) =>
      candidates(Math.min(limit, OVERDUE_SUBMISSION_CANDIDATE_LIMIT)),
    );

    const summary = await autoSubmitOverdueSections(db);

    // The invariant that matters, counted the way Cloudflare counts it:
    // one fetch for the org list, one per candidate SELECT, one per insert.
    const spent =
      1 + findOverdueSubmissionCandidatesMock.mock.calls.length + insertAutoSubmissionMock.mock.calls.length;
    expect(spent).toBeLessThanOrEqual(AUTO_SUBMIT_RUN_SUBREQUEST_BUDGET);

    // And the orgs it could not afford are reported as deferred, not
    // silently dropped and not attempted-then-crashed.
    expect(summary.orgsDeferred).toBeGreaterThan(0);
    expect(summary.orgsDeferred).toBe(orgCount - findOverdueSubmissionCandidatesMock.mock.calls.length);
  });

  it("reaches every org on a healthy platform, where orgs are mostly idle", async () => {
    // The budget bites on backlog, not on org count: an org with no
    // candidates costs one SELECT.
    listAllOrgScopesMock.mockResolvedValue(orgs(400));
    findOverdueSubmissionCandidatesMock.mockResolvedValue([]);

    const summary = await autoSubmitOverdueSections(db);

    expect(summary.orgsDeferred).toBe(0);
    expect(findOverdueSubmissionCandidatesMock).toHaveBeenCalledTimes(400);
  });

  it("rotates the starting org by the hour, so a deferred tail is not starved forever", async () => {
    const all = orgs(5);
    listAllOrgScopesMock.mockResolvedValue(all);
    findOverdueSubmissionCandidatesMock.mockResolvedValue([]);
    vi.useFakeTimers();

    const firstSweptAt = async (hoursSinceEpoch: number) => {
      vi.setSystemTime(new Date(hoursSinceEpoch * 3_600_000));
      findOverdueSubmissionCandidatesMock.mockClear();
      await autoSubmitOverdueSections(db);
      return findOverdueSubmissionCandidatesMock.mock.calls[0]![1] as OrgScope;
    };

    // Consecutive hourly runs must not begin at the same organization --
    // that is what stops a shared budget from permanently starving the tail,
    // and it is the reason the per-org cap could stop being the only bound.
    expect(await firstSweptAt(0)).toBe(all[0]);
    expect(await firstSweptAt(1)).toBe(all[1]);
    expect(await firstSweptAt(2)).toBe(all[2]);
  });

  it("does not divide by zero when the platform has no organizations", async () => {
    listAllOrgScopesMock.mockResolvedValue([]);
    await expect(autoSubmitOverdueSections(db)).resolves.toMatchObject({ candidates: 0, orgsDeferred: 0 });
  });
});
