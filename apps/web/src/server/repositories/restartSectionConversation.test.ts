import { describe, it, expect, vi } from "vitest";
import { restartSectionConversation, SubmissionGradedError } from "./submissions";
import { unsafeOrgScope } from "./scope";
import type { Db } from "../../db/client";

const SCOPE = unsafeOrgScope("org-1");
const CONV = "11111111-2222-4333-8444-555555555555";
const OWNER = "owner-1";

/** Minimal db double.
 *
 *  `selects` is a queue: each `.select()` chain shifts the next canned result,
 *  in the order restartSectionConversation issues them —
 *    1. conversation ownership/kind lookup (has .innerJoin)
 *    2. submission lookup
 *    3. grade lookup
 *  The write builders return marker strings so a test can assert on exactly
 *  which statements were grouped into the batch, and in what order.
 *
 *  `batch` is defined, so runAtomically takes its production (neon-http)
 *  path. The transaction fallback is covered in atomic.test.ts rather than
 *  re-tested through every caller. */
function makeDb(selects: unknown[][]) {
  const batch = vi.fn().mockResolvedValue(undefined);
  const queue = [...selects];
  const nextResult = async () => queue.shift() ?? [];
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: nextResult }),
        where: nextResult,
      }),
    }),
    update: () => ({ set: () => ({ where: () => "soft-delete-conversation" }) }),
    delete: () => ({ where: () => "delete-submission" }),
    batch,
  } as unknown as Db;
  return { db, batch };
}

describe("restartSectionConversation (#128)", () => {
  it("throws when the conversation is absent, deleted, or the wrong kind", async () => {
    const { db, batch } = makeDb([[]]);

    await expect(restartSectionConversation(db, SCOPE, CONV, OWNER)).rejects.toThrow(
      "Conversation not found or not accessible",
    );
    expect(batch).not.toHaveBeenCalled();
  });

  it("throws a distinct message when the requester does not own it", async () => {
    // Deliberately distinguishable from the message above: the repository
    // reports "absent" and "not yours" separately so the route can choose to
    // collapse them (to avoid leaking existence) rather than being forced to.
    const { db, batch } = makeDb([[{ id: CONV, ownerUserId: "someone-else" }]]);

    await expect(restartSectionConversation(db, SCOPE, CONV, OWNER)).rejects.toThrow(
      "Conversation is not owned by requester",
    );
    expect(batch).not.toHaveBeenCalled();
  });

  it("refuses to restart a graded submission, before writing anything", async () => {
    const { db, batch } = makeDb([
      [{ id: CONV, ownerUserId: OWNER }],
      [{ id: "sub-1", submittedAt: new Date() }],
      [{ id: "grade-1" }],
    ]);

    await expect(restartSectionConversation(db, SCOPE, CONV, OWNER)).rejects.toBeInstanceOf(
      SubmissionGradedError,
    );
    // The guard has to run before the atomic group, not alongside it: a
    // grade's RESTRICT FK would abort the delete anyway, but only after the
    // conversation had already been soft-deleted in the same group.
    expect(batch).not.toHaveBeenCalled();
  });

  it("soft-deletes the conversation and voids the submission in one atomic group", async () => {
    const submittedAt = new Date();
    const { db, batch } = makeDb([
      [{ id: CONV, ownerUserId: OWNER }],
      [{ id: "sub-1", submittedAt }],
      [],
    ]);

    const result = await restartSectionConversation(db, SCOPE, CONV, OWNER);

    expect(result.voidedSubmission).toEqual({ id: "sub-1", submittedAt });
    // One group, both statements. Two independent awaits would leave a
    // submission pointing at a soft-deleted conversation if the second failed.
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toEqual(["soft-delete-conversation", "delete-submission"]);
  });

  it("soft-deletes with no submission to void", async () => {
    const { db, batch } = makeDb([[{ id: CONV, ownerUserId: OWNER }], [], []]);

    const result = await restartSectionConversation(db, SCOPE, CONV, OWNER);

    expect(result.voidedSubmission).toBeNull();
    expect(batch.mock.calls[0]![0]).toEqual(["soft-delete-conversation"]);
  });

  it("does not look for a grade when there is no submission", async () => {
    // Third canned result is a grade row. If the implementation queried for a
    // grade despite there being no submission, it would consume this and
    // throw SubmissionGradedError instead of succeeding.
    const { db } = makeDb([[{ id: CONV, ownerUserId: OWNER }], [], [{ id: "grade-1" }]]);

    await expect(restartSectionConversation(db, SCOPE, CONV, OWNER)).resolves.toEqual({
      voidedSubmission: null,
    });
  });
});
