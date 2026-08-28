import { describe, it, expect, vi } from "vitest";
import { restartSectionConversation } from "./sectionConversations";
import { SubmissionGradedError } from "./submissions";
import { unsafeOrgScope } from "./scope";
import { SECTION_CONVERSATION_PROMPTS, type SectionConversationPrompts } from "../../lib/prompts";
import type { Db } from "../../db/client";

// #25: both restartSectionConversation and startSectionConversation now
// resolve+pin a prompt template internally. Mocked here (not just given a
// canned queue result) because resolvePromptTemplate's real implementation
// issues its own .select() chains against `db`, which would silently
// consume from this file's hand-rolled `queue`/`selects` fakes below and
// desync every carefully-ordered assertion that follows. getOrgScopeForCourse
// uses db.query.courses.findFirst -- an API these fakes don't implement at
// all -- so it must be mocked regardless.
vi.mock("./organizations", () => ({
  getOrgScopeForCourse: async () => "org-1",
}));
vi.mock("../../lib/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/prompts")>();
  return {
    ...actual,
    resolvePromptTemplate: async () => ({ id: null, content: "test system prompt", version: null }),
  };
});

/** A SECOND TENANT's wording -- deliberately unlike SECTION_CONVERSATION_
 *  PROMPTS in both templates, so an assertion on the persisted text can only
 *  pass if this object is what the repository actually formatted with. #305's
 *  whole reason for making these a parameter. */
