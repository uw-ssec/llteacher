import { describe, it, expect, vi } from "vitest";
import { restartSectionConversation } from "./sectionConversations";
import { SubmissionGradedError } from "./submissions";
import { unsafeOrgScope } from "./scope";
import type { Db } from "../../db/client";

const SCOPE = unsafeOrgScope("org-1");
const CONV = "11111111-2222-4333-8444-555555555555";
const OWNER = "owner-1";

/** A conversation row shaped like the one restartSectionConversation reads. */
const OWNED = {
  id: CONV,
  ownerUserId: OWNER,
  courseId: "course-1",
  sectionId: "section-1",
  isTeacherTest: false,
  sectionOrder: 2,
  sectionTitle: "Confidence intervals",
  sectionContent: "Estimate the mean.",
};

/** Minimal db double.
 *
 *  `selects` is a queue: each `.select()` chain shifts the next canned result,
 *  in the order restartSectionConversation issues them —
 *    1. conversation ownership/kind lookup (two chained innerJoins)
 *    2. submission lookup
 *    3. grade lookup
 *  The write builders return marker strings so a test can assert exactly which
 *  statements were grouped into the batch, and in what order — ordering
 *  matters here, since the soft-delete has to precede the insert for
 *  conversations_owner_section_active_uq to permit the replacement.
 *
 *  `batch` is defined, so runAtomically takes its production (neon-http) path.
 *  The transaction fallback is covered in atomic.test.ts rather than being
 *  re-tested through every caller. */
function makeDb(selects: unknown[][]) {
  const batch = vi.fn().mockResolvedValue(undefined);
  const queue = [...selects];
  const nextResult = async () => queue.shift() ?? [];
  const joinable: Record<string, unknown> = {
    where: nextResult,
    get innerJoin() {
      return () => joinable;
    },
  };
  const inserted: Record<string, unknown>[] = [];
  const db = {
    select: () => ({ from: () => joinable }),
    update: () => ({ set: () => ({ where: () => "soft-delete-conversation" }) }),
    delete: () => ({ where: () => "delete-submission" }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return v.parts ? "insert-greeting" : "insert-conversation";
      },
    }),
    batch,
  } as unknown as Db;
  return { db, batch, inserted };
}

