import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { MessageMarkdown, renderToolPart, isToolPart } from "@llteacher/ui";
import type { MessageData, RCodeResult } from "@llteacher/ui";

/* ==========================================================================
   #302: shared machinery for App.tsx's two chat surfaces (the homework
   section chat and the tutor rail chat). Extracted from App.tsx, which had
   grown to host two complete, independently-implemented chat lifecycles
   side by side.

   What this file owns: the useChat instance itself, the response-accepted
   tracking that classifies a failure as "send" vs "response" half (#96),
   the stopped-message-id UI state and its reset-on-switch semantics, the
   send-half failure record and its retained-but-key-gated semantics across a
   switch (#418/#419/#420), the response-half failure's OWN switch-vs-failure
   race (#441 -- the same hazard as #420, on the other half of a turn), the
   retryable error-row derivation (#144/#276/#286), and the translation of
   UIMessage[] into the design system's MessageData[] (#28/#317/#397).

   What deliberately stays OUTSIDE this file, in App.tsx, because it is
   genuinely per-surface rather than incidentally duplicated:
     - the `fetch` wrapper passed in as `fetchImpl` -- the section instance
       scrapes `x-conversation-id` and writes it into section state; the
       tutor instance tees the response body to track a turn's own
       completion independently of the mounted useChat instance (#292).
       Both already throw ChatResponseError on a non-2xx response BEFORE
       doing that surface-specific work (see ChatResponseError below), which
       is what lets this hook layer generic "did the server accept this
       send" tracking on top without caring which surface it is.
     - `buildSendBody`/`buildRetryBody` -- the two surfaces' request bodies
       are shaped differently (a section identifies itself by
       conversationId-or-courseId+kind+sectionId; a tutor conversation
       always has an id by the time anything can be sent into it), and
       their RETRY bodies are already divergently shaped in the current
       code (the section retry falls back to courseId/kind/sectionId; the
       tutor retry falls back to `{}`) -- preserved here as a documented
       asymmetry (task #302 constraint), not fixed, since reconciling it
       was not this task's ask.
     - hint-flagging and tutor auto-titling, both of which are extra
       pre-send work specific to one surface, layered on top of this hook's
       generic send guard by App.tsx's own thin wrapper handlers. ========================================================================== */

/* #286: a non-2xx /api/chat response's body is the exact JSON envelope
   chat.ts always sends (`{error, code}`) -- @ai-sdk/react's own transport
   (HttpChatTransport#sendMessages, node_modules/ai/dist/index.mjs) calls
   OUR fetch wrapper (chatFetch/tutorChatFetch in App.tsx) as `fetch2`, then
   itself does `if (!response.ok) throw new Error(await response.text())`
   on whatever that resolves to. Throwing INSIDE our wrapper instead means
   that `await fetch2(...)` never resolves at all -- the SDK's own check
   is never reached, and OUR exception is what the SDK's surrounding
   try/catch stores as `chat.error` (both paths land in the same catch,
   confirmed against the SDK's own AbstractChat#sendMessage sequencing --
   it doesn't distinguish "the transport threw" from "the transport
   returned and then something after it threw").
   `.message` is left as the exact same raw JSON text the SDK would have
   used, so packages/ui's readErrorMessage (which already parses that
   shape for `code`/`error` and never renders it verbatim) keeps working
   completely unchanged -- this only ADDS `.status` and
   `.retryAfterSeconds`, neither of which anything downstream could
   otherwise recover once a generic `Error` had already discarded the
   Response object. */
