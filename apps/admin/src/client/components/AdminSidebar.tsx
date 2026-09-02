/* --------------------------------------------------------------------------
   AdminSidebar — instructor's left rail.

   Replaces the student syllabus rail with admin navigation: the catalog
   sections (Homeworks, Submissions, LLM Configs, Students) plus quick
   actions. Same UW Husky Purple surface as the student sidebar so the
   brand reads as one product; different content so an instructor knows
   they're in the console.
   -------------------------------------------------------------------------- */

import {
  BookOpen,
  CaretDoubleLeft,
  CaretDoubleRight,
  ClipboardText,
  DownloadSimple,
  Flag,
  ShieldCheck,
  Sparkle,
  Users,
  Plus,
} from "@phosphor-icons/react";

export type AdminNavKey =
  | "homeworks"
  | "submissions"
  | "feedback"
  | "llm-configs"
  | "students"
  | "ta-permissions"
  | "exports";

export type AdminSidebarProps = {
  active: AdminNavKey;
  onNavigate: (key: AdminNavKey) => void;
  onNewHomework: () => void;
  onNewLLMConfig: () => void;
  /** #172: false for a TA, who may read this console but not author in it.
     The QUICK ACTIONS block and any authoring-only nav entry are omitted
     rather than shown disabled -- a disabled control still advertises an
     action the caller can never complete.

     Required, not defaulted: a permission-shaped prop that falls back to
     "allowed" when a caller forgets to thread it fails open, silently, with
     no compile error (#172 audit, MNT-003). */
  canAuthor: boolean;
  /** When true, the sidebar collapses to a 64px rail showing only icons. */
  isCollapsed?: boolean;
  /** Called when the collapse toggle is clicked. */
  onToggleCollapse?: () => void;
};

type NavItem = {
  key: AdminNavKey;
  label: string;
  icon: React.ReactNode;
  description: string;
  /** #172 audit: entries whose backing endpoint is instructor-only. Rendering
     them for a TA produced a reachable surface whose every request 403s --
     the precise defect this feature exists to remove, reintroduced at a
     different nav item. */
  authorOnly?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { key: "homeworks",    label: "Homeworks",   icon: <BookOpen size={15} weight="regular" />,      description: "Course assignments" },
  { key: "submissions",  label: "Submissions", icon: <ClipboardText size={15} weight="regular" />, description: "Student work" },
  // #90: grader-tier (requireGraderOf), same tier as Submissions directly
  // above -- not authorOnly, so a TA sees it too, matching that route's own
  // GRADER_ROLES gate.
  { key: "feedback",     label: "Feedback",    icon: <Flag size={15} weight="regular" />,          description: "Flagged tutor responses" },
  // #31: authorOnly since the configs became real. While this list was
  // fixture-driven it was harmless static data for a TA to look at; the
  // routes behind it are requireInstructorOf, so leaving the entry visible
  // would be a nav item leading to a denial -- the dead-end shape #172
  // exists to remove.
  { key: "llm-configs",  label: "LLM configs", icon: <Sparkle size={15} weight="regular" />,       description: "Tutor models", authorOnly: true },
  // #32: the roster now exists, so "Students" points at the students. Until
  // it did, #172's audit (USE-004) had to rename this entry to "TA
  // permissions" because that page was the only thing behind it -- an entry
  // labelled Students that listed the one role it does not show.
  { key: "students",     label: "Students",       icon: <Users size={15} weight="regular" />,      description: "Course roster", authorOnly: true },
  { key: "ta-permissions", label: "TA permissions", icon: <ShieldCheck size={15} weight="regular" />, description: "Grant solutions and drafts", authorOnly: true },
  { key: "exports",      label: "Export",         icon: <DownloadSimple size={15} weight="regular" />, description: "Records and transcripts", authorOnly: true },
];

export function AdminSidebar({
  active,
  onNavigate,
  onNewHomework,
  onNewLLMConfig,
  canAuthor,
  isCollapsed = false,
  onToggleCollapse,
}: AdminSidebarProps) {
  return (
    <aside
      className={isCollapsed ? "sidebar admin-sidebar sidebar--collapsed" : "sidebar admin-sidebar"}
      aria-label="Admin navigation"
    >
      {/* Collapse toggle — chevron points toward the edge the rail will move toward */}
      <div className="sidebar__top">
        <button
          className="sidebar__collapse-toggle"
          type="button"
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!isCollapsed}
          onClick={onToggleCollapse}
        >
          {isCollapsed
            ? <CaretDoubleRight size={14} weight="regular" />
            : <CaretDoubleLeft size={14} weight="regular" />}
        </button>
      </div>

      <div className="admin-sidebar__label">
        <span className="admin-sidebar__label-dot" aria-hidden="true" />
        <span className="admin-sidebar__label-text">CATALOG</span>
      </div>

      <nav className="admin-sidebar__nav">
        <ul className="admin-sidebar__nav-list">
          {NAV_ITEMS.filter((item) => canAuthor || !item.authorOnly).map((item) => {
            const isActive = item.key === active;
            return (
              <li key={item.key}>
                <button
                  type="button"
                  className={
                    isActive
                      ? "admin-sidebar__nav-item admin-sidebar__nav-item--active"
                      : "admin-sidebar__nav-item"
                  }
                  onClick={() => onNavigate(item.key)}
                  aria-current={isActive ? "page" : undefined}
                  aria-label={isCollapsed ? item.label : undefined}
                  title={isCollapsed ? item.label : undefined}
                >
                  <span className="admin-sidebar__nav-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className="admin-sidebar__nav-text">
                    <span className="admin-sidebar__nav-label">{item.label}</span>
                    <span className="admin-sidebar__nav-desc">{item.description}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {canAuthor && (
        <>
          <div className="admin-sidebar__divider" />

          <div className="admin-sidebar__quick">
            <div className="admin-sidebar__quick-label">QUICK ACTIONS</div>
            <button
              type="button"
              className="admin-sidebar__quick-action"
              onClick={onNewHomework}
              aria-label={isCollapsed ? "New homework" : undefined}
              title={isCollapsed ? "New homework" : undefined}
            >
              <Plus size={13} weight="bold" aria-hidden="true" />
              <span className="admin-sidebar__quick-action-label">New homework</span>
            </button>
            <button
              type="button"
              className="admin-sidebar__quick-action"
              onClick={onNewLLMConfig}
              aria-label={isCollapsed ? "New LLM config" : undefined}
              title={isCollapsed ? "New LLM config" : undefined}
            >
              <Plus size={13} weight="bold" aria-hidden="true" />
              <span className="admin-sidebar__quick-action-label">New LLM config</span>
            </button>
          </div>
        </>
      )}

      <div className="admin-sidebar__spacer" />

      <div className="admin-sidebar__meta">
        <span className="admin-sidebar__meta-dot" aria-hidden="true" />
        <span className="admin-sidebar__meta-text">admin · port 2312</span>
      </div>
    </aside>
  );
}