const TENANT_TWO_PROMPTS: SectionConversationPrompts = {
  greeting: (s) => `Bienvenue -- partie ${s.order}. ${s.content}`,
  title: (s) => `Partie ${s.order} : ${s.title}`,
};

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

    await expect(restartSectionConversation(db, SCOPE, CONV, OWNER, true, SECTION_CONVERSATION_PROMPTS)).rejects.toThrow(
      "Conversation not found or not accessible",
    );
    expect(batch).not.toHaveBeenCalled();
  });

  it("throws a distinct message when the requester does not own it", async () => {
    // Deliberately distinguishable from the message above: the repository
    // reports "absent" and "not yours" separately so the route can choose to
    // collapse them (to avoid leaking existence) rather than being forced to.
    const { db, batch } = makeDb([[{ ...OWNED, ownerUserId: "someone-else" }]]);

    await expect(restartSectionConversation(db, SCOPE, CONV, OWNER, true, SECTION_CONVERSATION_PROMPTS)).rejects.toThrow(
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

    await expect(restartSectionConversation(db, SCOPE, CONV, OWNER, true, SECTION_CONVERSATION_PROMPTS)).rejects.toBeInstanceOf(
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

    const result = await restartSectionConversation(db, SCOPE, CONV, OWNER, true, SECTION_CONVERSATION_PROMPTS);

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

    const result = await restartSectionConversation(db, SCOPE, CONV, OWNER, true, SECTION_CONVERSATION_PROMPTS);

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

    await expect(restartSectionConversation(db, SCOPE, CONV, OWNER, true, SECTION_CONVERSATION_PROMPTS)).resolves.toMatchObject({
      voidedSubmission: null,
    });
  });

  it("carries isTeacherTest onto the replacement rather than re-deriving it", async () => {
    // A student promoted to TA mid-term who restarts must not have their work
    // silently reclassified as a teacher test -- and an instructor's test
    // conversation must stay a test after restarting.
    const { db, inserted } = makeDb([[{ ...OWNED, isTeacherTest: true }], [], []]);

    await restartSectionConversation(db, SCOPE, CONV, OWNER, true, SECTION_CONVERSATION_PROMPTS);

    const conversation = inserted.find((v) => !v.parts);
    expect(conversation).toMatchObject({ isTeacherTest: true, kind: "section" });
  });

  it("opens the replacement with the canonical greeting for its section", async () => {
    const { db, inserted, batch } = makeDb([[OWNED], [], []]);

    const result = await restartSectionConversation(db, SCOPE, CONV, OWNER, true, SECTION_CONVERSATION_PROMPTS);

    const greeting = inserted.find((v) => v.parts) as { parts: { text: string }[] };
    expect(greeting.parts[0]!.text).toBe(
      "Estimate the mean.\n\nWhere would you like to start? If you already have an idea, tell me what you're thinking and we'll work from there.",
    );
    expect(result.conversation.title).toBe("Section 2: Confidence intervals");
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("writes the CALLER's wording, not a built-in default (#305 seam)", async () => {
    // Nothing else proves the `prompts` parameter is load-bearing: every
    // other test in this file (and its siblings) passes
    // SECTION_CONVERSATION_PROMPTS, so a repository that ignored the
    // parameter and reached for that same module-level object again would
    // pass all of them. This one drives an ALTERNATE object through the real
    // function and asserts on the persisted row, so reintroducing a hardcoded
    // default fails here.
    const { db, inserted } = makeDb([[OWNED], [], []]);

    const result = await restartSectionConversation(db, SCOPE, CONV, OWNER, true, TENANT_TWO_PROMPTS);

    const greeting = inserted.find((v) => v.parts) as { parts: { text: string }[] };
    expect(greeting.parts[0]!.text).toBe("Bienvenue -- partie 2. Estimate the mean.");
    expect(result.conversation.title).toBe("Partie 2 : Confidence intervals");
    // And explicitly NOT the built-in copy, so the assertions above can't be
    // satisfied by a formatter that merely appended the tenant's text to it.
    expect(greeting.parts[0]!.text).not.toContain("Where would you like to start?");
    expect(result.conversation.title).not.toContain("Section 2");
  });
});

describe("startSectionConversation prompt injection point (#305 seam)", () => {
  /** db double whose insert batch SUCCEEDS, so the greeting and title the
   *  function formatted are observable on the values it inserted. Select
   *  queue matches the order startSectionConversation issues: membership,
   *  section, existing-conversation pre-check. */
  function startingDb() {
    const inserted: Record<string, unknown>[] = [];
    const queue: unknown[][] = [
      [{ id: "membership-1" }],
      [{ id: "section-1", order: 7, title: "Bootstrap", content: "Resample it.", type: "conversation" }],
      [],
    ];
    const joinable: Record<string, unknown> = {
      where: async () => queue.shift() ?? [],
      get innerJoin() {
        return () => joinable;
      },
    };
    const db = {
      select: () => ({ from: () => joinable }),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return "stmt";
        },
      }),
      batch: vi.fn().mockResolvedValue(undefined),
    } as unknown as Db;
    return { db, inserted };
  }

  it("opens the conversation with the CALLER's wording, not a built-in default", async () => {
    // Companion to the restart-side seam test above, on the other writer.
    // Both call sites take the formatters as a parameter precisely so a
    // second tenant can supply different copy; asserting on the persisted
    // greeting/title is the only thing that can fail if that parameter is
    // ever quietly ignored in favour of SECTION_CONVERSATION_PROMPTS again.
    const { startSectionConversation } = await import("./sectionConversations");
    const { unsafeCourseScope } = await import("./scope");
    const { db, inserted } = startingDb();

    const result = await startSectionConversation(db, unsafeCourseScope("course-1"), {
      sectionId: "section-1",
      ownerUserId: OWNER,
      isTeacherTest: false,
      canViewDrafts: true,
      prompts: TENANT_TWO_PROMPTS,
    });

    expect(result.title).toBe("Partie 7 : Bootstrap");
    const greeting = inserted.find((v) => v.parts) as { parts: { text: string }[] };
    expect(greeting.parts[0]!.text).toBe("Bienvenue -- partie 7. Resample it.");
    expect(greeting.parts[0]!.text).not.toContain("Where would you like to start?");
    expect(result.title).not.toContain("Section 7");
  });

  it("opens it with the built-in wording when that is what the caller passed", async () => {
    // The other half of the seam: same harness, default formatters, canonical
    // copy. Together these two pin that the output tracks the ARGUMENT.
    const { startSectionConversation } = await import("./sectionConversations");
    const { unsafeCourseScope } = await import("./scope");
    const { db, inserted } = startingDb();

    const result = await startSectionConversation(db, unsafeCourseScope("course-1"), {
      sectionId: "section-1",
      ownerUserId: OWNER,
      isTeacherTest: false,
      canViewDrafts: true,
      prompts: SECTION_CONVERSATION_PROMPTS,
    });

    expect(result.title).toBe("Section 7: Bootstrap");
    const greeting = inserted.find((v) => v.parts) as { parts: { text: string }[] };
    expect(greeting.parts[0]!.text).toBe(
      "Resample it.\n\nWhere would you like to start? If you already have an idea, tell me what you're thinking and we'll work from there.",
    );
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
        canViewDrafts: true,
        prompts: SECTION_CONVERSATION_PROMPTS,
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
      canViewDrafts: true,
      prompts: SECTION_CONVERSATION_PROMPTS,
    });
    await expect(promise).rejects.toThrow("duplicate key");
    await expect(promise).rejects.not.toBeInstanceOf(SectionConversationExistsError);
  });
});
