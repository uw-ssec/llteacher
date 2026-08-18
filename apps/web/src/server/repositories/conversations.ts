import { and, count, desc, eq, getTableColumns, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { conversations, messages, sections, homeworks, courses, courseMemberships, submissions } from "../../db/schema";
import type { ConversationKind } from "../../db/schema";
import type { CourseScope } from "./scope";
import { TenancyMismatchError, IdempotencyKeyConflictError } from "./errors";
import { getOrgScopeForCourse } from "./organizations";
import { resolvePromptTemplate } from "../../lib/prompts";

export const DEFAULT_CONVERSATIONS_PAGE_SIZE = 50;
// #317 review, #326: exported so getSectionConversationMessages
// (repositories/sectionConversations.ts) can share the exact same default
// page size instead of hand-picking its own -- one pagination convention
// for "a page of a conversation's messages", not two independently-tuned
// ones.
export const DEFAULT_MESSAGES_PAGE_SIZE = 200;

export async function listConversationsForOwner(
  db: Db,
  scope: CourseScope,
  ownerUserId: string,
  opts?: { includeDeleted?: boolean; kind?: ConversationKind; limit?: number; before?: { updatedAt: Date; id: string } },
) {
  const conditions = [
    eq(conversations.courseId, scope),
    eq(conversations.ownerUserId, ownerUserId),
  ];
  if (!opts?.includeDeleted) {
    conditions.push(eq(conversations.isDeleted, false));
  }
  // Optional: #5's GET /api/conversations?kind=tutor route always passes
  // this (defaulting to "tutor" itself, not here -- this function stays a
  // no-op filter when omitted so the #3-era repo tests that call it without
  // a kind still see both kinds). desc(updatedAt) matches #5's
  // "ordered by updatedAt desc" requirement -- also harmless for those
  // older tests, none of which assert on ordering.
  if (opts?.kind) {
    conditions.push(eq(conversations.kind, opts.kind));
  }
  // #281: a compound (updated_at, id) cursor, not updated_at alone.
  // updated_at is JS-Date (millisecond) precision and mutates on every chat
  // turn/rename ($onUpdate, runtime.ts) -- two rows touched in the same
  // millisecond are indistinguishable to a plain `lt`, so a row exactly at
  // the boundary could be silently excluded from BOTH the page that should
  // have included it and the next one. `id` (a UUID) breaks every tie
  // deterministically; its own ordering is arbitrary (a UUID has no
  // intrinsic meaning) but that's fine -- it only needs to be a stable
  // total order, not a meaningful one. This is the row-constructor
  // comparison `(updated_at, id) < ($before, $beforeId)` expanded into its
  // OR/AND form, since drizzle has no native tuple-comparison helper:
  // strictly older, OR exactly tied on updated_at and strictly "before" on
  // id.
  if (opts?.before) {
    const { updatedAt, id } = opts.before;
    conditions.push(
      or(
        lt(conversations.updatedAt, updatedAt),
        and(eq(conversations.updatedAt, updatedAt), lt(conversations.id, id)),
      )!,
    );
  }
  const limit = opts?.limit ?? DEFAULT_CONVERSATIONS_PAGE_SIZE;
  const rows = await db
    .select()
    .from(conversations)
    .where(and(...conditions))
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(limit);

  if (rows.length === 0) return [];

  // #4: the tutor-conversations list surface needs a per-conversation
  // message count (its "message-count or preview snippet" requirement).
  // #301: count was chosen over a last-message snippet -- a snippet would
  // mean fetching and truncating message *content* into a list response
  // that otherwise carries no message bodies at all (widening what this
  // endpoint exposes for a cosmetic win), and jsonb `parts` has no cheap
  // "just the preview text" projection the way a plain text column would --
  // extracting one means unpacking a part array's first text part per row.
  // A count is a single aggregate, needs no content-shape assumptions, and
  // is what #216's rail-refresh behavior (bumping this same count on each
  // new message) already treats as the row's live-activity signal. A
  // second grouped query rather than a LEFT JOIN + GROUP BY on the
  // primary select above -- same fan-out-avoidance pattern
  // listHomeworksForCourse (homeworks.ts) already uses for sectionCount,
  // merged back in application code via a Map instead of reasoning about
  // duplicate conversation rows a JOIN would produce.
  //
  // #224: bounded by construction now that `rows` is itself limited above --
  // the inArray parameter list can never grow past the page size.
  const counts = await db
    .select({ conversationId: messages.conversationId, count: sql<number>`count(*)::int` })
    .from(messages)
    .where(inArray(messages.conversationId, rows.map((r) => r.id)))
    .groupBy(messages.conversationId);
  const countByConversationId = new Map(counts.map((c) => [c.conversationId, c.count]));

  return rows.map((r) => ({ ...r, messageCount: countByConversationId.get(r.id) ?? 0 }));
}

export async function createConversation(
  db: Db,
  scope: CourseScope,
  input: { ownerUserId: string; sectionId: string | null; kind: ConversationKind; title: string },
) {
  // Neither ownerUserId nor sectionId is guaranteed to belong to `scope`'s
  // course just because the caller says so -- both are caller-supplied
  // UUIDs. Verify membership and section scope before writing, or a
  // mismatched id gets a conversation minted into the wrong course.
  // droppedAt IS NULL matches listMembershipsForUser (#139) -- a dropped
  // membership must not be able to originate new conversations either.
  // Both throws below are TenancyMismatchError (repositories/errors.ts,
  // #141), mapped to an honest 404 by app.onError (server/index.ts) at this
  // function's callers -- createConversationHandler (routes/conversations.ts,
  // #5) and chatHandler's new-conversation branch (routes/chat.ts, #3).
  //
  // #214: the section-tenancy check below is reachable now -- chatHandler's
  // section-chat path passes a real sectionId (see routes/chat.ts).
  const [membership] = await db
    .select({ id: courseMemberships.id })
    .from(courseMemberships)
    .where(
      and(
        eq(courseMemberships.userId, input.ownerUserId),
        eq(courseMemberships.courseId, scope),
        isNull(courseMemberships.droppedAt),
      ),
    );
  if (!membership) {
    throw new TenancyMismatchError("Owner is not a member of this course scope");
  }

  if (input.sectionId) {
    const [section] = await db
      .select({ id: sections.id })
      .from(sections)
      .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
      .where(and(eq(sections.id, input.sectionId), eq(homeworks.courseId, scope)));
    if (!section) {
      throw new TenancyMismatchError("Section not found in this course scope");
    }
  }

  // #25: pinned once here, at creation -- never re-resolved per-message (see
  // lib/prompts.ts's module doc comment for why). orgScope isn't something
  // this function's callers carry (only CourseScope), so it's derived here
  // rather than widening every caller's signature for one internal lookup.
  const orgScope = await getOrgScopeForCourse(db, scope);
  const promptTemplateId = orgScope
    ? (await resolvePromptTemplate(db, orgScope, scope, input.sectionId)).id
    : null;

  const [created] = await db
    .insert(conversations)
    .values({ courseId: scope, promptTemplateId, ...input })
    .returning();
  return created;
}

// #308: backs createConversationHandler's per-user conversation cap --
// POST /api/conversations had no bound at all on how many rows one student
// could mint (the free-standing tutor rail has no natural "one per X" limit
// the way section conversations do via conversations_owner_section_active_uq
// above). Counts only LIVE rows: a student who deletes old conversations to
// make room is exactly the intended relief valve, not a bypass. Scoped to
// (ownerUserId, scope, kind) so a student's section-conversation count
// (bounded structurally anyway, one per section) never eats into their
// tutor-conversation budget or vice versa.
export async function countActiveConversationsForOwner(
  db: Db,
  scope: CourseScope,
  ownerUserId: string,
  kind: ConversationKind,
) {
  const [row] = await db
    .select({ count: count() })
    .from(conversations)
    .where(
      and(
        eq(conversations.ownerUserId, ownerUserId),
        eq(conversations.courseId, scope),
        eq(conversations.kind, kind),
        eq(conversations.isDeleted, false),
      ),
    );
  return row?.count ?? 0;
}

// Enforces CourseScope only -- any member of the course could soft-delete
// any other student's conversation by UUID if called with just a
// CourseScope, since ownerUserId isn't checked here. #301: this function IS
// now route-reachable (DELETE /api/conversations/:id ->
// deleteConversationHandler), which is exactly the condition an earlier
// version of this comment said hadn't happened yet -- the ownership check
// that closes the gap lives at the route layer instead:
// deleteConversationHandler calls getOwnedConversationOrNull first and only
// reaches this function with a CourseScope minted from an
// already-ownership-verified row. See ARCHITECTURE.md's "Row Ownership
// (Within a Scope)" section and issue #134 (still open: a requesterId
// parameter here would let this function enforce its own invariant instead
// of relying on every caller to check first).
//
// #128: refuses a conversation that already has a submission. Soft-deleting
// one here would leave the submission row alive, pointing at a conversation
// the student can no longer see -- and the moment they start a replacement
// and submit it, a second submissions row for the same section. Callers that
// mean "start over" want restartSectionConversation (repositories/
// submissions.ts), which voids the submission in the same atomic group.
// Tutor conversations can never have a submission (the composite FK added in
// #128 makes that structural), so they are unaffected by this check.
export async function softDeleteConversation(db: Db, scope: CourseScope, conversationId: string) {
  const [blocking] = await db
    .select({ id: submissions.id })
    .from(submissions)
    .innerJoin(conversations, eq(submissions.conversationId, conversations.id))
    .where(and(eq(conversations.id, conversationId), eq(conversations.courseId, scope)));
  if (blocking) {
    throw new Error(
      "Conversation has a submission; use restartSectionConversation to void it (#128)",
    );
  }

  return db
    .update(conversations)
    .set({ isDeleted: true, deletedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), eq(conversations.courseId, scope)));
}

