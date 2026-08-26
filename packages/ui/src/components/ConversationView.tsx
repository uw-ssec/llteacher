/* --------------------------------------------------------------------------
   ConversationView — the main conversation column.

   Layout:
     Breadcrumb (mono, top — e.g. "STATS 311 · HW 3 · Section 3 P-VALUES")
     Scrolling message list
     Composer (sticky at bottom)

   Receives a list of messages and renders them via Message.
   The breadcrumb string is passed as a prop.
   -------------------------------------------------------------------------- */

import { useRef, useEffect, useState } from "react";
import { Message } from "./Message";
import { Composer } from "./Composer";
import { CodeBlock } from "./CodeBlock";
import { EditableTitle } from "./EditableTitle";
import { Button } from "./Button";
import { renderTextWithCode, type RCodeResult } from "../generative";

/** The student-facing copy for a failed turn.
 *
 *  Two rules, both learned the hard way by auditing the previous version of
 *  this function:
 *
 *  1. **The client owns the copy; the server owns the classification.** The
 *     earlier version pattern-matched the error *prose* to guess whether a
 *     string was safe to show. That is unfixable in principle -- it matched
 *     one provider's English, so it missed WebKit's "Load failed", missed
 *     Bedrock's `ThrottlingException`, and missed every string this server
 *     itself emits (none of which contain the words it looked for). The
 *     server now sends a stable `code` and the copy lives here.
 *
 *  2. **Fail safe, not open.** An unrecognized string is treated as machine
 *     output, never promoted to the student's headline. The previous version
 *     failed open: anything it did not recognize became the sentence the
 *     student read, which is how `OPENROUTER_API_KEY is not set. Add it via
 *     wrangler secret put ...` could have been rendered into a homework
 *     thread, and how a failed JSON unwrap rendered the raw body -- the exact
 *     defect the function existed to prevent.
 */
export type StoppedReason =
  | "unauthorized"
  | "rate_limited"
  | "history_too_long"
  | "not_found"
  | "denied"
  | "in_progress"
  | "duplicate_message"
  | "section_closed"
  | "tutor_stopped"
  | "unavailable"
  | "unknown";

export interface StoppedCopy {
  /** Short status line. Names what stopped, not what the student did. */
  label: string;
  /** One or two sentences the student can act on. */
  message: string;
  /** Machine text, kept for a bug report. Never the headline. */
  detail?: string;
  /** False when retrying provably cannot succeed, so no retry is offered. */
  retryable: boolean;
}

/** Longest machine string worth showing. A body generated above this app --
 *  a gateway or WAF error page -- is unbounded, and the detail line has no
 *  height cap, so an unclamped body pushes the recovery control off-screen. */
const MAX_DETAIL_CHARS = 300;