export class ChatResponseError extends Error {
  status: number;
  /** #286 (requirement 5): the 429 response's own `Retry-After` header
   *  (seconds), read here since this is the only place in the client that
   *  ever sees the real Response headers on a failure. `undefined` for
   *  every other status. */
  retryAfterSeconds?: number;
  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "ChatResponseError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** #286: shared by both surfaces' own fetch wrappers (built in App.tsx) --
 *  a non-ok /api/chat response is classified identically either way. */
export async function toChatResponseError(res: Response): Promise<ChatResponseError> {
  const rawText = await res.text();
  const retryAfterHeader = res.headers.get("Retry-After");
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
  return new ChatResponseError(
    rawText || "Failed to fetch the chat response.",
    res.status,
    retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
  );
}

/** #277: the AI SDK's own re-render throttle (milliseconds) -- one
 *  animation frame at 60Hz, fast enough that a streamed reply still reads
 *  as continuously typed, slow enough that the render rate is bounded by
 *  the display rather than by the model's token rate. Shared by both
 *  useChat instances since both hit the same cap. */
const STREAM_THROTTLE_MS = 16;

/* #317 review, blocking finding #3: DefaultChatTransport's default request
   body sends useChat's ENTIRE local message array on every turn -- for a
   long-running section (hydration restores up to 200 messages), that array
   alone measures ~189KB at 100 realistic messages and eventually exceeds
   MAX_REQUEST_BODY_BYTES (chat.ts), 400ing every further send with no
   recovery (reloading just re-hydrates the same history). chat.ts has never
   actually needed more than the last message -- #143's server-authoritative
   history redesign already reads persisted history from the DB, not from
   this array -- so trimming here costs nothing server-side. `body` already
   carries the envelope fields (conversationId, or courseId/kind/sectionId)
   merged in by the transport before this runs; only `messages` needs
   overriding. Shared by both useChat instances since both hit the same
   cap. */
function prepareSendMessagesRequest({
  messages,
  body,
}: {
  messages: UIMessage[];
  body: Record<string, unknown> | undefined;
}) {
  return { body: { ...body, messages: messages.slice(-1) } };
}

/** #277: cap on how often a streamed response re-renders the chat surface. */
function buildMessageData(
  aiMessages: UIMessage[],
  chatStatus: ReturnType<typeof useChat>["status"],
  stoppedMessageId: string | null | undefined,
  onRunRCode?: (code: string) => Promise<RCodeResult>,
): MessageData[] {
  /* #397: the persisted row's timestamp, riding on UIMessage.metadata (set in
     fetchConversationHistory, App.tsx). A turn the student has only just
     sent, or one still streaming, has no persisted row yet and therefore no
     time -- the transcript renders none rather than stamping Date.now(),
     which would show a time the server never recorded and would drift from
     the row once it lands. */
  const turnCreatedAt = (m: UIMessage): string | undefined => {
    const meta = m.metadata as { createdAt?: unknown } | undefined;
    return typeof meta?.createdAt === "string" ? meta.createdAt : undefined;
  };

  const messages: MessageData[] = aiMessages.map((m, idx) => {
    const isLast = idx === aiMessages.length - 1;
    const isStreaming = isLast && chatStatus === "streaming";
    const isStopped = m.id === stoppedMessageId;

    if (m.role === "assistant") {
      const content = (
        <>
          {m.parts.map((part, i) => {
            if (part.type === "text") {
              return (
                <MessageMarkdown key={`text-${m.id}-${i}`} onRun={onRunRCode}>
                  {part.text}
                </MessageMarkdown>
              );
            }
            /* #144: no `part as ToolPart` cast -- useChat isn't given the
               server's tool-input generics, so the AI SDK's UIMessagePart
               union can't statically prove a `tool-*` part carries
               `input`/`state`. */
            if (!isToolPart(part)) return null;
            return renderToolPart(part, `tool-${m.id}-${i}`, { onRunRCode });
          })}
          {isStopped && (
            <p className="message__stopped-note">
              You stopped this response. It wasn&rsquo;t saved, so the tutor won&rsquo;t remember it.
            </p>
          )}
        </>
      );
      return {
        id: m.id,
        role: "ai" as const,
        content,
        createdAt: turnCreatedAt(m),
        isStreaming: isStreaming && !isStopped,
      };
    }

    if (m.role === "user") {
      const text = m.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      return {
        id: m.id,
        role: "student" as const,
        content: text,
        createdAt: turnCreatedAt(m),
      };
    }

    /* system role messages — not user-facing in this UI; render empty */
    return {
      id: m.id,
      role: "system" as const,
      content: "",
    };
  });

  /* While the request is in flight but no tokens have streamed yet, the AI
     SDK has no assistant message in `aiMessages` -- so the streaming dots
     have nothing to attach to. Append a synthetic placeholder so the user
     sees the AI is thinking; it drops out the moment the first real part
     arrives and chatStatus transitions to "streaming". */
  if (chatStatus === "submitted") {
    messages.push({
      id: "__pending__",
      role: "ai" as const,
      content: null,
      isStreaming: true,
    });
  }

  return messages;
}

export interface ConversationSurfaceErrorRow {
  message: string;
  /** Absent for a hydration failure (history fetch) -- ConversationView
   *  treats a missing stage the same as "response" (see its own default
   *  parameter), matching the pre-#302 hydration-error objects, which
   *  never set this field either. */
  stage?: "send" | "response";
  retryAfterSeconds?: number;
  retryAttemptId?: number;
  onRetry?: () => void;
}

export interface UseConversationSurfaceOptions {
  /** #302 (the reconciliation this task's issue explicitly calls for): the
   *  useChat `id`. Both surfaces are now keyed, so both get a reset path --
   *  a genuinely different conversation showing under this key recreates
   *  the Chat instance (clearing stream status/error along with the
   *  messages), the same relief switching tutor conversations already gave
   *  the tutor surface before this task.
   *
   *  Deliberately NOT the raw section/tutor conversationId for the section
   *  surface -- see App.tsx's own doc comment on the section useChat call
   *  site (now paraphrased here) for why binding `id` directly to a
   *  conversationId that can be minted asynchronously, mid-turn, by the
   *  server is exactly the naive unification this task was warned against:
   *  it would recreate (and blow away) the Chat instance the moment a
   *  section's first turn's response header arrives. The caller is
   *  responsible for deriving a `surfaceKey` that only changes when it
   *  actually wants a reset (a different section, or a fresh id from an
   *  explicit restart) -- never as a side effect of a fetch wrapper
   *  observing a new id mid-stream. */
  surfaceKey: string | undefined;
  /** #96/#317 (review fix); #418/#419/#420 (retained-but-gated, not reset):
   *  the key a pending send-half failure's restored draft is recorded
   *  against, and the key an error row is cleared on. For the tutor surface
   *  this is the same as `surfaceKey` (its ConversationView remount and its
   *  useChat `id` both update together, in the same
   *  `selectTutorConversation` call). For the section surface it
   *  deliberately is NOT `surfaceKey`: the section's ConversationView
   *  remounts on `currentSection` alone, synchronously, the instant a switch
   *  is requested -- but `surfaceKey` only updates once that section's
   *  history fetch resolves (see App.tsx's loadSectionConversation). A
   *  restored-draft leak from the OLD section would otherwise have a real
   *  window to land in the freshly-remounted (but not yet re-keyed) child
   *  before this hook's own state catches up -- gating the exposed
   *  `sendFailure` on the section number directly, at the same instant the
   *  remount happens, closes that window (see `sendFailure`'s own doc
   *  comment for why this is a gate on exposure, not a clear of the
   *  underlying record: #419 requires the record to survive a switch so
   *  returning to it still hands the words back).
   *
   *  #420: also the key the error row is cleared on (see this hook's own
   *  `useEffect(() => clearError(), [resetKey, clearError])`) -- an error
   *  row from a surface the student has switched away from must not survive
   *  until `surfaceKey` eventually catches up. */
  resetKey: string | number | undefined;
  /** #317 review, #352 (review fix): the key that resets the "you stopped
   *  this response" note left on a stopped turn. Deliberately `surfaceKey`
   *  for BOTH surfaces -- reproducing the pre-#302 asymmetry exactly: the
   *  tutor surface always reset this on `tutorConversationId` change (an
   *  effect); the section surface NEVER reset it on any key at all (only
   *  ever cleared by its own `stop`/`send`), which was harmless only
   *  because message ids are globally unique so a stale id could never
   *  coincidentally match a message in a different conversation. Using
   *  `surfaceKey` here for the section surface reproduces that same
   *  "effectively never matters" behavior, but NOT because `surfaceKey`
   *  fails to change on an ordinary section switch -- it does (see
   *  App.tsx's `sectionChatKey`, `${sectionNumber}:${conversationId}`,
   *  which updates once that section's OWN history fetch resolves). It is
   *  simply LATE relative to the switch: `resetKey` (`currentSection`)
   *  changes synchronously the instant the switch is requested, while this
   *  reset doesn't fire until the new section's key lands afterward. That
   *  lag is exactly why the timing is harmless: a stopped turn is never
   *  persisted server-side, so the stale `stoppedMessageId` this key would
   *  clear can never coincidentally match a message id that shows up in
   *  the newly-loaded section's history, whether or not this reset has
   *  fired yet -- the same "can't coincidentally match" guarantee the
   *  pre-#302 code relied on, just via non-persistence here instead of
   *  global id uniqueness. Do not fold this into `resetKey`: that would
   *  give the section surface a switch-triggered reset it never had, an
   *  undisclosed behavior change flagged in review. */
  stoppedMessageResetKey: string | number | undefined;
  /** Seed for the Chat instance whenever `surfaceKey` changes -- mirrors
   *  the tutor surface's pre-existing `tutorInitialMessages` pattern.
   *  Content changes that do NOT accompany a `surfaceKey` change (loading
   *  older messages, an eagerly-created greeting, re-hydrating after a
   *  turn creates a conversation) go through `setMessages` instead. */
  initialMessages: UIMessage[];
  /** The surface's own fetch wrapper (chatFetch/tutorChatFetch in
   *  App.tsx) -- already throws ChatResponseError on a non-2xx response,
   *  and already does whatever surface-specific work a successful response
   *  implies (reading x-conversation-id; teeing the body for turn
   *  tracking). This hook layers the shared "was this send accepted by the
   *  server" bookkeeping on top, generically, since it only needs to know
   *  whether `fetchImpl` resolved or threw. */
  fetchImpl: typeof fetch;
  /** This surface's per-send request body (conversationId, or
   *  courseId/kind/sectionId for a section's first turn; conversationId +
   *  courseId for a tutor turn). */
  buildSendBody: () => Record<string, unknown>;
  /** This surface's regenerate (retry) request body -- see this file's own
   *  top-of-file comment for why the two surfaces' shapes are allowed to
   *  differ here. */
  buildRetryBody: () => Record<string, unknown>;
  /** #276: a hydration (history-fetch) failure, tracked outside this hook
   *  since fetching a conversation's history is orchestrated by App.tsx
   *  (it has too many surface-specific side effects -- pagination cursors,
   *  the tutor rail's busy state, the section's eager-greeting start -- to
   *  live here). Takes priority over an ordinary chat-stream error, and
   *  disables sending while set, matching the pre-existing contract. */
  hydrationError: { message: string; onRetry: () => void } | null;
  runRCode?: (code: string) => Promise<RCodeResult>;
}

export interface ConversationSurface {
  messages: MessageData[];
  aiMessages: UIMessage[];
  setMessages: (updater: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => void;
  status: ReturnType<typeof useChat>["status"];
  /** #144: true while a turn is genuinely in flight OR a hydration error is
   *  blocking sends -- "error" (an already-failed turn) is deliberately
   *  NOT included, so the composer stays usable after a failure. */
  isSending: boolean;
  /** #317 review, #352 (requirement 3): the narrower "a turn is genuinely
   *  in flight" check Stop itself should key off of -- unlike `isSending`,
   *  this excludes a hydration error (nothing to stop in that case). */
  isStopActionable: boolean;
  /** The same in-flight guard `send` itself already enforces, exposed so a
   *  caller's OWN pre-send side effects (hint-flagging, tutor auto-titling)
   *  don't run when the send is about to be a no-op -- matching the
   *  original handlers, where the guard was the very first line. */
  canSend: boolean;
  errorRow: ConversationSurfaceErrorRow | null;
  /** Non-null exactly when the last failure was a send-half failure (#96)
   *  AND it was recorded under the CURRENT `resetKey` -- handed back to the
   *  composer as ConversationView's own `restoredDraft` prop DIRECTLY (its
   *  shape, `{ text: string }`, is exactly what that prop wants).
   *
   *  #418/#419: this is a GATE on exposure, not a clear of the underlying
   *  record. Before #419, a `resetKey` change nulled the failure outright --
   *  which meant a send-half failure's words, which exist nowhere else (the
   *  un-persisted bubble was already dropped from the transcript, and the
   *  server never stored them), were destroyed the instant the student
   *  looked away, with no way back. The record now survives a `resetKey`
   *  change; only ITS EXPOSURE here is gated by a match against the current
   *  `resetKey` (computed during render, before any child of this render
   *  exists -- see this hook's own `sendFailureRecord` for why that timing
   *  needs no race-avoidance the way the pre-#419 stateful reset did),
   *  which is what keeps a stale-section failure from leaking into a
   *  DIFFERENT section's composer while still letting a return to the SAME
   *  section hand the words back.
   *
   *  #302 review fix (Critical #1): this MUST stay an object allocated
   *  fresh per failure, not a string re-wrapped in a new object literal at
   *  the call site every render. ConversationView keys its "restore once"
   *  behavior on OBJECT IDENTITY (`restoredDraft === lastRestoredDraftRef
   *  .current`) specifically so that a student who deliberately clears a
   *  restored draft (select-all, delete) does not have it silently
   *  reinjected by the next unrelated App re-render (a sidebar collapse, a
   *  hint-count refetch, anything) -- a literal built fresh every render
   *  would have a NEW identity every render and re-fire that restore on
   *  every single one, undoing the student's own deletion. This is also why
   *  the gate above exposes the SAME stored object on every render where the
   *  key still matches, rather than wrapping `sendFailureRecord.failure.text`
   *  in a new literal each time: two consecutive failures with IDENTICAL
   *  text must each independently restore (see ConversationView.test.tsx's
   *  own coverage of that), which a value-keyed memo would collapse into a
   *  single identity and only fire once. */
  sendFailure: { text: string } | null;
  send: (text: string, extraBody?: Record<string, unknown>) => void;
  stop: () => void;
  stoppedMessageId: string | null;
}

/** #302: the extracted shared hook. See this file's top-of-file comment for
 *  the extraction's scope and what deliberately stays in App.tsx. */
export function useConversationSurface(options: UseConversationSurfaceOptions): ConversationSurface {
  const {
    surfaceKey,
    resetKey,
    stoppedMessageResetKey,
    initialMessages,
    fetchImpl,
    buildSendBody,
    buildRetryBody,
    hydrationError,
    runRCode,
  } = options;

  /* #96: false from the moment a fresh send is dispatched until the server
     answers 2xx for it -- see ConversationSurface.sendFailure for what
     that implies. `fetchImpl` already throws (ChatResponseError)
     on a non-2xx response before returning, so "fetchImpl resolved" and
     "the server accepted this send" are the same event regardless of which
     surface-specific work happens inside `fetchImpl` first. */
  const acceptedRef = useRef(true);
  /* #418: what the in-flight send actually was, and which `resetKey` it was
     typed under. Written by `send` below at the moment of sending -- not
     reconstructed in the failure-detection effect below from whatever
     `aiMessages`/`resetKey` happen to hold when the request finally rejects,
     which can be arbitrarily later than the send itself (a hanging fetch
     outlives a switch). Read and cleared by the failure-detection effect on
     the failure path; cleared here on the SUCCESS path too (#420 review fix,
     Minor) -- not currently reachable as a live bug (the failure effect
     already requires `acceptedRef.current === false`, and `send()`
     unconditionally overwrites this ref before every subsequent send
     regardless), but leaving a stale reference to already-accepted, already
     -persisted text around for longer than it's needed is a footgun for
     whoever next reads or extends this file. */
  const pendingSendRef = useRef<{ text: string; key: typeof resetKey } | null>(null);
  const wrappedFetch: typeof fetch = async (input, init) => {
    const res = await fetchImpl(input, init);
    acceptedRef.current = true;
    pendingSendRef.current = null;
    return res;
  };

  /* #441 (response-half twin of #420's send-half fix): the `resetKey` that
     was current at the moment the turn NOW in flight was dispatched -- for
     EVERY turn, a fresh send or a retry, not just the send-half case
     `pendingSendRef` already tracks. Deliberately NOT cleared on acceptance
     (unlike `pendingSendRef`, which the whole point of #420's fix was to
     stop needing past that point) -- a send-half failure is already fully
     handled by the time `wrappedFetch` resolves, but a response-half
     failure (the stream itself dying) can only be detected LATER, arbitrarily
     long after acceptance, which is exactly the window a switch can land in.
     Only overwritten by a fresh dispatch (`send` below, or the retry
     handler in `errorRow.onRetry`) or cleared once the current turn
     resolves (success via "ready", or failure -- see the failure-detection
     effect below) -- so a stale key from the turn before can never be
     mistaken for the one now in flight. */
  const dispatchedKeyRef = useRef<typeof resetKey>(resetKey);

  /* #302: @ai-sdk/react's own `shouldRecreateChat` (use-chat.ts) is
     `"id" in options && chat.id !== options.id` -- note the `"id" in
     options` half fires as soon as the KEY is present at all, even with
     value `undefined`, and `AbstractChat`'s constructor defaults a missing
     id to a freshly `generateId()`'d string. So an options object that
     always includes `id: surfaceKey` -- even while `surfaceKey` is
     `undefined` -- would compare that fixed generated string against
     `undefined` on every single render and recreate the Chat instance
     EVERY render, unconditionally, for as long as `surfaceKey` stays
     `undefined`: not a one-time reset, a permanent per-render reset loop.
     Omitting the `id` key entirely while `surfaceKey` is `undefined`
     (rather than passing `id: undefined`) keeps `"id" in options` false,
     matching the pre-#302 section instance's own unkeyed behavior exactly
     for that phase -- `id` only starts participating in the reset check
     once `surfaceKey` first becomes a real string. */
  const {
    messages: aiMessages,
    setMessages,
    sendMessage,
    status,
    error,
    regenerate,
    // #420: neither useChat instance has anything else that resets its
    // status/error on a surface switch until `surfaceKey` eventually catches
    // up (late, for the section surface -- see `stoppedMessageResetKey`'s own
    // doc comment) -- without this, an error row from the surface just left
    // renders over the next one. See the `resetKey`-keyed effect below.
    clearError,
    stop: stopChat,
  } = useChat({
    ...(surfaceKey !== undefined ? { id: surfaceKey } : {}),
    messages: initialMessages,
    transport: new DefaultChatTransport({ api: "/api/chat", fetch: wrappedFetch, prepareSendMessagesRequest }),
    experimental_throttle: STREAM_THROTTLE_MS,
  });

  const [stoppedMessageId, setStoppedMessageId] = useState<string | null>(null);

  /* #419: the send-half failure record. Deliberately NOT cleared when
     `resetKey` changes (see below) -- it's a `{ failure, recordedAtKey }`
     pair kept alive across a switch so that returning to the surface it was
     recorded under still hands the student's words back (the pre-#419
     behavior nulled this the instant `resetKey` changed, which meant
     leaving and returning destroyed an un-persisted, un-recoverable message
     outright). `failure` is the exact object identity exposed as
     `sendFailure` below -- see that field's own doc comment (#302 review fix,
     Critical #1) for why this must stay a single stable object per failure,
     not one rebuilt fresh on every render that happens to still match. */
  const [sendFailureRecord, setSendFailureRecord] = useState<{
    failure: { text: string };
    recordedAtKey: typeof resetKey;
  } | null>(null);

  /* #419: exposed to the caller ONLY when the failure's own `recordedAtKey`
     still matches the CURRENT `resetKey` -- this is the render-site gate
     that replaces the old unconditional clear-on-switch, and it does so
     with no race to win: unlike the pre-#419 stateful reset (which had to
     beat a freshly-remounted ConversationView's own mount effect to null
     the value before that child read it), this is a pure derivation
     computed during THIS render, before any child of this render exists --
     a remounted child's very first render already sees the correctly-gated
     value. A stale-key record derives to `null` (closing the cross-surface
     leak #418/#419 both cared about); the record itself, and the object
     identity inside it, survive untouched so a later return to the same key
     exposes the exact same object again. */
  const sendFailure = sendFailureRecord && sendFailureRecord.recordedAtKey === resetKey ? sendFailureRecord.failure : null;

  /* #420 review fix (Critical): the ERROR-ROW classification below
     (`stage`/`onRetry`) must NOT key off the same key-gated `sendFailure`
     that `restoredDraft` uses. Upstream kept these as two SEPARATE
     consumers of the failure record for a reason: `sendFailure` (the
     composer restore) is correctly key-gated to `null` the moment a switch
     happens, but `errorRow`'s job is different -- classifying whichever
     error is CURRENTLY live on this useChat instance as "send" vs
     "response" so `onRetry` is never offered for a send-half failure. Once
     a switch moves `resetKey` on, `sendFailure` derives to `null` -- and
     reusing that as the classification signal would make a STILL-LIVE
     send-half failure (from the surface just left, on the SAME useChat
     instance, still showing "error" until `surfaceKey` catches up) get
     misclassified as "response", silently re-enabling `onRetry` pointed at
     whatever `buildRetryBody`/`conversationId` the CURRENT surface now
     resolves to -- i.e. regenerating a turn that never failed, in someone
     else's conversation. `hasSendFailure` is deliberately UNGATED (reads
     `sendFailureRecord` directly, ignoring `recordedAtKey`) so the
     send-half classification survives a switch exactly as long as the
     underlying `useChat` status does -- which the effect below now keeps
     in sync via `clearError()` the moment it detects the record no longer
     belongs to the current surface, so this is a belt-and-suspenders
     defense, not the only thing standing between here and that bug: even
     if some future change added a render where `status` were still
     "error" for a beat after a key-mismatched failure, `onRetry` could
     still never be resurrected against the wrong surface. Safe against
     misclassifying a LATER surface's own genuine response-half failure --
     `send()` unconditionally retires `sendFailureRecord` before every new
     send, so `hasSendFailure` can never be stale-true for a turn that
     hasn't itself failed on the send half. */
  const hasSendFailure = sendFailureRecord !== null;

  /* #420: clears a stale chat-stream error the instant `resetKey` changes.
     Mirrors the pre-#302 code's own `useEffect(() => clearChatError(),
     [currentSection, clearChatError])` exactly -- an EFFECT, not a
     render-time call like the reset below, because (unlike the restored
     draft) nothing here needs to win a race against a freshly-mounted
     child's own effects: the error row is read straight from this hook's
     return value, not gated by a child's mount-time ref. Keyed on
     `resetKey` rather than `surfaceKey` for the same reason #418/#419 care
     about the distinction -- for the section surface `surfaceKey` only
     catches up once the new section's history fetch resolves, and an error
     row from the section just left must not survive until then. A no-op
     when there is no error (`clearError`'s own internal guard) and a no-op
     for the tutor surface's ordinary switch, where `resetKey === surfaceKey`
     already recreates the Chat instance (and so already clears status/error
     that way) -- this firing too is harmless. */
  useEffect(() => {
    clearError();
  }, [resetKey, clearError]);

  /* #302 review fix (Important #2): the stopped-note reset is deliberately
     a SEPARATE render-time check, keyed on `stoppedMessageResetKey` (see
     that option's own doc comment for why it must not share `resetKey` --
     folding the two together silently gave the section surface a
     switch-triggered reset it never had before this extraction). */
  const lastStoppedMessageResetKeyRef = useRef(stoppedMessageResetKey);
  if (lastStoppedMessageResetKeyRef.current !== stoppedMessageResetKey) {
    lastStoppedMessageResetKeyRef.current = stoppedMessageResetKey;
    setStoppedMessageId(null);
  }

  /* #96/#418: detects a send-half failure -- the request never reached the
     server, or the server refused it outright -- and hands the student's
     words back rather than leaving an un-persisted bubble on screen (see
     sendFailure's own doc comment above for the full contract). */
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const previous = prevStatusRef.current;
    prevStatusRef.current = status;

    /* #441: a turn that finished successfully needs no dispatch-key record
       any more. Defensive, mirroring `pendingSendRef`'s own success-path
       clear in `wrappedFetch` above -- not currently reachable as a live
       bug (a fresh dispatch always overwrites `dispatchedKeyRef` before it
       is next read), but leaving a stale key around for longer than
       needed is the same footgun that comment already warns about. */
    if (status === "ready" && previous !== "ready") {
      dispatchedKeyRef.current = undefined;
    }

    // Only the moment a turn FAILS, not every render while it stays failed.
    if (status !== "error" || previous === "error") return;
    if (acceptedRef.current) {
      /* #441 (response-half twin of #420's send-half fix): the send was
         already accepted -- the server persisted the student's turn, and
         either the reply stream itself died, or this is a `regenerate`
         retry (which never routes through `send` below, so `acceptedRef`
         never goes false for it either) -- so there is no un-persisted
         text to hand back, unlike the send-half branch below. But #420's
         OWN fix only closed this window on the send half: `surfaceKey`
         (and the Chat instance recreation with it) doesn't catch up until
         the NEW surface's history fetch resolves, so if the turn that just
         failed was dispatched under a DIFFERENT `resetKey` than the one
         current right now, the student has already switched away from the
         surface this failure belongs to -- and without clearing here, this
         still-mounted instance's `status`/`error` would sit at "error" over
         the new surface, rendering an error row with a live Retry
         (`errorRow.onRetry`, since `hasSendFailure` is false here) pointed
         at the OLD surface's `buildRetryBody`/conversationId. One click
         regenerates a turn into a DIFFERENT section's conversation --
         reachable more easily than the Critical #420 fixed, since this is
         a durable button sitting on screen, not a sub-frame timing window. */
      if (dispatchedKeyRef.current !== resetKey) {
        clearError();
      }
      dispatchedKeyRef.current = undefined;
      return;
    }
    const pending = pendingSendRef.current;
    // No record of a send means nothing to hand back -- a turn that reached
    // "error" without `send` having started it is not a send-half failure
    // this can recover.
    if (!pending) return;
    pendingSendRef.current = null;
    // A FRESH object every time this fires (#302 review fix, Critical #1) --
    // never re-derived from a memo or recomputed at a render call site -- so
    // that two consecutive failures with the same text each independently
    // restore, and so ConversationView's own identity-keyed "restore once"
    // guard can't be defeated by an unrelated re-render minting a
    // new-looking object for the SAME failure.
    setSendFailureRecord({ failure: { text: pending.text }, recordedAtKey: pending.key });
    /* #418: only mutate the transcript on screen when it's still the one
       that failed -- i.e. `resetKey` hasn't moved on since the send. After a
       switch, `aiMessages` belongs to a different surface and slicing its
       tail would delete that surface's real, persisted message; that
       surface needs no cleanup in that case, since its transcript is
       unmounted and returning re-hydrates it from the server, which never
       stored the failed message in the first place. */
    if (pending.key === resetKey) {
      const last = aiMessages[aiMessages.length - 1];
      // Defensive: a send-half failure never gets far enough for the SDK to
      // append an assistant message, so the tail is the student's own
      // message.
      if (last?.role === "user") setMessages(aiMessages.slice(0, -1));
    } else {
      /* #420 review fix (Important #2): the switch-beats-failure ordering
         all of #418/#419/#420 are about -- this rejection is landing on a
         surface the student has already left. `surfaceKey` (and the Chat
         instance recreation that comes with it) won't catch up until the
         NEW surface's own history fetch resolves, which can be arbitrarily
         later than this moment -- so without an explicit clear here, this
         still-mounted useChat instance's `status`/`error` would otherwise
         sit at "error" over the new surface until then. Clearing it HERE,
         the instant the mismatch is detected (rather than only on the
         `resetKey`-keyed effect above, which already ran once for THIS
         switch and won't fire again until the NEXT one), closes that
         window immediately: the same effect invocation that records the
         failure (for #419's later restore) also retires the stale error
         row and its Retry it would otherwise render for the wrong
         conversation. Batched with `setSendFailureRecord` above into the
         same commit, so there is no intermediate render where `status` is
         still "error" for a `hasSendFailure`-classified-but-orphaned row to
         flash on screen. */
      clearError();
    }
    // #441: this turn's failure has now been fully handled (send-half) --
    // same resolution-clear as the response-half branch above.
    dispatchedKeyRef.current = undefined;
  }, [status, aiMessages, setMessages, resetKey, clearError]);

