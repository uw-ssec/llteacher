/* --------------------------------------------------------------------------
   HomeworksView — the admin's primary landing view.

   A catalog of homework records: each row anchored by its `HW·xxx` ID
   badge, with title, due date, section count, status, and a fast path
   into per-homework submissions. Records appear with a brief staggered
   entrance on first paint — subtle but enough to telegraph "this is a
   live catalog, not static documentation."
   -------------------------------------------------------------------------- */

import { ArrowRight, CalendarBlank, ClipboardText, Folder } from "@phosphor-icons/react";
import { PageHeader } from "../components/PageHeader";
import { RecordId } from "../components/RecordId";
import { StatusBadge } from "../components/StatusBadge";
import type { Homework } from "../lib/fixtures";

export type HomeworksViewProps = {
  homeworks: Homework[];
  onOpenHomework: (id: string) => void;
  onOpenSubmissions: (id: string) => void;
  onNewHomework: () => void;
};

const STATUS_LABEL: Record<Homework["status"], string> = {
  active:    "active",
  draft:     "draft",
  scheduled: "scheduled",
  archived:  "archived",
  past_due:  "past due",
};

function formatDueDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function HomeworksView({
  homeworks,
  onOpenHomework,
  onOpenSubmissions,
  onNewHomework,
}: HomeworksViewProps) {
  const totalStudents = homeworks[0]?.studentsTotal ?? 0;
  const totalSubmissions = homeworks.reduce((s, h) => s + h.submissionsCount, 0);
  const activeCount = homeworks.filter((h) => h.status === "active").length;

  return (
    <div className="admin-view">
      <PageHeader
        eyebrow={`HOMEWORKS · ${homeworks.length} RECORDS`}
        title="STATS 311 · Autumn 2026"
        subtitle="Assignments, sections, and the AI tutor configuration backing each homework."
        actions={
          <button
            type="button"
            className="admin-button admin-button--primary"
            onClick={onNewHomework}
          >
            + New homework
          </button>
        }
      />

      <div className="admin-stat-row" role="list" aria-label="Catalog summary">
        <div className="admin-stat" role="listitem">
          <div className="admin-stat__label">Records</div>
          <div className="admin-stat__value">{homeworks.length}</div>
        </div>
        <div className="admin-stat" role="listitem">
          <div className="admin-stat__label">Active</div>
          <div className="admin-stat__value">{activeCount}</div>
        </div>
        <div className="admin-stat" role="listitem">
          <div className="admin-stat__label">Students enrolled</div>
          <div className="admin-stat__value">{totalStudents}</div>
        </div>
        <div className="admin-stat" role="listitem">
          <div className="admin-stat__label">Submissions logged</div>
          <div className="admin-stat__value">{totalSubmissions}</div>
        </div>
      </div>

      <section className="admin-record-list" aria-label="Homeworks">
        {homeworks.map((hw, idx) => (
          <article
            key={hw.id}
            className="admin-record-row admin-record-row--enterable"
            style={{ animationDelay: `${idx * 55}ms` }}
          >
            <div className="admin-record-row__id">
              <RecordId prefix="HW" index={hw.recordNumber} />
            </div>

            <div className="admin-record-row__body">
              <button
                type="button"
                className="admin-record-row__title"
                onClick={() => onOpenHomework(hw.id)}
              >
                {hw.title}
              </button>
              <div className="admin-record-row__meta">
                <span className="admin-record-row__meta-chip">
                  <Folder size={12} weight="regular" aria-hidden="true" />
                  {hw.sections.length} {hw.sections.length === 1 ? "section" : "sections"}
                </span>
                <span className="admin-record-row__meta-chip">
                  <CalendarBlank size={12} weight="regular" aria-hidden="true" />
                  due {formatDueDate(hw.dueDate)}
                </span>
                <span className="admin-record-row__meta-chip">
                  <ClipboardText size={12} weight="regular" aria-hidden="true" />
                  {hw.submissionsCount} submissions
                </span>
              </div>
              <p className="admin-record-row__desc">{hw.description}</p>
            </div>

            <div className="admin-record-row__status">
              <StatusBadge kind={hw.status === "past_due" ? "past_due" : hw.status}>
                {STATUS_LABEL[hw.status]}
              </StatusBadge>
            </div>

            <div className="admin-record-row__actions">
              <button
                type="button"
                className="admin-button admin-button--ghost"
                onClick={() => onOpenSubmissions(hw.id)}
              >
                Submissions
              </button>
              <button
                type="button"
                className="admin-button admin-button--minimal"
                onClick={() => onOpenHomework(hw.id)}
                aria-label={`Open ${hw.title}`}
              >
                Open
                <ArrowRight size={14} weight="regular" aria-hidden="true" />
              </button>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
