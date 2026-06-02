import { useEffect, useState } from "react";
import { Sidebar, TopNav, ConversationView, CodeBlock } from "@llteacher/ui";
import type { SidebarSection, MessageData } from "@llteacher/ui";

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

/* -- Homework sections fixture data ---------------------------------------- */

/** localStorage key for the sidebar collapsed preference. Namespaced so it
    doesn't collide with future preference keys (`llteacher:*`). */
const SIDEBAR_COLLAPSED_KEY = "llteacher:sidebar-collapsed";

const INITIAL_SECTIONS: SidebarSection[] = [
  { number: 1, title: "Random variables",          status: "submitted" },
  { number: 2, title: "Probability distributions", status: "submitted" },
  { number: 3, title: "P-values",                  status: "current"   },
  { number: 4, title: "Confidence intervals",      status: "pending"   },
  { number: 5, title: "Hypothesis testing",        status: "pending"   },
];

/* -- Sample conversation messages ------------------------------------------ */

const INITIAL_MESSAGES: MessageData[] = [
  {
    id: "ai-1",
    role: "ai",
    content: (
      <p>What do you think a hypothesis is, exactly?</p>
    ),
  },
  {
    id: "student-1",
    role: "student",
    content: "A guess about what's happening?",
  },
  {
    id: "ai-2",
    role: "ai",
    content: (
      <p>
        Close. More specifically — a claim that can be tested. So if I
        claimed this coin is fair, what would you do to test it?
      </p>
    ),
  },
  {
    id: "student-2",
    role: "student",
    content: "Flip it a bunch of times and count heads?",
  },
  {
    id: "ai-3",
    role: "ai",
    content: (
      <p>
        Exactly. Say you flip it 100 times and get 70 heads. Is that
        suspicious?
      </p>
    ),
  },
  {
    id: "student-3",
    role: "student",
    content: "Yeah, but I don't know how suspicious.",
  },
  {
    id: "ai-4",
    role: "ai",
    content: (
      <>
        <p>
          That&apos;s precisely what a p-value measures. It&apos;s the probability of
          getting a result this extreme — or more — assuming the coin is
          actually fair. If that probability is small, your data is suspicious.
        </p>
        <p>Want to compute one with R?</p>
        <CodeBlock lang="r" output="[1] 47">
{`flips <- rbinom(100, 1, 0.5)
sum(flips)`}
        </CodeBlock>
      </>
    ),
  },
  {
    id: "student-4",
    role: "student",
    content: "So if I got 47 heads, that's not very suspicious?",
  },
  {
    id: "ai-5",
    role: "ai",
    isStreaming: true,
    content: (
      <p>
        Right. Now try running the same code but change 0.5 to 0.7 — what do
        you get?
      </p>
    ),
  },
];

/* ==========================================================================
   App — the root component
   ========================================================================== */

export default function App() {
  const { status: workerStatus, loading: workerLoading } = useWorkerStatus();
  const [messages, setMessages] = useState<MessageData[]>(INITIAL_MESSAGES);
  const [sections, setSections] = useState<SidebarSection[]>(INITIAL_SECTIONS);
  const [currentSection, setCurrentSection] = useState(3);
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

  const handleSendMessage = (text: string) => {
    /* Add the student message immediately */
    const studentMsg: MessageData = {
      id: `student-${Date.now()}`,
      role: "student",
      content: text,
    };

    /* Placeholder streaming AI response */
    const aiMsg: MessageData = {
      id: `ai-${Date.now()}`,
      role: "ai",
      isStreaming: true,
      content: (
        <p>Thinking about that — give me a moment…</p>
      ),
    };

    setMessages((prev) => [...prev, studentMsg, aiMsg]);
    /* Each AI response counts as a hint — increments trigger the gold flash
       on the sidebar's hint-history-row count numeral. */
    setHintCount((n) => n + 1);
  };

  const handleSubmit = (sectionNumber: number) => {
    const systemMsg: MessageData = {
      id: `system-${Date.now()}`,
      role: "system",
      content: `· Section ${sectionNumber} submitted for grading ·`,
    };
    setMessages((prev) => [...prev, systemMsg]);

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
  };

  return (
    <div className="page-frame">
      {/* Top nav — UW Husky Purple full-bleed bar */}
      <TopNav
        course="STATS 311"
        term="Autumn 2026"
        homework="HW 3 · Probability and Distributions"
        userInitials="AC"
      />

      {/* Sidebar + main row */}
      <div className="app-shell">
        {/* Left rail — homework section progress on UW Husky Purple */}
        <Sidebar
          hwNumber={3}
          hwTitle="Probability and Distributions"
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
