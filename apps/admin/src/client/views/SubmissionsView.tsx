/* --------------------------------------------------------------------------
   SubmissionsView — student-by-student submission dashboard for a single
   homework.

   The most distinctive admin view: a roster of students with per-section
   progress visualized as a row of small markers. Three quick-filter
   chips at the top (All / Active / No interaction) act on a single
   data set with no remote round-trip.
   -------------------------------------------------------------------------- */

import { useMemo, useState } from "react";
import { ArrowLeft, ChatCircleDots, ClipboardText, Warning } from "@phosphor-icons/react";
import { PageHeader } from "../components/PageHeader";
import { RecordId } from "../components/RecordId";
import { StatusBadge } from "../components/StatusBadge";
import type { Homework, SubmissionRow } from "../lib/fixtures";

export type SubmissionsViewProps = {
  homework: Homework;
  rows: SubmissionRow[];
  onBack: () => void;
};

type Filter = "all" | "active" | "no_interaction";

const STATUS_LABEL: Record<SubmissionRow["status"], string> = {
  active:         "active",
  partial:        "partial",
  no_interaction: "no interaction",
};

export function SubmissionsView({ homework, rows, onBack }: SubmissionsViewProps) {
  const [filter, setFilter] = useState<Filter>("all");

  const counts = useMemo(() => ({
    total:          rows.length,
    active:         rows.filter((r) => r.status === "active").length,
    partial:        rows.filter((r) => r.status === "partial").length,
    no_interaction: rows.filter((r) => r.status === "no_interaction").length,
  }), [rows]);

  const filtered = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "active") return rows.filter((r) => r.status === "active");
    return rows.filter((r) => r.status === "no_interaction");
  }, [rows, filter]);

  return (
    <div className="admin-view">
      <button type="button" className="admin-back" onClick={onBack}>
        <ArrowLeft size={14} weight="regular" aria-hidden="true" />
        All homeworks
      </button>

      <PageHeader
        eyebrow={
          <>
            <RecordId prefix="HW" index={homework.recordNumber} size="sm" />
            <span className="admin-page-header__eyebrow-sep" aria-hidden="true">·</span>
            SUBMISSIONS
          </>
        }
        title={homework.title}
        subtitle={`${homework.sections.length} sections · due ${new Date(homework.dueDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`}
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
        <FilterChip active={filter === "all"}            onClick={() => setFilter("all")}            label="All"            count={counts.total} />
        <FilterChip active={filter === "active"}         onClick={() => setFilter("active")}         label="Active"         count={counts.active} />
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
          <article
            key={row.studentId}
            className="admin-submission-row admin-record-row--enterable"
            style={{ animationDelay: `${idx * 40}ms` }}
          >
            <div className="admin-submission-row__avatar">
              <span aria-hidden="true">{row.studentInitials}</span>
            </div>
            <div className="admin-submission-row__name">
              <span className="admin-submission-row__name-label">{row.studentName}</span>
              <span className="admin-submission-row__name-id">{row.studentId}</span>
            </div>
            <div className="admin-submission-row__grid" role="group" aria-label="Section progress">
              {row.sectionsProgress.map((sp) => (
                <span
                  key={sp.sectionNumber}
                  className={`admin-progress-cell admin-progress-cell--${sp.state}`}
                  aria-label={`Section ${sp.sectionNumber}: ${sp.state.replace("_", " ")}`}
                  title={`Section ${sp.sectionNumber}: ${sp.state.replace("_", " ")}`}
                >
                  {sp.sectionNumber}
                </span>
              ))}
            </div>
            <div className="admin-submission-row__conv">
              <ChatCircleDots size={13} weight="regular" aria-hidden="true" />
              {row.conversationCount}
            </div>
            <div className="admin-submission-row__status">
              <StatusBadge kind={row.status}>
                {STATUS_LABEL[row.status]}
              </StatusBadge>
            </div>
            <div className="admin-submission-row__activity">
              {row.lastActivity ?? <span className="admin-muted">—</span>}
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

function FilterChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      className={active ? "admin-filter admin-filter--active" : "admin-filter"}
      onClick={onClick}
      role="tab"
      aria-selected={active}
    >
      <span className="admin-filter__label">{label}</span>
      <span className="admin-filter__count">{count}</span>
    </button>
  );
}
