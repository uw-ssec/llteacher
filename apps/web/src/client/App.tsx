import { useCallback, useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { useNavigate } from "react-router";
import { Sidebar, TopNav, ConversationView, AlertDialog, Button, ErrorBoundary } from "@llteacher/ui";
import type { RCodeResult } from "@llteacher/ui";
import { useRExecution } from "./hooks/useRExecution";
import { useAuth } from "./components/AuthProvider";
import { UnauthenticatedHome } from "./components/UnauthenticatedHome";
import { ResponseFeedback } from "./components/ResponseFeedback";
import { TutorConversationsList } from "./views/TutorConversationsList";
import { useTutorConversations } from "./hooks/useTutorConversations";
import { useStudentHomework } from "./hooks/useStudentHomework";
import { useLocalStoragePreference } from "./hooks/useLocalStoragePreference";
import { useConversationSurface, toChatResponseError } from "./hooks/useConversationSurface";
import { trackTutorTurnCompletion } from "./hooks/trackTutorTurnCompletion";
import type { ConversationMessageResponse, HintCountResponse } from "../shared/types";
import { MAX_HISTORY_MESSAGES } from "../shared/chat-limits";
import { deriveTutorConversationTitle, DEFAULT_TUTOR_CONVERSATION_TITLE } from "../shared/tutorConversationTitle";

// #302: re-exported from its new home (hooks/useStudentHomework.ts) so
// existing imports of `useStudentHomework` from "./App" (App.test.tsx)
// keep working unchanged.
export { useStudentHomework };

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

   #302: the two chat surfaces below (the homework section chat, and the
   tutor rail chat) share their useChat lifecycle, hydration bookkeeping,
   send guard, and error-row derivation via useConversationSurface
   (hooks/useConversationSurface.tsx) -- see that file's own top-of-file
   comment for exactly what it owns and what stays here because it is
   genuinely per-surface.
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

/** #294: TopNav's account chip used to hardcode `userInitials="AC"` --
 *  initials belonging to no signed-in user at all, shown to every
 *  student. `useAuth`'s only identity fields are `displayName` (nullable
 *  -- not every user has set one) and `email` (always present once
 *  authenticated); there is no separate given/family name field anywhere
 *  in this client. Prefers the first letter of up to the first two words
 *  of `displayName`; falls back to the first two characters of the
 *  email's local part (before the "@") when there is no display name;
 *  falls back to a neutral placeholder (never a fabricated name) when
 *  neither is available yet. */
