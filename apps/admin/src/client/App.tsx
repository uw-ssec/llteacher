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
import { TopNav } from "@llteacher/ui";
import { AdminSidebar } from "./components/AdminSidebar";
import type { AdminNavKey } from "./components/AdminSidebar";
import { HomeworksView } from "./views/HomeworksView";
import { SubmissionsView } from "./views/SubmissionsView";
import { LLMConfigsView } from "./views/LLMConfigsView";
import {
  HOMEWORKS,
  LLM_CONFIGS,
  SUBMISSIONS_HW_003,
  CURRENT_TEACHER,
} from "./lib/fixtures";
import { useAuth } from "./components/AuthProvider";
import { UnauthenticatedAdmin } from "./components/UnauthenticatedAdmin";
import { Forbidden } from "./components/Forbidden";

const INSTRUCTOR_ROLES = new Set(["instructor", "ta", "admin"]);

/* localStorage key for the admin sidebar collapsed preference. Namespaced
   separately from the student app — different surface, different user,
   different optimal default. The "llteacher:" prefix avoids colliding
   with any other app on the same origin. */
const SIDEBAR_COLLAPSED_KEY = "llteacher:admin-sidebar-collapsed";

/* The view-state machine. Adding a view = adding a discriminated case. */
type View =
  | { kind: "homeworks" }
  | { kind: "submissions"; homeworkId: string }
  | { kind: "llm-configs" }
  | { kind: "students" };

const NAV_BREADCRUMB: Record<View["kind"], string> = {
  "homeworks":   "Instructor Console · Homeworks",
  "submissions": "Instructor Console · Submissions",
  "llm-configs": "Instructor Console · LLM Configs",
  "students":    "Instructor Console · Students",
};

export default function App() {
  const { isAuthenticated, loading: authLoading, error: authError, role, login, logout } =
    useAuth();

  const [view, setView] = useState<View>({ kind: "homeworks" });

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
    view.kind === "submissions" ? "submissions" : (view.kind as AdminNavKey);

  const navigate = (key: AdminNavKey) => {
    if (key === "submissions") {
      /* No homework selected → default to the active homework */
      const active = HOMEWORKS.find((h) => h.status === "active") ?? HOMEWORKS[0]!;
      setView({ kind: "submissions", homeworkId: active.id });
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
  if (!role || !INSTRUCTOR_ROLES.has(role)) return <Forbidden />;

  return (
    <div className="app-shell-vertical">
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
          onNewHomework={() => {
            /* TODO: route to HomeworkEditView when the form view lands.
               For now the click is acknowledged with a console log so the
               affordance feels live during the demo. */
            // eslint-disable-next-line no-console
            console.log("[admin] new homework — form view not yet implemented");
          }}
          onNewLLMConfig={() => {
            // eslint-disable-next-line no-console
            console.log("[admin] new LLM config — form view not yet implemented");
          }}
        />

        <main className="conversation-column admin-main">
          <div className="conversation-messages">
            <div className="conversation-inner admin-inner">
              {view.kind === "homeworks" && (
                <HomeworksView
                  homeworks={HOMEWORKS}
                  onOpenHomework={(id) => setView({ kind: "submissions", homeworkId: id })}
                  onOpenSubmissions={(id) => setView({ kind: "submissions", homeworkId: id })}
                  onNewHomework={() => {
                    // eslint-disable-next-line no-console
                    console.log("[admin] new homework — form view not yet implemented");
                  }}
                />
              )}

              {view.kind === "submissions" && (() => {
                const hw = HOMEWORKS.find((h) => h.id === view.homeworkId);
                if (!hw) return <EmptyView label="Homework not found" />;
                return (
                  <SubmissionsView
                    homework={hw}
                    rows={SUBMISSIONS_HW_003}
                    onBack={() => setView({ kind: "homeworks" })}
                  />
                );
              })()}

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

              {view.kind === "students" && (
                <EmptyView label="Course roster — coming next" />
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function EmptyView({ label }: { label: string }) {
  return (
    <div className="admin-coming-soon">
      <div className="admin-coming-soon__mark" aria-hidden="true">¶</div>
      <h2 className="admin-coming-soon__title">{label}</h2>
      <p className="admin-coming-soon__body">
        This view is scaffolded in the navigation but not yet implemented.
        Wire it next — the data shape lives in <code>lib/fixtures.ts</code>.
      </p>
    </div>
  );
}