// #5's PATCH /api/conversations/:id (rename). Same CourseScope-only gap as
// softDeleteConversation above -- the route (routes/conversations.ts) does
// the ownerUserId check itself via getOwnedConversationOrNull before calling
// this, same pattern chatHandler (#3) established for conversationId
// ownership, rather than this function taking a requesterId. isDeleted is
// checked so a soft-deleted conversation can't be renamed back to life
// through PATCH; the route treats a null return (not found under scope, or
// soft-deleted) as the same 404 as an ownership mismatch.
export async function updateConversationTitle(db: Db, scope: CourseScope, conversationId: string, title: string) {
  const [updated] = await db
    .update(conversations)
    .set({ title })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.courseId, scope),
        eq(conversations.isDeleted, false),
      ),
    )
    .returning();
  return updated ?? null;
}

// Same CourseScope-only gap as softDeleteConversation above -- see
// ARCHITECTURE.md's "Row Ownership (Within a Scope)" section and #134; that
// gap (no requesterId/ownership check here) is still open. The membership
// check-then-insert(-then-touch) below is not wrapped together -- a
// conversation soft-deleted between the check and the insert is a narrow
// TOCTOU race, documented in ARCHITECTURE.md rather than closed here.
//
// #220: the insert and the `updatedAt` touch below are now atomic with each
// other. Branches on driver capability at runtime -- same reasoning and
// pattern as updateHomework (repositories/homeworks.ts): production's
// neon-http driver supports `db.batch()` but not `db.transaction()` (throws
// "No transactions support in neon-http driver"); the node-postgres driver
// real-DB tests use (`makeNodeDb`) is the mirror image -- `db.transaction()`
// works, `db.batch` doesn't exist at runtime despite the shared `Db` type
// claiming it does. Feature-detect via `typeof db.batch === "function"` (a
// missing method is a TypeError at the call site, not something to
// try/catch). Before this fix (on either path) a failure between the two
// statements could leave a persisted message whose parent conversation's
// updatedAt never moved, so the conversation would have messages but sort
// as though it did not.
type BatchStatement = Parameters<Db["batch"]>[0][number];

