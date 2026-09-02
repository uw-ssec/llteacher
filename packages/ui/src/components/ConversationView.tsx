/* --------------------------------------------------------------------------
   ConversationView — the main conversation column.

   Layout:
     Breadcrumb (mono, top — e.g. "STATS 311 · HW 3 · Section 3 P-VALUES")
     Scrolling message list
     Composer (sticky at bottom)

   Receives a list of messages and renders them via Message.
   The breadcrumb string is passed as a prop.
   -------------------------------------------------------------------------- */

import { Fragment, useCallback, useRef, useEffect, useLayoutEffect, useState } from "react";
import { Message } from "./Message";
import { Composer } from "./Composer";
import { CodeBlock } from "./CodeBlock";
import { EditableTitle } from "./EditableTitle";
import type { RCodeResult } from "../generative";

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
  /** #397: ISO 8601 from the message row. The server has always returned this
   *  (routes/sectionConversations.ts) -- the client was dropping it. Absent
   *  for a turn still streaming, which renders no time rather than a made-up
   *  one. */
  createdAt?: string;
}

export interface StudentMessageData {
  id: string;
  role: "student";
  content: string;
  createdAt?: string;
}

export interface SystemMessageData {
  id: string;
  role: "system";
  content: string;
  /** System markers ("submitted at 11:34") happen at a time like any other
   *  turn, so they can legitimately open a new day in the transcript. The
   *  Message component renders no meta row for them; this is only used for
   *  day grouping. */
  createdAt?: string;
}

export type MessageData =
  | AIMessageData
  | StudentMessageData
  | SystemMessageData;

/* -- Day separators ---------------------------------------------------------

   A tutoring conversation can span days -- a student opens a section on
   Monday, comes back Wednesday -- and until now the transcript ran those
   together, so the reply above a question could be two days older than it
   looked. The per-turn time (#397) makes that visible turn by turn; this
   makes the DAY boundary visible as a boundary.

   Local time throughout, deliberately: the student's own calendar day is
   what "Wednesday" means to them. Comparing toDateString() gets local
   midnight boundaries without pulling in a date library.
   -------------------------------------------------------------------------- */

const DAY_MS = 86_400_000;

function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today" / "Yesterday" / a weekday name while it is still unambiguous /
 *  an explicit date once it is not.
 *
 *  The weekday form is only used within the last 6 days. Say "Wednesday" any
 *  longer than that and it starts meaning two different Wednesdays, which is
 *  worse than no label -- so past a week it becomes a real date, and past a
 *  year it carries the year too. */
export function formatDayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  const daysApart = Math.round((startOfLocalDay(now) - startOfLocalDay(d)) / DAY_MS);
  if (daysApart === 0) return "Today";
  if (daysApart === 1) return "Yesterday";
  if (daysApart > 1 && daysApart < 7) {
    return d.toLocaleDateString(undefined, { weekday: "long" });
  }
  return d.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