  /* #286 (review fix): a stable id per DISTINCT error object, so
     ConversationView's Retry-After cooldown can tell "a genuinely new
     failure" apart from "the same still-active failure being recomputed on
     an unrelated re-render." Derived directly during render (not in an
     effect) by comparing against the previous render's error reference --
     `useChat`'s error value is stable across renders that don't represent
     an actual change, so this only increments when a new Error instance
     was genuinely produced. */
  const errorAttemptRef = useRef(0);
  const lastErrorRef = useRef<unknown>(undefined);
  if (error !== lastErrorRef.current) {
    lastErrorRef.current = error;
    errorAttemptRef.current += 1;
  }

  /* #276: a hydration failure takes priority over a chat-stream error --
     it's the more fundamental problem, and `regenerate`'s retry wouldn't
     even be reachable in a useful state without history loaded.
     #96: `stage` splits the one error row into the two cases that need
     different recoveries -- a send-half failure omits `onRetry` entirely
     (the student's text is already back in the composer; Enter is the
     retry), a response-half failure keeps `regenerate`, which re-sends the
     same clientMessageId and is deduped server-side. */
  const errorRow: ConversationSurfaceErrorRow | null =
    hydrationError ??
    (status === "error"
      ? {
          message: error?.message || "Something went wrong. Please try again.",
          // #420 review fix (Critical): `hasSendFailure` (ungated), not
          // `sendFailure` (key-gated) -- see that field's own doc comment.
          stage: hasSendFailure ? "send" : "response",
          // #286: only ChatResponseError (a non-2xx /api/chat response) ever
          // carries this; an in-stream failure or a dropped connection never
          // does, and neither has a cooldown to enforce.
          retryAfterSeconds:
            error instanceof ChatResponseError && error.status === 429 ? error.retryAfterSeconds : undefined,
          retryAttemptId: errorAttemptRef.current,
          onRetry: hasSendFailure
            ? undefined
            : () => {
                // #441: `regenerate` dispatches a turn exactly like `send`
                // does, but bypasses `send` entirely -- record the key it's
                // dispatched under here too, so the failure-detection
                // effect's response-half branch has an accurate answer if
                // THIS retry's own stream later dies after another switch.
                dispatchedKeyRef.current = resetKey;
                regenerate({ body: buildRetryBody() });
              },
        }
      : null);