function getUserInitials(profile: { displayName?: string | null; email?: string }): string {
  const name = profile.displayName?.trim();
  if (name) {
    const words = name.split(/\s+/).filter(Boolean);
    return words.length >= 2
      ? (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase()
      : words[0]!.slice(0, 2).toUpperCase();
  }
  const localPart = profile.email?.trim().split("@")[0];
  if (localPart) return localPart.slice(0, 2).toUpperCase();
  return "?";
}

/* #28: after the STUDENT'S OWN code runs (a fenced ```r block in one of
   THEIR messages -- see ConversationView's onRunRCode wiring below), share
   code + result back into the same conversation as a new turn, so the tutor
   can actually discuss it. Reuses handleSendMessage/handleSendTutorMessage
   (via runRCodeForSection/runRCodeForTutor below) rather than calling
   sendMessage directly -- same in-flight guard, same conversationId/
   courseId/sectionId body, same hint-count/stopped-note bookkeeping every
   other send already gets.

   Deliberately NOT done for the tutor's own suggested code (executeRCode
   tool, or a fenced block in the assistant's own text) -- buildMessageData
   (useConversationSurface.tsx) wires those to the bare `runRCode` with no
   persistence, so experimenting with the tutor's example doesn't spam a new
   (paid) model turn on every click. Only code the STUDENT wrote and sent
   counts as their "actual output" worth sharing automatically. */
function formatRExecutionMessage(code: string, result: RCodeResult): string {
  const codeFence = "```r\n" + code + "\n```";
  if (result.status === "error") {
    return `I ran this R code:\n${codeFence}\nIt produced an error:\n\`\`\`\n${result.error ?? "Unknown error"}\n\`\`\``;
  }
  const output = result.output && result.output.trim() ? result.output : "(no output)";
  return `I ran this R code:\n${codeFence}\nOutput:\n\`\`\`\n${output}\n\`\`\``;
}

/* #96 (interrupted-stream resilience, and the two-tabs non-goal).
   ---------------------------------------------------------------
   A turn can fail in two places, and the recovery differs:

     send half     -- the request never reached the server, or the server
                      refused it (any non-2xx: rate limit, closed section,
                      duplicate id, lost wifi). Nothing was persisted. The
                      student's words are handed back to the composer and the
                      un-persisted bubble is dropped, so what's on screen
                      matches what a reload would show.
     response half -- the server accepted the send (2xx), so the user message
                      IS persisted, but the model turn didn't finish. #268's
                      onFinish gate means the truncated reply is deliberately
                      NOT persisted, so a reload shows the question with no
                      answer; the in-session recovery is regenerate, which
                      re-sends the same clientMessageId and so is deduped by
                      the server's own idempotency check rather than
                      double-writing the question.

   Two tabs on one conversation is last-writer-wins with the persisted
   transcript as truth on reload -- an explicit v1 non-goal, not an oversight:
   there is no realtime sync, no cross-tab channel, and no attempt to merge.
   The server's per-conversation turn lock (chat.ts) already prevents the only
   outcome that would corrupt anything -- two interleaved turns writing into
   one conversation -- by 409ing the second tab's overlapping send; each tab
   otherwise just shows its own stale view until it reloads. */

/* ==========================================================================
   App — the root component
   ========================================================================== */

export default function App() {
  const { status: workerStatus, loading: workerLoading } = useWorkerStatus();
  const { isAuthenticated, loading: authLoading, error: authError, login, logout, email, displayName } = useAuth();
  const userInitials = getUserInitials({ email, displayName });
  const navigate = useNavigate();

  /* #3: the server creates a conversation on the first turn and returns its
     id via the x-conversation-id response header; every subsequent turn
     sends it back so the server persists into the same conversation instead
     of minting a new one each time. */
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);

  const {
    sections,
    setSections,
    sectionMetaByOrder,
    setSectionMetaByOrder,
    hwTitle,
    courseId,
    courseName,
    loading: homeworkLoading,
    loadError,
  } = useStudentHomework();

  // #271: mirrors sectionMetaByOrder for chatFetch's closure below, which is
  // captured once at mount (via the transport) and would otherwise never
  // see updates.
  const sectionMetaByOrderRef = useRef(sectionMetaByOrder);
  useEffect(() => {
    sectionMetaByOrderRef.current = sectionMetaByOrder;
  }, [sectionMetaByOrder]);

  // #160: starts at 1 (the Sidebar's own placeholder-free default) and
  // snaps to the first real section's number once the fetch resolves.
  const [currentSection, setCurrentSection] = useState(1);
  const hasAutoSelectedSection = useRef(false);
  const currentSectionRef = useRef(currentSection);
  useEffect(() => {
    currentSectionRef.current = currentSection;
  }, [currentSection]);

  /* #28: one shared useRExecution -- and therefore one shared WebR
     singleton -- for both chat surfaces. Declared early since both
     useConversationSurface calls below need it. */
  const { run: runRCode } = useRExecution();

  // #276: set when a conversation's history fetch fails -- declared before
  // the useConversationSurface calls below, which take it as a parameter
  // (a hydration failure takes priority over an ordinary chat-stream error).
  const [sectionHydrationError, setSectionHydrationError] = useState<{ message: string; onRetry: () => void } | null>(
    null,
  );

  /* #302: the section surface's useChat `id`, and its message seed --
     see useConversationSurface's own doc comment on `surfaceKey` for why
     this is a dedicated key (only ever written by selectSectionConversation
     below) rather than the raw `conversationId` state chatFetch mutates
     mid-turn: binding `id` straight to `conversationId` would recreate (and
     reset) the Chat instance the moment a section's first turn's response
     header mints one, mid-stream -- the exact naive unification this task
     is warned against. Keying by `${sectionNumber}:${targetConversationId}`
     instead only changes on an actual section switch or an explicit restart
     (a genuinely different conversation), which is exactly when a reset is
     wanted -- the "gains a reset path" reconciliation this task calls for. */
  const [sectionChatKey, setSectionChatKey] = useState<string | undefined>(undefined);
  const [sectionInitialMessages, setSectionInitialMessages] = useState<UIMessage[]>([]);
  const selectSectionConversation = (
    sectionNumber: number,
    targetConversationId: string | undefined,
    initialMessages: UIMessage[],
  ) => {
    setSectionInitialMessages(initialMessages);
    setSectionChatKey(`${sectionNumber}:${targetConversationId ?? "new"}`);
  };

  /* Wraps fetch to read the x-conversation-id response header before handing
     the (untouched) Response back to useConversationSurface's own stream
     parsing -- DefaultChatTransport otherwise has no way to surface response
     headers to the caller.

     #271: this function is captured ONCE by DefaultChatTransport at first
     render -- reading `currentSection`/`sectionMetaByOrder` directly here
     would freeze both at whatever they were on that first render forever.
     currentSectionRef/sectionMetaByOrderRef (kept current via their own
     effects above) are how this stays correct across every later render
     without recreating the transport. */
  const chatFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (!res.ok) {
      // #286: see useConversationSurface's ChatResponseError doc comment --
      // parsed and re-thrown here, before the AI SDK's own generic
      // `Error(await response.text())` would otherwise run.
      throw await toChatResponseError(res);
    }
    const newConversationId = res.headers.get("x-conversation-id");
    if (newConversationId) {
      setConversationId(newConversationId);
      const section = currentSectionRef.current;
      const prevMeta = sectionMetaByOrderRef.current.get(section);
      // #271: sectionMetaByOrder is the single source of truth a section's
      // conversationId is read from everywhere else in this file -- writing
      // the server-minted id back into it here is what makes those reads
      // see it, instead of only ever seeing whatever the initial
      // /api/student/homeworks fetch returned.
      if (prevMeta) {
        setSectionMetaByOrder((prev) => {
          const next = new Map(prev);
          next.set(section, { ...prevMeta, conversationId: newConversationId });
          return next;
        });
      }
      // #272: no prior conversationId for this section means THIS request
      // is the one that just made the server write the section's greeting
      // as the conversation's first message -- queued rather than fetched
      // immediately (see the effect below, which waits for this turn's
      // stream to finish first).
      if (prevMeta && !prevMeta.conversationId) {
        pendingGreetingConversationIdRef.current = newConversationId;
        latestSectionConversationRef.current = newConversationId;
      }
    }
    return res;
  };

  const sectionSurface = useConversationSurface({
    surfaceKey: sectionChatKey,
    // #96/#317: reset on `currentSection` (not `sectionChatKey`) -- see
    // resetKey's own doc comment in useConversationSurface.tsx. currentSection
    // updates synchronously the instant a section switch is requested (and
    // is what ConversationView's own `key={currentSection}` remounts on);
    // sectionChatKey only updates once that section's history fetch
    // resolves, which would otherwise leave a window for a stale restored
    // draft to land in the freshly-remounted (but not yet re-keyed) child.
    resetKey: currentSection,
    initialMessages: sectionInitialMessages,
    fetchImpl: chatFetch,
    buildSendBody: () =>
      conversationId
        ? { conversationId }
        : { courseId, kind: "section" as const, sectionId: sectionMetaByOrder.get(currentSection)?.id },
    // #302 constraint (preserve, don't reconcile): identical to
    // buildSendBody today -- kept as its own parameter (not merged with
    // buildSendBody) because the tutor surface's own retry body below is
    // NOT identical to ITS send body, and the two surfaces share this hook.
    buildRetryBody: () =>
      conversationId
        ? { conversationId }
        : { courseId, kind: "section" as const, sectionId: sectionMetaByOrder.get(currentSection)?.id },
    hydrationError: sectionHydrationError,
    runRCode,
  });
  /* #302: a live-updated ref onto the CURRENT sectionSurface.setMessages.
     Needed specifically because startFreshSectionConversation below starts
     its fetch synchronously inside the SAME loadSectionConversation call
     that also sets `sectionChatKey` for the first time (undefined -> a real
     key) -- by the time that fetch resolves, the key change has already
     caused useConversationSurface to recreate its Chat instance on a LATER
     render, so a `setMessages` captured in startFreshSectionConversation's
     own closure (from the render before the key changed) would silently
     write into the now-discarded instance instead of the one on screen.
     Reading through a ref that's reassigned every render always resolves
     to whichever instance is actually current by the time the async
     callback runs. */
  const sectionSetMessagesRef = useRef(sectionSurface.setMessages);
  sectionSetMessagesRef.current = sectionSurface.setMessages;

  /* #4: the tutor-conversations rail. Undefined = the homework section chat
     is showing (default); set = the selected/created tutor conversation is
     showing instead. */
  const [tutorConversationId, setTutorConversationId] = useState<string | undefined>(undefined);
  /* #4: seeds the tutor Chat instance's message list whenever
     tutorConversationId changes -- empty for a brand-new conversation, or
     the persisted history for an existing one (chatHandler builds the
     model's context from exactly the array the client sends, so leaving
     this empty on resume would mean the LLM receives zero prior context). */
  const [tutorInitialMessages, setTutorInitialMessages] = useState<UIMessage[]>([]);

  /** #292 (review fix): holds the CURRENT bumpTutorConversation so
   *  tutorChatFetch/trackTutorTurnCompletion below (both defined before
   *  useTutorConversations runs later in this function) can call it once a
   *  turn's stream actually finishes, at whatever later, asynchronous point
   *  that happens to be. */
  const bumpTutorConversationRef = useRef<(id: string, delta: number) => void>(() => {});
  // #276: set when a tutor conversation's history fetch fails -- declared
  // before the tutorSurface useConversationSurface call below, which takes
  // it as a parameter.
  const [tutorHydrationError, setTutorHydrationError] = useState<{ message: string; onRetry: () => void } | null>(
    null,
  );
  const tutorChatFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (!res.ok) throw await toChatResponseError(res);
    // #292 (review fix): tee the response body and track ITS completion
    // independently of whatever `useChat` instance is mounted by the time
    // this turn actually finishes -- see trackTutorTurnCompletion's own
    // doc comment for the full reasoning. The conversationId comes from the
    // request body this exact fetch call is making, not from component
    // state, so it's correct even if the student has switched away by the
    // time this resolves.
    if (res.body) {
      let requestConversationId: string | undefined;
      try {
        const parsedBody = JSON.parse(String(init?.body)) as { conversationId?: unknown };
        if (typeof parsedBody.conversationId === "string") requestConversationId = parsedBody.conversationId;
      } catch {
        /* no parseable body -- nothing to track this turn against */
      }
      if (requestConversationId) {
        const [forSdk, forBump] = res.body.tee();
        trackTutorTurnCompletion(requestConversationId, forBump, bumpTutorConversationRef);
        return new Response(forSdk, { status: res.status, statusText: res.statusText, headers: res.headers });
      }
    }
    return res;
  };

  /* #4: tracks whichever tutor-surface switch was requested most recently.
     Written synchronously at the START of every switch, so it's always
     current the instant a new request is made. Read back after
     handleSelectExistingTutorConversation's await resolves to detect
     whether that fetch has since been superseded. */
  const latestTutorSelectionRef = useRef<string | undefined>(undefined);
  /* Mirrors `tutorConversationId` for reads that happen after an await. */
  const displayedTutorConversationRef = useRef<string | undefined>(undefined);
  displayedTutorConversationRef.current = tutorConversationId;
  /* #235: which tutor conversation (if any) was just created this session,
     so the chat column can autofocus its composer once on mount. */
  const [justCreatedTutorConversationId, setJustCreatedTutorConversationId] = useState<string | undefined>(
    undefined,
  );
  /* #290: the conversation whose history is currently being fetched, if
     any -- lets the rail show that the click registered. */
  const [pendingTutorSelectionId, setPendingTutorSelectionId] = useState<string | undefined>(undefined);

  /* #280: true when there are older messages than the transcript holds
     (the messages route pages at 200). One flag per surface since
     tutor/section hydrate independently. Paired with the `seq` of the
     oldest message currently loaded -- the cursor `GET .../messages?before=`
     takes. */
  const [tutorHistoryHasMore, setTutorHistoryHasMore] = useState(false);
  const [sectionHistoryHasMore, setSectionHistoryHasMore] = useState(false);
  const [tutorOldestSeq, setTutorOldestSeq] = useState<number | undefined>(undefined);
  const [sectionOldestSeq, setSectionOldestSeq] = useState<number | undefined>(undefined);
  const [loadingOlderTutorMessages, setLoadingOlderTutorMessages] = useState(false);
  const [loadingOlderSectionMessages, setLoadingOlderSectionMessages] = useState(false);
  const [tutorOlderMessagesError, setTutorOlderMessagesError] = useState(false);
  const [sectionOlderMessagesError, setSectionOlderMessagesError] = useState(false);

  /* #4/#6, lifted here per #223: one useTutorConversations instance shared
     by the rail and this chat column's header. */
  const {
    conversations: tutorConversations,
    loading: tutorConversationsLoading,
    awaitingCourseContext: tutorConversationsAwaitingCourse,
    loadError: tutorConversationsLoadError,
    hasMore: tutorConversationsHasMore,
    loadingMore: tutorConversationsLoadingMore,
    loadMoreError: tutorConversationsLoadMoreError,
    loadMore: loadMoreTutorConversations,
    refetch: refetchTutorConversations,
    createConversation: createTutorConversationRow,
    deleteConversation: deleteTutorConversationRow,
    renameConversation: renameTutorConversationRow,
    bumpConversation: bumpTutorConversation,
    recentlyMovedId: recentlyMovedTutorConversationId,
  } = useTutorConversations(courseId);

  // #292: tutorChatFetch (defined earlier) needs to call the CURRENT
  // bumpTutorConversation -- assigned here, on every render, so an async
  // callback firing later always reads whichever bumpTutorConversation is
  // current at that moment.
  bumpTutorConversationRef.current = bumpTutorConversation;

  const tutorSurface = useConversationSurface({
    surfaceKey: tutorConversationId,
    // #96/#317: the tutor surface's ConversationView remount and its
    // useChat `id` always update together (selectTutorConversation sets
    // both tutorConversationId and tutorInitialMessages in the same
    // handler pass), so resetKey and surfaceKey coincide here -- unlike
    // the section surface above.
    resetKey: tutorConversationId,
    initialMessages: tutorInitialMessages,
    fetchImpl: tutorChatFetch,
    buildSendBody: () => ({ conversationId: tutorConversationId, courseId }),
    // #302 constraint (preserve, don't reconcile): the section surface's
    // retry body above falls back to courseId/kind/sectionId when there is
    // no conversationId yet; this one sends `{}` in that case. Genuinely
    // divergent already (every tutor turn has an id by the time it can be
    // sent -- see the tutor useChat's own historical doc comment -- so a
    // regenerate with no conversationId is an edge case neither surface
    // treats the same way), not something this refactor was asked to
    // reconcile -- flagged in the task report as a follow-up candidate.
    buildRetryBody: () => (tutorConversationId ? { conversationId: tutorConversationId } : {}),
    hydrationError: tutorHydrationError,
    runRCode,
  });

  const tutorConversationTitle = tutorConversations.find((c) => c.id === tutorConversationId)?.title;

  const handleRenameTutorConversation = async (newTitle: string) => {
    if (!tutorConversationId) return;
    await renameTutorConversationRow(tutorConversationId, newTitle);
  };

  /* #4: the single place that switches the tutor surface to a given
     conversation, always setting its seed messages in the same event-
     handler pass as its id (React batches both into one commit). */
  const selectTutorConversation = (id: string, initialMessages: UIMessage[] = []) => {
    latestTutorSelectionRef.current = id;
    setPendingTutorSelectionId(undefined);
    setTutorInitialMessages(initialMessages);
    setTutorConversationId(id);
  };

  // #252: shared by both hydration paths -- fetches a conversation's
  // persisted history and parses it against the wire contract.
  const MESSAGES_HISTORY_LIMIT = 200;
  const fetchConversationHistory = async (
    id: string,
    before?: number,
  ): Promise<{ messages: UIMessage[]; hasMore: boolean; oldestSeq: number | undefined }> => {
    const res = await fetch(
      `/api/conversations/${id}/messages?limit=${MESSAGES_HISTORY_LIMIT}${
        before !== undefined ? `&before=${before}` : ""
      }`,
    );
    if (!res.ok) throw new Error(`failed to load conversation history: ${res.status}`);
    const rows = (await res.json()) as ConversationMessageResponse[];
    return {
      oldestSeq: rows[0]?.seq,
      messages: rows.map((r) => ({
        id: r.id,
        role: r.role,
        parts: r.parts as UIMessage["parts"],
        metadata: { createdAt: r.createdAt },
      })),
      hasMore: rows.length === MESSAGES_HISTORY_LIMIT,
    };
  };

  /* #4: TutorConversationsList's onSelectConversation -- fetches that
     conversation's persisted history before switching the chat column to
     it. Fails open to an empty thread (not a thrown error) on a failed
     fetch. Stale-response guarded via latestTutorSelectionRef: a second
     selection made while THIS fetch is still in flight discards this
     (now-stale) response once it resolves. */
  const handleSelectExistingTutorConversation = async (id: string) => {
    if (id === tutorConversationId) return;
    if (id === pendingTutorSelectionId) return;
    latestTutorSelectionRef.current = id;
    setPendingTutorSelectionId(id);
    setJustCreatedTutorConversationId(undefined);
    try {
      const history = await fetchConversationHistory(id);
      if (latestTutorSelectionRef.current !== id) return; // superseded while in flight -- discard
      setTutorHydrationError(null);
      setTutorHistoryHasMore(history.hasMore);
      setTutorOldestSeq(history.oldestSeq);
      setTutorOlderMessagesError(false);
      selectTutorConversation(id, history.messages);
    } catch (err) {
      console.error("[App] tutor conversation history fetch failed", err);
      if (latestTutorSelectionRef.current !== id) return;
      setTutorHydrationError({
        message: "Couldn't load that conversation. Please try again.",
        onRetry: () => void handleSelectExistingTutorConversation(id),
      });
      setTutorHistoryHasMore(false);
      setTutorOldestSeq(undefined);
      selectTutorConversation(id, []);
    } finally {
      // #398: clear only when this request is still the current one -- a
      // superseded fetch resolving late must not clear a marker belonging
      // to the selection that replaced it.
      if (latestTutorSelectionRef.current === id) setPendingTutorSelectionId(undefined);
    }
  };

  /* #280 (requirement 2, transcript half): fetch the page of messages
     BEFORE the oldest one showing and PREPEND it. One handler shape,
     twice -- the tutor and section surfaces have separate cursors and
     separate staleness refs, so they share the fetch
     (fetchConversationHistory) rather than the handler. */
  const handleLoadOlderTutorMessages = async () => {
    const targetConversationId = tutorConversationId;
    if (!targetConversationId || tutorOldestSeq === undefined || loadingOlderTutorMessages) return;
    setLoadingOlderTutorMessages(true);
    setTutorOlderMessagesError(false);
    try {
      const older = await fetchConversationHistory(targetConversationId, tutorOldestSeq);
      if (latestTutorSelectionRef.current !== targetConversationId) return;
      if (older.messages.length === 0) {
        setTutorHistoryHasMore(false);
        return;
      }
      tutorSurface.setMessages((prev) => [...older.messages, ...prev]);
      setTutorOldestSeq(older.oldestSeq);
      setTutorHistoryHasMore(older.hasMore);
    } catch (err) {
      console.error("[App] tutor older-message fetch failed", err);
      if (latestTutorSelectionRef.current !== targetConversationId) return;
      setTutorOlderMessagesError(true);
    } finally {
      setLoadingOlderTutorMessages(false);
    }
  };

  const handleLoadOlderSectionMessages = async () => {
    const targetConversationId = conversationId;
    if (!targetConversationId || sectionOldestSeq === undefined || loadingOlderSectionMessages) return;
    setLoadingOlderSectionMessages(true);
    setSectionOlderMessagesError(false);
    try {
      const older = await fetchConversationHistory(targetConversationId, sectionOldestSeq);
      if (latestSectionConversationRef.current !== targetConversationId) return;
      if (older.messages.length === 0) {
        setSectionHistoryHasMore(false);
        return;
      }
      sectionSurface.setMessages((prev) => [...older.messages, ...prev]);
      setSectionOldestSeq(older.oldestSeq);
      setSectionHistoryHasMore(older.hasMore);
    } catch (err) {
      console.error("[App] section older-message fetch failed", err);
      if (latestSectionConversationRef.current !== targetConversationId) return;
      setSectionOlderMessagesError(true);
    } finally {
      setLoadingOlderSectionMessages(false);
    }
  };

  /* #289: deleting the conversation currently on screen has to move the
     student off it. Falls back to the section chat, this surface's own
     default when no tutor conversation is active. */
  const handleDeleteTutorConversation = async (id: string): Promise<boolean> => {
    /* #401: invalidate BEFORE awaiting -- removes the race (rather than
       detecting it) where the history request resolves DURING the await
       and would otherwise make the deleted conversation current again. */
    if (latestTutorSelectionRef.current === id) {
      latestTutorSelectionRef.current = undefined;
      setPendingTutorSelectionId((pending) => (pending === id ? undefined : pending));
    }

    const ok = await deleteTutorConversationRow(id);
    if (!ok) return false;

    /* Only the DISPLAYED conversation needs the surface torn down, read
       from a ref (correct in both directions -- see #401) rather than the
       closed-over `tutorConversationId`. */
    if (displayedTutorConversationRef.current === id) {
      setTutorConversationId(undefined);
      setTutorInitialMessages([]);
      setJustCreatedTutorConversationId(undefined);
      setTutorHydrationError(null);
      setTutorHistoryHasMore(false);
    }
    return true;
  };

  /* #4: TutorConversationsList's "New conversation" button. */
  const handleCreateTutorConversation = async (): Promise<boolean> => {
    const created = await createTutorConversationRow();
    if (!created) return false;
    setTutorHistoryHasMore(false);
    setTutorOldestSeq(undefined);
    setTutorOlderMessagesError(false);
    setTutorHydrationError(null);
    selectTutorConversation(created.id);
    setJustCreatedTutorConversationId(created.id);
    return true;
  };

  /* #252: tracks whichever section-conversation load was requested most
     recently -- the same staleness-guard shape latestTutorSelectionRef
     gives the tutor rail, applied to the section chat's mount/switch path. */
  const latestSectionConversationRef = useRef<string | undefined>(undefined);
  // #272: set by chatFetch above when a turn just created a section's FIRST
  // conversation -- the conversationId to re-hydrate from once this turn's
  // stream finishes.
  const pendingGreetingConversationIdRef = useRef<string | undefined>(undefined);

  /* #318: a fresh section (no conversation yet) used to render an empty
     composer until the student's own first message lazily created the
     conversation server-side -- this calls the same start endpoint
     chatHandler already uses internally, eagerly, so the greeting shows
     the moment the student opens the section. Deliberately does NOT touch
     sectionChatKey/sectionInitialMessages -- this updates the CURRENT
     surface's live content in place (via sectionSetMessagesRef.current,
     not sectionSurface.setMessages directly -- see that ref's own doc
     comment for why: this function's fetch starts in the same tick as
     loadSectionConversation's own first-ever key assignment), exactly the
     "mint a new id mid-turn must not reset the Chat instance" case
     surfaceKey's own doc comment warns about. */
  const startFreshSectionConversation = async (sectionNumber: number, sectionId: string) => {
    if (!courseId) return;
    try {
      const res = await fetch(`/api/courses/${courseId}/sections/${sectionId}/conversations`, { method: "POST" });
      if (currentSectionRef.current !== sectionNumber) return; // superseded -- discard
      if (!res.ok) return; // 409: already exists, or section isn't interactive (#164)
      const created = (await res.json()) as { id: string; greetingMessageId: string; greetingParts: unknown };
      setConversationId(created.id);
      latestSectionConversationRef.current = created.id;
      const greetingMessages: UIMessage[] = [
        { id: created.greetingMessageId, role: "assistant", parts: created.greetingParts as UIMessage["parts"] },
      ];
      /* #302: both calls are needed, and in this order, because this
         function's own `selectSectionConversation(sectionNumber,
         undefined, [])` call (in loadSectionConversation, just before this
         function was kicked off) queued `sectionChatKey`'s FIRST-ever
         transition away from `undefined` -- and React may not have applied
         that queued render yet by the time this awaited fetch resolves.
         Writing only through sectionSetMessagesRef would be lost the
         moment that still-pending key change finally lands (it recreates
         the Chat instance, reseeding from whatever sectionInitialMessages
         was at THAT render). Updating sectionInitialMessages here too means
         that even a recreation landing after this point seeds correctly
         from the greeting -- and since this call is unambiguously LATER
         than the earlier `[]` one, it always wins regardless of which
         render actually applies the key change. */
      setSectionInitialMessages(greetingMessages);
      sectionSetMessagesRef.current(greetingMessages);
      setSectionMetaByOrder((prev) => {
        const prevMeta = prev.get(sectionNumber);
        if (!prevMeta) return prev;
        const next = new Map(prev);
        next.set(sectionNumber, { ...prevMeta, conversationId: created.id });
        return next;
      });
      setSections((prev) => prev.map((s) => (s.number === sectionNumber ? { ...s, status: "current" as const } : s)));
    } catch (err) {
      console.error("[App] failed to eagerly start section conversation", err);
    }
  };

  /* #252: the section chat's own version of handleSelectExistingTutorConversation.
     #276: fails closed -- a failed fetch leaves the message list as
     whatever it already was (not cleared), surfaces a retryable
     sectionHydrationError, and disables the composer while it's set. */
  const loadSectionConversation = async (
    sectionNumber: number,
    targetConversationId: string | undefined,
    sectionId?: string,
  ) => {
    setCurrentSection(sectionNumber);
    setConversationId(targetConversationId);
    latestSectionConversationRef.current = targetConversationId;
    setSectionHydrationError(null);
    setSectionOlderMessagesError(false);
    if (!targetConversationId) {
      selectSectionConversation(sectionNumber, targetConversationId, []);
      setSectionHistoryHasMore(false);
      setSectionOldestSeq(undefined);
      if (sectionId) void startFreshSectionConversation(sectionNumber, sectionId);
      return;
    }
    try {
      const history = await fetchConversationHistory(targetConversationId);
      if (latestSectionConversationRef.current !== targetConversationId) return; // superseded -- discard
      selectSectionConversation(sectionNumber, targetConversationId, history.messages);
      setSectionHistoryHasMore(history.hasMore);
      setSectionOldestSeq(history.oldestSeq);
    } catch (err) {
      console.error("[App] section conversation history fetch failed", err);
      if (latestSectionConversationRef.current !== targetConversationId) return;
      setSectionHydrationError({
        message: "Couldn't load this section's conversation. Please try again.",
        onRetry: () => void loadSectionConversation(sectionNumber, targetConversationId, sectionId),
      });
      /* Deliberately no cursor/messages reset here -- #276 leaves the
         previous section's transcript on screen when hydration fails, so
         a surviving hasMore/oldestSeq must not let "Load older messages"
         prepend the NEW section's messages onto the OLD transcript. */
      setSectionHistoryHasMore(false);
      setSectionOldestSeq(undefined);
    }
  };

  // #272: fires the greeting re-hydration chatFetch queued above, but only
  // once this turn's stream has fully finished -- calling setMessages while
  // still streaming would race with (and could visibly clobber) that
  // render.
  useEffect(() => {
    const pendingId = pendingGreetingConversationIdRef.current;
    if (!pendingId || pendingId !== conversationId || sectionSurface.status !== "ready") return;
    pendingGreetingConversationIdRef.current = undefined;
    void (async () => {
      try {
        const history = await fetchConversationHistory(pendingId);
        if (latestSectionConversationRef.current === pendingId) {
          sectionSurface.setMessages(history.messages);
          setSectionHistoryHasMore(history.hasMore);
          setSectionOldestSeq(history.oldestSeq);
        }
      } catch (err) {
        console.error("[App] failed to hydrate section greeting after creation", err);
      }
    })();
  }, [sectionSurface.status, conversationId]);

  useEffect(() => {
    if (!hasAutoSelectedSection.current && sections.length > 0) {
      const first = sections[0]!.number;
      // #214/#252: resume the section's own conversation if it already has
      // one (a returning student).
      void loadSectionConversation(
        first,
        sectionMetaByOrder.get(first)?.conversationId ?? undefined,
        sectionMetaByOrder.get(first)?.id,
      );
      hasAutoSelectedSection.current = true;
    }
  }, [sections, sectionMetaByOrder]);

  /* #80: real hint usage. Fetched from GET .../hints for the active section
     whenever it changes, and again once an in-flight hint request settles.
     `hintLimit` is null when the section has no configured budget
     (unlimited by default). A fetch failure degrades to "0 used, no known
     limit" rather than throwing. */
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
        console.error("[App] failed to load hint count", err);
      });
  }, [courseId, currentSectionId]);
  useEffect(() => {
    refetchHintCount();
  }, [refetchHintCount]);
  /* Set by handleSendMessage the moment a hint-flagged turn is sent;
     consumed the next time sectionSurface.status settles back to
     "ready"/"error" to refetch the real count. */
  const hintRequestPendingRef = useRef(false);
  useEffect(() => {
    if (
      hintRequestPendingRef.current &&
      sectionSurface.status !== "submitted" &&
      sectionSurface.status !== "streaming"
    ) {
      hintRequestPendingRef.current = false;
      refetchHintCount();
    }
  }, [sectionSurface.status, refetchHintCount]);

  const [justSubmittedSection, setJustSubmittedSection] = useState<number | null>(null);
  /* #248: restart-affordance dialog state for the section chat. */
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  /* Sidebar collapse and the tutor rail's own collapse preference each
     persist across reloads via localStorage (#302: useLocalStoragePreference). */
  const SIDEBAR_COLLAPSED_KEY = "llteacher:sidebar-collapsed";
  const TUTOR_SIDEBAR_COLLAPSED_KEY = "llteacher:tutor-sidebar-collapsed";
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useLocalStoragePreference(SIDEBAR_COLLAPSED_KEY);
  const [isTutorSidebarCollapsed, setIsTutorSidebarCollapsed] = useLocalStoragePreference(
    TUTOR_SIDEBAR_COLLAPSED_KEY,
  );

  const handleSendMessage = (text: string, options?: { isHintRequest?: boolean }) => {
    /* #144: guarded independently of the composer's own `disabled` --
       cheap insurance against any other caller that doesn't go through it.
       "error" is deliberately NOT blocked (unlike "submitted"/"streaming")
       -- sending a fresh message is a safe and correct way to move past a
       failed turn (and, as of #302, so is switching sections/restarting --
       see sectionChatKey's own doc comment for the surface's other reset
       path). */
    if (!sectionSurface.canSend) return;
    /* #80: server-authoritative grant/deny -- this flag only REQUESTS the
       server treat this turn as a hint; hintRequestPendingRef, consumed by
       the effect above, is what turns "this turn settled" into "refetch
       the real count". */
    if (options?.isHintRequest) hintRequestPendingRef.current = true;
    sectionSurface.send(text, options?.isHintRequest ? { isHintRequest: true } : undefined);
  };

  /* #80: "Give me a hint" -- sends a fixed, clearly-labeled request through
     the SAME pipeline as a typed message, flagged so the server treats it
     as a hint. */
  const HINT_REQUEST_MESSAGE = "Give me a hint for this section, please.";
  const handleRequestHint = () => {
    handleSendMessage(HINT_REQUEST_MESSAGE, { isHintRequest: true });
  };

  /* #4: sends into whichever tutor conversation is currently selected. */
  const handleSendTutorMessage = (text: string) => {
    if (!tutorConversationId) return;
    if (!tutorSurface.canSend) return;
    /* #287: auto-title a brand-new tutor conversation from its first
       message -- gated on the row's title still being the untouched
       default, which is both necessary and sufficient (see the #287
       review notes this replaces: a messageCount===0 gate was tried and
       removed for actively breaking the self-healing and retry-after-a-
       failed-PATCH cases the title-only gate handles correctly). Fired
       here rather than gated on the turn's own completion: the title
       depends only on the text already known at send time. Best-effort --
       a failed PATCH here is swallowed, not surfaced as a send failure. */
    const currentTutorConversationTitle = tutorConversations.find((c) => c.id === tutorConversationId)?.title;
    if (currentTutorConversationTitle === DEFAULT_TUTOR_CONVERSATION_TITLE) {
      const derivedTitle = deriveTutorConversationTitle([{ type: "text", text }]);
      if (derivedTitle) {
        void renameTutorConversationRow(tutorConversationId, derivedTitle).catch(() => {
          /* best-effort -- see the comment above. */
        });
      }
    }
    tutorSurface.send(text);
  };

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

  /* Selecting a homework section always means "I want the section chat" --
     switches back out of the tutor surface if one was showing. */
  const handleSectionSelect = (sectionNumber: number) => {
    void loadSectionConversation(
      sectionNumber,
      sectionMetaByOrder.get(sectionNumber)?.conversationId ?? undefined,
      sectionMetaByOrder.get(sectionNumber)?.id,
    );
    latestTutorSelectionRef.current = undefined;
    setPendingTutorSelectionId(undefined);
    setTutorConversationId(undefined);
    setTutorInitialMessages([]);
    setJustCreatedTutorConversationId(undefined);
  };

  /* Submits the section's active conversation via the real API. */
  const handleSubmit = async (sectionNumber: number) => {
    const meta = sectionMetaByOrder.get(sectionNumber);
    if (!meta?.conversationId) return; // no active conversation yet -- nothing to submit
    // #318: the Submit button always targets `currentSection`, so the live
    // transcript for whichever section is currently shown is the right
    // thing to check for content, not a second fetch.
    if (!sectionSurface.aiMessages.some((m) => m.role === "user")) return;
    try {
      const res = await fetch(`/api/conversations/${meta.conversationId}/submit`, { method: "POST" });
      if (!res.ok) throw new Error("submit failed");
      setSections((prev) =>
        prev.map((s) => (s.number === sectionNumber ? { ...s, status: "submitted" as const } : s)),
      );
      setJustSubmittedSection(sectionNumber);
      setTimeout(() => setJustSubmittedSection(null), 800);
    } catch (err) {
      console.error("[App] section submit failed", err);
    }
  };

  const openRestartDialog = () => {
    setRestartError(null);
    setRestartDialogOpen(true);
  };

  const cancelRestart = () => {
    if (restarting) return;
    setRestartDialogOpen(false);
    setRestartError(null);
  };

  /* POST .../restart (#27/#248). On success, reuses loadSectionConversation
     -- the same hydration path the initial mount and section-switch already
     go through -- which, as of #302, now also gives restart a real Chat
     instance reset (see sectionChatKey's own doc comment). */
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
        setRestartError(body?.error ?? "Something went wrong restarting this section. Please try again.");
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
      console.error("[App] section restart failed", err);
      setRestartError("Something went wrong restarting this section. Please try again.");
    } finally {
      setRestarting(false);
    }
  };

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

  if (authLoading) return null;
  if (!isAuthenticated) return <UnauthenticatedHome onLogin={login} error={authError} />;

  if (loadError) {
    return (
      <div className="page-frame">
        <TopNav
          course={courseName}
          homework=""
          userInitials={userInitials}
          isAuthenticated={isAuthenticated}
          onProfileClick={() => navigate("/profile")}
          onLogout={logout}
        />
        <div className="app-shell">
          <HomeworkLoadError />
        </div>
      </div>
    );
  }

  return (
    <div className="page-frame">
      <a href="#conversation-main" className="skip-link sr-only">
        Skip to conversation
      </a>
      <TopNav
        course={courseName}
        homework={hwTitle}
        userInitials={userInitials}
        isAuthenticated={isAuthenticated}
        onProfileClick={() => navigate("/profile")}
        onLogout={logout}
      />

      <div className="app-shell">
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

        <TutorConversationsList
          courseId={courseId}
          courseContextLoading={homeworkLoading}
          conversations={tutorConversations}
          loading={tutorConversationsLoading}
          awaitingCourseContext={tutorConversationsAwaitingCourse}
          loadError={tutorConversationsLoadError}
          onRetryLoad={refetchTutorConversations}
          hasMore={tutorConversationsHasMore}
          onLoadMore={() => void loadMoreTutorConversations()}
          loadingMore={tutorConversationsLoadingMore}
          loadMoreError={tutorConversationsLoadMoreError}
          selectedConversationId={tutorConversationId}
          pendingConversationId={pendingTutorSelectionId}
          recentlyMovedId={recentlyMovedTutorConversationId}
          onSelectConversation={handleSelectExistingTutorConversation}
          onCreateConversation={handleCreateTutorConversation}
          onRenameConversation={renameTutorConversationRow}
          onDeleteConversation={handleDeleteTutorConversation}
          isCollapsed={isTutorSidebarCollapsed}
          onToggleCollapse={() => setIsTutorSidebarCollapsed((c) => !c)}
        />

        <main id="conversation-main" tabIndex={-1} className="conversation-main">
        {tutorConversationId ? (
          <ErrorBoundary key={`tutor-${tutorConversationId}`}>
            <ConversationView
              key={tutorConversationId}
              breadcrumb="TUTOR CHAT"
              title={tutorConversationTitle}
              onRenameTitle={handleRenameTutorConversation}
              messages={tutorSurface.messages}
              onSendMessage={handleSendTutorMessage}
              onRunRCode={runRCodeForTutor}
              isSending={tutorSurface.isSending}
              isStopActionable={tutorSurface.isStopActionable}
              error={tutorSurface.errorRow}
              restoredDraft={tutorSurface.sendFailureText !== null ? { text: tutorSurface.sendFailureText } : null}
              autoFocusComposer={tutorConversationId === justCreatedTutorConversationId}
              hasMoreHistory={tutorHistoryHasMore}
              onLoadOlderMessages={() => void handleLoadOlderTutorMessages()}
              isLoadingOlderMessages={loadingOlderTutorMessages}
              loadOlderMessagesError={tutorOlderMessagesError}
              contextWindowSize={MAX_HISTORY_MESSAGES}
              onStop={tutorSurface.stop}
            />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary key="section">
            <ConversationView
              key={currentSection}
              breadcrumb={`Section ${currentSection}${
                currentSectionTitle ? `: ${currentSectionTitle}` : ""
              }`}
              messages={sectionSurface.messages}
              onSendMessage={handleSendMessage}
              onRunRCode={runRCodeForSection}
              onRequestHint={handleRequestHint}
              hintDisabled={hintLimit !== null && hintCount >= hintLimit}
              isSending={sectionSurface.isSending}
              isStopActionable={sectionSurface.isStopActionable}
              error={sectionSurface.errorRow}
              restoredDraft={
                sectionSurface.sendFailureText !== null ? { text: sectionSurface.sendFailureText } : null
              }
              hasMoreHistory={sectionHistoryHasMore}
              onLoadOlderMessages={() => void handleLoadOlderSectionMessages()}
              isLoadingOlderMessages={loadingOlderSectionMessages}
              loadOlderMessagesError={sectionOlderMessagesError}
              contextWindowSize={MAX_HISTORY_MESSAGES}
              onStop={sectionSurface.stop}
              renderAiFeedbackSlot={
                conversationId
                  ? (messageId) => <ResponseFeedback conversationId={conversationId} messageId={messageId} />
                  : undefined
              }
              headerActions={
                conversationId ? (
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
 *  focus-on-mount effect the other two fallbacks carry (#298). */
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
