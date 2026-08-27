import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useNavigate } from "react-router";
import { Sidebar, TopNav, ConversationView, AlertDialog, Button, MessageMarkdown, renderToolPart, isToolPart, ErrorBoundary } from "@llteacher/ui";
import type { SidebarSection, MessageData, RCodeResult } from "@llteacher/ui";
import { useRExecution } from "./hooks/useRExecution";
import { useAuth } from "./components/AuthProvider";
import { UnauthenticatedHome } from "./components/UnauthenticatedHome";
import { TutorConversationsList } from "./views/TutorConversationsList";
import { useTutorConversations } from "./hooks/useTutorConversations";
import type { ConversationMessageResponse, StudentHomeworkListResponse, HintCountResponse } from "../shared/types";
import { MAX_HISTORY_MESSAGES } from "../shared/chat-limits";

/* ==========================================================================
   LLTeacher v2 — Chat-with-syllabus shell
   Section 3 P-Values — STATS 311, Homework 3

   Three-zone vertical shell:
     [TOP NAV — UW Husky Purple, full-bleed 56px]
     [Sidebar 240px UW Husky Purple] [Conversation max 720px paper]

   The top nav carries branding, course/term/homework context, and the user
   account menu. The sidebar carries the homework syllabus (section progress)
   for the current homework only — not generic thread history.

   Purple is the chrome. Heritage Gold is the AI's voice. Paper is the content.
   ========================================================================== */

/* -- Worker status ping ---------------------------------------------------- */

type HelloResponse = { message: string; ping_id: string };

function useWorkerStatus() {
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/hello")
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json() as Promise<HelloResponse>;
      })
      .then((data) => {
        setStatus(data.ping_id.slice(0, 8));
        setLoading(false);
      })
      .catch(() => {
        setStatus(null);
        setLoading(false);
      });
  }, []);

  return { status, loading };
}

/* -- Student homework data -------------------------------------------------- */

/** localStorage key for the sidebar collapsed preference. Namespaced so it
    doesn't collide with future preference keys (`llteacher:*`). */
const SIDEBAR_COLLAPSED_KEY = "llteacher:sidebar-collapsed";

/** #4: separate key for the tutor-conversations rail's own collapse state --
    a distinct zone from the homework Sidebar (see TutorConversationsList's
    doc comment for the IA decision), so it gets its own preference rather
    than sharing (and fighting over) SIDEBAR_COLLAPSED_KEY. */
const TUTOR_SIDEBAR_COLLAPSED_KEY = "llteacher:tutor-sidebar-collapsed";

/** #214: a section's real database id + its pre-existing conversation id
 *  (if the student has already started it) -- SidebarSection (below) drops
 *  both, since @llteacher/ui's Sidebar only ever needed `number`/`title`/
 *  `status`. Keyed by `order` (== SidebarSection.number), the same key the
 *  Sidebar/handleSectionSelect already navigate by. */
interface SectionMeta {
  id: string;
  conversationId: string | null;
}

/** Fetches the current student's homework list and adapts it into the
    Sidebar's section shape. SidebarSection's status union ("submitted" |
    "current" | "pending") has no direct equivalent for "not_started" /
    "overdue" / "in_progress_overdue" -- those all map onto "pending" for
    now; a richer Sidebar status vocabulary is a @llteacher/ui change out of
    scope for this issue. */
export function useStudentHomework() {
  const [sections, setSections] = useState<SidebarSection[]>([]);
  const [sectionMetaByOrder, setSectionMetaByOrder] = useState<Map<number, SectionMeta>>(new Map());
  const [hwTitle, setHwTitle] = useState("");
  // #4: the tutor-conversations rail (TutorConversationsList) needs a
  // courseId to scope GET/POST /api/conversations -- this hook's homework
  // fetch is the client's only source of course context today (see
  // StudentHomeworkSummary.courseId's doc comment), so it's threaded
  // through here rather than added as a second fetch.
  const [courseId, setCourseId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  // #160: distinct from "loaded, zero homeworks" -- a 401/403/503 must not
  // render as an indistinguishable empty sidebar. r.ok was never checked
  // before, so a non-2xx error-body response (`{ error: "..." }`) was cast
  // straight to StudentHomeworkListResponse; data.homeworks[0] then threw a
  // TypeError inside the .then chain that the trailing .catch swallowed.
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    fetch("/api/student/homeworks")
      .then((r) => {
        if (!r.ok) throw new Error(`failed to load student homeworks: ${r.status}`);
        return r.json() as Promise<StudentHomeworkListResponse>;
      })
      .then((data) => {
        const hw = data.homeworks[0]; // single-homework sidebar UI, matches current design
        if (!hw) {
          setLoading(false);
          return;
        }
        setHwTitle(hw.title);
        setCourseId(hw.courseId);
        setSections(
          hw.sections.map((s) => ({
            number: s.order,
            title: s.title,
            status:
              s.status === "submitted"
                ? ("submitted" as const)
                : s.status === "in_progress"
                  ? ("current" as const)
                  : ("pending" as const),
          })),
        );
        setSectionMetaByOrder(
          new Map(hw.sections.map((s) => [s.order, { id: s.id, conversationId: s.conversationId }])),
        );
        setLoading(false);
      })
      .catch(() => {
        setLoadError(true);
        setLoading(false);
      });
  }, []);

  // #271: setSectionMetaByOrder returned so the caller can update a
  // section's conversationId the moment the server mints one (chatFetch
  // below) -- sectionMetaByOrder is the single source of truth for a
  // section's conversationId now that the redundant copy on SidebarSection
  // above is gone; previously this setter existed only inside this hook,
  // which made it structurally impossible for anything outside the hook to
  // keep the map current after the initial fetch.
  return { sections, setSections, sectionMetaByOrder, setSectionMetaByOrder, hwTitle, courseId, loading, loadError };
}

/* Translates the AI SDK's UIMessage[] + status into the design system's
   MessageData[] -- shared by both the homework-section chat and the tutor
   chat below (#4 introduced the second consumer; this was inlined in App
   before). See the two useChat call sites for why they're separate Chat
   instances rather than one shared one. */
/** #277: cap on how often a streamed response re-renders the chat surface,
 *  in milliseconds. One animation frame at 60Hz -- fast enough that the
 *  reply still reads as continuously typed, slow enough that the render
 *  rate is bounded by the display rather than by the model's token rate. */
const STREAM_THROTTLE_MS = 16;

function buildMessageData(
  aiMessages: UIMessage[],
  chatStatus: ReturnType<typeof useChat>["status"],
  // #317 review, #352: the id of the assistant message that was on screen
  // the moment the student pressed Stop, if any -- App.tsx clears it the
  // moment a new send starts (see handleStopSectionChat's own doc comment),
  // so it only ever marks the ONE turn Stop actually interrupted, never a
  // later one. Server-side, this exact partial is never persisted (chat.ts's
  // hasRenderableContent/isErrorOutcome gate, #342) -- this note is what
  // keeps the visible transcript honest about that instead of the fragment
  // silently reading as an ordinary, complete, remembered reply.
  stoppedMessageId?: string | null,
  /* #28: bound to this app's own useRExecution().run -- threaded through
     to BOTH an assistant text part's own R-fenced code (renderTextWithCode
     below) and a tool-executeRCode part (renderToolPart's handlers arg).
     Deliberately the SAME, non-persisting callback for anything the model
     produces, however it got there (a raw fenced block in its own text, or
     the executeRCode display tool) -- unlike the student's OWN code (see
     App.tsx's runRCodeForSection/runRCodeForTutor), running the tutor's
     example code is exploratory and must not auto-generate a new
     persisted turn on every click (see this file's own doc comment on
     that decision). */
  onRunRCode?: (code: string) => Promise<RCodeResult>,
): MessageData[] {
  /* #397: the persisted row's timestamp, riding on UIMessage.metadata (set in
     fetchConversationHistory). A turn the student has only just sent, or one
     still streaming, has no persisted row yet and therefore no time -- the
     transcript renders none rather than stamping Date.now(), which would show
     a time the server never recorded and would drift from the row once it
     lands. */
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
              /* Markdown owns its own block structure, so the raw text goes
                 straight to MessageMarkdown -- wrapping it in a <p> trapped the
                 markdown inside a block element it needed to own ("\n\n"
                 collapsed to spaces, a leading "# " came out as a literal
                 hash).

                 This REPLACES renderTextWithCode at this call site, and
                 subsumes it: that helper split the text on ```r fences and
                 rendered everything else as a bare <p>, so a reply could have
                 a Run button or formatting but never both. MessageMarkdown's
                 own `pre` override now detects the r fence during markdown
                 rendering and hands it to the same CodeExecution component,
                 so `onRun` still reaches it and the prose around it is
                 finally prose. See MarkdownPre in Message.tsx. */
              return (
                <MessageMarkdown key={`text-${m.id}-${i}`} onRun={onRunRCode}>
                  {part.text}
                </MessageMarkdown>
              );
            }
            /* #144: no `part as ToolPart` cast -- useChat isn't given the
               server's tool-input generics, so the AI SDK's UIMessagePart
               union can't statically prove a `tool-*` part carries
               `input`/`state`. isToolPart runtime-checks the one thing
               actually needed (a string `type`) before handing off to
               renderToolPart, which validates the tool-specific `input`
               shape itself (parseShowDefinitionInput) rather than trusting
               a blind cast all the way through. */
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
        // A stopped turn is definitionally done, even if this happened to
        // still be the last message and chatStatus hasn't settled out of
        // "streaming" yet by the render that first sees it.
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

