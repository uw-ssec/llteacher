import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useNavigate } from "react-router";
import { Sidebar, TopNav, ConversationView, renderToolPart } from "@llteacher/ui";
import type { SidebarSection, MessageData, ToolPart } from "@llteacher/ui";
import { useAuth } from "./components/AuthProvider";
import { UnauthenticatedHome } from "./components/UnauthenticatedHome";
import type { StudentHomeworkListResponse } from "../shared/types";

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

/** Fetches the current student's homework list and adapts it into the
    Sidebar's section shape. SidebarSection's status union ("submitted" |
    "current" | "pending") has no direct equivalent for "not_started" /
    "overdue" / "in_progress_overdue" -- those all map onto "pending" for
    now; a richer Sidebar status vocabulary is a @llteacher/ui change out of
    scope for this issue. */
export function useStudentHomework() {
  const [sections, setSections] = useState<SidebarSection[]>([]);
  const [hwTitle, setHwTitle] = useState("");
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
            conversationId: s.conversationId ?? undefined,
          })),
        );
        setLoading(false);
      })
      .catch(() => {
        setLoadError(true);
        setLoading(false);
      });
  }, []);

  return { sections, setSections, hwTitle, loading, loadError };
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
     to the caller. */
  const chatFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    const newConversationId = res.headers.get("x-conversation-id");
    if (newConversationId) setConversationId(newConversationId);
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
    sendMessage,
    status: chatStatus,
  } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      fetch: chatFetch,
    }),
  });

  const { sections, setSections, hwTitle, loadError } = useStudentHomework();
  // #160: was hardcoded to 3 regardless of what actually loaded -- a
  // homework with fewer than 3 sections left this pointing at a section
  // that doesn't exist. Starts at 1 (the Sidebar's own placeholder-free
  // default) and snaps to the first real section's number once the fetch
  // resolves; the ref guards against re-snapping after the student has
  // already navigated to a different section.
  const [currentSection, setCurrentSection] = useState(1);
  const hasAutoSelectedSection = useRef(false);
  useEffect(() => {
    if (!hasAutoSelectedSection.current && sections.length > 0) {
      setCurrentSection(sections[0]!.number);
      hasAutoSelectedSection.current = true;
    }
  }, [sections]);
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

  /* Translate AI SDK UIMessages into the design system's MessageData. AI
     messages get a ReactNode body assembled from their `parts` — text parts
     become paragraphs, tool-* parts go through the renderToolPart registry
     in @llteacher/ui/generative. Streaming state applies only to the last
     AI message. */
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
            return renderToolPart(part as ToolPart, `tool-${m.id}-${i}`);
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

  const handleSendMessage = (text: string) => {
    /* conversationId flows per-call (not via the transport's own `body`,
       see the useChat comment above) so each turn after the first actually
       carries whatever the previous turn's x-conversation-id response
       header set -- letting the server continue the same conversation
       instead of minting a new one on every message. */
    sendMessage({ text }, { body: conversationId ? { conversationId } : {} });
    /* Each AI response counts as a hint — increments trigger the gold flash
       on the sidebar's hint-history-row count numeral. */
    setHintCount((n) => n + 1);
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
    const section = sections.find((s) => s.number === sectionNumber);
    if (!section?.conversationId) return; // no active conversation yet -- nothing to submit
    try {
      const res = await fetch(`/api/conversations/${section.conversationId}/submit`, { method: "POST" });
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
          onSectionSelect={setCurrentSection}
          onSubmit={handleSubmit}
          workerStatus={workerStatus}
          workerLoading={workerLoading}
        />

        {/* Main conversation column — warm paper surface */}
        <ConversationView
          breadcrumb="STATS 311 · HW 3 · Section 3 P-VALUES"
          messages={messages}
          onSendMessage={handleSendMessage}
        />
      </div>
    </div>
  );
}