  /* #144: "error" deliberately excluded from both -- see isSending's own
     field doc above. */
  const isSending = status === "submitted" || status === "streaming" || !!hydrationError;
  const isStopActionable = status === "submitted" || status === "streaming";
  const canSend = status !== "submitted" && status !== "streaming";

  /* #144: the shared half of the two send handlers -- the in-flight guard,
     the accepted-ref reset, the send-failure clear, and the stopped-note
     clear. Surface-specific pre-send work (hint-flagging, tutor
     auto-titling) happens in App.tsx's own thin wrapper, gated on `canSend`
     BEFORE calling this, so it never runs for a blocked send -- matching
     the original handlers, where the guard was the very first line before
     any of that work. */
  const send = (text: string, extraBody?: Record<string, unknown>) => {
    acceptedRef.current = false;
    // A fresh send supersedes any previous failure -- its text is either
    // being re-sent right now or was deliberately replaced by the student.
    // Unlike a `resetKey` change (#419), a fresh send genuinely retires the
    // old record rather than merely gating its display.
    setSendFailureRecord(null);
    /* #418: the words, and the `resetKey` they belong to, recorded HERE, at
       the moment of sending -- not reconstructed in the failure-detection
       effect above from whatever `aiMessages`/`resetKey` happen to hold when
       the request finally rejects.

       A hanging send outlives a switch: the caller's `initialMessages`/
       `setMessages` replace `aiMessages` with the new surface's history on a
       switch, so reading the tail of `aiMessages` at failure time could read
       the WRONG surface's last message, stamp the failure with the wrong
       key, drop a PERSISTED message out of that surface's transcript, and
       pre-fill its composer one Enter away from sending it twice. The failed
       surface's actual text would be lost either way. */
    pendingSendRef.current = { text, key: resetKey };
    // #441: this send's dispatch key, unconditionally overwritten here --
    // see dispatchedKeyRef's own doc comment above.
    dispatchedKeyRef.current = resetKey;
    sendMessage({ text }, { body: { ...buildSendBody(), ...extraBody } });
    setStoppedMessageId(null);
  };

  /* #274, #317 review, #352: a client-side escape hatch for a turn that's
     merely slow -- marks whichever assistant message was on screen at the
     moment Stop was pressed so buildMessageData can render its "wasn't
     saved" note on exactly that one turn. */
  const stop = () => {
    const last = aiMessages[aiMessages.length - 1];
    if (last?.role === "assistant") setStoppedMessageId(last.id);
    stopChat();
  };

  /* #277: memoized per surface -- `runRCode` is stable (useRExecution
     returns a useCallback whose own dep is itself a []-dep useCallback), so
     this only recomputes when this surface's own messages/status/stopped-id
     actually change. */
  const messages = useMemo(
    () => buildMessageData(aiMessages, status, stoppedMessageId, runRCode),
    [aiMessages, status, stoppedMessageId, runRCode],
  );

  return {
    messages,
    aiMessages,
    setMessages,
    status,
    isSending,
    isStopActionable,
    canSend,
    errorRow,
    sendFailure,
    send,
    stop,
    stoppedMessageId,
  };
}
