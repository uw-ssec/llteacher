// Typed error for a repository-layer tenancy/ownership mismatch -- e.g. an
// owner/section id that doesn't actually belong to the CourseScope it's
// being written under, or a conversation id that doesn't resolve within the
// caller's scope. Distinguishable (via `instanceof`) from an unexpected
// infra failure (DB connection drop, etc.), which stays a plain Error/
// unknown thrown value and falls through to app.onError's generic 503.
//
// #141: introduced so createConversation/appendMessage
// (repositories/conversations.ts) can signal this specific case to the
// route layer, which maps it to an honest 404 (see server/index.ts's
// app.onError) -- never a 403, so a guessed/leaked id can't be used to
// confirm a row exists that isn't the caller's, matching the 404-not-403
// convention `getOwnedConversationOrNull` (repositories/conversations.ts)
// already established for the route-level ownership check. See
// ARCHITECTURE.md's "Tenancy Mismatch Errors" section.
//
// Scope: only createConversation/appendMessage throw this today.
// `recordGrade` (repositories/submissions.ts, #75/M5) is expected to reuse
// this class, not invent its own, whenever it's wired to a route.
// `createSubmission` (repositories/submissions.ts) deliberately does NOT --
// #22's submitSectionHandler already has its own reasoned (403, not 404)
// convention for that specific call site, which this class doesn't
// override.
export class TenancyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenancyMismatchError";
  }
}

// #266: appendMessage throws this when a caller reuses a clientMessageId
// for DIFFERENT content than the row already stored under that id.
// clientMessageId is fully client-controlled and never bound to what it
// claims to identify -- reusing it used to silently drop the new message
// (onConflictDoNothing + "just return whatever's already there") while
// chatHandler still called the model with the new text, leaving a
// persisted answer with no question in the transcript. A genuine retry
// (same id, same content -- #254) is unaffected and still resolves to the
// existing row; only a real mismatch is a refusal. Mapped to 409 in
// server/index.ts's app.onError, same single-chokepoint pattern as
// TenancyMismatchError above.
export class IdempotencyKeyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyKeyConflictError";
  }
}

// #317 review follow-up: two concurrent writers racing the same partial
// unique index used to only be handled at one call site
// (sectionConversations.ts's startSectionConversation ->
// conversations_owner_section_active_uq). promptTemplates.ts's
// upsertCourseScopedPromptTemplate has the identical shape (read current,
// write under a partial unique index, no row lock in between) and needs
// the same translation -- extracted here so a third caller doesn't have to
// reinvent it a third time.

/** Postgres unique-violation SQLSTATE. */
export const PG_UNIQUE_VIOLATION = "23505";

/** True when `err` is a Postgres unique-violation naming `constraint`.
 *
 *  Both drivers surface the SQLSTATE on a `code` property; neon-http also
 *  carries `constraint`, and node-postgres does too. Checked structurally
 *  rather than by message, which is locale- and version-dependent. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === PG_UNIQUE_VIOLATION && e.constraint === constraint;
}

// #317 review, code-review follow-up: upsertCourseScopedPromptTemplate
// (repositories/promptTemplates.ts) reads the course's current active
// template, then writes "deactivate old, insert new" as one atomic group --
// with no row lock between the read and the write, unlike
// acquireConversationTurnLock's single conditional UPDATE. Two concurrent
// PUTs to the same course's prompt template (a double-click, two tabs) can
// both read the same `current` and both attempt to insert a new active row;
// prompt_templates_scope_course_active_uq (#324) lets only one succeed, and
// the loser used to surface as an unhandled exception -> the generic 503
// every unrecognized error falls through to (server/index.ts's app.onError)
// instead of a clean, retryable response. Mapped to 409 there, same
// single-chokepoint pattern as TenancyMismatchError/IdempotencyKeyConflictError.
export class PromptTemplateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptTemplateConflictError";
  }
}
