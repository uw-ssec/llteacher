import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useNavigate } from "react-router";
import { Sidebar, TopNav, ConversationView, renderToolPart, isToolPart, ErrorBoundary } from "@llteacher/ui";
import type { SidebarSection, MessageData } from "@llteacher/ui";
import { useAuth } from "./components/AuthProvider";
import { UnauthenticatedHome } from "./components/UnauthenticatedHome";
import { TutorConversationsList } from "./views/TutorConversationsList";
import { useTutorConversations } from "./hooks/useTutorConversations";
import type { ConversationMessageResponse, StudentHomeworkListResponse } from "../shared/types";

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
function buildMessageData(
  aiMessages: UIMessage[],
  chatStatus: ReturnType<typeof useChat>["status"],
): MessageData[] {
  const messages: MessageData[] = aiMessages.map((m, idx) => {
    const isLast = idx === aiMessages.length - 1;
    const isStreaming = isLast && chatStatus === "streaming";

    if (m.role === "assistant") {
      const content = (
        <>
          {m.parts.map((part, i) => {
            if (part.type === "text") {
              return <p key={`text-${m.id}-${i}`}>{part.text}</p>;
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
            return renderToolPart(part, `tool-${m.id}-${i}`);
          })}
        </>
      );
      return {
        id: m.id,
        role: "ai" as const,
        content,
        isStreaming,
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
      if (prevMeta && !prevMeta.conversationId) {
        pendingGreetingConversationIdRef.current = newConversationId;
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
  } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      fetch: chatFetch,
    }),
  });

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
  } = useChat({
    id: tutorConversationId,
    messages: tutorInitialMessages,
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

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
    loadError: tutorConversationsLoadError,
    hasMore: tutorConversationsHasMore,
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
      messages: rows.map((r) => ({ id: r.id, role: r.role, parts: r.parts as UIMessage["parts"] })),
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
    latestTutorSelectionRef.current = id;
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
  const loadSectionConversation = async (sectionNumber: number, targetConversationId: string | undefined) => {
    setCurrentSection(sectionNumber);
    setConversationId(targetConversationId);
    latestSectionConversationRef.current = targetConversationId;
    setSectionHydrationError(null);
    if (!targetConversationId) {
      setSectionMessages([]);
      setSectionHistoryHasMore(false);
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
        onRetry: () => void loadSectionConversation(sectionNumber, targetConversationId),
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
      void loadSectionConversation(first, sectionMetaByOrder.get(first)?.conversationId ?? undefined);
      hasAutoSelectedSection.current = true;
    }
  }, [sections, sectionMetaByOrder]);
  const [hintCount, setHintCount] = useState(3);
  const [justSubmittedSection, setJustSubmittedSection] = useState<number | null>(null);
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

  /* Translate AI SDK UIMessages into the design system's MessageData --
     one call per Chat instance (buildMessageData, defined above the
     component). Whichever one is showing depends on tutorConversationId. */
  const messages = buildMessageData(aiMessages, chatStatus);
  const tutorMessages = buildMessageData(tutorAiMessages, tutorChatStatus);

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

  const handleSendMessage = (text: string) => {
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
    sendMessage(
      { text },
      {
        body: conversationId
          ? { conversationId }
          : { courseId, kind: "section" as const, sectionId: currentSectionMeta?.id },
      },
    );
    /* Each AI response counts as a hint — increments trigger the gold flash
       on the sidebar's hint-history-row count numeral. */
    setHintCount((n) => n + 1);
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
  };

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
    void loadSectionConversation(sectionNumber, sectionMetaByOrder.get(sectionNumber)?.conversationId ?? undefined);
    latestTutorSelectionRef.current = undefined;
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
          <p role="alert">Failed to load your homework. Please refresh the page.</p>
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
        homework="HW 3 · Probability and Distributions"
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
          loadError={tutorConversationsLoadError}
          hasMore={tutorConversationsHasMore}
          selectedConversationId={tutorConversationId}
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
              breadcrumb="STATS 311 · TUTOR CHAT"
              title={tutorConversationTitle}
              onRenameTitle={handleRenameTutorConversation}
              messages={tutorMessages}
              onSendMessage={handleSendTutorMessage}
              /* #144: "error" deliberately excluded -- see isSending's own
                 doc comment (ConversationView.tsx) for why. #276: a
                 hydration failure DOES disable sending -- unlike a chat
                 error, there's no persisted conversation state to safely
                 send a fresh turn into while it's broken. */
              isSending={tutorChatStatus === "submitted" || tutorChatStatus === "streaming" || !!tutorHydrationError}
              error={tutorChatErrorRow}
              autoFocusComposer={tutorConversationId === justCreatedTutorConversationId}
              hasMoreHistory={tutorHistoryHasMore}
            />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary key="section">
            <ConversationView
              breadcrumb="STATS 311 · HW 3 · Section 3 P-VALUES"
              messages={messages}
              onSendMessage={handleSendMessage}
              /* #144: "error" excluded here matters most for the section
                 chat specifically -- its useChat instance has no `id`
                 (unlike the tutor chat), so nothing else ever resets it
                 out of an error state; see isSending's own doc comment.
                 #276: a hydration failure DOES disable sending -- see the
                 tutor instance's own isSending comment above. */
              isSending={chatStatus === "submitted" || chatStatus === "streaming" || !!sectionHydrationError}
              error={sectionChatErrorRow}
              hasMoreHistory={sectionHistoryHasMore}
            />
          </ErrorBoundary>
        )}
        </main>
      </div>
    </div>
  );
}