function clampDetail(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_DETAIL_CHARS
    ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}…`
    : trimmed;
}

/** #96 (send-failure UX): which HALF of a turn failed.
 *
 *  "send" — the request never reached the server, or the server refused it
 *  outright (any non-2xx). Nothing about this turn was persisted: no user
 *  row, no assistant row. The student's own text is the thing at risk, and
 *  the caller is expected to have put it back in the composer (see
 *  `restoredDraft`), so the copy must say "not sent" and must NOT offer a
 *  regenerate-style retry against a turn the server never heard of.
 *
 *  "response" — the server accepted the send (2xx) and therefore persisted
 *  the student's message, but the model turn didn't complete (an in-stream
 *  `error` chunk, a dropped connection mid-stream, a server timeout). The
 *  student's message IS in the transcript and will still be there on reload;
 *  only the reply is missing, so the right recovery is regenerate.
 *
 *  These were conflated before: every failed turn rendered the same row with
 *  the same regenerate retry, which for a refused send meant the student's
 *  text sat in the transcript as a bubble the server had never stored (it
 *  vanished on reload) while the copy told them to retype it by hand. */
export type TurnFailureStage = "send" | "response";

export function readErrorMessage(raw: string, stage: TurnFailureStage = "response"): StoppedCopy {
  const copy = classifyStoppedTurn(raw, stage);
  /* #96: a refused/undelivered send is never retryable through the error
     row, whatever its code says in the response-failure case. The turn does
     not exist server-side, so there is nothing to regenerate -- the caller
     has put the student's text back in the composer instead, and Enter is
     the retry. Applied centrally so no individual case below can drift out
     of step with that (rate_limited's "retryable: true" is correct for a
     response-half failure and wrong for this one). */
  return stage === "send" ? { ...copy, retryable: false } : copy;
}

function classifyStoppedTurn(raw: string, stage: TurnFailureStage): StoppedCopy {
  /* Defensive: the SDK stores whatever was thrown, typed `unknown`. A
     non-Error throw yields `undefined` here, and `.trim()` on it would raise
     inside the render body -- escalating a recoverable failed turn into a
     boundary swap that destroys the student's unsent draft. */
  const trimmed = typeof raw === "string" ? raw.trim() : "";

  let code: StoppedReason = "unknown";
  let serverError: string | undefined;

  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const obj = parsed as { error?: unknown; code?: unknown };
      if (typeof obj?.code === "string") code = obj.code as StoppedReason;
      if (typeof obj?.error === "string") serverError = obj.error;
    } catch {
      /* Not JSON. Falls through as "unknown" -- deliberately NOT rendered. */
    }
  }

  switch (code) {
    case "unauthorized":
      return {
        label: "Signed out",
        message:
          "Your session expired while you were working. Sign in again and your conversation will still be here.",
        retryable: false,
      };
    case "rate_limited":
      return {
        label: "Slow down",
        message:
          "You're sending messages faster than the tutor can answer. Wait a few seconds, then send again.",
        retryable: true,
      };
    case "history_too_long":
      return {
        label: "Conversation too long",
        message:
          "This conversation has grown past what the tutor can take in one go. Start a new one to keep going — this transcript stays saved.",
        // Retrying re-sends the same oversized history and fails identically.
        retryable: false,
      };
    case "not_found":
      return {
        label: "Not found",
        message:
          "This conversation isn't available any more. It may have been restarted, or the section may have been withdrawn by your instructor.",
        retryable: false,
      };
    case "denied":
      return {
        label: "No access",
        message: "You don't have access to this course any more. Check with your instructor.",
        retryable: false,
      };
    case "in_progress":
      return {
        label: "Already sending",
        message: "That message is already on its way. Give it a moment before sending again.",
        retryable: true,
      };
    case "duplicate_message":
      /* #266: the third 409 on this route, and distinct from in_progress for
         the same reason section_closed is -- the server refused this send
         because its message id already identifies DIFFERENT stored text, so
         re-sending the identical id and body 409s identically forever.
         Sharing in_progress's code told the student their message was
         "already on its way" when it had in fact been rejected and never
         persisted -- the precise silent-drop this issue exists to end, just
         relocated from the transcript to the error copy. Says plainly that
         nothing was sent, and points at the one action that does work
         (compose it again, which mints a fresh id -- #96 puts the text
         itself back in the composer, so that's one keystroke, not a
         retype). */
      return {
        label: "Message not sent",
        message:
          "That message wasn't sent — it clashed with an earlier one. Nothing was lost from the conversation: it's back in the box below, ready to send again.",
        retryable: false,
      };
    case "section_closed":
      /* Distinct from in_progress on purpose: both are 409s, but this one is
         permanent. Sharing a code meant a closed section rendered "already on
         its way" with a retry that 409s identically forever. */
      return {
        label: "Section closed",
        message:
          "This section isn't open for conversation. Your instructor may have closed it, or you may have already submitted it.",
        retryable: false,
      };
    case "tutor_stopped":
      return {
        label: "No response",
        message: "The tutor stopped partway through. Nothing you wrote was lost.",
        retryable: true,
      };
    case "unavailable":
      // #317 review, #344: retryable was true, but "unavailable" is a
      // server misconfiguration (a missing/invalid LLM credential, no
      // resolvable config) -- retrying re-hits the same broken state every
      // time, so the button offered a false promise. The server's own
      // message (e.g. "...Reference ID: abc123") is the one thing an
      // instructor can actually act on, and it was hidden inside the
      // collapsed "Details for support" disclosure the `default` case
      // uses -- surfaced directly in the body instead.
      return {
        label: "Tutor unavailable",
        message: serverError
          ? `${serverError} This is a problem on our side, not yours — your work is saved.`
          : "The tutor isn't available right now. This is a problem on our side, not yours — your work is saved. Tell your instructor if it persists.",
        retryable: false,
      };
    default:
      /* #96: an unrecognized failure means very different things depending
         on which half of the turn died, and the previous single sentence
         ("The tutor didn't finish answering") was only ever true for the
         response half. A send that never reached the server -- a dropped
         wifi connection, a WebKit "Load failed", a gateway page in front of
         the Worker -- did not fail to ANSWER; it failed to ARRIVE, and the
         student's own words are what needs accounting for. */
      if (stage === "send") {
        return {
          label: "Not sent",
          message:
            "Your message didn't reach the tutor, so nothing was added to this conversation. It's back in the box below — check your connection and send it again.",
          detail: clampDetail(serverError ?? trimmed),
          /* The composer holds the text: pressing Enter is the retry. A
             regenerate-style button here would re-request a turn the server
             never received. */
          retryable: false,
        };
      }
      /* Everything unrecognized -- a provider string, a gateway HTML page, a
         WebKit "Load failed", a body whose shape we do not know. The student
         gets a sentence; the machine's words go to the detail line only. */
      return {
        label: "No response",
        message: "The tutor didn't finish answering. Nothing you wrote was lost.",
        detail: clampDetail(serverError ?? trimmed),
        retryable: true,
      };
  }
}

/* -- Message data shape ---------------------------------------------------- */

export interface AIMessageData {
  id: string;
  role: "ai";
  content: React.ReactNode;
  isStreaming?: boolean;
}

export interface StudentMessageData {
  id: string;
  role: "student";
  content: string;
}

export interface SystemMessageData {
  id: string;
  role: "system";
  content: string;
}

export type MessageData =
  | AIMessageData
  | StudentMessageData
  | SystemMessageData;

/* -- Props ----------------------------------------------------------------- */

export interface ConversationViewProps {
  breadcrumb: string;
  /** #6: the active conversation's own title, shown as an editable heading
   *  below the breadcrumb -- omitted entirely (no heading rendered) for
   *  surfaces with no per-conversation title of their own, e.g. the
   *  homework-section chat, which only ever passes `breadcrumb`. */
  title?: string;
  /** Required alongside `title` to make the heading actually editable --
   *  see EditableTitle's onSave for the resolve/reject contract. */
  onRenameTitle?: (newTitle: string) => void | Promise<void>;
  /** False hides the rename affordance on the header title, matching the
   *  issue's "Only the conversation owner sees the edit affordance".
   *  Defaults to true (every conversation this column ever shows is the
   *  signed-in student's own -- see ConversationListItem's isEditable doc
   *  comment for the same reasoning applied to the list row). */
  isTitleEditable?: boolean;
  messages: MessageData[];
  onSendMessage?: (text: string) => void;
  /** #144: true while the owning `useChat` request is in flight (status
   *  "submitted" or "streaming") -- i.e. a send is genuinely outstanding.
   *  Disables the composer so pressing Enter mid-stream can't fire a
   *  second, overlapping `sendMessage` call (AI SDK v5's `Chat#sendMessage`
   *  has no internal guard against being called while already in flight --
   *  it just pushes another message and starts another request). Defaults
   *  to false so callers that don't track a `useChat` status (e.g. a
   *  fixture in tests) keep the composer usable.
   *
   *  Deliberately does NOT include status "error": `useChat`'s own
   *  `sendMessage` unconditionally resets status to "submitted" and clears
   *  `error` the moment a new message is sent, so sending a fresh message
   *  is the correct way out of a failed turn -- for a `useChat` instance
   *  with no `id` (nothing else ever resets it, e.g. the homework-section
   *  chat), disabling the composer on "error" too would leave Retry (which
   *  replays the exact request that just failed) as the only way out. */
  isSending?: boolean;
  /** #144: set when the owning `useChat`'s last turn failed (status
   *  "error") so a failed/rate-limited stream doesn't just silently
   *  disappear. Rendered as an inline row below the messages with a Retry
   *  action; `onRetry` should call that `useChat` instance's own
   *  `regenerate()`. `null`/`undefined` renders nothing.
   *
   *  #96: `stage` says which half of the turn failed (see TurnFailureStage)
   *  and defaults to "response", the only case that existed before. `onRetry`
   *  is optional because a "send"-stage failure has nothing to regenerate --
   *  omit it and no Retry button renders, since the student's text has been
   *  handed back to the composer via `restoredDraft` instead. */
  error?: { message: string; onRetry?: () => void; stage?: TurnFailureStage } | null;
  /** #96 (send-failure UX): text to put back into the composer after a send
   *  that never reached the server, so the student's words survive a dropped
   *  connection or a refused request instead of being stranded in a
   *  transcript bubble the server never stored.
   *
   *  Restored once per object identity -- pass a NEW object per failure (the
   *  same text failing twice must restore twice) and `null` the rest of the
   *  time. Never overwrites a non-empty draft: if the student has already
   *  started typing something else, their current words win. */
  restoredDraft?: { text: string } | null;
  /** #235: focuses the composer once on mount -- pass true for the one
   *  render right after a brand-new conversation was created and switched
   *  to, so a keyboard user lands in the composer without an extra Tab. */
  autoFocusComposer?: boolean;
  /** #280: true when the fetched history came back a full page (the
   *  messages route pages at 200, no "load older" is wired yet) -- renders
   *  a static notice above the transcript so the ceiling is visible rather
   *  than silent (a conversation with exactly 200 messages is otherwise
   *  indistinguishable from one truncated at 200). */
  hasMoreHistory?: boolean;
  /** #248: optional slot rendered alongside the breadcrumb for
   *  surface-specific header actions -- e.g. the homework-section chat's
   *  "Restart section" button. `undefined` renders nothing, so surfaces
   *  with no header action (the tutor chat) are unaffected. */
  headerActions?: React.ReactNode;
  /** #274: the owning `useChat` instance's own `stop()` -- rendered as a
   *  "Stop" affordance next to the composer while `isSending` is true.
   *  `undefined` renders nothing (matches every other optional-callback
   *  prop here), so a caller that doesn't track a `useChat` instance (e.g.
   *  a fixture in tests) is unaffected. The server-side half of #274 (a
   *  timeout on the model call itself) already exists (chat.ts's
   *  STREAM_TIMEOUT_MS); this is the client's own escape hatch for a
   *  request that's merely slow, not yet timed out. */
  onStop?: () => void;
  /** #317 review, #352 (requirement 3): whether a turn is GENUINELY in
   *  flight (the owning `useChat`'s status is "submitted" or "streaming")
   *  -- gates the Stop button's own active state. Distinct from
   *  `isSending`, which callers also set true for reasons that leave
   *  nothing for Stop to actually stop (App.tsx ORs in a hydration-error
   *  flag so the composer stays disabled through it) -- without this,
   *  Stop rendered as active while `onStop()` was a no-op against a chat
   *  that was never streaming. Defaults to `isSending`, matching this
   *  component's original (conflated) behavior for any caller that
   *  doesn't pass it. */
  isStopActionable?: boolean;
  /** #28: bound to the app layer's own useRExecution().run -- lets a
   *  student's own message render an R-fenced code block (see
   *  renderTextWithCode's doc comment for why detection happens on the
   *  raw string here, not upstream: StudentMessageData.content stays a
   *  plain string because the composer's history-recall feature needs the
   *  literal text back, not a React tree) as a runnable CodeExecution card
   *  instead of inert text. `undefined` degrades to a read-only code block
   *  with no Run affordance -- matches CodeExecution's own graceful
   *  degradation when a caller hasn't wired R execution up at all. */
  onRunRCode?: (code: string) => Promise<RCodeResult>;
  /** #29: omits the Composer entirely rather than merely disabling it.
   *  Every other prop on this component already degrades to a static,
   *  useChat-free render when omitted (onSendMessage/isSending/onStop/etc.
   *  are all optional) -- but the Composer's own textarea always rendered
   *  regardless, which is a visible edit affordance even at
   *  isSending=true/readOnly (the instructor transcript viewer's own
   *  "copy-safe: no edit affordances" requirement, which a merely-disabled
   *  textbox does not satisfy). Defaults to false, so every existing caller
   *  (the student-facing section/tutor chats) is byte-for-byte unaffected --
   *  this is an additive opt-in, not a behavior change to the component's
   *  default shape. */
  hideComposer?: boolean;
  /** #80: forwarded straight to Composer -- see its own doc comment.
   *  `undefined` renders no hint affordance at all, matching every other
   *  optional prop's degrade-to-nothing convention on this component. */
  onRequestHint?: () => void;
  /** Forwarded straight to Composer's own `hintDisabled` -- see its doc
   *  comment. Ignored when `onRequestHint` is unset. */
  hintDisabled?: boolean;
}