// #254: the (conversation_id, client_message_id) unique index (#213) is a
// check-then-insert race away from a Postgres 23505 -- two in-flight
// requests carrying the same clientMessageId (a double-fired Retry, a
// fetch-layer retry, a duplicated tab) can both pass chatHandler's
// idempotency read and both reach here. `.onConflictDoNothing` makes the
// insert itself race-safe (Postgres's unique index resolves the conflict
// atomically; no serialization needed) -- the loser gets an empty
// `.returning()` instead of a thrown constraint violation. A NULL
// clientMessageId (every assistant/system row) can never trigger this: a
// unique index treats every NULL as distinct from every other NULL, so
// `created` is only ever missing here when `input.clientMessageId` was a
// real, colliding string -- fetchExistingMessage's `clientMessageId ===
// null` early-return is defense against that invariant being violated by a
// future caller, not a path this function's own callers can reach today.
async function fetchExistingMessage(
  // Pick<Db, "select">, not Db: the transaction-path caller below passes
  // its `tx` handle, whose type (PgTransaction<...>) is not assignable to
  // the full `Db` (it's missing driver-capability members like `batch`
  // that a transaction handle genuinely doesn't have) -- this function only
  // ever calls `.select()`, so that's all it should require.
  db: Pick<Db, "select">,
  conversationId: string,
  clientMessageId: string | null,
) {
  if (clientMessageId === null) return undefined;
  const [existing] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.clientMessageId, clientMessageId)));
  return existing;
}

