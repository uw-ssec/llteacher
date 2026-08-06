/* --------------------------------------------------------------------------
   SubmissionsView — student-by-student submission dashboard for a single
   homework.

   The most distinctive admin view: a roster of students with per-section
   progress visualized as a row of small markers. Three quick-filter
   chips at the top (All / Active / No interaction) act on a single
   data set with no remote round-trip.

   Local types mirror apps/web's HomeworkSubmissionsMatrix/StudentSubmissionRow/
   SubmissionCell/ParticipationStatus (Tasks 19-20) -- apps/admin never
   imports from apps/web (the only cross-package import anywhere in
   apps/admin/src is @llteacher/ui), so these are the contract, same
   convention as lib/fixtures.ts's own header comment.
   -------------------------------------------------------------------------- */

import { useMemo, useState } from "react";
import { ArrowLeft, ChatCircleDots, ClipboardText, Warning } from "@phosphor-icons/react";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";

export type ParticipationStatus = "no_interaction" | "partial" | "active";

export interface SubmissionCell {
  sectionId: string;
  status: "missing" | "in_progress" | "submitted";
  conversationCount: number;
  lastActivityAt: string | null;
  hasDeletedConversation: boolean;
}

export interface StudentSubmissionRow {
  studentId: string;
  displayName: string;
  email: string;
  sections: SubmissionCell[];
  totalConversations: number;
  submissionCount: number;
  participationStatus: ParticipationStatus;
  lastActivityAt: string | null;
}

export interface HomeworkSubmissionsData {
  homeworkId: string;
  homeworkTitle: string;
  homeworkDueDate: string;
  sectionHeaders: { id: string; order: number; title: string }[];
  students: StudentSubmissionRow[];
  aggregateStats: {
    totalStudents: number; activeStudents: number; inactiveStudents: number;
    totalSubmissions: number; submissionRate: number;
  };
}

export type SubmissionsViewProps = {
  data: HomeworkSubmissionsData;
  onBack: () => void;
};

type Filter = "all" | "active" | "no_interaction";

const STATUS_LABEL: Record<ParticipationStatus, string> = {
  active: "active",
  partial: "partial",
  no_interaction: "no interaction",
};

function initialsFor(displayName: string): string {
  return displayName.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase() || "?";
}