/* #317 review, blocking finding #3: DefaultChatTransport's default request
   body sends useChat's ENTIRE local message array on every turn -- for a
   long-running section (hydration restores up to 200 messages), that array
   alone measures ~189KB at 100 realistic messages and eventually exceeds
   MAX_REQUEST_BODY_BYTES (chat.ts), 400ing every further send with no
   recovery (reloading just re-hydrates the same history). chat.ts has never
   actually needed more than the last message -- #143's server-authoritative
   history redesign already reads persisted history from the DB, not from
   this array (see chatEnvelopeSchema's own doc comment) -- so trimming here
   costs nothing server-side. `body` already carries the envelope fields
   (conversationId, or courseId/kind/sectionId) merged in by the transport
   before this runs; only `messages` needs overriding. Shared by both
   useChat instances below since both hit the same cap. */
function prepareSendMessagesRequest({
  messages,
  body,
}: {
  messages: UIMessage[];
  body: Record<string, unknown> | undefined;
}) {
  return { body: { ...body, messages: messages.slice(-1) } };
}

/* ==========================================================================
   App — the root component

   Chat state is owned by the AI SDK's useChat hook. We translate the
   UIMessage[] it manages into the design system's MessageData[] for
   ConversationView. Empty initial state — the student starts by typing.
   ========================================================================== */

