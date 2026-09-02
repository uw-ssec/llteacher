/* --------------------------------------------------------------------------
   Auto-titling for tutor conversations (#231, #287).

   #287: #231's auto-titling originally lived only in server/routes/chat.ts,
   on a code path (chatHandler's no-conversationId + kind:"tutor" branch)
   that turns out to have no live client caller -- every tutor conversation
   a student can actually create goes through the rail's "New conversation"
   button (POST /api/conversations, no title) followed by a chat turn that
   ALWAYS carries the conversationId that POST returned (App.tsx's
   handleSendTutorMessage guards on tutorConversationId being set before it
   will send at all). So the auto-titling branch in chat.ts never ran for a
   real user, and every tutor row stayed "New Conversation" forever -- the
   exact state #231 was filed to eliminate.

   The real fix (#287) is client-side: App.tsx's handleSendTutorMessage
   derives a title from the student's own first message and PATCHes it via
   the existing renameConversation client function, the moment that message
   is sent (see that function's own doc comment for why it doesn't wait on
   the turn's completion). This module exists so that client-side call and
   chat.ts's now-effectively-dead server branch (kept, see its own doc
   comment, rather than deleted) derive an IDENTICAL title from identical
   input instead of maintaining two copies that can silently drift apart --
   `deriveTutorConversationTitle` is plain, dependency-free TS, safe to
   import from both a Cloudflare Worker route and a browser bundle.

   DEFAULT_TUTOR_CONVERSATION_TITLE is the "hasn't been auto-titled or
   manually renamed yet" sentinel every caller that needs to answer "is it
   still safe to auto-title this row" compares against -- both
   routes/conversations.ts's createConversationHandler (what a brand-new,
   title-less row is actually created with) and App.tsx's auto-title check
   read this one constant, so "still the untouched default" has exactly one
   definition in the codebase, not two strings that must be kept in sync by
   hand. */
export const AUTO_TITLE_MAX_LENGTH = 60;
export const DEFAULT_TUTOR_CONVERSATION_TITLE = "New Conversation";

/** Derives an initial title for a brand-new tutor conversation from its
 *  first user message. Truncates the first text part; returns null (falls
 *  back to DEFAULT_TUTOR_CONVERSATION_TITLE) for a message with no text
 *  part (a tool-only first message isn't a shape this app's own composer
 *  can currently produce, but the fallback keeps this honest either way).
 *
 *  #287: truncation is over Unicode CODE POINTS (`Array.from`), not UTF-16
 *  code units (the original implementation's `String.prototype.slice`). A
 *  first message ending in a character outside the Basic Multilingual
 *  Plane -- most emoji, U+10000 and above -- is represented in a JS string
 *  as a surrogate PAIR: two UTF-16 code units. `slice(0, N)` cuts on
 *  code-unit boundaries and can land exactly between the high and low
 *  surrogate of such a pair, leaving a single, LONE surrogate in the
 *  result. A lone surrogate has no valid UTF-8 encoding at all (lone
 *  surrogates are explicitly excluded from the Unicode scalar value range
 *  UTF-8 can represent) -- it can still round-trip JS-to-JS (JSON.stringify
 *  escapes it as \uXXXX) but corrupts the moment anything re-encodes it as
 *  UTF-8, which is exactly what happens on the way into a Postgres text
 *  column. `Array.from(str)` iterates a string by code point (via its own
 *  `[Symbol.iterator]`, which is surrogate-pair-aware), so slicing the
 *  resulting array can only ever cut BETWEEN whole characters. */
export function deriveTutorConversationTitle(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  const textPart = parts.find(
    (p): p is { type: "text"; text: string } =>
      !!p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string",
  );
  const text = textPart?.text.trim();
  if (!text) return null;
  const codePoints = Array.from(text);
  if (codePoints.length <= AUTO_TITLE_MAX_LENGTH) return text;
  return `${codePoints.slice(0, AUTO_TITLE_MAX_LENGTH).join("").trimEnd()}…`;
}