/* -- Component ------------------------------------------------------------- */

export function ConversationView({
  breadcrumb,
  title,
  onRenameTitle,
  isTitleEditable = true,
  messages,
  onSendMessage,
  isSending = false,
  error = null,
  restoredDraft = null,
  autoFocusComposer = false,
  hasMoreHistory = false,
  headerActions,
  onStop,
  isStopActionable = isSending,
  onRunRCode,
  hideComposer = false,
  onRequestHint,
  hintDisabled = false,
}: ConversationViewProps) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  /* Scroll to bottom when new messages arrive -- and when a turn fails.
     `error` belongs in the deps: a failed turn does not change `messages`
     (the assistant reply is deliberately not persisted), so without it the
     error row mounts below the fold and nothing scrolls to it, leaving the
     only recovery control off-screen. */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, error]);

  // #317 review, #327: no deterministic announcement existed for a
  // streamed reply *finishing* -- the start is announced (Message.tsx's
  // own "AI is responding" aria-busy row), but the end relied entirely on
  // aria-busy clearing, whose replay behavior across AT is unspecified
  // (Cordero's own finding: "a blind student hears 'AI is responding' then
  // silence" is a plausible outcome, not a hypothetical one). A static,
  // deterministic phrase -- not the reply's own text -- is used
  // deliberately: `msg.content` is `React.ReactNode` (markdown-rendered,
  // may include a CodeBlock or a generative-UI card), not always a string
  // this component could safely re-read as plain text without risking a
  // garbled or incomplete announcement.
  // Counted, not just a static string: a role="status" region is expected
  // to announce on any mutation regardless of whether the new text matches
  // the old, but that's exactly the AT-dependent behavior this issue's own
  // "manual AT verification" requirement flags as unconfirmed -- appending
  // the turn count keeps consecutive completions textually distinct
  // (and, as a side effect, informative) rather than relying on that
  // assumption holding.
  //
  // #317 review, #345: the naive `isSending` true->false transition fired
  // this same "Response complete" phrase on three outcomes that are not
  // completion at all -- App.tsx's own `isSending` folds together
  // `chatStatus === "submitted" || "streaming" || !!sectionHydrationError`,
  // so it also flips false on Stop (the opposite of what the phrase
  // claims -- the one feedback the student got for pressing Stop stated
  // the reply finished), on error (redundant with, and contradicting, the
  // assertive alert that fires alongside it), and on a hydration-retry
  // clearing with no chat turn ever sent. Three independent guards below,
  // one per false-positive source:
  const [turnCompleteAnnouncement, setTurnCompleteAnnouncement] = useState("");
  const completedTurnCountRef = useRef(0);
  const wasSendingRef = useRef(isSending);
  // Set by the Stop button's own onClick below -- ConversationView owns
  // that click, so it can flag "the next isSending->false transition was
  // caused by Stop" without App.tsx needing to plumb a distinct status
  // through `isSending`'s single boolean.
  const stoppedRef = useRef(false);
  // The message count at the moment `isSending` became true -- a genuine
  // chat turn appends the student's own message essentially immediately
  // (see handleSubmit below), so an unchanged count by the time
  // `isSending` clears again means no turn was actually sent (the
  // hydration-retry-clearing case).
  const messagesLengthAtSendStartRef = useRef(messages.length);
  useEffect(() => {
    if (isSending && !wasSendingRef.current) {
      messagesLengthAtSendStartRef.current = messages.length;
    }
    if (wasSendingRef.current && !isSending) {
      if (stoppedRef.current) {
        stoppedRef.current = false;
        setTurnCompleteAnnouncement("Response stopped.");
      } else if (!error && messages.length !== messagesLengthAtSendStartRef.current) {
        completedTurnCountRef.current += 1;
        setTurnCompleteAnnouncement(`Response complete (turn ${completedTurnCountRef.current}).`);
      }
      // error !== null: the assertive role="alert" error row is the
      // announcement -- a second, contradictory "complete" status right
      // alongside it helps nobody.
      // messages unchanged: nothing was actually sent (isSending was true
      // only because of a hydration retry) -- no turn to announce.
    }
    wasSendingRef.current = isSending;
    // messages.length, not the whole `messages` array/`error`, is the
    // correct dependency here -- this effect only needs to READ their
    // current values at the moment isSending's own edge fires, not
    // re-run whenever a message's content mutates mid-stream (which
    // would restart the "count runs of this exact turn" logic every
    // token) or `error` changes independently of isSending.
  }, [isSending]);

  const handleSubmit = (text: string) => {
    onSendMessage?.(text);
    setDraft("");
  };

  /* #96: hand a failed-to-send message back to the composer. Keyed on object
     identity rather than on the text, so the same message failing twice in a
     row restores both times -- a value-keyed effect would see no change and
     silently swallow the second failure, which is exactly the "my words just
     disappeared" complaint this exists to prevent. */
  const lastRestoredDraftRef = useRef<{ text: string } | null>(null);
  useEffect(() => {
    if (!restoredDraft || restoredDraft === lastRestoredDraftRef.current) return;
    lastRestoredDraftRef.current = restoredDraft;
    setDraft((current) => (current.trim() ? current : restoredDraft.text));
  }, [restoredDraft]);

  /* Composer history: the student's most recent 10 sent messages, oldest→newest.
     Derived from the conversation messages already in props — no separate store. */
  const composerHistory = messages
    .filter((m): m is StudentMessageData => m.role === "student")
    .map((m) => m.content)
    .slice(-10);

  /* Hoisted rather than computed inside JSX: the previous inline IIFE
     existed only to bind locals, and foreclosed memoising or extracting. */
  const errorCopy = error ? readErrorMessage(error.message, error.stage ?? "response") : null;

  return (
    <div className="conversation-column">
      {/* Scrollable message area */}
      <div className="conversation-messages">
        <div className="conversation-inner">
          {/* #317 review, #327: moved OUT of the role="log" region below --
              this row (and the title/hasMoreHistory notice under it) used
              to sit INSIDE it, so App.tsx's #248 Restart button was
              announced as a node ADDITION the moment an eager section
              greeting landed, and every section switch queued the whole
              breadcrumb/title/notice as "new" log content alongside the
              200 fetched messages. None of this is conversation TURN
              content -- role="log" now wraps only the messages themselves. */}
          <div className="conversation-header-row">
            <p className="breadcrumb">{breadcrumb}</p>
            {headerActions}
          </div>

          {/* #6: conversation header title -- only for surfaces that pass
              one (the homework-section chat has no per-conversation title
              and omits `title` entirely, so nothing renders here for it). */}
          {title !== undefined && onRenameTitle && (
            <h1 className="conversation-header-title">
              <EditableTitle
                value={title}
                onSave={onRenameTitle}
                isEditable={isTitleEditable}
                renameLabel="Rename conversation"
              />
            </h1>
          )}

          {/* #280: the ceiling made visible instead of silent -- see
              hasMoreHistory's own doc comment above. No message count in
              the copy: `messages` here keeps growing as the conversation
              continues after hydration, so a count captured from the
              fetched page would go stale the moment a new turn is sent. */}
          {hasMoreHistory && (
            <p className="conversation-history-notice">
              Showing the most recent messages. Older messages aren't shown yet.
            </p>
          )}

          {/* #300: role="log" is the ARIA role specified for exactly this
              case -- a sequence of items where new ones append at the end
              (vs. role="status"/"alert" for a single replaceable message).
              aria-relevant="additions" (not the "additions text" default)
              means only a newly APPENDED node is announced, not every text
              mutation inside an existing one -- combined with aria-busy on
              the in-progress AI message (Message.tsx), a streaming reply is
              silent while it fills in.

              #317 review, #345 (correcting the claim this comment used to
              make): "announced once, whole, on completion" describes
              behavior ARIA does not specify and this markup does not
              produce. "additions" excludes TEXT changes by definition --
              the reply's own content is a text mutation inside the AI
              message node that already exists (appended empty, then
              filled in via streaming deltas), never a new node arriving.
              So the reply text is never announced by this region at all;
              aria-busy clearing does not retroactively announce the
              subtree it was set on. What the student actually hears is the
              turnCompleteAnnouncement fixed phrase below ("Response
              complete") -- a deterministic signal that a reply finished,
              deliberately not the reply's own words (see that state's own
              doc comment for why: `msg.content` is markdown-rendered
              ReactNode, not always safely re-readable as plain text).
              Reading the actual answer requires leaving the composer and
              navigating into the transcript. Known, real limitation --
              not fixed here because it wants manual AT verification
              (NVDA/JAWS/VoiceOver) this session cannot perform: the
              candidate fix (aria-busy on the log root, aria-relevant back
              to its "additions text" default) changes what gets announced
              and when for every message in the transcript, and shipping
              that blind risks a worse regression than the current,
              honestly-documented gap.

              #317 review, #327: wraps ONLY the appended turns now (the
              breadcrumb/title/notice above moved out, see their own
              comment). Bulk hydration/section-switch replacement is
              handled at the CALLER: App.tsx keys the section
              ConversationView by section id (the tutor surface was
              already keyed by conversationId) so a switch remounts this
              whole component -- including this region -- instead of
              diffing up to 200 messages into a persistent live region as
              node insertions. A freshly-mounted live region has nothing to
              retroactively announce; only genuinely incremental appends
              during an ACTIVE conversation reach an AT as insertions. */}
          <div className="conversation-log" role="log" aria-live="polite" aria-relevant="additions">
            {messages.map((msg) => {
              if (msg.role === "ai") {
                return (
                  <Message key={msg.id} role="ai" isStreaming={msg.isStreaming}>
                    {msg.content}
                  </Message>
                );
              }
              if (msg.role === "student") {
                return (
                  <Message key={msg.id} role="student">
                    {renderTextWithCode(msg.content, { onRun: onRunRCode, keyPrefix: msg.id })}
                  </Message>
                );
              }
              return (
                <Message key={msg.id} role="system">
                  {msg.content}
                </Message>
              );
            })}
          </div>

          {/* #317 review, #327: deterministic "the reply is done" signal --
              see turnCompleteAnnouncement's own doc comment above for why
              this is a fixed phrase, not the reply's own text. */}
          <p className="sr-only" role="status">
            {turnCompleteAnnouncement}
          </p>
        </div>

        {/* Deliberately OUTSIDE the role="log" region above.

            A role="alert" nested inside a live region is two overlapping
            live regions governing one insertion, with conflicting settings:
            the log is polite + aria-relevant="additions" + non-atomic, and
            alert is implicitly assertive + atomic. ARIA defines no
            resolution for that and screen readers diverge. Worse, because
            "additions" excludes text changes, a second consecutive failure
            producing an identical message mutates no DOM and announces
            nothing at all -- the student hears silence after pressing
            Try again.

            Hoisted here, its alert semantics work unopposed. It keeps
            .conversation-inner for the reading measure, and stays inside
            .conversation-messages so it scrolls with the thread. */}
        {error && errorCopy && (
          <div className="conversation-inner">
            <div className="conversation-error-row">
              {/* role="alert" scoped to the two lines the student must hear.
                  It was on the whole block, which meant the machine detail
                  was announced at the same weight as the sentence -- the
                  visual demotion existed only in CSS. */}
              <div role="alert">
                <span className="conversation-error-row__label">{errorCopy.label}</span>
                <p className="conversation-error-row__message">{errorCopy.message}</p>
              </div>

              {/* Before the detail, not after. A gateway error body pushed the
                  only recovery control arbitrarily far down a thread that does
                  not auto-scroll on error. */}
              {/* #96: `onRetry` is optional now -- a send-stage failure has
                  no server-side turn to regenerate, so the caller omits it
                  and the student recovers from the composer instead
                  (readErrorMessage already forces retryable false there;
                  this second condition keeps the two from ever disagreeing). */}
              {errorCopy.retryable && error.onRetry && (
                <button
                  type="button"
                  className="conversation-error-row__retry"
                  onClick={error.onRetry}
                >
                  Try again
                  <span className="conversation-error-row__retry-arrow" aria-hidden="true">
                    →
                  </span>
                </button>
              )}

              {errorCopy.detail && (
                <details className="conversation-error-row__detail-wrap">
                  <summary className="conversation-error-row__detail-toggle">
                    Details for support
                  </summary>
                  <p className="conversation-error-row__detail">{errorCopy.detail}</p>
                </details>
              )}
            </div>
          </div>
        )}

        {/* Sentinel last, so "scroll to bottom" means the real bottom --
            below the error row, not above it. */}
        <div ref={bottomRef} aria-hidden="true" />
      </div>

      {/* #274: a Stop affordance for a turn that's merely slow, not yet
          timed out (chat.ts's own STREAM_TIMEOUT_MS bounds the server side
          of this).
          #317 review, #327: stays MOUNTED whenever the caller tracks a
          useChat instance to stop (onStop set) -- previously conditional
          on `isSending` too, so a keyboard user who activated Stop had it
          unmount out from under their focus the instant `isSending`
          flipped false, stranding them at document.body with no handoff
          (same harm Composer.tsx's #270 fix already closed for the
          composer). `ariaDisabled` (Button.tsx) keeps it focusable and
          merely refuses activation while nothing is in flight, instead of
          native `disabled` removing it from the tab order. */}
      {onStop && (
        <div className="conversation-stop-row">
          <Button
            variant="danger"
            size="sm"
            outlined
            // #317 review, #345: flags the next isSending->false transition
            // as caused by Stop (see turnCompleteAnnouncement's own effect
            // above) -- Button.tsx only invokes onClick when the button is
            // genuinely actionable (not aria-disabled), so this can't set
            // the flag from a click that didn't actually stop anything.
            onClick={() => {
              stoppedRef.current = true;
              onStop();
            }}
            ariaDisabled={!isStopActionable}
          >
            Stop
          </Button>
        </div>
      )}

      {/* Sticky composer -- #144: disabled while a send is genuinely in
          flight, so Enter mid-stream can't fire a second, overlapping
          send (see isSending's doc comment above for why "error" is
          deliberately excluded).

          #29: omitted entirely when hideComposer -- see that prop's own
          doc comment for why a merely-disabled textarea isn't good enough
          for a copy-safe, no-edit-affordances surface. */}
      {!hideComposer && (
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={handleSubmit}
          disabled={isSending}
          history={composerHistory}
          autoFocus={autoFocusComposer}
          onRequestHint={onRequestHint}
          hintDisabled={hintDisabled}
        />
      )}
    </div>
  );
}

/* Re-export CodeBlock so callers building message content have it available */
export { CodeBlock };
