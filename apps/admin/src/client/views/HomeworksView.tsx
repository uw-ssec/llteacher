/* --------------------------------------------------------------------------
   HomeworksView — the admin's primary landing view.

   A catalog of homework records: each row anchored by its `HW·xxx` ID
   badge, with title, due date, section count, status, and a fast path
   into per-homework submissions. Records appear with a brief staggered
   entrance on first paint — subtle but enough to telegraph "this is a
   live catalog, not static documentation."
   -------------------------------------------------------------------------- */

import { useMemo, useState } from "react";
import { ArrowRight, CalendarBlank, Folder, Lock } from "@phosphor-icons/react";
import { ListControls, searchRows } from "@llteacher/ui";
import { PageHeader } from "../components/PageHeader";
import { RecordId } from "../components/RecordId";
import { StatusBadge } from "../components/StatusBadge";

/** Mirrors apps/web's `HomeworkListItemResponse` (Task 23) -- apps/admin
 *  never imports from apps/web (the only cross-package import anywhere in
 *  apps/admin/src is @llteacher/ui), so this is the contract, same
 *  convention as SubmissionsView.tsx's local types. */
export type HomeworkStatus = "draft" | "scheduled" | "active" | "past_due" | "hidden" | "archived";

export interface HomeworkListItemResponse {
  id: string;
  title: string;
  description: string;
  dueDate: string;
  llmConfigId: string | null;
  status: HomeworkStatus;
  isHidden: boolean;
  expiresAt: string | null;
  sectionCount: number;
}

export type HomeworksViewProps = {
  homeworks: HomeworkListItemResponse[];
  onOpenHomework: (id: string) => void;
  onOpenSubmissions: (id: string) => void;
  onNewHomework: () => void;
  /** #172: false for a TA. The list itself stays readable -- a TA needs it
     to reach the submissions dashboard -- but the create affordance is
     omitted, since POST /homeworks is instructor-only.

     Required, not defaulted: a permission-shaped prop defaulting to
     "allowed" fails open when a caller forgets it (#172 audit, MNT-003). */
  canAuthor: boolean;
  /** #187 (#172 re-audit, USE-022): whether the caller holds
     `can_view_drafts` in this course.

     The list route silently filters draft/scheduled/hidden homeworks out of
     the response for anyone without it, and this view rendered the filtered
     result as fact -- "N RECORDS" over a truncated list. The solutions half
     of the same grant explains itself (HomeworkReadOnlyView says so and
     names where it is granted); the drafts half did not, so a TA told
     "I've drafted HW4, take a look" simply could not see it and had no way
     to tell "not granted" from "never saved" from "the console is broken".

     Required for the same reason canAuthor is: defaulting a
     permission-shaped prop to the permissive value hides the notice from
     exactly the callers who need it. */
  canViewDrafts: boolean;
};

const STATUS_LABEL: Record<HomeworkStatus, string> = {
  active:    "active",
  draft:     "draft",
  scheduled: "scheduled",
  archived:  "archived",
  past_due:  "past due",
  hidden:    "hidden",
};

type Sort = "due" | "title" | "sections";

const SORT_OPTIONS = [
  { value: "due", label: "Due date" },
  { value: "title", label: "Title (A–Z)" },
  { value: "sections", label: "Most sections" },
];

/* Lifecycle order, so the chips read the way a homework moves through the
   quarter rather than however Map happened to see them first. */
const STATUS_ORDER: HomeworkStatus[] = ["draft", "scheduled", "active", "past_due", "archived", "hidden"];

