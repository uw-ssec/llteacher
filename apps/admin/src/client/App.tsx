/* --------------------------------------------------------------------------
   LLteacher Admin — the instructor console.

   Shell composition:
     [TopNav — UW Husky Purple, mirrors the student app's chrome with
      an admin-mode indicator and a course-context breadcrumb]
     [AdminSidebar — catalog navigation (Homeworks, Submissions, LLM
      configs, Students) + quick actions]
     [Main column — the current view, switched via type-safe tagged-
      union state. Each view component is a self-contained page.]

   No router: the URL is the student app's domain, this is a bounded
   admin surface, and the view space is small enough that tagged-union
   state in a single useState beats a router dependency for now.
   -------------------------------------------------------------------------- */

import { useEffect, useState } from "react";
import { TopNav, AUTHOR_ROLES, CONSOLE_ROLES } from "@llteacher/ui";
import { AdminSidebar } from "./components/AdminSidebar";
import { AdminNotice } from "./components/AdminNotice";
import type { AdminNavKey } from "./components/AdminSidebar";
import { HomeworksView } from "./views/HomeworksView";
import type { HomeworkListItemResponse } from "./views/HomeworksView";
import { HomeworkCreateView } from "./views/HomeworkCreateView";
import { HomeworkEditView } from "./views/HomeworkEditView";
import { HomeworkReadOnlyView } from "./views/HomeworkReadOnlyView";
import { SubmissionsView } from "./views/SubmissionsView";
import { TranscriptListView } from "./views/TranscriptListView";
import type { TranscriptListData } from "./views/TranscriptListView";
import { TranscriptDetailView } from "./views/TranscriptDetailView";
import type { TranscriptDetailData } from "./views/TranscriptDetailView";
import { TaCapabilitiesView } from "./views/TaCapabilitiesView";
import { LLMConfigsView } from "./views/LLMConfigsView";
import type { LLMConfigOption } from "./components/HomeworkForm";
import {
  LLM_CONFIGS,
  CURRENT_TEACHER,
} from "./lib/fixtures";
import { useAuth, type CourseRole } from "./components/AuthProvider";
import { UnauthenticatedAdmin } from "./components/UnauthenticatedAdmin";
import { Forbidden } from "./components/Forbidden";

/* #172 audit (FLX-003/MNT-002): imported, not re-declared. These were
   hand-mirrored here with a comment warning that a disagreement with the
   server reintroduces #172's own defect -- a comment is not a mechanism.
   They now live beside COURSE_ROLES in @llteacher/ui, which both apps
   already depend on and which courseRoleParity.test.ts already guards. */
const CONSOLE_ROLE_SET: ReadonlySet<CourseRole> = new Set(CONSOLE_ROLES);
const AUTHOR_ROLE_SET: ReadonlySet<CourseRole> = new Set(AUTHOR_ROLES);

/* localStorage key for the admin sidebar collapsed preference. Namespaced
   separately from the student app — different surface, different user,
   different optimal default. The "llteacher:" prefix avoids colliding
   with any other app on the same origin. */
const SIDEBAR_COLLAPSED_KEY = "llteacher:admin-sidebar-collapsed";

/* The view-state machine. Adding a view = adding a discriminated case. */
type View =
  | { kind: "homeworks" }
  | { kind: "create-homework" }
  | { kind: "edit-homework"; homeworkId: string }
  | { kind: "submissions"; homeworkId: string }
  // #29/#23: reached only via a SubmissionsView cell drill-in today, so
  // homeworkId (for the "back" hop past the list, straight to submissions)
  // and sectionId/studentId (the list's own filter) are always known at the
  // point this state is created. `offset` lives here, not as separate
  // useState in the list view, so navigating away and back (e.g. opening a
  // transcript, then going back) preserves which page was showing.
  | { kind: "transcript-list"; homeworkId: string; sectionId: string; studentId: string; offset: number }
  | {
      kind: "transcript-detail";
      conversationId: string;
      /** Exactly the transcript-list state to return to on "back". */
      list: { homeworkId: string; sectionId: string; studentId: string; offset: number };
    }
  | { kind: "llm-configs" }
  | { kind: "students" };

