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