function DayDivider({ label }: { label: string }) {
  /* role="separator" with an accessible name, rather than a bare decorative
     rule: the day IS information, and a separator is announced sparsely
     enough not to become noise inside the role="log" region it sits in. The
     rules either side are drawn by CSS pseudo-elements, so there is no
     presentational markup to hide from AT. */
  return (
    <div className="day-divider" role="separator" aria-label={label}>
      <span className="day-divider__pill" aria-hidden="true">
        {label}
      </span>
    </div>
  );
}

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
  error?: {
    message: string;
    onRetry?: () => void;
    stage?: TurnFailureStage;
    /** #310: epoch ms until which a retry is certain to fail, from the 429's
     *  `Retry-After`. The server has always sent that header and no client
     *  has ever read it, so the Retry button stayed live through the whole
     *  window and every click was guaranteed to fail. */
    retryAfterUntil?: number;
  } | null;
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
  /** #280: true when there are older messages than the transcript holds
   *  (the messages route pages at 200). Renders the "Load older messages"
   *  control above the transcript when `onLoadOlderMessages` is also
   *  given, and a static "older messages aren't shown" notice when it
   *  isn't.
   *
   *  That notice branch has NO live consumer today -- both callers (App.tsx's
   *  tutor and section surfaces) wire the loader. It is kept deliberately,
   *  as a defensive default rather than a described behaviour: these two
   *  props are independently optional, so `hasMoreHistory` without a loader
   *  is reachable by construction of this API, and #280 is specifically a
   *  bug about a page ceiling being SILENT. Disclosing it is the safe thing
   *  for this component to do when it is told history is truncated but given
   *  no way to fetch more.
   *
   *  (The instructor transcript viewer, apps/admin's TranscriptDetailView,
   *  is not that consumer: it never passes `hasMoreHistory` at all and
   *  renders its own offset-based pagination outside this component.) */
  hasMoreHistory?: boolean;
  /** #280 (requirement 2, transcript half): fetches the page of messages
   *  BEFORE the oldest one showing and prepends it. The caller owns the
   *  cursor (the oldest loaded message's `seq`); this component only owns
   *  the affordance and the scroll anchoring that keeps the student
   *  looking at the same message afterwards. */
  onLoadOlderMessages?: () => void;
  /** #280: true while `onLoadOlderMessages`' request is in flight. */
  isLoadingOlderMessages?: boolean;
  /** #280: true when the last "load older" attempt failed. The control
   *  stays live -- the page is still there to ask for. */
  loadOlderMessagesError?: boolean;
  /** #288: how many trailing messages the model actually sees on a turn.
   *  When the transcript is longer than this, a divider is rendered above
   *  the oldest message still inside the window.
   *
   *  The tutor forwards only a trailing window while this component renders
   *  the full history it fetched, so a student could scroll up, read turn 3,
   *  reference it, and get an answer as if it had never happened -- with
   *  nothing on screen distinguishing "the tutor cannot see that" from "the
   *  tutor is being obtuse". 40 messages is 20 turns, and a persisted,
   *  semester-spanning tutor conversation is the whole point of the rail.
   *
   *  Passed in rather than hardcoded here: the number the server enforces
   *  and the line this component draws must be one number. Callers source
   *  it from `shared/chat-limits.ts`, which is also what chat.ts trims by.
   *  Omitted (the default) renders no divider -- correct for surfaces with
   *  no model behind them, e.g. the instructor transcript viewer, where
   *  nothing is "forgotten" because nothing is being sent. */
  contextWindowSize?: number;
  /** #248: optional slot rendered alongside the breadcrumb for
   *  surface-specific header actions -- e.g. the homework-section chat's
   *  "Restart section" button. `undefined` renders nothing, so surfaces
   *  with no header action (the tutor chat) are unaffected. */
  headerActions?: React.ReactNode;
  /** #397: "revert the conversation to this message", offered on the
   *  student's turns. UNWIRED BY DESIGN: no endpoint exists for it yet.
   *  Truncating a conversation is not a client-side edit -- it has to delete
   *  persisted rows, and past a submission it carries #128's voiding
   *  semantics exactly as restartSectionConversation does. Until a caller can
   *  actually pass a handler, the affordance does not render at all, because
   *  a button that cannot act is worse than an absent one. */
  onRevertToMessage?: (messageId: string) => void;
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

/** #278: JS-initiated scrolling is invisible to the design system's global
 *  CSS motion rule (styles.css's `prefers-reduced-motion` block), so it is
 *  the one motion path that escapes the user's stated preference unless it
 *  is checked here. Read per call rather than cached: the preference can be
 *  toggled mid-session, and this is a cheap lookup next to the layout the
 *  caller is about to force. Guarded for non-browser/jsdom hosts where
 *  matchMedia may be absent. */
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/** Within a message's height of the bottom. Not an exact equality check:
 *  fractional device-pixel scroll offsets mean `scrollTop + clientHeight`
 *  rarely equals `scrollHeight` precisely even when visually pinned. */
const FOLLOW_THRESHOLD_PX = 120;
function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX;
}

/** #288: one message row. Extracted so the boundary branch inside the map
 *  renders a row identically to the three inline branches below it rather
 *  than duplicating them -- a fourth copy is how the boundary row would
 *  quietly stop matching the others. Takes no `key`: the caller owns it,
 *  since the boundary case wraps this in a Fragment that holds the key. */