function formatDueDate(iso: string): string {
  // The real API returns a full ISO datetime (`dueDate.toISOString()`),
  // unlike the fixture's plain YYYY-MM-DD -- parse directly rather than
  // appending a redundant time component that would double up on "Z".
  const d = new Date(iso);
  // #228: undefined locale -- Intl resolves the viewer's own runtime
  // default instead of always formatting as en-US.
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function HomeworksView({
  homeworks,
  onOpenHomework,
  onOpenSubmissions,
  onNewHomework,
  canAuthor,
  canViewDrafts,
}: HomeworksViewProps) {
  const activeCount = homeworks.filter((h) => h.status === "active").length;
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | HomeworkStatus>("all");
  const [sort, setSort] = useState<Sort>("due");

  /* Only offer statuses this list actually contains. A quarter with nothing
     archived should not show an "Archived 0" chip that can only ever empty
     the list -- the chip rail describes this course, not the schema. */
  const statusOptions = useMemo(() => {
    const present = new Map<HomeworkStatus, number>();
    for (const h of homeworks) present.set(h.status, (present.get(h.status) ?? 0) + 1);
    // One status present means the filter can only ever choose between "all"
    // and "all of them again" -- a control that cannot change the list is
    // just something else to read past.
    if (present.size < 2) return null;
    return [
      { value: "all", label: "All", count: homeworks.length },
      ...[...present.entries()]
        .sort((a, b) => STATUS_ORDER.indexOf(a[0]) - STATUS_ORDER.indexOf(b[0]))
        // STATUS_LABEL is lowercase because StatusBadge renders it uppercase
        // in CSS. Here it sits beside "All", so it needs a capital of its own.
        .map(([s, count]) => ({
          value: s,
          label: STATUS_LABEL[s].charAt(0).toUpperCase() + STATUS_LABEL[s].slice(1),
          count,
        })),
    ];
  }, [homeworks]);

  const visible = useMemo(() => {
    const byStatus = status === "all" ? homeworks : homeworks.filter((h) => h.status === status);
    const sorted = [...byStatus].sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "sections") return b.sectionCount - a.sectionCount;
      // Soonest due first: the deadline an instructor is about to face is the
      // one worth putting at the top of the page.
      return a.dueDate.localeCompare(b.dueDate);
    });
    return searchRows(sorted, query, { fields: (h) => [h.title, h.description] });
  }, [homeworks, status, sort, query]);

  const noun = homeworks.length === 1 ? "homework" : "homeworks";
  const summary =
    visible.length === homeworks.length
      ? `${homeworks.length} ${noun}`
      : `Showing ${visible.length} of ${homeworks.length} ${noun}`;

  return (
    <div className="admin-view">
      <PageHeader
        eyebrow={`HOMEWORKS · ${homeworks.length} RECORDS`}
        title="STATS 311 · Autumn 2026"
        subtitle="Assignments, sections, and the AI tutor configuration backing each homework."
        actions={
          canAuthor ? (
            <button
              type="button"
              className="admin-button admin-button--primary"
              onClick={onNewHomework}
            >
              + New homework
            </button>
          ) : undefined
        }
      />

      {!canViewDrafts && (
        // Same admin-alert + role="status" treatment as the solutions notice
        // in HomeworkReadOnlyView, so the two halves of one grant explain
        // themselves identically (#187, USE-022).
        <div className="admin-alert" role="status">
          <span className="admin-alert__icon" aria-hidden="true">
            <Lock size={16} weight="regular" />
          </span>
          <span>
            Homeworks in draft, scheduled, or hidden status are not shown. An instructor grants
            access to them per course under TA permissions.
          </span>
        </div>
      )}

      <div className="admin-stat-row" role="list" aria-label="Catalog summary">
        <div className="admin-stat" role="listitem">
          <div className="admin-stat__label">Records</div>
          <div className="admin-stat__value">{homeworks.length}</div>
        </div>
        <div className="admin-stat" role="listitem">
          <div className="admin-stat__label">Active</div>
          <div className="admin-stat__value">{activeCount}</div>
        </div>
      </div>

      <ListControls
        search={{
          value: query,
          onChange: setQuery,
          label: "Search homeworks by title or description",
          placeholder: "Search homeworks…",
        }}
        filter={
          statusOptions
            ? {
                value: status,
                onChange: (v) => setStatus(v as "all" | HomeworkStatus),
                label: "Filter homeworks by status",
                options: statusOptions,
              }
            : undefined
        }
        sort={{ value: sort, onChange: (v) => setSort(v as Sort), label: "Sort", options: SORT_OPTIONS }}
        summary={summary}
      />

      <section className="admin-record-list" aria-label="Homeworks">
        {visible.map((hw, idx) => (
          <article
            key={hw.id}
            className="admin-record-row admin-record-row--enterable"
            style={{ animationDelay: `${idx * 55}ms` }}
          >
            <div className="admin-record-row__id">
              {/* Numbered from the record's place in the FULL list, not the
                  rendered one. Indexing by render position meant a record
                  changed its own ID as soon as a filter hid a row above it,
                  which makes the badge useless as a way to refer to it. */}
              <RecordId prefix="HW" index={homeworks.indexOf(hw) + 1} />
            </div>

            <div className="admin-record-row__body">
              <button
                type="button"
                className="admin-record-row__title"
                onClick={() => onOpenHomework(hw.id)}
              >
                {hw.title}
              </button>
              {/* Status leads the meta line rather than occupying its own
                  column beside the buttons. It is an attribute of the record,
                  like the section count and the due date -- parked next to
                  Submissions/Open it read as a third action, and it was the
                  only element in the row with its own optical nudge (4px
                  against everything else's 2px), which is what made it look
                  like it was floating. First position keeps it at a fixed x
                  down the list, so a column of rows still scans. */}
              <div className="admin-record-row__meta">
                <StatusBadge kind={hw.status === "past_due" ? "past_due" : hw.status}>
                  {STATUS_LABEL[hw.status]}
                </StatusBadge>
                <span className="admin-record-row__meta-chip">
                  <Folder size={12} weight="regular" aria-hidden="true" />
                  {hw.sectionCount} {hw.sectionCount === 1 ? "section" : "sections"}
                </span>
                <span className="admin-record-row__meta-chip">
                  <CalendarBlank size={12} weight="regular" aria-hidden="true" />
                  due {formatDueDate(hw.dueDate)}
                </span>
              </div>
              <p className="admin-record-row__desc">{hw.description}</p>
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

        {/* Split by cause, not just by count. "Create your first homework" in
            front of an instructor who has twelve and mistyped a search is the
            classic version of this bug. */}
        {visible.length === 0 && homeworks.length > 0 && (
          <div className="list-empty">
            <p className="list-empty__title">
              {query.trim() ? `No homeworks match “${query.trim()}”` : "No homeworks match this filter"}
            </p>
            <p className="list-empty__body">
              {homeworks.length} {homeworks.length === 1 ? "homework is" : "homeworks are"} in this
              course.
            </p>
            <button
              type="button"
              className="list-empty__action"
              onClick={() => { setQuery(""); setStatus("all"); }}
            >
              Clear search and filters
            </button>
          </div>
        )}

        {homeworks.length === 0 && (
          <div className="admin-empty">
            <Folder size={22} weight="regular" aria-hidden="true" />
            <p>
              {canViewDrafts
                ? "No homeworks in this course yet."
                : "No published homeworks in this course yet."}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