// #266: a `.returning()` miss from onConflictDoNothing only ever meant "this
// clientMessageId already has a row" -- it said nothing about whether that
// row holds the SAME content this call was trying to insert. Reusing an id
// for genuinely different text (a client bug, or an id derived from
// something other than a fresh per-send token) used to silently discard the
// new message while the caller still ran the model against it, leaving a
// persisted answer with no question. A same-id-same-content conflict (the
// real retry case -- #254) still resolves to the existing row unchanged;
// only a genuine mismatch is now a hard refusal instead of a quiet drop.
// A plain JSON.stringify comparison is NOT safe here: `parts` round-trips
// through a `jsonb` column, and jsonb does not preserve object key order
// (confirmed empirically -- inserting `{type, text}` and reading it back
// can come back key-reordered). Two structurally identical objects would
// then compare unequal purely from the round-trip, turning a legitimate
// same-content retry into a false-positive conflict. Recurse structurally
// instead, comparing object keys by set membership + per-key value, not by
// serialized string.
function partsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false; // primitives already covered by a === b above
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => partsEqual(item, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.hasOwn(bObj, key) && partsEqual(aObj[key], bObj[key]));
}

async function resolveConflict(
  db: Pick<Db, "select">,
  conversationId: string,
  clientMessageId: string | null,
  input: { parts: unknown },
) {
  const existing = await fetchExistingMessage(db, conversationId, clientMessageId);
  if (!existing) {
    // Per the invariant documented on appendMessage's onConflictDoNothing
    // call: a real, colliding clientMessageId string is the only way
    // `.returning()` comes back empty, so `existing` also missing here means
    // the unique index was violated by something this function's own
    // callers can't produce -- not a condition to paper over.
    throw new Error(
      `appendMessage: onConflictDoNothing fired but no existing row was found for clientMessageId ${clientMessageId}`,
    );
  }
  if (!partsEqual(existing.parts, input.parts)) {
    throw new IdempotencyKeyConflictError(
      "A message with this clientMessageId already exists with different content",
    );
  }
  return existing;
}

// #312: the id/courseId/isDeleted predicate below was written verbatim in
// three places (this function, getLastMessages, getMessagesForConversation)
// -- a tenancy guard duplicated three times has to change in lockstep or one
// copy silently becomes more permissive than the others. `Pick<Db, "select">`
// (not `Db`) so the transaction-path caller in appendMessage below can pass
// its `tx` handle, which lacks driver-capability members like `batch`.
export async function assertConversationInScope(
  db: Pick<Db, "select">,
  scope: CourseScope,
  conversationId: string,
): Promise<boolean> {
  const [owned] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.courseId, scope),
        eq(conversations.isDeleted, false),
      ),
    );
  return !!owned;
}

