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
   the stopped-message-id / send-failure UI state and its reset-on-switch
   semantics, the retryable error-row derivation (#144/#276/#286), and the
   translation of UIMessage[] into the design system's MessageData[]
   (#28/#317/#397).

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

/* #96: the plain text a student actually typed, recovered from the UIMessage
   useChat optimistically appended for it. Used only on the send-failure path
   below, to hand those words back to the composer before dropping the bubble
   the server never stored. Tool/file parts are ignored: a student message is
   text parts only. */
function studentTextOf(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
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
  /** #96/#317: the key that should reset the per-conversation UI-only
   *  state -- the stopped-message note, and a pending send-half failure's
   *  restored draft. For the tutor surface this is the same as
   *  `surfaceKey` (its ConversationView remount and its useChat `id` both
   *  update together, in the same `selectTutorConversation` call). For the
   *  section surface it deliberately is NOT `surfaceKey`: the section's
   *  ConversationView remounts on `currentSection` alone, synchronously,
   *  the instant a switch is requested -- but `surfaceKey` only updates
   *  once that section's history fetch resolves (see App.tsx's
   *  loadSectionConversation). A restored-draft leak from the OLD section
   *  would otherwise have a real window to land in the freshly-remounted
   *  (but not yet re-keyed) child before this hook's own state catches up
   *  -- resetting on the section number directly, at the same instant the
   *  remount happens, closes that window. */
  resetKey: string | number | undefined;
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
   *  -- the text is handed back to the composer via ConversationView's own
   *  `restoredDraft`. Reset synchronously the moment `surfaceKey` changes
   *  (see this hook's own render-time reset below), which is what makes it
   *  safe for a caller to read this directly as `restoredDraft` without
   *  separately tagging it by section/conversation the way the pre-#302
   *  code had to (see this hook's inline comment on that reset). */
  sendFailureText: string | null;
  send: (text: string, extraBody?: Record<string, unknown>) => void;
  stop: () => void;
  stoppedMessageId: string | null;
}

/** #302: the extracted shared hook. See this file's top-of-file comment for
 *  the extraction's scope and what deliberately stays in App.tsx. */
export function useConversationSurface(options: UseConversationSurfaceOptions): ConversationSurface {
  const { surfaceKey, resetKey, initialMessages, fetchImpl, buildSendBody, buildRetryBody, hydrationError, runRCode } =
    options;

  /* #96: false from the moment a fresh send is dispatched until the server
     answers 2xx for it -- see UseConversationSurfaceOptions.sendFailureText
     for what that implies. `fetchImpl` already throws (ChatResponseError)
     on a non-2xx response before returning, so "fetchImpl resolved" and
     "the server accepted this send" are the same event regardless of which
     surface-specific work happens inside `fetchImpl` first. */
  const acceptedRef = useRef(true);
  const wrappedFetch: typeof fetch = async (input, init) => {
    const res = await fetchImpl(input, init);
    acceptedRef.current = true;
    return res;
  };

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
    stop: stopChat,
  } = useChat({
    ...(surfaceKey !== undefined ? { id: surfaceKey } : {}),
    messages: initialMessages,
    transport: new DefaultChatTransport({ api: "/api/chat", fetch: wrappedFetch, prepareSendMessagesRequest }),
    experimental_throttle: STREAM_THROTTLE_MS,
  });

  const [stoppedMessageId, setStoppedMessageId] = useState<string | null>(null);
  const [sendFailureText, setSendFailureText] = useState<string | null>(null);

  /* #302: reset both pieces of per-conversation UI state the INSTANT
     `resetKey` changes -- synchronously, during this render, rather than
     in a `useEffect`. This closes a real race the pre-#302 tutor code
     needed a second, external defense for: both ConversationViews are
     keyed and therefore REMOUNT on a surface switch, and React runs a
     freshly-mounted child's own effects before a PARENT's effect -- so an
     effect-based reset here alone could still lose to a child's mount
     effect reading the stale value first. Doing it inline during render
     (React's own sanctioned "adjust state when a prop changes" pattern)
     runs before any child of this render exists at all, which is strictly
     earlier than either defense the pre-#302 code had -- see `resetKey`'s
     own doc comment for why this is keyed separately from `surfaceKey`. */
  const lastResetKeyRef = useRef(resetKey);
  if (lastResetKeyRef.current !== resetKey) {
    lastResetKeyRef.current = resetKey;
    setStoppedMessageId(null);
    setSendFailureText(null);
  }

  /* #96: detects a send-half failure -- the request never reached the
     server, or the server refused it outright -- and hands the student's
     words back rather than leaving an un-persisted bubble on screen (see
     sendFailureText's own doc comment above for the full contract). */
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const previous = prevStatusRef.current;
    prevStatusRef.current = status;
    // Only the moment a turn FAILS, not every render while it stays failed.
    if (status !== "error" || previous === "error") return;
    if (acceptedRef.current) return; // response half: the question is persisted, leave it on screen
    const last = aiMessages[aiMessages.length - 1];
    // Defensive: a send-half failure never gets far enough for the SDK to
    // append an assistant message, so the tail is the student's own message.
    if (last?.role !== "user") return;
    setSendFailureText(studentTextOf(last));
    // The bubble is dropped, not merely marked: it was never persisted, so
    // leaving it would show a message that a reload makes vanish.
    setMessages(aiMessages.slice(0, -1));
  }, [status, aiMessages, setMessages]);

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
          stage: sendFailureText !== null ? "send" : "response",
          // #286: only ChatResponseError (a non-2xx /api/chat response) ever
          // carries this; an in-stream failure or a dropped connection never
          // does, and neither has a cooldown to enforce.
          retryAfterSeconds:
            error instanceof ChatResponseError && error.status === 429 ? error.retryAfterSeconds : undefined,
          retryAttemptId: errorAttemptRef.current,
          onRetry: sendFailureText !== null ? undefined : () => regenerate({ body: buildRetryBody() }),
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
    setSendFailureText(null);
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
    sendFailureText,
    send,
    stop,
    stoppedMessageId,
  };
}