function renderMessageRow(
  msg: MessageData,
  onRunRCode?: (code: string) => Promise<RCodeResult>,
  onRevertToMessage?: (messageId: string) => void,
) {
  if (msg.role === "ai") {
    return (
      <Message role="ai" isStreaming={msg.isStreaming} createdAt={msg.createdAt}>
        {msg.content}
      </Message>
    );
  }
  if (msg.role === "student") {
    return (
      <Message
        role="student"
        createdAt={msg.createdAt}
        onRun={onRunRCode}
        onRevert={onRevertToMessage ? () => onRevertToMessage(msg.id) : undefined}
      >
        {msg.content}
      </Message>
    );
  }
  return <Message role="system">{msg.content}</Message>;
}

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
  onLoadOlderMessages,
  isLoadingOlderMessages = false,
  loadOlderMessagesError = false,
  contextWindowSize,
  headerActions,
  onStop,
  isStopActionable = isSending,
  onRunRCode,
  hideComposer = false,
  onRequestHint,
  hintDisabled = false,
  onRevertToMessage,
}: ConversationViewProps) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  /* #288: index of the oldest message the model still sees. Undefined when
     there is no window to disclose -- either the caller passed none, or the
     transcript is short enough that everything on screen is in context, in
     which case a divider would claim a boundary that isn't there. Strictly
     greater-than: a transcript of exactly the window size is entirely
     visible to the model. */
  const contextBoundaryIndex =
    contextWindowSize !== undefined && messages.length > contextWindowSize
      ? messages.length - contextWindowSize
      : undefined;

  /* #410: one place that knows HOW to reach the bottom, so the three
     callers (new message, streaming follow, turn completion) cannot drift
     apart on the container-vs-sentinel question or the reduced-motion
     check. jsdom implements neither scrollTo nor real layout, hence the
     capability guard -- not dead code in a browser, where scrollTo is where
     the smooth behaviour comes from. */
  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight, behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  /* Scroll to bottom when new messages arrive -- and when a turn fails.
     `error` belongs in the deps: a failed turn does not change `messages`
     (the assistant reply is deliberately not persisted), so without it the
     error row mounts below the fold and nothing scrolls to it, leaving the
     only recovery control off-screen.

     #278: keyed on `messages.length`, NOT `messages`. The array identity is
     brand new on every parent render, so this used to run once per streamed
     token rather than once per new message -- a synchronous layout of a
     subtree holding up to 200 hydrated nodes, tens of times a second.
     Length changes exactly when a message is actually added.

     #410 (merged in): scrolls THIS container via scrollTo rather than
     calling scrollIntoView on a bottom sentinel. scrollIntoView walks up
     the ancestor chain and scrolls every scrollable ancestor it finds --
     and `overflow: hidden` still makes an element programmatically
     scrollable -- so it was also scrolling .conversation-column, dragging
     the composer up by ~455px and further on every delta. That was measured
     live on staging; this branch's sentinel approach had the same bug and
     inherits the fix rather than carrying its own version forward.

     A new message or a failed turn scrolls unconditionally: both are
     content the student has not seen, and the error row carries the only
     recovery control, so it must not mount below the fold. */
  /* #280: a "load older" prepend also grows `messages.length`, and the
     scroll-to-bottom below would then throw the student to the newest
     message -- the exact opposite of what they just asked for. Two refs
     cooperate:

     - `pendingScrollAnchorRef` records the scroll geometry at the moment
       the control was pressed, so the layout effect can restore the same
       message to the same place once the older page has been inserted
       ABOVE it (browser scroll anchoring is not reliable enough to lean on,
       and jsdom has none at all).
     - `restoredScrollAnchorRef` tells the bottom-scroll effect that this
       particular length change was a prepend it must not react to. Layout
       effects all run before passive ones in the same commit, so the flag
       is always set by the time the effect below reads it. */
  const pendingScrollAnchorRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
    /** #428: which message was at the TOP when the control was pressed. */
    firstMessageId: string | undefined;
  } | null>(null);
  const restoredScrollAnchorRef = useRef(false);

  const handleLoadOlderMessages = () => {
    const el = scrollRef.current;
    if (el) {
      pendingScrollAnchorRef.current = {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
        firstMessageId: messages[0]?.id,
      };
    }
    onLoadOlderMessages?.();
  };

  useLayoutEffect(() => {
    const anchor = pendingScrollAnchorRef.current;
    const el = scrollRef.current;
    if (!anchor || !el) return;
    /* #428: only a PREPEND may consume the anchor.

       This effect is keyed on `messages.length`, and an assistant reply
       landing while a "load older" request is still in flight changes that
       too. The anchor was then spent on an APPEND: scrollTop was set to a
       meaningless offset, restoredScrollAnchorRef suppressed the scroll for
       the new reply, and when the older page finally arrived the anchor was
       null -- so the prepend fell through to scrollToBottom and threw the
       student to the newest message, the exact jump this exists to prevent.

       A prepend is precisely the case where the message at the top changes;
       an append never touches it. */
    if (messages[0]?.id === anchor.firstMessageId) return;
    pendingScrollAnchorRef.current = null;
    restoredScrollAnchorRef.current = true;
    // The prepended page's own height -- whatever was added above the
    // message the student was looking at is exactly how far down it moved.
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
  }, [messages.length]);

  /* A request that returned no older messages never changes
     `messages.length`, so the layout effect above never fires and its
     anchor would sit stale until the next genuine append -- which would
     then be mistaken for a prepend. Clearing on the in-flight flag going
     false covers that (and the failure case) without a third signal. */
  useEffect(() => {
    if (!isLoadingOlderMessages) pendingScrollAnchorRef.current = null;
  }, [isLoadingOlderMessages]);

  useEffect(() => {
    if (restoredScrollAnchorRef.current) {
      restoredScrollAnchorRef.current = false;
      return;
    }
    scrollToBottom(true);
  }, [messages.length, error, scrollToBottom]);

  /* #278: follow the reply as it streams, without queueing an animation.
     A growing assistant message makes the thread taller without adding a
     message, so the length-keyed effect above deliberately does not fire.
     Assigning scrollTop directly queues no smooth scroll for the next
     assignment to interrupt, which is what made the original per-token
     scrollIntoView pathological.

     Skipped under prefers-reduced-motion: a >5s reply otherwise means >5s
     of continuous automatic movement, and a JS-driven scroll is invisible
     to the stylesheet's global motion rule.

     Only follows a student already AT the bottom -- scrolling up during a
     long reply is deliberate, and yanking them back would make re-reading
     impossible. #387 gates the completion settle the same way; see the
     turn-completion effect below, which owns the isSending edge. */
  useEffect(() => {
    if (!isSending || prefersReducedMotion()) return;
    const el = scrollRef.current;
    if (!el || !isNearBottom(el)) return;
    el.scrollTop = el.scrollHeight;
  });

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

      /* #387: settle the view at the bottom when a turn finishes -- but
         ONLY for a student who never left it.

         `isSending` used to be a dependency of the scroll effect above, so
         this same transition fired an unconditional scrollIntoView. That
         defeated the follow effect's own guard one moment after it had
         done its job: a student who scrolled up mid-reply was left alone
         for the whole response, then yanked back to the bottom the instant
         it completed -- the moment they were most likely to still be
         reading. The follow effect documented "only follows a student
         already AT the bottom"; the effect above silently broke it.

         Placed here rather than in its own effect because this one already
         owns the isSending edge; a second ref tracking the same transition
         would have two effects racing to write it. */
      const scroller = scrollRef.current;
      if (scroller && isNearBottom(scroller)) {
        scrollToBottom(true);
      }
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
  /* #427: the failed text when the composer was ALREADY occupied and the
     restore had to be declined. It exists nowhere else at that point -- the
     bubble was dropped from the transcript and the server never stored it --
     so without surfacing it here the message is simply gone, while the error
     row goes on claiming it is "back in the box below".

     Shown in the error row rather than appended to the draft: appending
     splices two different thoughts into one message the student never wrote,
     and would overwrite the exact case the "don't clobber" guard exists for
     (a hint send failing while the student is mid-question). */
  const [unrestoredText, setUnrestoredText] = useState<string | null>(null);
  useEffect(() => {
    if (!restoredDraft || restoredDraft === lastRestoredDraftRef.current) return;
    lastRestoredDraftRef.current = restoredDraft;
    setDraft((current) => {
      if (!current.trim()) {
        setUnrestoredText(null);
        return restoredDraft.text;
      }
      setUnrestoredText(restoredDraft.text);
      return current;
    });
  }, [restoredDraft]);
  // Cleared once there is no failure left to describe.
  useEffect(() => {
    if (!restoredDraft) setUnrestoredText(null);
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

  /* #310: seconds left on a rate-limit window, ticking so the button
     re-enables on its own. Only runs while there is actually a future
     deadline -- no interval on the overwhelmingly common error, and none
     once it has elapsed. */
  const retryAfterUntil = error?.retryAfterUntil;
  const [retrySecondsLeft, setRetrySecondsLeft] = useState(0);
  useEffect(() => {
    if (!retryAfterUntil) {
      setRetrySecondsLeft(0);
      return;
    }
    const tick = () => {
      const left = Math.ceil((retryAfterUntil - Date.now()) / 1000);
      setRetrySecondsLeft(left > 0 ? left : 0);
      return left;
    };
    if (tick() <= 0) return;
    const id = setInterval(() => {
      if (tick() <= 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [retryAfterUntil]);

  return (
    <div className="conversation-column">
      {/* Scrollable message area */}
      <div className="conversation-messages" ref={scrollRef}>
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
            {/* Review finding: Message.tsx shifts markdown `#` to <h2> on the
                premise that "the conversation column already owns the page's
                <h1>". True of the tutor chat, FALSE of the section chat, which
                passes neither `title` nor `onRenameTitle` -- so no <h1> existed
                and every seeded section (whose content opens with a heading)
                emitted an <h2> into a document with no <h1>: a heading-order
                violation for screen-reader navigation.

                Fixed by promoting THIS element rather than adding a visually
                hidden heading beside it. A hidden duplicate would make an AT
                announce the same string twice, which is a worse outcome than
                the bug. On the section surface the breadcrumb genuinely is the
                page's name ("Section 1: Sample Spaces & Events"), so an <h1>
                is the honest element; where a real title <h1> already renders
                below, this stays a <p> and there is still exactly one. The
                .breadcrumb class carries all the styling either way, so
                nothing changes visually. */}
            {title !== undefined && onRenameTitle ? (
              <p className="breadcrumb">{breadcrumb}</p>
            ) : (
              <h1 className="breadcrumb">{breadcrumb}</h1>
            )}
            {headerActions}
          </div>

          {/* #6: conversation header title -- only for surfaces that pass
              one (the homework-section chat has no per-conversation title
              and omits `title` entirely, so nothing renders here for it). */}
          {title !== undefined && onRenameTitle ? (
            /* #405 follow-on: the heading is named EXPLICITLY rather than
               from its contents. EditableTitle renders its keybinding hint
               and character counter inside this element while editing, and
               once those stopped being aria-hidden (so a screen-reader user
               could finally discover blur-to-save) they began participating
               in the heading's accessible name -- heading navigation
               announced "Original enter ↵ or click away saves · esc cancels
               92 left" instead of the conversation's title.

               aria-label isolates the name without hiding anything: the hint
               stays in the accessibility tree, still referenced by the
               input's aria-describedby, and the heading still says what the
               conversation is called. */
            <h1 className="conversation-header-title" aria-label={title}>
              <EditableTitle
                value={title}
                onSave={onRenameTitle}
                isEditable={isTitleEditable}
                renameLabel="Rename conversation"
              />
            </h1>
          ) : null}

          {/* #280: the ceiling made visible instead of silent -- see
              hasMoreHistory's own doc comment above. No message count in
              the copy: `messages` here keeps growing as the conversation
              continues after hydration, so a count captured from the
              fetched page would go stale the moment a new turn is sent. */}
          {hasMoreHistory &&
            (onLoadOlderMessages ? (
              /* #280 (requirement 2): the real control. A button rather
                 than load-on-scroll-to-top: this column's scroll handler is
                 already carrying the streaming-follow and
                 scroll-to-bottom behaviours, and a fetch fired by scrolling
                 up would race both of them. */
              <div className="conversation-history-more">
                <button
                  type="button"
                  className="conversation-history-more__btn"
                  onClick={handleLoadOlderMessages}
                  disabled={isLoadingOlderMessages}
                  aria-busy={isLoadingOlderMessages}
                >
                  {isLoadingOlderMessages ? "Loading…" : "Load older messages"}
                </button>
                {loadOlderMessagesError && (
                  <p className="conversation-history-notice" role="alert">
                    Couldn&rsquo;t load older messages. Please try again.
                  </p>
                )}
              </div>
            ) : (
              /* Defensive default, not a path any current caller takes --
                 see hasMoreHistory's own doc comment. Told history is
                 truncated but given no way to fetch more, disclosing the
                 ceiling beats hiding it. */
              <p className="conversation-history-notice">
                Showing the most recent messages. Older messages aren't shown yet.
              </p>
            ))}

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
            {messages.map((msg, index) => {
              /* Two independent separators can precede a turn, and they mean
                 different things: the DAY divider says when this was written,
                 the #288 context boundary says what the tutor can still see.
                 Both can land on the same message, so they are computed
                 independently and rendered day-first (the broader frame)
                 rather than one being made a special case of the other. */

              /* #288: the boundary is rendered as a sibling ABOVE the message
                 it marks, from inside this same map so it cannot drift from
                 the index it describes.

                 role="separator" with a label, not a styled div: for a
                 screen-reader user scrolling the transcript this is
                 meaningful structure, not decoration -- it is the only thing
                 distinguishing "the tutor cannot see that" from "the tutor
                 ignored me". It sits inside the role="log" region because it
                 is part of the transcript's structure, and it renders at
                 mount for an already-long conversation rather than appearing
                 mid-stream, so it is not announced as an insertion. */
              const boundary =
                index === contextBoundaryIndex ? (
                  <div
                    className="conversation-context-boundary"
                    role="separator"
                    aria-label="Start of what the tutor can see"
                  >
                    <span>
                      The tutor&rsquo;s memory starts here &mdash; messages above this line aren&rsquo;t part
                      of what it sees. Re-state anything from earlier you want it to use.
                    </span>
                  </div>
                ) : null;

              /* #397: emitted when this turn's local calendar day differs from
                 the last DATED turn's -- including before the first, so a
                 transcript opened days later says so at the top rather than
                 only between groups.

                 Turns with no createdAt (a live stream, or a message just
                 sent, neither of which has a persisted row yet) inherit the
                 current day rather than breaking the run: an undated turn is
                 always "now", so it cannot be the thing that starts a day. */
              const dayLabel = (() => {
                if (!msg.createdAt) return null;
                const prevDated = messages
                  .slice(0, index)
                  .reverse()
                  .find((m) => m.createdAt);
                if (
                  prevDated?.createdAt &&
                  new Date(prevDated.createdAt).toDateString() ===
                    new Date(msg.createdAt).toDateString()
                ) {
                  return null;
                }
                const label = formatDayLabel(msg.createdAt);
                return label === "" ? null : label;
              })();

              const row = renderMessageRow(msg, onRunRCode, onRevertToMessage);
              if (!boundary && !dayLabel) return <Fragment key={msg.id}>{row}</Fragment>;
              return (
                <Fragment key={msg.id}>
                  {dayLabel ? <DayDivider label={dayLabel} /> : null}
                  {boundary}
                  {row}
                </Fragment>
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
                  onClick={retrySecondsLeft > 0 ? undefined : error.onRetry}
                  /* #310: a rate-limited retry cannot succeed until the
                     window closes, and the old button invited the student to
                     find that out by clicking. Not hidden -- a control that
                     vanishes and returns reads as a glitch.

                     #310 review: `aria-disabled`, NOT the real `disabled`
                     attribute. `disabled` drops the button out of the tab
                     order and out of a screen reader's control listing
                     entirely, so a student using one would find no "Try
                     again" at all -- the exact disappearance the paragraph
                     above rejects, just invisible to sighted review. This
                     keeps it focusable and announced, and inert via the
                     omitted onClick. */
                  aria-disabled={retrySecondsLeft > 0 ? true : undefined}
                >
                  {retrySecondsLeft > 0 ? `Try again in ${retrySecondsLeft}s` : "Try again"}
                  <span className="conversation-error-row__retry-arrow" aria-hidden="true">
                    →
                  </span>
                </button>
              )}

              {/* #427: only when the restore was declined. The ordinary case
                  puts the text in the composer and says so; this is the
                  branch where that sentence would otherwise be false. */}
              {unrestoredText && (
                <div className="conversation-error-row__unrestored">
                  <p className="conversation-error-row__message">
                    Your composer already had text, so we left it alone. The message that didn&rsquo;t send was:
                  </p>
                  <pre className="conversation-error-row__unrestored-text">{unrestoredText}</pre>
                </div>
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

      </div>

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
          /* #274 redesign: Stop moved from its own row above the composer into
             the composer's own trailing action slot, where it shares one
             never-unmounted button with Send. Composer.tsx's own comment on
             that button covers why the shared element is what makes #327's
             focus guarantee structural. */
          onStop={
            onStop
              ? () => {
                  // #317 review, #345: flags the next isSending->false
                  // transition as caused by Stop (see
                  // turnCompleteAnnouncement's own effect above). Composer
                  // only invokes this in its Stop identity, which requires
                  // isStopActionable, so it can't fire from a click that
                  // didn't actually stop anything.
                  stoppedRef.current = true;
                  onStop();
                }
              : undefined
          }
          isStopActionable={isStopActionable}
        />
      )}
    </div>
  );
}

/* Re-export CodeBlock so callers building message content have it available */
export { CodeBlock };