export async function appendMessage(
  db: Db,
  scope: CourseScope,
  conversationId: string,
  input: { role: "user" | "assistant" | "system"; parts: unknown; clientMessageId?: string | null },
  // #279: chatHandler calls this after it has already resolved/verified
  // `conv` for the current request (via getOwnedConversationOrNull,
  // startSectionConversation, or createConversation, all of which prove
  // scope membership) -- re-running the same select here is a fourth
  // redundant round-trip per turn. Every OTHER caller (none exist outside
  // chat.ts today, but the type stays safe by default) has not already
  // proven this, so the check stays on unless a caller explicitly opts out.
  opts?: { skipOwnershipCheck?: boolean },
) {
  if (!opts?.skipOwnershipCheck) {
    const owned = await assertConversationInScope(db, scope, conversationId);
    if (!owned) {
      throw new TenancyMismatchError("Conversation not found in this course scope");
    }
  }

  const clientMessageId = input.clientMessageId ?? null;
  const messageValues = {
    conversationId,
    role: input.role,
    parts: input.parts,
    clientMessageId,
  };
  const conflictTarget = { target: [messages.conversationId, messages.clientMessageId] };

  // #312: this duplicates the same db.batch()/db.transaction() capability
  // branch as atomic.ts's runAtomically and repositories/homeworks.ts's
  // updateHomework, rather than reusing runAtomically -- deliberately, same
  // reasoning runAtomically's own doc comment already gives for
  // updateHomework: runAtomically returns Promise<void>, but this call site
  // needs the INSERT's own `.returning()` row (and the created/existing
  // distinction below, #273) back from whichever branch ran. Consolidating
  // would mean widening runAtomically's signature to carry a result back out
  // through both the batch and per-statement-await transaction paths -- a
  // real change to a helper already shared by sectionConversations.ts, not
  // a drop-in swap here.
  if (typeof db.batch === "function") {
    // Production path: neon-http, one atomic HTTP round-trip.
    const [[created]] = await db.batch([
      db.insert(messages).values(messageValues).onConflictDoNothing(conflictTarget).returning(),
      // #140/#220: keep the parent conversation's "last activity" timestamp
      // (and therefore its position in listConversationsForOwner's
      // updatedAt-desc ordering) current with actual chat activity, not
      // just renames -- atomic with the insert above.
      db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId)),
    ] as [BatchStatement, BatchStatement]);
    // #254: a duplicate send must end in the same successful response as a
    // retry, not a 503 -- ON CONFLICT DO NOTHING means `created` is
    // undefined exactly when this clientMessageId already has a row; look
    // it up and hand back the existing row instead of treating an empty
    // `.returning()` as a failure.
    //
    // #273: the caller needs to know WHICH of those two happened, not just
    // get a row back either way -- two concurrent requests carrying the
    // same clientMessageId both used to sail past this call (one truly
    // created the row, one silently resolved to it) and both went on to
    // call the model, producing two paid calls and two assistant rows for
    // one student turn. `created` lets chatHandler tell "I won this race"
    // from "someone else already has this" and stop before the model call.
    if (created) return { row: created, created: true };
    return { row: await resolveConflict(db, conversationId, clientMessageId, messageValues), created: false };
  }

  // Test/dev path: node-postgres (makeNodeDb) has no runtime db.batch().
  // A real db.transaction() gives the same all-or-nothing guarantee
  // through a different Drizzle primitive.
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(messages)
      .values(messageValues)
      .onConflictDoNothing(conflictTarget)
      .returning();
    await tx.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));
    if (created) return { row: created, created: true };
    return { row: await resolveConflict(tx, conversationId, clientMessageId, messageValues), created: false };
  });
}

// Unscoped by design (chatHandler needs to look a conversation up by id
// before it knows -- or can prove -- which CourseScope it belongs to). The
// caller MUST check the returned row's ownerUserId against the requesting
// user before trusting it or minting a CourseScope from its courseId (see
// scope.ts's unsafeCourseScope docstring: "a row just read back from the DB
// under an already-verified scope" is the sanctioned case for that cast --
// the ownerUserId check below is what verifies it here).
//
// #317 review, #326 (remaining requirement): joins courses for
// organizationId -- chat.ts's resolveConversation used to always call
// getOrgScopeForCourse separately even on this path, a fully redundant
// round-trip: this row's own courseId already determines the org, and
// courses.organizationId is NOT NULL, so an inner join can't drop a
// conversation that a plain select would have found. Every other caller
// (routes/conversations.ts's PATCH/DELETE/GET-messages) just ignores the
// extra field.
export async function getConversationById(db: Db, conversationId: string) {
  const [row] = await db
    .select({ ...getTableColumns(conversations), organizationId: courses.organizationId })
    .from(conversations)
    .innerJoin(courses, eq(conversations.courseId, courses.id))
    .where(eq(conversations.id, conversationId));
  return row ?? null;
}