const NAV_BREADCRUMB: Record<View["kind"], string> = {
  "homeworks":          "Instructor Console · Homeworks",
  "create-homework":    "Instructor Console · New Homework",
  "edit-homework":      "Instructor Console · Edit Homework",
  "submissions":        "Instructor Console · Submissions",
  "transcript-list":    "Instructor Console · Transcripts",
  "transcript-detail":  "Instructor Console · Transcript",
  "llm-configs":        "Instructor Console · LLM Configs",
  "students":           "Instructor Console · TA permissions",
};

export default function App() {
  const { isAuthenticated, loading: authLoading, error: authError, role, courses, login, logout } =
    useAuth();

  // Stopgap: this app assumes exactly one course everywhere else today
  // (TopNav's hardcoded course="STATS 311" string) -- courses[0] matches
  // that existing assumption rather than inventing a switcher here. Real
  // multi-course support (picker, deep-linked course context, persisted
  // selection) is issue #70; when that lands, replace this with real
  // course-scoped navigation. See Resolved Design Decision 8 in the M3 plan
  // for the full reasoning. An instructor with zero courses (a genuine edge
  // case, e.g. a brand-new admin account before any course assignment)
  // sees the "No course found" empty state below rather than a broken form.
  const CURRENT_COURSE = courses[0];
  const CURRENT_COURSE_ID = CURRENT_COURSE?.id;

  /* #172: authoring is decided per course, not by the priority-ranked
     top-level `role`. Someone who instructs course A and assists on course B
     must not be shown authoring controls while B is the active course. */
  const canAuthor = CURRENT_COURSE ? AUTHOR_ROLE_SET.has(CURRENT_COURSE.role) : false;

  const [view, setView] = useState<View>({ kind: "homeworks" });

  // The homework create/edit form's "LLM config" picker needs the course's
  // *real* llm_configs UUIDs -- it used to render the LLM_CONFIGS fixture's
  // placeholder ids ("llm-001" etc.), which updateHomeworkHandler correctly
  // rejects as not-a-UUID (400) on save. That PATCH failure landed after the
  // homework's bare POST had already succeeded, so a save that picked
  // anything but "(course/org default)" looked like a total failure while
  // actually leaving an incomplete homework behind. Fetched once per course,
  // same "no cache layer to hook into" reasoning as HomeworksDataLoader.
  const [llmConfigOptions, setLlmConfigOptions] = useState<LLMConfigOption[]>([]);
  useEffect(() => {
    if (!CURRENT_COURSE_ID) return;
    fetch(`/api/courses/${CURRENT_COURSE_ID}/llm-configs`)
      .then((r) => { if (!r.ok) throw new Error("failed"); return r.json(); })
      .then((data: { llmConfigs: { id: string; provider: string; modelName: string; isDefault: boolean }[] }) => {
        setLlmConfigOptions(
          data.llmConfigs.map((cfg) => ({
            id: cfg.id,
            name: `${cfg.provider} · ${cfg.modelName}${cfg.isDefault ? " (org default)" : ""}`,
          })),
        );
      })
      .catch(() => {
        /* Leave empty -- the picker still offers "(course/org default)",
           which is always valid, so a failed fetch degrades to "instructors
           can't pick a specific config right now" rather than blocking
           homework creation entirely. */
      });
  }, [CURRENT_COURSE_ID]);

  /* Sidebar collapse persists across reloads via localStorage. Lazy
     initializer reads on first render; the effect below writes on change.
     The try/catch handles private mode where storage throws. */
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(isSidebarCollapsed));
    } catch {
      /* private mode / quota — ignore */
    }
  }, [isSidebarCollapsed]);

  const navKey: AdminNavKey =
    view.kind === "submissions" || view.kind === "transcript-list" || view.kind === "transcript-detail"
      ? "submissions"
      : view.kind === "create-homework" || view.kind === "edit-homework"
        ? "homeworks"
        : (view.kind as AdminNavKey);

  const navigate = (key: AdminNavKey) => {
    if (key === "submissions") {
      /* No homework selected → default to the active homework. Fetches
         the real list fresh (mirrors HomeworksDataLoader/SubmissionsData
         Loader's per-need fetch pattern -- no app-level cache elsewhere
         in this codebase to hook into) rather than falling back to the
         HOMEWORKS fixture, whose ids aren't real UUIDs and would 400
         against the real submissions endpoint. */
      if (!CURRENT_COURSE_ID) return;
      fetch(`/api/courses/${CURRENT_COURSE_ID}/homeworks`)
        .then((r) => { if (!r.ok) throw new Error("failed"); return r.json(); })
        .then((data: { homeworks: HomeworkListItemResponse[] }) => {
          const active = data.homeworks.find((h) => h.status === "active") ?? data.homeworks[0];
          if (active) setView({ kind: "submissions", homeworkId: active.id });
        })
        .catch(() => {
          /* No general-purpose error affordance in this shell (matches
             the student app's own documented choice in App.tsx) -- stay
             on the current view rather than navigating to a broken one. */
        });
    } else {
      setView({ kind: key } as View);
    }
  };

  const initials = CURRENT_TEACHER.name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2);

  if (authLoading) return null;
  if (!isAuthenticated) return <UnauthenticatedAdmin onLogin={login} error={authError} />;
  if (!role || !CONSOLE_ROLE_SET.has(role)) return <Forbidden userInitials={initials} onLogout={logout} />;

  /* .page-frame (not a bespoke admin wrapper) — the 100vh/overflow-hidden
     outer shell the student app uses. Without it the sidebar has no height
     to fill, so the rail only stretches as far as the main column's content
     and the whole page scrolls as one. */
  return (
    <div className="page-frame">
      {/* Shared TopNav with admin mode. The Heritage Gold dot + "Admin"
          marker in the affiliation tag is the at-a-glance "instructor
          console" cue; the trailing breadcrumb segment names the view. */}
      <TopNav
        course="STATS 311"
        term="Autumn 2026"
        homework={NAV_BREADCRUMB[view.kind]}
        userInitials={initials}
        admin
        isAuthenticated={isAuthenticated}
        onLogout={logout}
      />

      <div className="app-shell">
        <AdminSidebar
          active={navKey}
          onNavigate={navigate}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={() => setIsSidebarCollapsed((c) => !c)}
          canAuthor={canAuthor}
          onNewHomework={() => setView({ kind: "create-homework" })}
          onNewLLMConfig={() => {
            // eslint-disable-next-line no-console
            console.log("[admin] new LLM config — form view not yet implemented");
          }}
        />

        <main className="conversation-column admin-main">
          <div className="conversation-messages">
            <div className="conversation-inner admin-inner">
              {view.kind === "homeworks" && (
                CURRENT_COURSE_ID ? (
                  <HomeworksDataLoader
                    courseId={CURRENT_COURSE_ID}
                    onOpenHomework={(id) => setView({ kind: "edit-homework", homeworkId: id })}
                    onOpenSubmissions={(id) => setView({ kind: "submissions", homeworkId: id })}
                    canAuthor={canAuthor}
                    canViewDrafts={CURRENT_COURSE?.canViewDrafts === true}
                    onNewHomework={() => setView({ kind: "create-homework" })}
                  />
                ) : (
                  <EmptyView label="No course found for your account yet" body={NO_COURSE_BODY} />
                )
              )}

              {/* #172: the authoring views are unreachable for a non-author
                  through the UI (every entry point is gated on canAuthor),
                  but they're guarded here too so a stale view state can't
                  render a form whose every save 403s -- the precise failure
                  this issue exists to remove. */}
              {view.kind === "create-homework" && (
                !canAuthor ? (
                  <EmptyView
                    label="You do not have permission to create homeworks in this course"
                    body={NOT_INSTRUCTOR_BODY}
                  />
                ) : CURRENT_COURSE_ID ? (
                  <HomeworkCreateView
                    courseId={CURRENT_COURSE_ID}
                    llmConfigs={llmConfigOptions}
                    onCreated={() => setView({ kind: "homeworks" })}
                    onCancel={() => setView({ kind: "homeworks" })}
                  />
                ) : (
                  <EmptyView label="No course found for your account yet" body={NO_COURSE_BODY} />
                )
              )}

              {/* #172 audit (FUN-002): a non-author opening a homework gets a
                  read-only view, not a dead end. Without it a granted
                  can_view_solutions had no surface anywhere in the product --
                  the API returned the solution and nothing rendered it. */}
              {view.kind === "edit-homework" && (
                !CURRENT_COURSE_ID ? (
                  <EmptyView label="No course found for your account yet" body={NO_COURSE_BODY} />
                ) : !canAuthor ? (
                  <HomeworkReadOnlyView
                    courseId={CURRENT_COURSE_ID}
                    homeworkId={view.homeworkId}
                    onBack={() => setView({ kind: "homeworks" })}
                    canViewSolutions={CURRENT_COURSE?.canViewSolutions === true}
                  />
                ) : (
                  /* #202 (MNT-027): no third CURRENT_COURSE_ID test. The
                     first branch already returned for a falsy id, so the
                     trailing EmptyView was unreachable -- and reading as
                     though the id could still be absent here invites further
                     defensive handling that is equally dead. */
                  <HomeworkEditView
                    courseId={CURRENT_COURSE_ID}
                    homeworkId={view.homeworkId}
                    llmConfigs={llmConfigOptions}
                    onSaved={() => setView({ kind: "homeworks" })}
                    onCancel={() => setView({ kind: "homeworks" })}
                  />
                )
              )}

              {view.kind === "submissions" && (
                CURRENT_COURSE_ID ? (
                  <SubmissionsDataLoader
                    courseId={CURRENT_COURSE_ID}
                    homeworkId={view.homeworkId}
                    onBack={() => setView({ kind: "homeworks" })}
                    onOpenTranscript={(sectionId, studentId) =>
                      setView({ kind: "transcript-list", homeworkId: view.homeworkId, sectionId, studentId, offset: 0 })
                    }
                  />
                ) : (
                  <EmptyView label="No course found for your account yet" body={NO_COURSE_BODY} />
                )
              )}

              {/* #29/#23: per-cell conversation list -> transcript, reached
                  from a SubmissionsView cell drill-in. */}
              {view.kind === "transcript-list" && (
                CURRENT_COURSE_ID ? (
                  <TranscriptListDataLoader
                    courseId={CURRENT_COURSE_ID}
                    sectionId={view.sectionId}
                    studentId={view.studentId}
                    offset={view.offset}
                    onBack={() => setView({ kind: "submissions", homeworkId: view.homeworkId })}
                    onChangeOffset={(offset) => setView({ ...view, offset })}
                    onOpenTranscript={(conversationId) =>
                      setView({
                        kind: "transcript-detail",
                        conversationId,
                        list: { homeworkId: view.homeworkId, sectionId: view.sectionId, studentId: view.studentId, offset: view.offset },
                      })
                    }
                  />
                ) : (
                  <EmptyView label="No course found for your account yet" body={NO_COURSE_BODY} />
                )
              )}

              {view.kind === "transcript-detail" && (
                CURRENT_COURSE_ID ? (
                  <TranscriptDetailDataLoader
                    courseId={CURRENT_COURSE_ID}
                    conversationId={view.conversationId}
                    onBack={() => setView({ kind: "transcript-list", ...view.list })}
                  />
                ) : (
                  <EmptyView label="No course found for your account yet" body={NO_COURSE_BODY} />
                )
              )}

              {view.kind === "llm-configs" && (
                <LLMConfigsView
                  configs={LLM_CONFIGS}
                  onOpenConfig={(id) => {
                    // eslint-disable-next-line no-console
                    console.log("[admin] open config", id);
                  }}
                  onNewConfig={() => {
                    // eslint-disable-next-line no-console
                    console.log("[admin] new LLM config");
                  }}
                />
              )}

              {/* #172 audit: instructor-only. The nav entry is filtered for
                  a TA, and the route is guarded too so a stale view state
                  can't land them on a surface whose only fetch 403s. */}
              {view.kind === "students" && (
                !canAuthor ? (
                  <EmptyView
                    label="Only instructors can manage TA permissions in this course"
                    body={NOT_INSTRUCTOR_BODY}
                  />
                ) : CURRENT_COURSE_ID ? (
                  <TaCapabilitiesView courseId={CURRENT_COURSE_ID} courseTitle={CURRENT_COURSE.title} />
                ) : (
                  <EmptyView label="No course found for your account yet" body={NO_COURSE_BODY} />
                )
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function HomeworksDataLoader({
  courseId,
  onOpenHomework,
  onOpenSubmissions,
  onNewHomework,
  canAuthor,
  canViewDrafts,
}: {
  courseId: string;
  onOpenHomework: (id: string) => void;
  onOpenSubmissions: (id: string) => void;
  onNewHomework: () => void;
  canAuthor: boolean;
  canViewDrafts: boolean;
}) {
  const [homeworks, setHomeworks] = useState<HomeworkListItemResponse[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  /* Bumped by the notice's retry action to re-run the effect. */
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setLoadError(false);
    fetch(`/api/courses/${courseId}/homeworks`)
      .then((r) => {
        if (!r.ok) throw new Error("failed");
        return r.json();
      })
      .then((data) => setHomeworks(data.homeworks))
      .catch(() => setLoadError(true));
  }, [courseId, attempt]);
  if (loadError)
    return (
      <AdminNotice
        eyebrow="Could not load"
        title="The homework list didn't load"
        body="The console reached the server but the course's homeworks came back empty-handed. This is usually a dropped connection rather than missing data — retrying is safe."
        detail={`GET /api/courses/${courseId}/homeworks`}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  if (!homeworks) return null;
  return (
    <HomeworksView
      homeworks={homeworks}
      onOpenHomework={onOpenHomework}
      onOpenSubmissions={onOpenSubmissions}
      onNewHomework={onNewHomework}
      canAuthor={canAuthor}
      canViewDrafts={canViewDrafts}
    />
  );
}

function SubmissionsDataLoader({
  courseId,
  homeworkId,
  onBack,
  onOpenTranscript,
}: {
  courseId: string;
  homeworkId: string;
  onBack: () => void;
  onOpenTranscript: (sectionId: string, studentId: string) => void;
}) {
  const [data, setData] = useState<import("./views/SubmissionsView").HomeworkSubmissionsData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setData(null); // clear stale data from a previously-open homework before the new fetch resolves
    setLoadError(false);
    fetch(`/api/courses/${courseId}/homeworks/${homeworkId}/submissions`)
      .then((r) => {
        if (!r.ok) throw new Error("failed");
        return r.json();
      })
      .then(setData)
      .catch(() => setLoadError(true));
  }, [courseId, homeworkId, attempt]);
  if (loadError)
    return (
      <AdminNotice
        eyebrow="Could not load"
        title="Submissions didn't load"
        body="Student work for this homework couldn't be fetched. Nothing has been altered — the records are intact on the server."
        detail={`GET /api/courses/${courseId}/homeworks/${homeworkId}/submissions`}
        onRetry={() => setAttempt((n) => n + 1)}
        secondaryAction={{ label: "Back to homeworks", onClick: onBack }}
      />
    );
  if (!data) return null;
  return <SubmissionsView data={data} onBack={onBack} onOpenTranscript={onOpenTranscript} />;
}

/** #29/#23: the (student, section) conversation list a submissions-matrix
 *  cell drills into. Same "presentational view + this loader fetches"
 *  split as SubmissionsDataLoader/SubmissionsView just above.
 *
 *  contextLabel (the header's "Ada Lovelace · Section 2" line) is derived
 *  from the first returned item rather than threaded down from
 *  SubmissionsView -- the matrix cell only carries ids, and this loader
 *  already has the real, decrypted studentName/sectionTitle the moment the
 *  fetch resolves, so deriving it here avoids a second round trip just to
 *  look up display names for a header. Falls back to no label (the view's
 *  own "Conversation transcripts" default title) when the page is empty --
 *  a section/student pair listed in the matrix as "missing" is not
 *  reachable through the drill-in (SubmissionsView only makes a cell
 *  clickable when conversationCount > 0), so this is a defensive fallback,
 *  not an expected path. */
function TranscriptListDataLoader({
  courseId,
  sectionId,
  studentId,
  offset,
  onBack,
  onChangeOffset,
  onOpenTranscript,
}: {
  courseId: string;
  sectionId: string;
  studentId: string;
  offset: number;
  onBack: () => void;
  onChangeOffset: (offset: number) => void;
  onOpenTranscript: (conversationId: string) => void;
}) {
  const [data, setData] = useState<TranscriptListData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setData(null);
    setLoadError(false);
    const params = new URLSearchParams({ sectionId, studentId, offset: String(offset) });
    fetch(`/api/courses/${courseId}/instructor/transcripts?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error("failed");
        return r.json();
      })
      .then(setData)
      .catch(() => setLoadError(true));
  }, [courseId, sectionId, studentId, offset, attempt]);
  if (loadError)
    return (
      <AdminNotice
        eyebrow="Could not load"
        title="Transcripts didn't load"
        body="This student's conversations for this section couldn't be fetched. Nothing has been altered — the records are intact on the server."
        detail={`GET /api/courses/${courseId}/instructor/transcripts`}
        onRetry={() => setAttempt((n) => n + 1)}
        secondaryAction={{ label: "Back to submissions", onClick: onBack }}
      />
    );
  if (!data) return null;
  const first = data.items[0];
  const contextLabel = first ? `${first.studentName || "(unnamed student)"} · ${first.sectionTitle}` : undefined;
  return (
    <TranscriptListView
      data={data}
      contextLabel={contextLabel}
      onBack={onBack}
      onOpenTranscript={onOpenTranscript}
      onChangeOffset={onChangeOffset}
    />
  );
}

/** #29: one conversation's read-only transcript. Same loader/view split. */
function TranscriptDetailDataLoader({
  courseId,
  conversationId,
  onBack,
}: {
  courseId: string;
  conversationId: string;
  onBack: () => void;
}) {
  const [data, setData] = useState<TranscriptDetailData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setData(null);
    setLoadError(false);
    fetch(`/api/courses/${courseId}/instructor/transcripts/${conversationId}`)
      .then((r) => {
        if (!r.ok) throw new Error("failed");
        return r.json();
      })
      .then(setData)
      .catch(() => setLoadError(true));
  }, [courseId, conversationId, attempt]);
  if (loadError)
    return (
      <AdminNotice
        eyebrow="Could not load"
        title="This transcript didn't load"
        body="The conversation couldn't be fetched. Nothing has been altered — the record is intact on the server."
        detail={`GET /api/courses/${courseId}/instructor/transcripts/${conversationId}`}
        onRetry={() => setAttempt((n) => n + 1)}
        secondaryAction={{ label: "Back", onClick: onBack }}
      />
    );
  if (!data) return null;
  return <TranscriptDetailView data={data} onBack={onBack} />;
}

/* #186 (#172 re-audit, USE-026): `body` is explicit and NOT defaulted to the
   scaffolding sentence.

   This component was written for genuinely unbuilt views, and its fixed body
   read "This view is scaffolded in the navigation but not yet implemented.
   Wire it next -- the data shape lives in lib/fixtures.ts." #172 then reused
   it for permission and no-course states, so a TA refused the TA-permissions
   page was told the feature does not exist and handed an internal file path.
   They would reasonably tell their instructor not to look for it -- and the
   instructor is the one person who could have granted them access.

   Defaulting to no body rather than to the old text is deliberate: a call
   site that forgets to say why the view is empty shows nothing, which is
   merely unhelpful, instead of asserting something false.

   The scaffolding sentence itself is gone, not parameterised: every remaining
   call site is a permission or no-course state, so it had no honest user
   left. Reinstate it as a `body` prop if a genuinely stubbed view returns. */
function EmptyView({ label, body }: { label: string; body?: React.ReactNode }) {
  return (
    <div className="admin-coming-soon">
      <div className="admin-coming-soon__mark" aria-hidden="true">¶</div>
      <h2 className="admin-coming-soon__title">{label}</h2>
      {body && <p className="admin-coming-soon__body">{body}</p>}
    </div>
  );
}

/** Shared copy for the two states #172 introduced, so the same situation
 *  reads the same way wherever it is reached. */
const NO_COURSE_BODY =
  "Your account is not attached to a course yet. Contact your program administrator.";
const NOT_INSTRUCTOR_BODY =
  "Ask the course instructor to grant you access, or switch to a course where you are the instructor.";