describe("restartSectionConversation (#27, #128)", () => {
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
    const { db, batch } = makeDb([[{ ...OWNED, ownerUserId: "someone-else" }]]);

    await expect(restartSectionConversation(db, SCOPE, CONV, OWNER)).rejects.toThrow(
      "Conversation is not owned by requester",
    );
    expect(batch).not.toHaveBeenCalled();
  });

  it("refuses to restart a graded submission, before writing anything", async () => {
    const { db, batch } = makeDb([
      [OWNED],
      [{ id: "sub-1", submittedAt: new Date() }],
      [{ id: "grade-1" }],
    ]);

    await expect(restartSectionConversation(db, SCOPE, CONV, OWNER)).rejects.toBeInstanceOf(
      SubmissionGradedError,
    );
    // The guard has to run before the atomic group, not alongside it: a
    // grade's RESTRICT FK would abort the submission delete anyway, but only
    // after the conversation had already been soft-deleted in the same group.
    expect(batch).not.toHaveBeenCalled();
  });

  it("voids the submission and creates the replacement in one atomic group", async () => {
    const submittedAt = new Date();
    const { db, batch } = makeDb([[OWNED], [{ id: "sub-1", submittedAt }], []]);

    const result = await restartSectionConversation(db, SCOPE, CONV, OWNER);

    expect(result.voidedSubmission).toEqual({ id: "sub-1", submittedAt });
    expect(batch).toHaveBeenCalledTimes(1);
    // Order is load-bearing: the soft-delete must precede the insert, or
    // conversations_owner_section_active_uq rejects the replacement.
    expect(batch.mock.calls[0]![0]).toEqual([
      "soft-delete-conversation",
      "delete-submission",
      "insert-conversation",
      "insert-greeting",
    ]);
  });

  it("restarts a conversation that was never submitted", async () => {
    const { db, batch } = makeDb([[OWNED], [], []]);

    const result = await restartSectionConversation(db, SCOPE, CONV, OWNER);

    expect(result.voidedSubmission).toBeNull();
    expect(batch.mock.calls[0]![0]).toEqual([
      "soft-delete-conversation",
      "insert-conversation",
      "insert-greeting",
    ]);
  });

  it("does not look for a grade when there is no submission", async () => {
    // Third canned result is a grade row. If the implementation queried for a
    // grade despite there being no submission, it would consume this and
    // throw SubmissionGradedError instead of succeeding.
    const { db } = makeDb([[OWNED], [], [{ id: "grade-1" }]]);

    await expect(restartSectionConversation(db, SCOPE, CONV, OWNER)).resolves.toMatchObject({
      voidedSubmission: null,
    });
  });

  it("carries isTeacherTest onto the replacement rather than re-deriving it", async () => {
    // A student promoted to TA mid-term who restarts must not have their work
    // silently reclassified as a teacher test -- and an instructor's test
    // conversation must stay a test after restarting.
    const { db, inserted } = makeDb([[{ ...OWNED, isTeacherTest: true }], [], []]);

    await restartSectionConversation(db, SCOPE, CONV, OWNER);

    const conversation = inserted.find((v) => !v.parts);
    expect(conversation).toMatchObject({ isTeacherTest: true, kind: "section" });
  });

  it("opens the replacement with the Django-parity greeting for its section", async () => {
    const { db, inserted, batch } = makeDb([[OWNED], [], []]);

    const result = await restartSectionConversation(db, SCOPE, CONV, OWNER);

    const greeting = inserted.find((v) => v.parts) as { parts: { text: string }[] };
    expect(greeting.parts[0]!.text).toBe(
      "Hello! I'm here to help you with Section 2: Confidence intervals.\n\nEstimate the mean.\n\nHow can I assist you with this question?",
    );
    expect(result.conversation.title).toBe("Section 2: Confidence intervals");
    expect(batch).toHaveBeenCalledTimes(1);
  });
});

describe("startSectionConversation constraint race (#238)", () => {
  /** db double whose insert batch rejects with a Postgres unique violation,
   *  the way a concurrent "Start" loses the race after both requests pass the
   *  pre-check. */
  function racingDb(constraint: string) {
    const joinable: Record<string, unknown> = {
      // membership found, section found, no existing conversation
      where: async () => queue.shift() ?? [],
      get innerJoin() {
        return () => joinable;
      },
    };
    const queue: unknown[][] = [
      [{ id: "membership-1" }],
      [{ id: "section-1", order: 1, title: "A", content: "c", type: "conversation" }],
      [],
    ];
    return {
      select: () => ({ from: () => joinable }),
      insert: () => ({ values: () => "stmt" }),
      batch: vi.fn().mockRejectedValue(Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint,
      })),
    } as unknown as Db;
  }

  it("translates the unique violation into the same 409 the pre-check produces", async () => {
    const { startSectionConversation, SectionConversationExistsError } = await import(
      "./sectionConversations"
    );
    const { unsafeCourseScope } = await import("./scope");

    await expect(
      startSectionConversation(racingDb("conversations_owner_section_active_uq"), unsafeCourseScope("course-1"), {
        sectionId: "section-1",
        ownerUserId: OWNER,
        isTeacherTest: false,
      }),
    ).rejects.toBeInstanceOf(SectionConversationExistsError);
  });

  it("does not swallow a unique violation on some other constraint", async () => {
    const { startSectionConversation, SectionConversationExistsError } = await import(
      "./sectionConversations"
    );
    const { unsafeCourseScope } = await import("./scope");

    // A 23505 naming a different constraint is not "you already started this
    // section" -- laundering it into a 409 would hide a real bug.
    const promise = startSectionConversation(racingDb("some_other_uq"), unsafeCourseScope("course-1"), {
      sectionId: "section-1",
      ownerUserId: OWNER,
      isTeacherTest: false,
    });
    await expect(promise).rejects.toThrow("duplicate key");
    await expect(promise).rejects.not.toBeInstanceOf(SectionConversationExistsError);
  });
});
