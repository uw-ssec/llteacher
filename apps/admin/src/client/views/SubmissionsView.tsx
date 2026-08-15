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
import { ListControls, searchRows } from "@llteacher/ui";
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
  missingSectionWarnings: { sectionId: string; sectionTitle: string; missingStudentCount: number }[];
  aggregateStats: {
    totalStudents: number; activeStudents: number; inactiveStudents: number;
    totalSubmissions: number; submissionRate: number;
  };
}

export type SubmissionsViewProps = {
  data: HomeworkSubmissionsData;
  onBack: () => void;
};

type Filter = "all" | ParticipationStatus;

const STATUS_LABEL: Record<ParticipationStatus, string> = {
  active: "active",
  partial: "partial",
  no_interaction: "no interaction",
};

function initialsFor(displayName: string): string {
  return displayName.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase() || "?";
}

type Sort = "name" | "activity" | "progress";

const SORT_OPTIONS = [
  { value: "name", label: "Name (A–Z)" },
  { value: "activity", label: "Last activity" },
  { value: "progress", label: "Least progress first" },
];

export function SubmissionsView({ data, onBack }: SubmissionsViewProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("name");

  const counts = useMemo(() => ({
    total: data.students.length,
    active: data.students.filter((r) => r.participationStatus === "active").length,
    partial: data.students.filter((r) => r.participationStatus === "partial").length,
    no_interaction: data.students.filter((r) => r.participationStatus === "no_interaction").length,
  }), [data.students]);

  /* Filter, then sort, then search -- in that order, deliberately. Search
     ranks its own results by how well they matched, so sorting afterwards
     would throw that ranking away; running it last lets the chosen sort act
     as the tiebreak within each rank bucket instead. */
  const visible = useMemo(() => {
    const byStatus =
      filter === "all"
        ? data.students
        : data.students.filter((r) => r.participationStatus === filter);

    const sorted = [...byStatus].sort((a, b) => {
      if (sort === "name") return a.displayName.localeCompare(b.displayName);
      if (sort === "progress") return a.submissionCount - b.submissionCount;
      // Most recent first, and students who have never touched it sort last
      // rather than first -- a null is "no activity ever", not "activity at
      // the epoch".
      if (!a.lastActivityAt && !b.lastActivityAt) return 0;
      if (!a.lastActivityAt) return 1;
      if (!b.lastActivityAt) return -1;
      return b.lastActivityAt.localeCompare(a.lastActivityAt);
    });

    return searchRows(sorted, query, { fields: (r) => [r.displayName, r.email] });
  }, [data.students, filter, sort, query]);

  const studentNoun = data.students.length === 1 ? "student" : "students";
  const summary =
    visible.length === data.students.length
      ? `${data.students.length} ${studentNoun}`
      : `Showing ${visible.length} of ${data.students.length} ${studentNoun}`;

  return (
    <div className="admin-view">
      <button type="button" className="admin-back" onClick={onBack}>
        <ArrowLeft size={14} weight="regular" aria-hidden="true" />
        All homeworks
      </button>

      <PageHeader
        eyebrow="SUBMISSIONS"
        title={data.homeworkTitle}
        // #228: undefined locale -- Intl resolves the viewer's own runtime
        // default instead of always formatting as en-US.
        subtitle={`${data.sectionHeaders.length} sections · due ${new Date(data.homeworkDueDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`}
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

      {data.missingSectionWarnings.length > 0 && (
        <div className="admin-alert" role="status">
          <span className="admin-alert__icon" aria-hidden="true"><Warning size={16} weight="regular" /></span>
          <span>
            {data.missingSectionWarnings.map((w) => (
              <span key={w.sectionId} style={{ display: "block" }}>
                <strong>{w.missingStudentCount}</strong> {w.missingStudentCount === 1 ? "student hasn't" : "students haven't"} started "{w.sectionTitle}"
              </span>
            ))}
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

      <ListControls
        search={{
          value: query,
          onChange: setQuery,
          label: "Search students by name or email",
          placeholder: "Search students…",
        }}
        filter={{
          value: filter,
          onChange: (v) => setFilter(v as Filter),
          label: "Filter students by participation",
          options: [
            { value: "all", label: "All", count: counts.total },
            { value: "active", label: "Active", count: counts.active },
            { value: "partial", label: "Partial", count: counts.partial },
            { value: "no_interaction", label: "No interaction", count: counts.no_interaction },
          ],
        }}
        sort={{ value: sort, onChange: (v) => setSort(v as Sort), label: "Sort", options: SORT_OPTIONS }}
        summary={summary}
      />

      <section className="admin-record-list" aria-label="Student submissions">
        <header className="admin-submission-row admin-submission-row--head" aria-hidden="true">
          <div className="admin-submission-row__avatar" />
          <div className="admin-submission-row__name">Student</div>
          <div className="admin-submission-row__grid">Sections</div>
          <div className="admin-submission-row__conv">Conversations</div>
          <div className="admin-submission-row__status">Status</div>
          <div className="admin-submission-row__activity">Last activity</div>
        </header>

        {visible.map((row, idx) => (
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
                ? new Date(row.lastActivityAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
                : <span className="admin-muted">—</span>}
            </div>
          </article>
        ))}

        {/* Three distinct empty states, because they call for three different
            actions. Telling an instructor "no students match this filter"
            when nobody is enrolled sends them hunting through filters that
            were never the problem -- and the reverse, blaming enrollment for
            a typo, is worse. */}
        {visible.length === 0 && data.students.length === 0 && (
          <div className="admin-empty">
            <ClipboardText size={22} weight="regular" aria-hidden="true" />
            <p>No students are enrolled in this course yet.</p>
          </div>
        )}

        {visible.length === 0 && data.students.length > 0 && query.trim() !== "" && (
          <div className="list-empty">
            <p className="list-empty__title">No students match “{query.trim()}”</p>
            <p className="list-empty__body">
              {filter === "all"
                ? "Check the spelling, or search by email instead."
                : "The filter may be hiding them — this searches only the current filter."}
            </p>
            <button type="button" className="list-empty__action" onClick={() => { setQuery(""); setFilter("all"); }}>
              Clear search and filters
            </button>
          </div>
        )}

        {visible.length === 0 && data.students.length > 0 && query.trim() === "" && (
          <div className="list-empty">
            <p className="list-empty__title">No students match this filter</p>
            <p className="list-empty__body">
              {data.students.length} {data.students.length === 1 ? "student is" : "students are"}{" "}
              enrolled, but none are {STATUS_LABEL[filter as ParticipationStatus] ?? filter}.
            </p>
            <button type="button" className="list-empty__action" onClick={() => setFilter("all")}>
              Show all students
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