// #217/#222/#263: shared "not found, not owned, soft-deleted, or the caller
// dropped the course" check -- originally routes/conversations.ts-local
// (PATCH/DELETE/GET-messages); moved here so routes/chat.ts's conversationId
// ownership check can reuse the exact same rule instead of hand-rolling its
// own (#217) and inherit the isDeleted check for free (#222) rather than
// depending on a downstream TenancyMismatchError to accidentally produce the
// same 404. Returns null for "doesn't exist", "exists but isn't yours",
// "exists, is yours, but is soft-deleted", AND "exists, is yours, but you no
// longer have a live membership in its course" -- callers must turn a null
// into a 404 (never 401/403), so a guessed/leaked conversation id can't be
// used to confirm one exists that isn't the caller's.
//
// #263: createConversation already refuses to *originate* a conversation
// without a live membership; this closes the matching gap on every path
// that resolves an *existing* one, which is where every read/write/chat
// call on an already-created conversation goes through this function
// (chat.ts's conversationId branch; PATCH/DELETE/GET-messages below) and
// then mints its CourseScope straight from the row via unsafeCourseScope --
// with no membership check here, that scope mint was tautological: a
// dropped student's still-valid session cookie kept full read/write/chat
// access to conversations in a course they no longer belong to. isMemberOf
// comes from AuthContext (already filters droppedAt, #139) so a repository
// function stays free of route-layer auth types while still enforcing the
// rule at its one real chokepoint instead of at each of the four call sites.
export async function getOwnedConversationOrNull(
  db: Db,
  conversationId: string,
  userId: string,
  isMemberOfCourse: (courseId: string) => boolean,
) {
  const existing = await getConversationById(db, conversationId);
  if (
    !existing ||
    existing.ownerUserId !== userId ||
    existing.isDeleted ||
    !isMemberOfCourse(existing.courseId)
  ) {
    return null;
  }
  return existing;
}

/** #317 review, #322: claims the per-conversation turn lock via a single
 *  conditional UPDATE -- the only thing that makes this race-safe under
 *  concurrent requests is that the WHERE clause and the write happen
 *  atomically in one statement; a read-then-write pair here would have the
 *  exact same race window classifyTurn's retry logic was already losing to.
 *
 *  `RETURNING id` is how the caller tells "I got the lock" from "someone
 *  else holds it" apart: a real conflict updates 0 rows, and this returns
 *  false without touching anything. `staleMs` treats an old lock as
 *  abandoned (a Worker killed mid-request -- an uncaught exception, a
 *  platform-level timeout -- never reaches the release call below) rather
 *  than a permanent deadlock; chat.ts's own STREAM_TIMEOUT_MS bounds how
 *  long a legitimate turn can hold it, so staleMs is set comfortably above
 *  that, not equal to it. */
export async function acquireConversationTurnLock(
  db: Db,
  conversationId: string,
  staleMs: number,
): Promise<boolean> {
  const staleBefore = new Date(Date.now() - staleMs);
  const rows = await db
    .update(conversations)
    .set({ processingStartedAt: new Date() })
    .where(
      and(
        eq(conversations.id, conversationId),
        or(isNull(conversations.processingStartedAt), lt(conversations.processingStartedAt, staleBefore)),
      ),
    )
    .returning({ id: conversations.id });
  return rows.length > 0;
}

/** Releases the lock acquired above. Best-effort by design: called from
 *  chat.ts's onFinish/onAbort/catch paths, all of which run after the
 *  response has already started streaming to the client -- a failure here
 *  must never surface as a second error layered on top of whatever the
 *  turn itself already reported. A conversation stuck locked past staleMs
 *  self-heals on the next send via the staleness check above, so silently
 *  losing a release is degraded, not broken. */
export async function releaseConversationTurnLock(db: Db, conversationId: string): Promise<void> {
  await db
    .update(conversations)
    .set({ processingStartedAt: null })
    .where(eq(conversations.id, conversationId));
}

/** #317 review, #326: chat.ts calls this the first time resolvePromptTemplate
 *  (lib/prompts.ts) finds a REAL template for a conversation that reached
 *  its "no pin" fallback branch -- either the conversation predates the
 *  promptTemplateId column, or nothing resolved at creation and a template
 *  has since been added at some scope. Without this write-back, that same
 *  4-scope walk re-runs on every future turn forever (the exact waste
 *  #326's issue text names), even after this call has already told us the
 *  answer once. Only ever moves promptTemplateId from null to a real id --
 *  never overwrites an existing pin, matching the pinning invariant
 *  (lib/prompts.ts's module doc comment: resolved ONCE, at creation,
 *  never re-resolved to a DIFFERENT value later) via the `IS NULL` guard
 *  in the WHERE clause, not just the caller's own `conv.promptTemplateId
 *  === null` check -- a second concurrent turn on the same never-pinned
 *  conversation could otherwise race this into overwriting a pin the first
 *  turn already wrote (to the SAME id resolution would produce, but not
 *  guaranteed if the template scope changed between the two reads). */