export function SubmissionsView({ data, onBack }: SubmissionsViewProps) {
  const [filter, setFilter] = useState<Filter>("all");

  const counts = useMemo(() => ({
    total: data.students.length,
    active: data.students.filter((r) => r.participationStatus === "active").length,
    partial: data.students.filter((r) => r.participationStatus === "partial").length,
    no_interaction: data.students.filter((r) => r.participationStatus === "no_interaction").length,
  }), [data.students]);

  const filtered = useMemo(() => {
    if (filter === "all") return data.students;
    if (filter === "active") return data.students.filter((r) => r.participationStatus === "active");
    return data.students.filter((r) => r.participationStatus === "no_interaction");
  }, [data.students, filter]);

  return (
    <div className="admin-view">
      <button type="button" className="admin-back" onClick={onBack}>
        <ArrowLeft size={14} weight="regular" aria-hidden="true" />
        All homeworks
      </button>

      <PageHeader
        eyebrow="SUBMISSIONS"
        title={data.homeworkTitle}
        subtitle={`${data.sectionHeaders.length} sections · due ${new Date(data.homeworkDueDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`}
      />

      {counts.no_interaction > 0 && (
        <div className="admin-alert" role="status">
          <span className="admin-alert__icon" aria-hidden="true">
            <Warning size={16} weight="regular" />
          </span>
          <span>
            <strong>{counts.no_interaction}</strong>{" "}
            {counts.no_interaction === 1 ? "student has" : "students have"} not started this homework.
          </span>
        </div>
      )}

      <div className="admin-stat-row" role="list" aria-label="Submission summary">
        <div className="admin-stat" role="listitem">
          <div className="admin-stat__label">Total students</div>
          <div className="admin-stat__value">{counts.total}</div>
        </div>
        <div className="admin-stat" role="listitem">
          <div className="admin-stat__label">Active</div>
          <div className="admin-stat__value">{counts.active}</div>
        </div>
        <div className="admin-stat" role="listitem">
          <div className="admin-stat__label">Partial</div>
          <div className="admin-stat__value">{counts.partial}</div>
        </div>
        <div className="admin-stat" role="listitem">
          <div className="admin-stat__label">No interaction</div>
          <div className="admin-stat__value">{counts.no_interaction}</div>
        </div>
      </div>

      <div className="admin-filter-row" role="tablist" aria-label="Filter students">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")} label="All" count={counts.total} />
        <FilterChip active={filter === "active"} onClick={() => setFilter("active")} label="Active" count={counts.active} />
        <FilterChip active={filter === "no_interaction"} onClick={() => setFilter("no_interaction")} label="No interaction" count={counts.no_interaction} />
      </div>

      <section className="admin-record-list" aria-label="Student submissions">
        <header className="admin-submission-row admin-submission-row--head" aria-hidden="true">
          <div className="admin-submission-row__avatar" />
          <div className="admin-submission-row__name">Student</div>
          <div className="admin-submission-row__grid">Sections</div>
          <div className="admin-submission-row__conv">Conversations</div>
          <div className="admin-submission-row__status">Status</div>
          <div className="admin-submission-row__activity">Last activity</div>
        </header>

        {filtered.map((row, idx) => (
          <article key={row.studentId} className="admin-submission-row admin-record-row--enterable" style={{ animationDelay: `${idx * 40}ms` }}>
            <div className="admin-submission-row__avatar">
              <span aria-hidden="true">{initialsFor(row.displayName)}</span>
            </div>
            <div className="admin-submission-row__name">
              <span className="admin-submission-row__name-label">{row.displayName}</span>
              <span className="admin-submission-row__name-id">{row.email}</span>
            </div>
            <div className="admin-submission-row__grid" role="group" aria-label="Section progress">
              {data.sectionHeaders.map((header) => {
                const cell = row.sections.find((c) => c.sectionId === header.id);
                // cell.status is already one of "missing"|"in_progress"|"submitted" --
                // the same 3 values the existing admin-progress-cell--* CSS classes
                // expect (unchanged from the fixture-era shape), so no translation needed.
                const state = cell?.status ?? "missing";
                return (
                  <span
                    key={header.id}
                    className={`admin-progress-cell admin-progress-cell--${state}`}
                    aria-label={`${header.title}: ${state}${cell?.hasDeletedConversation ? " (has a deleted conversation)" : ""}`}
                    title={`${header.title}: ${state}${cell?.hasDeletedConversation ? " -- includes a deleted conversation" : ""}`}
                  >
                    {header.order}
                    {cell?.hasDeletedConversation && <sup aria-hidden="true">†</sup>}
                  </span>
                );
              })}
            </div>
            <div className="admin-submission-row__conv">
              <ChatCircleDots size={13} weight="regular" aria-hidden="true" />
              {row.totalConversations}
            </div>
            <div className="admin-submission-row__status">
              <StatusBadge kind={row.participationStatus}>{STATUS_LABEL[row.participationStatus]}</StatusBadge>
            </div>
            <div className="admin-submission-row__activity">
              {row.lastActivityAt
                ? new Date(row.lastActivityAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
                : <span className="admin-muted">—</span>}
            </div>
          </article>
        ))}

        {filtered.length === 0 && (
          <div className="admin-empty">
            <ClipboardText size={22} weight="regular" aria-hidden="true" />
            <p>No students match this filter.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function FilterChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button type="button" className={active ? "admin-filter admin-filter--active" : "admin-filter"} onClick={onClick} role="tab" aria-selected={active}>
      <span className="admin-filter__label">{label}</span>
      <span className="admin-filter__count">{count}</span>
    </button>
  );
}