export default function App() {
  const { status: workerStatus, loading: workerLoading } = useWorkerStatus();
  const { isAuthenticated, loading: authLoading, error: authError, login, logout } = useAuth();
  const navigate = useNavigate();

  /* #3: the server creates a conversation on the first turn and returns its
     id via the x-conversation-id response header; every subsequent turn
     sends it back so the server persists into the same conversation instead
     of minting a new one each time. Component state only for now (not the
     URL) -- persisting it there, and loading an existing conversation's
     history on mount, is conversation-lifecycle scope (#27), not this task. */
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);

  /* Wraps fetch to read the x-conversation-id response header before handing
     the (untouched) Response back to useChat's own stream parsing --
     DefaultChatTransport otherwise has no way to surface response headers
     to the caller.

     #271: this function is captured ONCE by DefaultChatTransport at first
     render (see the useChat comment below) -- reading `currentSection` or
     `sectionMetaByOrder` directly here would freeze both at whatever they
     were on that first render forever. currentSectionRef/sectionMetaByOrderRef
     (declared below, kept current via their own effects) are how this
     stays correct across every later render without recreating the
     transport. */
  const chatFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    const newConversationId = res.headers.get("x-conversation-id");
    if (newConversationId) {
      setConversationId(newConversationId);
      const section = currentSectionRef.current;
      const prevMeta = sectionMetaByOrderRef.current.get(section);
      // #271: sectionMetaByOrder (not the removed SidebarSection.conversationId
      // copy) is the single source of truth a section's conversationId is
      // read from everywhere else in this file (loadSectionConversation,
      // handleSubmit) -- writing the server-minted id back into it here is
      // what makes those reads see it, instead of only ever seeing whatever
      // the initial /api/student/homeworks fetch returned.
      if (prevMeta) {
        setSectionMetaByOrder((prev) => {
          const next = new Map(prev);
          next.set(section, { ...prevMeta, conversationId: newConversationId });
          return next;
        });
      }
      // #272: no prior conversationId for this section means THIS request
      // is the one that just made the server write the section's greeting
      // (the actual question text) as the conversation's first message --
      // the client has no way to know that yet. Queued rather than fetched
      // immediately: see the effect below for why it waits for this turn's
      // stream to finish first.
      //
      // Round-4 review fix: the re-hydration effect below only applies its
      // fetched history when `latestSectionConversationRef.current ===
      // pendingId` -- and until now, nothing on this path ever wrote
      // `newConversationId` into that ref. It's only ever set by
      // loadSectionConversation, which for a section starting life at
      // conversationId: null was last called with `undefined`. So the
      // guard compared `undefined === newConversationId`, always false,
      // and the re-fetched [greeting, question, reply] history was
      // silently discarded -- the fetch fired (a wasted round-trip) but
      // setSectionMessages was never reached. The server-side half of #272
      // (the model seeing the greeting on the creation turn) was never
      // affected; only the in-session transcript stayed missing it until a
      // section switch or reload re-ran loadSectionConversation from
      // scratch.
      if (prevMeta && !prevMeta.conversationId) {
        pendingGreetingConversationIdRef.current = newConversationId;
        latestSectionConversationRef.current = newConversationId;
      }
    }
    return res;
  };

  /* The AI SDK chat — owns messages + streaming state.

     useChat memoizes its internal Chat instance in a useRef on first mount
     (see @ai-sdk/react's use-chat.ts: shouldRecreateChat only fires when
     the `chat` or `id` option changes) -- the `transport` object built here
     is therefore only ever read on the FIRST render. Putting
     `conversationId` into DefaultChatTransport's own `body` option (as an
     earlier version of this file did) silently froze it at `undefined`
     forever: every turn after the first would omit it and the server would
     mint a brand-new conversation each time. `sendMessage`'s per-call
     `options.body` (in handleSendMessage below) is merged into the request
     body per-request instead, at the version of `conversationId` current on
     the render that calls it -- through the *same* long-lived transport --
     avoiding both the staleness bug and the churn/message-reset (`id in
     options` triggers a fresh Chat with reset UI messages) that swapping
     `id: conversationId` into useChat's options would cause. */
  const {
    messages: aiMessages,
    setMessages: setSectionMessages,
    sendMessage,
    status: chatStatus,
    error: chatError,
    regenerate: regenerateChat,
    // #274: a client-side escape hatch for a turn that's merely slow, not
    // yet timed out (chat.ts's own STREAM_TIMEOUT_MS bounds the server
    // side) -- aliased since both useChat instances below would otherwise
    // collide on the name `stop`.
    stop: stopChat,
  } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      fetch: chatFetch,
      prepareSendMessagesRequest,
    }),
    // #277: the AI SDK's own re-render throttle, previously unused. Without
    // it useChat re-renders this component once per streamed chunk -- a rate
    // set by the model's token stream, not by anything the UI needs. At 16ms
    // the text still reads as continuously typed while the cap holds
    // re-renders to roughly one animation frame.
    experimental_throttle: STREAM_THROTTLE_MS,
  });

  // #317 review, #352: the id of the assistant message on screen at the
  // moment Stop was pressed, if any -- threaded into buildMessageData
  // below so that ONE turn (never a later one) gets the "wasn't saved"
  // note instead of silently reading as an ordinary complete reply. Set by
  // handleStopSectionChat (wraps stopChat below, passed to ConversationView
  // as onStop instead of stopChat directly); cleared the moment a new send
  // starts (handleSendMessage) so a stale note doesn't linger onto a later
  // turn that has nothing to do with the one that got stopped.
  const [sectionStoppedMessageId, setSectionStoppedMessageId] = useState<string | null>(null);
  const handleStopSectionChat = () => {
    const last = aiMessages[aiMessages.length - 1];
    if (last?.role === "assistant") setSectionStoppedMessageId(last.id);
    stopChat();
  };

  const {
    sections,
    setSections,
    sectionMetaByOrder,
    setSectionMetaByOrder,
    hwTitle,
    courseId,
    loading: homeworkLoading,
    loadError,
  } = useStudentHomework();

  // #271: mirrors sectionMetaByOrder for chatFetch's closure above, which is
  // captured once at mount and would otherwise never see updates.
  const sectionMetaByOrderRef = useRef(sectionMetaByOrder);
  useEffect(() => {
    sectionMetaByOrderRef.current = sectionMetaByOrder;
  }, [sectionMetaByOrder]);

  /* #4: the tutor-conversations rail. Undefined = the homework section chat
     is showing (default); set = the selected/created tutor conversation is
     showing instead. Selecting a homework section (handleSectionSelect
     below) switches back. No separate "activeSurface" enum is needed --
     this one nullable id fully determines which surface is active. */
  const [tutorConversationId, setTutorConversationId] = useState<string | undefined>(undefined);

  /* #4 fix-round: seeds the tutor Chat instance's message list whenever
     tutorConversationId changes (see selectTutorConversation below) --
     empty for a brand-new conversation, or the persisted history for an
     existing one. This is NOT just cosmetic: chatHandler (chat.ts) builds
     the model's context via convertToModelMessages(uiMessages) over
     exactly the array the client sends on each turn, so if this stayed
     empty on resume, the LLM would receive zero prior context and respond
     as if the conversation were brand new -- a real functional break code
     review caught, not merely "the UI hasn't caught up visually." */
  const [tutorInitialMessages, setTutorInitialMessages] = useState<UIMessage[]>([]);

  /* A second, independent Chat instance for tutor conversations -- NOT the
     same instance the homework-section chat above uses. Deliberately keyed
     by `id: tutorConversationId` (the opposite of the section chat's own
     choice, see the useChat comment above): every tutor turn already knows
     its conversationId upfront (TutorConversationsList only lets you send
     into a conversation you've selected or just created, both of which
     return an id before any message is sent), so there's no
     undefined-then-set staleness window here for `id` to corrupt -- and
     `id` changing (switching to a different tutor conversation, or back to
     none) is exactly when we DO want useChat to reset and reseed from
     `messages: tutorInitialMessages` -- selectTutorConversation below
     always updates both together in the same event handler (batched into
     one render), so the freshly fetched history is already in state by the
     time `id` changes and useChat recreates its Chat instance off it. Plain
     `fetch` (not the section chat's chatFetch wrapper): that wrapper writes
     into the *section* chat's conversationId state, which would corrupt it
     if reused here. */
  const {
    messages: tutorAiMessages,
    sendMessage: sendTutorMessage,
    status: tutorChatStatus,
    error: tutorChatError,
    regenerate: regenerateTutorChat,
    // #274: see stopChat's own doc comment above -- same escape hatch, this
    // instance's own turn.
    stop: stopTutorChat,
  } = useChat({
    id: tutorConversationId,
    messages: tutorInitialMessages,
    transport: new DefaultChatTransport({ api: "/api/chat", prepareSendMessagesRequest }),
    // #277: same reasoning as the section instance above.
    experimental_throttle: STREAM_THROTTLE_MS,
  });

  // #317 review, #352: same reasoning as sectionStoppedMessageId above.
  // Also reset on tutorConversationId change (switching conversations, or
  // to none) -- useChat itself resets aiMessages there (its `id` changed),
  // so a stale stopped-id from a previous conversation must not survive
  // into this one's first render.
  const [tutorStoppedMessageId, setTutorStoppedMessageId] = useState<string | null>(null);
  useEffect(() => {
    setTutorStoppedMessageId(null);
  }, [tutorConversationId]);
  const handleStopTutorChat = () => {
    const last = tutorAiMessages[tutorAiMessages.length - 1];
    if (last?.role === "assistant") setTutorStoppedMessageId(last.id);
    stopTutorChat();
  };

  /* #4 fix-round 2: tracks whichever tutor-surface switch was requested
     most recently -- a target conversation id, or undefined when the
     student switched away entirely (handleSectionSelect below). Written
     synchronously at the START of every switch (selectTutorConversation,
     and handleSelectExistingTutorConversation before its await), so it's
     always current the instant a new request is made, regardless of
     whether an earlier request's fetch is still in flight. Read back after
     handleSelectExistingTutorConversation's await resolves to detect
     whether that fetch has since been superseded (see below) -- a plain
     ref, not state, because it must be readable synchronously inside an
     async callback without waiting on a re-render. */
  const latestTutorSelectionRef = useRef<string | undefined>(undefined);

  /* #235: which tutor conversation (if any) was just created this session,
     so the chat column can autofocus its composer once on mount -- a
     keyboard user should land where the visual focus implicitly went
     (the chat column switched to the new conversation) instead of needing
     an extra Tab. Cleared on every OTHER way of changing the active tutor
     conversation, so returning to a created conversation via the rail
     later doesn't re-steal focus. */
  const [justCreatedTutorConversationId, setJustCreatedTutorConversationId] = useState<string | undefined>(
    undefined,
  );

  /* #290: the conversation whose history is currently being fetched, if any.
     Exists purely so the rail can show that the click registered -- the row
     renders selected and aria-busy while this is set. Deliberately NOT used
     to move focus into the chat column: a student clicking through the rail
     is browsing, and a focus jump would fight that. The announcement below
     is the right affordance. */
  const [pendingTutorSelectionId, setPendingTutorSelectionId] = useState<string | undefined>(undefined);

  // #276: set when a tutor conversation's history fetch fails -- rendered
  // through ConversationView's existing error row (see tutorChatErrorRow
  // below) with a Retry that re-runs the fetch, and disables the composer
  // while set (see isSending below) so a message can't be sent assuming a
  // switch succeeded when it didn't.
  const [tutorHydrationError, setTutorHydrationError] = useState<{ message: string; onRetry: () => void } | null>(
    null,
  );

  // #276: same shape as tutorHydrationError above, for the section chat's
  // own hydration path (loadSectionConversation below).
  const [sectionHydrationError, setSectionHydrationError] = useState<{ message: string; onRetry: () => void } | null>(
    null,
  );

  // #280: true when fetchConversationHistory's page came back full (the
  // messages route pages at 200, no load-more wired yet -- see that
  // function's own doc comment) -- the ceiling made visible instead of
  // silent, mirroring tutorConversationsHasMore's role for the rail list.
  // One flag per surface since tutor/section hydrate independently and
  // (rarely, but possibly) their most recent fetches could disagree.
  const [tutorHistoryHasMore, setTutorHistoryHasMore] = useState(false);
  const [sectionHistoryHasMore, setSectionHistoryHasMore] = useState(false);

  /* #4/#6, lifted here per #223: one useTutorConversations instance shared
     by the rail (TutorConversationsList, now presentational -- it takes
     `conversations`/etc. as props) and this chat column's header, instead
     of the rail owning it privately and handing the parent a rename
     function + a "selected conversation changed" callback through two refs
     and two effects. That ref-handoff was the actual root cause of #223's
     finding: `onSelectedConversationChange`/`onRenameHandlerReady` were new
     function identities every App render, so both of TutorConversationsList's
     effects re-ran on every render, including every streamed token. Lifting
     the hook removes both effects entirely -- the header title below is now
     just a derived read of `tutorConversations`, the same array the rail
     renders from, so it can never drift out of sync with the list row. */
  const {
    conversations: tutorConversations,
    loading: tutorConversationsLoading,
    awaitingCourseContext: tutorConversationsAwaitingCourse,
    loadError: tutorConversationsLoadError,
    hasMore: tutorConversationsHasMore,
    refetch: refetchTutorConversations,
    createConversation: createTutorConversationRow,
    renameConversation: renameTutorConversationRow,
    bumpConversation: bumpTutorConversation,
  } = useTutorConversations(courseId);

  const tutorConversationTitle = tutorConversations.find((c) => c.id === tutorConversationId)?.title;

  const handleRenameTutorConversation = async (newTitle: string) => {
    if (!tutorConversationId) return;
    await renameTutorConversationRow(tutorConversationId, newTitle);
  };

  /* #4 fix-round: the single place that switches the tutor surface to a
     given conversation, always setting its seed messages in the same
     event-handler pass as its id (React batches both into one commit, so
     useChat's `id` change and its `messages` seed are never torn apart
     across renders -- see the useChat comment above). `initialMessages`
     defaults to [] for the "just created, definitely empty" case
     (onConversationCreated below); handleSelectExistingTutorConversation
     fetches real history before calling this for the "picked an existing
     row" case. Also stamps latestTutorSelectionRef -- every switch, sync
     or async, funnels through here, so this is the one place that needs to
     mark "this is now the latest requested switch." */
  const selectTutorConversation = (id: string, initialMessages: UIMessage[] = []) => {
    latestTutorSelectionRef.current = id;
    /* #398: reaching here means a conversation is now current, so nothing
       is pending any more. This is the choke point for every "a different
       conversation became current" path -- notably creating one while
       another is still loading, which otherwise left the abandoned row
       busy and unselectable forever.

       Harmless for the ordinary selection path, which calls this with the
       id that was pending and would clear the same marker a moment later
       in its own `finally`. */
    setPendingTutorSelectionId(undefined);
    setTutorInitialMessages(initialMessages);
    setTutorConversationId(id);
  };

  /* #4 fix-round: TutorConversationsList's onSelectConversation -- fetches
     that conversation's persisted history (GET /api/conversations/:id/messages,
     added this fix-round) before switching the chat column to it, so the
     LLM's context on the next turn actually includes the prior exchange,
     not just the UI. A no-op re-fetch guard: re-selecting the
     already-active conversation (e.g. a stray double-click) skips the
     round-trip -- its messages are already showing correctly. Fails open to
     an empty thread (not a thrown error) on a failed fetch, matching this
     file's existing minimal-error-surface convention (see handleSubmit's
     catch below) -- the student can still send a new message into the
     right conversationId even if history hydration itself failed.

     #4 fix-round 2: stale-response guard. The pre-fetch `id ===
     tutorConversationId` check only rules out re-selecting the conversation
     already showing -- it says nothing about a SECOND selection made while
     THIS fetch is still in flight (student clicks conversation A, then B,
     before A's /messages response lands). Without a post-await recheck,
     whichever response resolves last would win regardless of click order,
     silently reverting the UI to a conversation the student already
     navigated away from. Fixed by stamping latestTutorSelectionRef.current
     = id synchronously before the fetch starts (so a later call -- to this
     function again, or to selectTutorConversation directly via "New
     conversation," or to undefined via handleSectionSelect -- immediately
     overwrites it), then rechecking it still equals `id` once the await
     resolves: a mismatch means a newer selection superseded this one while
     it was in flight, so this (now-stale) response is discarded instead of
     applied. */
  // #252: shared by both hydration paths below (the tutor selection path
  // here, and the section-chat mount/switch path further down) -- fetches a
  // conversation's persisted history and parses it against the wire
  // contract. What happens with the result (which useChat instance it
  // seeds, which staleness ref guards it) differs per caller, so only the
  // fetch+parse step itself is shared.
  //
  // #226: parsed against the actual wire contract (ConversationMessageResponse),
  // not asserted straight to UIMessage[] -- the server's `parts` column is
  // jsonb (genuinely `unknown` at this boundary, same as chat.ts's own
  // replayPersistedPart treats it), so that one field still needs an inner
  // cast; every other field is now the checked DTO shape rather than a
  // blind assertion across the whole array.
  //
  // #280: `limit` is requested explicitly (matching, not relying on, the
  // route's own DEFAULT_MESSAGES_PAGE_SIZE) so this function knows for
  // certain whether a full page means "there might be more" -- a length
  // that happens to equal an unstated server default would be a coincidence
  // to key off of, not a real signal. Older messages beyond this page
  // aren't fetched (a real prepend-on-scroll isn't wired yet); `hasMore`
  // lets the caller show that ceiling instead of leaving it silent.
  const MESSAGES_HISTORY_LIMIT = 200;
  const fetchConversationHistory = async (id: string): Promise<{ messages: UIMessage[]; hasMore: boolean }> => {
    const res = await fetch(`/api/conversations/${id}/messages?limit=${MESSAGES_HISTORY_LIMIT}`);
    if (!res.ok) throw new Error(`failed to load conversation history: ${res.status}`);
    const rows = (await res.json()) as ConversationMessageResponse[];
    return {
      /* #397: createdAt was being dropped here. The server has always sent it
         per message (routes/sectionConversations.ts), and the transcript now
         shows a per-turn time, so it rides along on the UIMessage metadata
         rather than needing a second fetch. */
      messages: rows.map((r) => ({
        id: r.id,
        role: r.role,
        parts: r.parts as UIMessage["parts"],
        metadata: { createdAt: r.createdAt },
      })),
      hasMore: rows.length === MESSAGES_HISTORY_LIMIT,
    };
  };

  // #276: a failed fetch used to switch the surface AND clear the message
  // list (selectTutorConversation(id, [])) with no error and nothing
  // disabled -- an empty thread beside a rail row that still shows a
  // non-zero message count, with the composer fully live to send a
  // context-free turn into the real conversation. The surface still
  // switches (the error needs somewhere to render, and ConversationView
  // only mounts for the currently-selected id) but now carries
  // tutorHydrationError alongside the empty seed: rendered as a retryable
  // error row (tutorChatErrorRow below) and disables the composer (see
  // isSending below) until Retry succeeds.
  const handleSelectExistingTutorConversation = async (id: string) => {
    if (id === tutorConversationId) return;
    // #290: a repeat click on a row that is already loading is now a genuine
    // no-op. The guard above only ruled out re-selecting the ALREADY-ACTIVE
    // conversation, so clicking an unresponsive row again -- the natural
    // response to no feedback -- fired a second identical fetch. The
    // stale-response guard below discarded the loser correctly, so this was
    // never a correctness bug; it was wasted work that the feedback gap made
    // likely to happen.
    if (id === pendingTutorSelectionId) return;
    latestTutorSelectionRef.current = id;
    // #290: set SYNCHRONOUSLY, before the await. Nothing on screen used to
    // change between the click and the response landing -- no row highlight,
    // no aria-current move, no chat-column change -- because every visible
    // piece of state derives from `tutorConversationId`, which is not
    // assigned until `selectTutorConversation` runs. For a conversation at
    // the 200-message cap that is a multi-hundred-millisecond to
    // multi-second dead zone in which the UI is indistinguishable from
    // broken.
    setPendingTutorSelectionId(id);
    setJustCreatedTutorConversationId(undefined);
    try {
      const history = await fetchConversationHistory(id);
      if (latestTutorSelectionRef.current !== id) return; // superseded while in flight -- discard
      setTutorHydrationError(null);
      setTutorHistoryHasMore(history.hasMore);
      selectTutorConversation(id, history.messages);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[App] tutor conversation history fetch failed", err);
      if (latestTutorSelectionRef.current !== id) return; // superseded while in flight -- discard
      setTutorHydrationError({
        message: "Couldn't load that conversation. Please try again.",
        onRetry: () => void handleSelectExistingTutorConversation(id),
      });
      setTutorHistoryHasMore(false);
      selectTutorConversation(id, []);
    } finally {
      /* #398: clear only when this request is still the current one -- a
         superseded fetch resolving late must not clear a marker belonging
         to the selection that replaced it.

         The bug this used to have: when nothing replaced it either (the
         student navigated to a homework section, or created a conversation,
         so the ref went to undefined rather than to another id), NOBODY
         cleared it. The row stayed aria-busy forever, and the repeat-click
         guard at the top of this function then refused to reselect it --
         permanently, until reload.

         `setPendingTutorSelectionId(undefined)` moved to the places that
         supersede a selection, so every path that changes
         latestTutorSelectionRef also owns the marker. This branch now only
         handles "my own request finished and I am still current". */
      if (latestTutorSelectionRef.current === id) setPendingTutorSelectionId(undefined);
    }
  };

  /* #4: TutorConversationsList's "New conversation" button -- lifted here
     (#223) alongside the useTutorConversations instance it used to own
     privately. Returns whether it succeeded so the rail can surface a
     failure itself (#235) instead of the button silently doing nothing. */
  const handleCreateTutorConversation = async (): Promise<boolean> => {
    const created = await createTutorConversationRow();
    if (!created) return false;
    selectTutorConversation(created.id);
    setJustCreatedTutorConversationId(created.id);
    return true;
  };
  // #160: was hardcoded to 3 regardless of what actually loaded -- a
  // homework with fewer than 3 sections left this pointing at a section
  // that doesn't exist. Starts at 1 (the Sidebar's own placeholder-free
  // default) and snaps to the first real section's number once the fetch
  // resolves; the ref guards against re-snapping after the student has
  // already navigated to a different section.
  const [currentSection, setCurrentSection] = useState(1);
  const hasAutoSelectedSection = useRef(false);

  // #271: mirrors currentSection for chatFetch's closure above (see that
  // function's own doc comment for why a ref, not the state itself).
  const currentSectionRef = useRef(currentSection);
  useEffect(() => {
    currentSectionRef.current = currentSection;
  }, [currentSection]);

  /* #252: tracks whichever section-conversation load was requested most
     recently -- the same staleness-guard shape latestTutorSelectionRef
     gives the tutor rail (see that ref's own doc comment above), applied to
     the section chat's mount/switch path: a section switch mid-fetch has
     the identical overlapping-request race. Keyed by conversationId (not
     section number) since that's what identifies which fetch is "this
     one" -- undefined is a valid target (a section with no conversation
     yet), distinct from "no load in flight." */
  const latestSectionConversationRef = useRef<string | undefined>(undefined);

  // #272: set by chatFetch above when a turn just created a section's FIRST
  // conversation -- the conversationId to re-hydrate from once this turn's
  // stream finishes (see the effect right after loadSectionConversation
  // below for why it waits rather than firing immediately).
  const pendingGreetingConversationIdRef = useRef<string | undefined>(undefined);

  /* #252: the section chat's own version of handleSelectExistingTutorConversation
     -- previously `setConversationId` was called directly (mount effect
     below) or via handleSectionSelect with no hydration at all, so a
     returning student's `useChat` stayed empty while the server kept
     appending to their real, existing conversation: the model received
     zero prior context on every reload, and the persisted transcript grew
     silent gaps the model was never shown. `setSectionMessages` (the
     section useChat instance's own setter -- it has no `id` to key a
     remount off, unlike the tutor instance) is how the fetched history
     actually gets applied.

     #276: a failed fetch used to fail OPEN -- clear the message list to
     `[]` and otherwise say nothing, so the next thing the student typed
     went to the model with zero context and got persisted into their real
     conversation, reinstating exactly what the paragraph above says #252
     already fixed. Now fails closed: the message list is left as whatever
     it already was (not cleared), a retryable error is surfaced via
     sectionHydrationError (rendered through ConversationView's existing
     error row, same as a chat-stream error), and the composer is disabled
     while it's set (see isSending below) so a context-free turn can't be
     sent into the real conversation while hydration is broken. */
  /* #318: a fresh section (no conversation yet) used to render an empty
     composer until the student's own first message lazily created the
     conversation server-side (chat.ts's resolveConversation) -- the
     canonical greeting (#27's sectionGreeting, which opens on the section's
     own title and problem statement) never appeared until AFTER that first
     turn, bundled with the
     model's reply to it. This calls the same start endpoint chatHandler
     already uses internally, eagerly, so the greeting shows the moment the
     student opens the section -- ordinary chat UX. Guarded by
     currentSectionRef rather than latestSectionConversationRef: the latter
     can't tell two different never-started sections apart (both target
     `undefined`), so a fast section switch mid-request would otherwise let
     a stale response land on whichever section is now showing. */
  const startFreshSectionConversation = async (sectionNumber: number, sectionId: string) => {
    if (!courseId) return;
    try {
      const res = await fetch(`/api/courses/${courseId}/sections/${sectionId}/conversations`, { method: "POST" });
      if (currentSectionRef.current !== sectionNumber) return; // superseded -- discard
      if (!res.ok) {
        // 409 covers both "already exists" (a race with another request for
        // the same section) and "section isn't interactive" (#164) -- either
        // way there's nothing to eagerly show. The composer stays empty and
        // the student's own first message still creates/finds the
        // conversation via chat.ts's existing lazy path, same as before
        // this fix.
        return;
      }
      const created = (await res.json()) as { id: string; greetingMessageId: string; greetingParts: unknown };
      setConversationId(created.id);
      latestSectionConversationRef.current = created.id;
      setSectionMessages([
        { id: created.greetingMessageId, role: "assistant", parts: created.greetingParts as UIMessage["parts"] },
      ]);
      setSectionMetaByOrder((prev) => {
        const prevMeta = prev.get(sectionNumber);
        if (!prevMeta) return prev;
        const next = new Map(prev);
        next.set(sectionNumber, { ...prevMeta, conversationId: created.id });
        return next;
      });
      // Matches confirmRestart's own status update below -- a section with
      // an active conversation is "current" (the sidebar's in-progress dot),
      // not "pending" (not_started). Without this, the dot stays stale until
      // a full reload re-derives status from the server.
      setSections((prev) =>
        prev.map((s) => (s.number === sectionNumber ? { ...s, status: "current" as const } : s)),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[App] failed to eagerly start section conversation", err);
      // Left as the empty state loadSectionConversation already set -- not
      // surfaced as sectionHydrationError (which disables the composer):
      // the student can still type, and chat.ts creates the same
      // conversation lazily on send, same as before this fix.
    }
  };

  const loadSectionConversation = async (
    sectionNumber: number,
    targetConversationId: string | undefined,
    sectionId?: string,
  ) => {
    setCurrentSection(sectionNumber);
    setConversationId(targetConversationId);
    latestSectionConversationRef.current = targetConversationId;
    setSectionHydrationError(null);
    if (!targetConversationId) {
      setSectionMessages([]);
      setSectionHistoryHasMore(false);
      if (sectionId) void startFreshSectionConversation(sectionNumber, sectionId);
      return;
    }
    try {
      const history = await fetchConversationHistory(targetConversationId);
      if (latestSectionConversationRef.current !== targetConversationId) return; // superseded -- discard
      setSectionMessages(history.messages);
      setSectionHistoryHasMore(history.hasMore);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[App] section conversation history fetch failed", err);
      if (latestSectionConversationRef.current !== targetConversationId) return; // superseded -- discard
      setSectionHydrationError({
        message: "Couldn't load this section's conversation. Please try again.",
        onRetry: () => void loadSectionConversation(sectionNumber, targetConversationId, sectionId),
      });
    }
  };

  // #272: fires the greeting re-hydration chatFetch queued above, but only
  // once this turn's stream has fully finished (chatStatus back to
  // "ready") -- setSectionMessages replaces the whole array, and calling it
  // while useChat is still appending streamed tokens to the in-progress
  // assistant reply would race with (and could visibly clobber) that
  // render. Once fired, the re-fetched history is the authoritative
  // [greeting, student's message, reply] triple a reload would also show.
  useEffect(() => {
    const pendingId = pendingGreetingConversationIdRef.current;
    if (!pendingId || pendingId !== conversationId || chatStatus !== "ready") return;
    pendingGreetingConversationIdRef.current = undefined;
    void (async () => {
      try {
        const history = await fetchConversationHistory(pendingId);
        if (latestSectionConversationRef.current === pendingId) {
          setSectionMessages(history.messages);
          setSectionHistoryHasMore(history.hasMore);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[App] failed to hydrate section greeting after creation", err);
      }
    })();
  }, [chatStatus, conversationId]);

  useEffect(() => {
    if (!hasAutoSelectedSection.current && sections.length > 0) {
      const first = sections[0]!.number;
      // #214/#252: resume the section's own conversation if it already has
      // one (a returning student), rather than always starting
      // `conversationId` at undefined regardless of prior progress --
      // sectionMetaByOrder carries the same conversationId
      // StudentSectionProgress already returns, just not dropped the way
      // SidebarSection's mapping drops it -- and hydrate its history so the
      // model (and the visible transcript) actually sees it, not just the
      // id.
      void loadSectionConversation(
        first,
        sectionMetaByOrder.get(first)?.conversationId ?? undefined,
        sectionMetaByOrder.get(first)?.id,
      );
      hasAutoSelectedSection.current = true;
    }
  }, [sections, sectionMetaByOrder]);
  /* #80: real hint usage, replacing the #20 fixture (which incremented
     unconditionally on every message send -- see handleSendMessage's own
     #80 note below). Fetched from GET .../hints for the active section
     whenever it changes, and again once an in-flight hint request settles
     (the effect below, keyed on chatStatus). `hintLimit` is null when the
     section has no configured budget (unlimited by default -- see
     hintBudgets' own doc comment, db/schema/content.ts) -- Sidebar itself
     has no "limit" concept yet (out of scope for this task, see its own
     hintCount prop), so only the Composer's disabled state reads it.
     A fetch failure degrades to "0 used, no known limit" rather than
     throwing -- same posture as useStudentHomework's own .catch() above,
     since a stale count is cosmetic, not blocking. */
  const [hintCount, setHintCount] = useState(0);
  const [hintLimit, setHintLimit] = useState<number | null>(null);
  const currentSectionId = sectionMetaByOrder.get(currentSection)?.id;
  const refetchHintCount = useCallback(() => {
    if (!courseId || !currentSectionId) return;
    fetch(`/api/courses/${courseId}/sections/${currentSectionId}/hints`)
      .then((r) => {
        if (!r.ok) throw new Error(`failed to load hint count: ${r.status}`);
        return r.json() as Promise<HintCountResponse>;
      })
      .then((data) => {
        setHintCount(data.count);
        setHintLimit(data.limit);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[App] failed to load hint count", err);
      });
  }, [courseId, currentSectionId]);
  useEffect(() => {
    refetchHintCount();
  }, [refetchHintCount]);
  /* Set by handleSendMessage the moment a hint-flagged turn is sent;
     consumed the next time chatStatus settles back to "ready"/"error" (a
     turn is genuinely done, granted or not) to refetch the real count --
     this is the "on hint request" half of the staleness fix the #20
     fixture never needed (Sidebar hint count staleness pitfall, issue
     #80). A ref, not state: it's read/written only inside effects/
     handlers, never rendered off of directly. */
  const hintRequestPendingRef = useRef(false);
  useEffect(() => {
    if (hintRequestPendingRef.current && chatStatus !== "submitted" && chatStatus !== "streaming") {
      hintRequestPendingRef.current = false;
      refetchHintCount();
    }
  }, [chatStatus, refetchHintCount]);
  const [justSubmittedSection, setJustSubmittedSection] = useState<number | null>(null);
  /* #248: restart-affordance dialog state for the section chat. `restarting`
     keeps the dialog open through the request (rather than closing
     optimistically) so a 409 (graded submission -- see
     SubmissionGradedError, sectionConversations.ts) can be shown inline
     instead of silently failing after the dialog already closed; per the
     design decision on #248, the client does not try to predict this
     state ahead of time (no separate "is this section graded" fetch) --
     the restart endpoint is the single source of truth for it. */
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  /* Sidebar collapse persists across reloads via localStorage. Lazy initializer
     reads on first render; the effect below writes whenever the state changes. */
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
    } catch {
      /* Private mode / disabled storage — fall back to default expanded state */
      return false;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(isSidebarCollapsed));
    } catch {
      /* localStorage may throw (private mode quota, etc.) — silently ignore */
    }
  }, [isSidebarCollapsed]);

  /* #4: the tutor rail's own collapse preference -- same lazy-init-then-
     write-effect pattern as the homework sidebar above, distinct key. */
  const [isTutorSidebarCollapsed, setIsTutorSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(TUTOR_SIDEBAR_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(TUTOR_SIDEBAR_COLLAPSED_KEY, String(isTutorSidebarCollapsed));
    } catch {
      /* localStorage may throw (private mode quota, etc.) — silently ignore */
    }
  }, [isTutorSidebarCollapsed]);

  /* #28: one shared useRExecution -- and therefore one shared WebR
     singleton (see useWebR.ts's own doc comment) -- for both chat
     surfaces. `messages`/`tutorMessages` (which need `runRCode` threaded
     into buildMessageData) are computed further down, after
     handleSendMessage/handleSendTutorMessage exist: running a STUDENT'S
     OWN code auto-shares the result back into whichever conversation it
     came from (runRCodeForSection/runRCodeForTutor below), which reuses
     those handlers rather than duplicating their conversationId/courseId
     plumbing. */
  const { run: runRCode } = useRExecution();

  /* #144: inline retryable error rows for ConversationView, one per useChat
     instance. `regenerate` re-issues the last turn's request through the
     SAME transport, so it needs the same per-call `body` as sendMessage
     (see the useChat comment above) -- without it, a retry after the
     conversation was already created would omit conversationId and the
     server would mint a second, unrelated conversation. Only shown when
     status is actually "error" (not just "error object happens to be set" --
     AI SDK v5 clears status but may leave a stale error reference on some
     paths, so status is the source of truth here, matching how chatStatus
     already gates the composer's disabled state below). */
  // #276: a hydration failure takes priority over a chat-stream error --
  // it's the more fundamental problem (the composer is disabled either way
  // while it's set, see isSending below), and regenerateChat's retry
  // wouldn't even be reachable in a useful state without history loaded.
  const sectionChatErrorRow =
    sectionHydrationError ??
    (chatStatus === "error"
      ? {
          message: chatError?.message || "Something went wrong. Please try again.",
          onRetry: () =>
            regenerateChat({
              body: conversationId
                ? { conversationId }
                : { courseId, kind: "section" as const, sectionId: sectionMetaByOrder.get(currentSection)?.id },
            }),
        }
      : null);
  const tutorChatErrorRow =
    tutorHydrationError ??
    (tutorChatStatus === "error"
      ? {
          message: tutorChatError?.message || "Something went wrong. Please try again.",
          onRetry: () =>
            regenerateTutorChat({ body: tutorConversationId ? { conversationId: tutorConversationId } : {} }),
        }
      : null);

  /* #216: bumps the rail row's messageCount/updatedAt (and re-sorts it to
     the top) the moment a tutor turn finishes -- /api/chat writes bypass
     useTutorConversations entirely, so without this the rail kept showing
     a conversation's original creation timestamp and a stuck messageCount
     of 0 for the entire session. Fires on the submitted/streaming -> ready
     transition specifically (not on every render where status happens to
     be "ready"), via a ref tracking the previous status -- an "error"
     transition deliberately does not bump (no new message was actually
     persisted, see chat.ts's hasRenderableContent-gated onFinish). */
  const prevTutorChatStatusRef = useRef(tutorChatStatus);
  useEffect(() => {
    const previousStatus = prevTutorChatStatusRef.current;
    prevTutorChatStatusRef.current = tutorChatStatus;
    const wasInFlight = previousStatus === "submitted" || previousStatus === "streaming";
    if (tutorConversationId && wasInFlight && tutorChatStatus === "ready") {
      bumpTutorConversation(tutorConversationId);
    }
  }, [tutorChatStatus, tutorConversationId, bumpTutorConversation]);

  const handleSendMessage = (text: string, options?: { isHintRequest?: boolean }) => {
    /* #144: AI SDK v5's Chat#sendMessage has no internal guard against
       being called while a previous turn is still in flight -- it just
       pushes another message and starts another request. Composer's own
       `disabled` (wired via ConversationView's `isSending` below) already
       prevents this from typing + Enter, but this handler is guarded
       independently too -- cheap insurance against any other caller
       (future keyboard shortcut, programmatic resend, etc.) that doesn't
       go through the composer.

       #144: "error" is deliberately NOT
       blocked here (unlike "submitted"/"streaming") -- useChat's own
       makeRequest() unconditionally resets status to "submitted" and
       clears `error` the moment a new message is sent (verified in
       @ai-sdk/react's Chat class), so sending a fresh message is a safe
       and correct way to move past a failed turn. Blocking it too would
       leave the section chat (this useChat instance has no `id`, unlike
       the tutor chat, so nothing else ever resets it) permanently stuck
       once errored, with Retry as the only way out -- and Retry replays
       the exact same request that just failed. */
    if (chatStatus === "submitted" || chatStatus === "streaming") return;
    /* conversationId flows per-call (not via the transport's own `body`,
       see the useChat comment above) so each turn after the first actually
       carries whatever the previous turn's x-conversation-id response
       header set -- letting the server continue the same conversation
       instead of minting a new one on every message.

       #214: when there's no conversationId yet (this section's first
       turn), kind: "section" + the section's real id tell chatHandler to
       create a kind:"section" conversation instead of defaulting to
       kind:"tutor" -- previously omitted entirely, so every section's
       first-ever turn minted a tutor-rail row indistinguishable from an
       actual tutor conversation. */
    const currentSectionMeta = sectionMetaByOrder.get(currentSection);
    /* #80: server-authoritative grant/deny -- see chat.ts's own
       isHintRequest handling. This flag only REQUESTS the server treat this
       turn as a hint; it grants nothing by itself. hintRequestPendingRef,
       consumed by the useEffect right below, is what turns "this turn
       settled" into "refetch the real count" -- replacing the #20 fixture's
       unconditional per-message increment (every send used to bump
       hintCount regardless of whether anything hint-shaped happened). */
    if (options?.isHintRequest) hintRequestPendingRef.current = true;
    sendMessage(
      { text },
      {
        body: {
          ...(conversationId
            ? { conversationId }
            : { courseId, kind: "section" as const, sectionId: currentSectionMeta?.id }),
          ...(options?.isHintRequest ? { isHintRequest: true } : {}),
        },
      },
    );
    // #317 review, #352: a fresh send starts a new turn -- any stopped-note
    // from a PRIOR turn must not linger onto it.
    setSectionStoppedMessageId(null);
  };

  /* #80: "Give me a hint" -- sends a fixed, clearly-labeled request through
     the SAME pipeline as a typed message (handleSendMessage above), flagged
     so the server treats it as a hint. Deliberately NOT a separate code
     path or a direct fetch to a hint endpoint: the model still needs a
     concrete turn to respond to, and reusing handleSendMessage keeps the
     conversationId/section plumbing, the in-flight guard, and the
     stopped-note reset all in exactly one place. */
  const HINT_REQUEST_MESSAGE = "Give me a hint for this section, please.";
  const handleRequestHint = () => {
    handleSendMessage(HINT_REQUEST_MESSAGE, { isHintRequest: true });
  };

  /* #4: sends into whichever tutor conversation is currently selected.
     Guarded (rather than trusted) even though the composer that calls this
     is only reachable once tutorConversationId is set -- cheap insurance
     against a future caller wiring the tutor composer up before selection.
     #144: guarded on tutorChatStatus for the same reason, and with the
     same "error" is not "in flight" carve-out, as handleSendMessage
     above. */
  const handleSendTutorMessage = (text: string) => {
    if (!tutorConversationId) return;
    if (tutorChatStatus === "submitted" || tutorChatStatus === "streaming") return;
    sendTutorMessage({ text }, { body: { conversationId: tutorConversationId } });
    // #317 review, #352: same reasoning as handleSendMessage above.
    setTutorStoppedMessageId(null);
  };

  /* #28: after the STUDENT'S OWN code runs (a fenced ```r block in one of
     THEIR messages -- see ConversationView's onRunRCode wiring below),
     share code + result back into the same conversation as a new turn, so
     the tutor can actually discuss it (issue requirement: "Executed code +
     results replay into LLM context... so the tutor can discuss the
     student's actual output"). Reuses handleSendMessage/handleSendTutorMessage
     rather than calling sendMessage directly -- same in-flight guard, same
     conversationId/courseId/sectionId body, same hint-count/stopped-note
     bookkeeping every other send already gets.

     Deliberately NOT done for the tutor's own suggested code (executeRCode
     tool, or a fenced block in the assistant's own text) -- buildMessageData
     above wires those to the bare `runRCode` with no persistence, so
     experimenting with the tutor's example doesn't spam a new (paid) model
     turn on every click. Only code the STUDENT wrote and sent counts as
     their "actual output" worth sharing automatically.

     Known limitation: handleSendMessage/handleSendTutorMessage silently
     no-op while a turn is already in flight (#144's own guard) -- if the
     student clicks Run again before the tutor's reply to their code
     message finishes, this result is shown inline (the CodeExecution card
     still updates) but is NOT auto-shared. Not fixed here: queuing a
     pending send is real, separate scope; the student can just click Run
     again once the turn completes. */
  function formatRExecutionMessage(code: string, result: RCodeResult): string {
    const codeFence = "```r\n" + code + "\n```";
    if (result.status === "error") {
      return `I ran this R code:\n${codeFence}\nIt produced an error:\n\`\`\`\n${result.error ?? "Unknown error"}\n\`\`\``;
    }
    const output = result.output && result.output.trim() ? result.output : "(no output)";
    return `I ran this R code:\n${codeFence}\nOutput:\n\`\`\`\n${output}\n\`\`\``;
  }
  const runRCodeForSection = (code: string) =>
    runRCode(code).then((result) => {
      handleSendMessage(formatRExecutionMessage(code, result));
      return result;
    });
  const runRCodeForTutor = (code: string) =>
    runRCode(code).then((result) => {
      handleSendTutorMessage(formatRExecutionMessage(code, result));
      return result;
    });

  /* Translate AI SDK UIMessages into the design system's MessageData --
     one call per Chat instance (buildMessageData, defined above the
     component). Whichever one is showing depends on tutorConversationId.
     `runRCode` (not the persisting wrappers above) is what the TUTOR's own
     code -- an executeRCode tool call, or a fenced block in its own text --
     runs against; see runRCodeForSection's own doc comment for why that's
     deliberately the non-persisting path. */
  /* #277: memoized, and each surface independently. These were plain calls,
     so BOTH lists -- including the one not on screen -- were rebuilt from
     scratch on every render, and `useChat` re-renders this component on
     every streamed chunk. The off-screen surface's rebuild was pure waste:
     its inputs cannot change while the other surface is streaming.

     `runRCode` is stable (useRExecution returns a useCallback whose own dep,
     useWebR's ensureReady, is itself a []-dep useCallback), so it does not
     defeat these deps. The remaining inputs are exactly what buildMessageData
     reads. */
  const messages = useMemo(
    () => buildMessageData(aiMessages, chatStatus, sectionStoppedMessageId, runRCode),
    [aiMessages, chatStatus, sectionStoppedMessageId, runRCode],
  );
  const tutorMessages = useMemo(
    () => buildMessageData(tutorAiMessages, tutorChatStatus, tutorStoppedMessageId, runRCode),
    [tutorAiMessages, tutorChatStatus, tutorStoppedMessageId, runRCode],
  );

  /* Selecting a homework section always means "I want the section chat" --
     switches back out of the tutor surface if one was showing. Clears
     tutorInitialMessages too (not load-bearing -- selectTutorConversation
     always resets it before the next tutor selection anyway -- but avoids
     holding onto a stale conversation's history in memory for no reason).
     #4 fix-round 2: also marks latestTutorSelectionRef as "nothing tutor
     selected" -- otherwise a tutor-conversation /messages fetch already in
     flight when the student jumps to a homework section would still match
     its own id on resolve and incorrectly flip the surface back to a
     tutor conversation the student explicitly navigated away from. */
  const handleSectionSelect = (sectionNumber: number) => {
    // #214/#252: switch to (or clear, if this section has none yet) that
    // section's own conversationId and hydrate its history -- see
    // loadSectionConversation's doc comment above for why this must come
    // from sectionMetaByOrder rather than staying whatever the
    // previously-viewed section's conversationId was, and why the fetch
    // needs the same staleness guard the tutor rail's own selection path
    // has (a section switch has the identical overlapping-request race).
    void loadSectionConversation(
      sectionNumber,
      sectionMetaByOrder.get(sectionNumber)?.conversationId ?? undefined,
      sectionMetaByOrder.get(sectionNumber)?.id,
    );
    latestTutorSelectionRef.current = undefined;
    // #398: this supersedes any in-flight selection, so it owns the pending
    // marker too -- otherwise the row the student abandoned stays busy and
    // unselectable for the rest of the session.
    setPendingTutorSelectionId(undefined);
    setTutorConversationId(undefined);
    setTutorInitialMessages([]);
    setJustCreatedTutorConversationId(undefined);
  };

  /* Submits the section's active conversation via the real API. No existing
     generic error-surface exists in this file to reuse (workerStatus/
     workerLoading is specifically for the /api/hello ping, not a
     general-purpose error affordance) -- rather than inventing new UI for
     this one failure path, log and leave sidebar state unchanged on
     failure; this is a deliberate, minimal-scope choice, not an oversight
     (a real error affordance is a separate, cross-cutting concern beyond
     this task). */
  const handleSubmit = async (sectionNumber: number) => {
    // #271: reads sectionMetaByOrder, not sections[].conversationId (that
    // copy is gone -- see SectionMeta's own doc comment) -- this is the
    // fix for Submit going permanently inert the moment a section's first
    // turn created a conversation mid-session: previously this map was
    // never updated after the initial fetch, so a section that started
    // life with conversationId: null stayed that way here forever.
    const meta = sectionMetaByOrder.get(sectionNumber);
    if (!meta?.conversationId) return; // no active conversation yet -- nothing to submit
    // #318: eagerly starting a section's conversation (above) means
    // meta.conversationId is now populated the moment the greeting loads --
    // before this check, that made a section submittable with zero student
    // input, since the Sidebar's Submit button (packages/ui) has no content
    // gate of its own. The Submit button always targets `currentSection`
    // (Sidebar.tsx's own onClick), so `aiMessages` -- the live transcript
    // for whichever section is currently shown -- is the right thing to
    // check, not a second fetch.
    if (!aiMessages.some((m) => m.role === "user")) return;
    try {
      const res = await fetch(`/api/conversations/${meta.conversationId}/submit`, { method: "POST" });
      if (!res.ok) throw new Error("submit failed");
      /* Transition the section to submitted and trigger the gold-halo
         success animation on its ✓ indicator. The flag clears after the
         animation duration (~700ms) so the indicator settles into its
         normal submitted state. */
      setSections((prev) =>
        prev.map((s) =>
          s.number === sectionNumber ? { ...s, status: "submitted" as const } : s,
        ),
      );
      setJustSubmittedSection(sectionNumber);
      setTimeout(() => setJustSubmittedSection(null), 800);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[App] section submit failed", err);
    }
  };

  /* #248: opens the restart-confirm dialog for the section currently
     showing. Only ever called from a button that's itself only rendered
     when `conversationId` is set (see the section ConversationView render
     below) -- there is nothing to restart otherwise. */
  const openRestartDialog = () => {
    setRestartError(null);
    setRestartDialogOpen(true);
  };

  const cancelRestart = () => {
    if (restarting) return; // AlertDialog disables Cancel while confirming; belt-and-suspenders
    setRestartDialogOpen(false);
    setRestartError(null);
  };

  /* POST /api/courses/:courseId/conversations/:conversationId/restart
     (restartSectionConversationHandler, #27/#248). On success, reuses
     loadSectionConversation -- the same hydration path the initial mount
     and section-switch already go through -- rather than re-deriving the
     new conversation's greeting client-side; the server is the source of
     truth for that copy (sectionGreeting in lib/prompts.ts, #305).
     Per the #248 design decision, a graded-submission refusal (409) is not
     predicted client-side -- it's surfaced here, inline, from the
     response the server actually gave. */
  const confirmRestart = async () => {
    if (!courseId || !conversationId) return;
    setRestarting(true);
    setRestartError(null);
    try {
      const res = await fetch(`/api/courses/${courseId}/conversations/${conversationId}/restart`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setRestartError(
          body?.error ?? "Something went wrong restarting this section. Please try again.",
        );
        return;
      }
      const result = (await res.json()) as {
        conversation: { id: string; title: string };
        voidedSubmission: { id: string; submittedAt: string } | null;
      };
      const sectionNumber = currentSection;
      setSectionMetaByOrder((prev) => {
        const next = new Map(prev);
        const meta = next.get(sectionNumber);
        if (meta) next.set(sectionNumber, { ...meta, conversationId: result.conversation.id });
        return next;
      });
      setSections((prev) =>
        prev.map((s) => (s.number === sectionNumber ? { ...s, status: "current" as const } : s)),
      );
      await loadSectionConversation(sectionNumber, result.conversation.id);
      setRestartDialogOpen(false);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[App] section restart failed", err);
      setRestartError("Something went wrong restarting this section. Please try again.");
    } finally {
      setRestarting(false);
    }
  };

  /* #248: the confirm dialog's copy. Conditioned only on whether the
     current conversation has an (ungraded -- see decision 1 in the #248
     comment) submission, not on an attempt count: the schema doesn't track
     attempt history (see #250's deferral of the append-only model), so the
     copy says "your previous attempt," singular, rather than approximating
     a number it can't get right. */
  const currentSectionStatus = sections.find((s) => s.number === currentSection)?.status;
  const currentSectionTitle = sections.find((s) => s.number === currentSection)?.title;
  const restartDescription = (
    <>
      <p>You&apos;ll lose your conversation so far, and you won&apos;t be able to see it again.</p>
      {currentSectionStatus === "submitted" && (
        <p>Your submission for this section will be undone — you&apos;ll need to resubmit when you&apos;re ready.</p>
      )}
      {restartError && (
        <p role="alert" style={{ color: "var(--color-error)" }}>
          {restartError}
        </p>
      )}
    </>
  );

  /* Anonymous visitors get a minimal placeholder, not the fixture course
     demo below -- see UnauthenticatedHome for why this isn't the full
     branded landing page. While the session check is in flight, render
     nothing rather than flashing one state then the other. */
  if (authLoading) return null;
  if (!isAuthenticated) return <UnauthenticatedHome onLogin={login} error={authError} />;

  // #160: distinct from a genuinely empty (zero-homework) sidebar -- a
  // failed fetch must surface something rather than silently rendering the
  // same "no sections" shell a real empty state would. No richer error UI
  // exists in this app yet (matches the deliberate minimal-scope choice in
  // handleSubmit's own catch above); this is the smallest surface that
  // isn't silence.
  if (loadError) {
    return (
      <div className="page-frame">
        <TopNav
          course="STATS 311"
          term="Autumn 2026"
          homework=""
          userInitials="AC"
          isAuthenticated={isAuthenticated}
          onProfileClick={() => navigate("/profile")}
          onLogout={logout}
        />
        <div className="app-shell">
          {/* Was a bare <p role="alert"> flush against the shell's top-left
              corner -- the same unstyled-alert shape the admin console had
              before AdminNotice. Routed through the stopped-state language
              the rest of this app now uses. */}
          <HomeworkLoadError />
        </div>
      </div>
    );
  }

  return (
    <div className="page-frame">
      {/* #299: two <nav> landmarks (Sidebar, TutorConversationsList) sit
          between here and the chat column, with no content landmark for
          landmark-navigation (NVDA `D`, etc.) to reach -- this skip link is
          the standard 2.4.1 Bypass Blocks technique, jumping straight past
          both to the <main> below. Visually hidden until focused (reuses
          the existing .sr-only pattern, see styles.css's own :focus
          override next to it). */}
      <a href="#conversation-main" className="skip-link sr-only">
        Skip to conversation
      </a>
      {/* Top nav — UW Husky Purple full-bleed bar */}
      <TopNav
        course="STATS 311"
        term="Autumn 2026"
        homework={hwTitle}
        userInitials="AC"
        isAuthenticated={isAuthenticated}
        onProfileClick={() => navigate("/profile")}
        onLogout={logout}
      />

      {/* Sidebar + main row */}
      <div className="app-shell">
        {/* Left rail — homework section progress on UW Husky Purple */}
        <Sidebar
          hwNumber={1}
          hwTitle={hwTitle}
          sections={sections}
          currentSection={currentSection}
          hintCount={hintCount}
          justSubmittedSection={justSubmittedSection}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={() => setIsSidebarCollapsed((c) => !c)}
          onSectionSelect={handleSectionSelect}
          onSubmit={handleSubmit}
          workerStatus={workerStatus}
          workerLoading={workerLoading}
        />

        {/* #4: second rail — course-scoped tutor conversations. A distinct
            surface from the homework Sidebar above (see
            TutorConversationsList's doc comment for the IA decision).
            Presentational as of #223 -- conversations/loading/etc. all come
            from the useTutorConversations instance this component shares
            with the chat column's header, above. */}
        <TutorConversationsList
          courseId={courseId}
          courseContextLoading={homeworkLoading}
          conversations={tutorConversations}
          loading={tutorConversationsLoading}
          awaitingCourseContext={tutorConversationsAwaitingCourse}
          loadError={tutorConversationsLoadError}
          onRetryLoad={refetchTutorConversations}
          hasMore={tutorConversationsHasMore}
          selectedConversationId={tutorConversationId}
          pendingConversationId={pendingTutorSelectionId}
          onSelectConversation={handleSelectExistingTutorConversation}
          onCreateConversation={handleCreateTutorConversation}
          onRenameConversation={renameTutorConversationRow}
          isCollapsed={isTutorSidebarCollapsed}
          onToggleCollapse={() => setIsTutorSidebarCollapsed((c) => !c)}
        />

        {/* Main conversation column — warm paper surface. Shows the
            selected tutor conversation when one is active, otherwise the
            homework section chat (default). #144: each wrapped in its own
            ErrorBoundary (keyed to the surface/conversation showing) so a
            render throw in one contains itself to the chat column instead
            of white-screening the whole app -- the sidebar/nav stay usable,
            and switching surfaces/conversations remounts a fresh boundary
            rather than being stuck on a stale caught error. */}
        {/* #299: the one content landmark in the page -- see the skip
            link above for why. tabIndex={-1} makes it a valid target for
            that link's focus jump (an <a href="#..."> only scrolls to a
            non-focusable element, it doesn't focus it) without adding the
            <main> itself to the normal Tab order. display: contents so
            wrapping doesn't change either branch's flex-item layout inside
            .app-shell. */}
        <main id="conversation-main" tabIndex={-1} className="conversation-main">
        {tutorConversationId ? (
          <ErrorBoundary key={`tutor-${tutorConversationId}`}>
            <ConversationView
              key={tutorConversationId}
              /* #397: the top nav already spells out
                 "STATS 311 · AUTUMN 2026 · <homework>" one line above, so
                 repeating the course code here cost the first line of the
                 reading column to say nothing new. Only the surface name
                 is new information. */
              breadcrumb="TUTOR CHAT"
              title={tutorConversationTitle}
              onRenameTitle={handleRenameTutorConversation}
              messages={tutorMessages}
              onSendMessage={handleSendTutorMessage}
              onRunRCode={runRCodeForTutor}
              /* #144: "error" deliberately excluded -- see isSending's own
                 doc comment (ConversationView.tsx) for why. #276: a
                 hydration failure DOES disable sending -- unlike a chat
                 error, there's no persisted conversation state to safely
                 send a fresh turn into while it's broken. */
              isSending={tutorChatStatus === "submitted" || tutorChatStatus === "streaming" || !!tutorHydrationError}
              /* #317 review, #352 (requirement 3): isSending above also
                 covers a hydration failure, which leaves nothing for Stop
                 to stop -- isStopActionable is the narrower "a turn is
                 genuinely in flight" check, so Stop doesn't render active
                 (and stopTutorChat doesn't fire as a no-op) while the
                 composer is merely disabled for an unrelated reason. */
              isStopActionable={tutorChatStatus === "submitted" || tutorChatStatus === "streaming"}
              error={tutorChatErrorRow}
              autoFocusComposer={tutorConversationId === justCreatedTutorConversationId}
              hasMoreHistory={tutorHistoryHasMore}
              contextWindowSize={MAX_HISTORY_MESSAGES}
              onStop={handleStopTutorChat}
            />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary key="section">
            {/* #317 review, #327: keyed by section, the same reasoning the
                tutor ConversationView above already gets from
                key={tutorConversationId} -- without this, switching
                sections replaced `messages` (up to 200 rows) inside a
                STILL-MOUNTED role="log" region, so the whole hydrated
                transcript queued as node-addition announcements. Keying
                forces a remount on every section switch instead: a fresh
                live region has nothing to retroactively announce, so only
                genuine mid-conversation appends reach an AT as insertions. */}
            <ConversationView
              key={currentSection}
              /* #397: was `STATS 311 · ${hwTitle} · Section N: ...`,
                 which repeated both the course code and the homework title
                 already shown in the top nav directly above -- long enough
                 that it wrapped to two lines and pushed the transcript down.
                 The section identity is the only part the nav doesn't say. */
              breadcrumb={`Section ${currentSection}${
                currentSectionTitle ? `: ${currentSectionTitle}` : ""
              }`}
              messages={messages}
              onSendMessage={handleSendMessage}
              onRunRCode={runRCodeForSection}
              /* #80: only the homework-section chat gets a hint affordance
                 -- the free-standing tutor ConversationView above never
                 passes these two props, so it renders none (see Composer's
                 own degrade-to-nothing doc comment). */
              onRequestHint={handleRequestHint}
              hintDisabled={hintLimit !== null && hintCount >= hintLimit}
              /* #144: "error" excluded here matters most for the section
                 chat specifically -- its useChat instance has no `id`
                 (unlike the tutor chat), so nothing else ever resets it
                 out of an error state; see isSending's own doc comment.
                 #276: a hydration failure DOES disable sending -- see the
                 tutor instance's own isSending comment above. */
              isSending={chatStatus === "submitted" || chatStatus === "streaming" || !!sectionHydrationError}
              /* #317 review, #352 (requirement 3): see the tutor
                 ConversationView's own isStopActionable comment above. */
              isStopActionable={chatStatus === "submitted" || chatStatus === "streaming"}
              error={sectionChatErrorRow}
              hasMoreHistory={sectionHistoryHasMore}
              contextWindowSize={MAX_HISTORY_MESSAGES}
              onStop={handleStopSectionChat}
              /* #248: only once there's an active conversation to restart --
                 a section the student hasn't started yet has nothing for
                 the affordance to act on. */
              headerActions={
                conversationId ? (
                  /* #248 redesign: `outlined` dropped and .btn--restart added --
                     the trigger only opens the confirm dialog below, so it sits
                     quietly in the breadcrumb row's register at rest and takes
                     on full danger styling on hover/focus. variant="danger" is
                     kept as the base so the styling degrades safely. See
                     .btn--restart in packages/ui/styles.css. */
                  <Button
                    variant="danger"
                    size="sm"
                    className="btn--restart"
                    leadingIcon="↺"
                    onClick={openRestartDialog}
                  >
                    Restart section
                  </Button>
                ) : undefined
              }
            />
          </ErrorBoundary>
        )}
        </main>
      </div>

      {/* #248: restart-confirm dialog for the section chat -- see
          confirmRestart's doc comment for the request/hydration flow and
          restartDescription for the copy decision. */}
      <AlertDialog
        open={restartDialogOpen}
        title="Restart this section?"
        description={restartDescription}
        confirmLabel="Restart section"
        cancelLabel="Keep this conversation"
        onConfirm={confirmRestart}
        onCancel={cancelRestart}
        confirming={restarting}
      />
    </div>
  );
}

/** The homework-load failure state.
 *
 *  A function component rather than inline JSX so it can hold the
 *  focus-on-mount effect the other two fallbacks carry (#298). Without it,
 *  flipping `loadError` replaced the shell's contents and dropped keyboard
 *  focus to <body> with nothing announced and nowhere to land.
 *
 *  The copy deliberately does not claim reloading will fix it. `loadError` is
 *  one boolean set by a bare `.catch`, covering 401/403/503/network alike --
 *  on an expired session, reloading will not bring it back, so promising that
 *  would be the same false-reassurance defect as the boundary copy. */
function HomeworkLoadError() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="error-boundary-fallback" role="alert" tabIndex={-1} ref={ref}>
      <h1 className="error-boundary-fallback__label">Homework didn&apos;t load</h1>
      <p className="error-boundary-fallback__body">
        Your assignment couldn&apos;t be fetched. Anything you&apos;ve already submitted is
        saved. Reloading often fixes it; if it doesn&apos;t, you may need to sign in again.
      </p>
      <button
        type="button"
        className="error-boundary-fallback__retry"
        onClick={() => window.location.reload()}
      >
        Reload
        <span aria-hidden="true">→</span>
      </button>
    </div>
  );
}