export async function pinConversationPromptTemplate(
  db: Db,
  conversationId: string,
  promptTemplateId: string,
): Promise<void> {
  await db
    .update(conversations)
    .set({ promptTemplateId })
    .where(and(eq(conversations.id, conversationId), isNull(conversations.promptTemplateId)));
}

// Used by chatHandler's retry/idempotency check (#3, reworked #213): the
// most recently persisted messages in a conversation, newest first (index 0
// = last message). limit=2 is what chatHandler needs to distinguish its two
// retry cases -- "the user message already landed but the assistant hasn't
// answered yet" (last row is that same user message) from "the assistant
// already answered but the client never received it" (last row is the
// assistant reply, and the row before it is that same user message) --
// without a second round-trip. Scoped the same way appendMessage is
// (courseId match + not-deleted) so a caller can't probe a message via a
// conversationId scoped to the wrong course.
//
// #221: ordered by `seq` (a monotonic bigserial), not `createdAt` alone --
// createdAt is timestamptz (microsecond resolution) and safe today only
// because each append is its own transaction, so two rows can never share a
// timestamp; `seq` makes that guarantee independent of that fact.
// #317 review, #326: narrowed from `db.select()` (all 7 columns, including
// the never-read-by-a-caller `conversationId`/`seq`/`createdAt`) to the 4
// columns chat.ts's two consumers -- classifyTurn's idempotency check and
// the model-context mapping -- actually read. `seq` still drives the
// ORDER BY below without needing to be part of the projection.
const LAST_MESSAGE_COLUMNS = {
  id: messages.id,
  role: messages.role,
  parts: messages.parts,
  clientMessageId: messages.clientMessageId,
} as const;

export async function getLastMessages(
  db: Db,
  scope: CourseScope,
  conversationId: string,
  limit = 2,
  // #279: same opt-out as appendMessage's own opts -- chatHandler's two call
  // sites both run after `conv` is already resolved/verified for this
  // request.
  opts?: { skipOwnershipCheck?: boolean },
) {
  if (!opts?.skipOwnershipCheck) {
    const owned = await assertConversationInScope(db, scope, conversationId);
    if (!owned) return [];
  }
  return db
    .select(LAST_MESSAGE_COLUMNS)
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.seq))
    .limit(limit);
}

// #4 fix-round: backs GET /api/conversations/:id/messages, added after code
// review caught that selecting an *existing* tutor conversation reset the
// client's useChat message list to empty with no way to reseed it -- not
// just a visual gap, chat.ts's chatHandler builds the model's context
// straight from convertToModelMessages(uiMessages) (the array the CLIENT
// sends), so an empty client-side history meant the LLM silently lost every
// prior turn on resume. Same scoping shape as getLastMessages above
// (courseId match + not-deleted), ascending by `seq` (#221; oldest first --
// the opposite of getLastMessages' retry-detection order, same underlying
// tiebreaker).
//
// #215: bounded by default (DEFAULT_MESSAGES_PAGE_SIZE) instead of
// returning the entire conversation -- `before` (a seq cursor) lets a
// caller page further back; omitted, this returns the most recent page in
// chronological order, which is what App.tsx's hydration fetch needs today.
export async function getMessagesForConversation(
  db: Db,
  scope: CourseScope,
  conversationId: string,
  opts?: { limit?: number; before?: number },
) {
  const owned = await assertConversationInScope(db, scope, conversationId);
  if (!owned) return [];

  const limit = opts?.limit ?? DEFAULT_MESSAGES_PAGE_SIZE;
  const conditions = [eq(messages.conversationId, conversationId)];
  if (opts?.before !== undefined) {
    conditions.push(lt(messages.seq, opts.before));
  }
  // Fetch the most recent `limit` rows (desc), then reverse in application
  // code -- the same "take the tail, then re-sort ascending" trick as a SQL
  // window would need anyway, without a subquery, since this table has no
  // natural "give me the last N in ascending order" clause.
  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.seq))
    .limit(limit);
  return rows.reverse();
}
