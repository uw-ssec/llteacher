/* --------------------------------------------------------------------------
   FeedbackDashboard — instructor review of student-flagged tutor responses
   (#90).

   One row per flag, newest first: reason, the student's optional comment, a
   plain-text preview of the exact response text as it stood at flag time
   (never a live join back to `messages` -- see responseSnapshot's own doc
   comment on the server, db/schema/runtime.ts), and a link into the FULL
   transcript. That link reuses the existing instructor transcript viewer
   (TranscriptDetailView, #29) via the same conversationId/App.tsx view-state
   plumbing SubmissionsView's own drill-in already uses -- this view renders
   no transcript of its own.

   A small reason-breakdown strip sits above the table. It counts only the
   rows on the CURRENT page (`data.items`), not every flag in the course --
   this dashboard is limit/offset-paginated the same way TranscriptListView
   is, and a true course-wide breakdown would need either a second endpoint
   or fetching every page up front, both more than a pilot-scale review
   surface needs. Labelled accordingly rather than implying a course-wide
   total it doesn't have.

   Local types mirror apps/web's CourseFeedbackListItemResponse/
   CourseFeedbackListResponse (routes/feedback.ts) -- apps/admin never
   imports from apps/web, same convention every other admin view follows
   (see SubmissionsView's own doc comment on why).

   Presentational + a `data` prop, no fetch of its own -- same split as
   every other admin{View,DataLoader} pair (SubmissionsView/
   SubmissionsDataLoader, TranscriptListView/TranscriptListDataLoader).
   -------------------------------------------------------------------------- */

import { useEffect, useRef } from "react";
import { ArrowLeft, CaretLeft, CaretRight, ClipboardText, Flag } from "@phosphor-icons/react";
import { PageHeader } from "../components/PageHeader";

export type FeedbackReason = "incorrect" | "gave_away_answer" | "confusing" | "other";

const REASON_LABELS: Record<FeedbackReason, string> = {
  incorrect: "Incorrect",
  gave_away_answer: "Gave away the answer",
  confusing: "Confusing",
  other: "Other",
};

export interface FeedbackListItem {
  id: string;
  conversationId: string;
  messageId: string | null;
  studentId: string;
  studentName: string;
  reason: FeedbackReason;
  comment: string | null;
  /** The AI SDK's UIMessage.parts shape, as persisted -- narrowed
   *  defensively by responseSnapshotPreview below, same posture
   *  TranscriptDetailView's own TranscriptMessage.parts doc comment takes. */
  responseSnapshot: unknown;
  /** #90 review (Minor #5): mirrors TranscriptListItem's own isDeleted --
   *  a soft-deleted conversation's flag stays in this list (never
   *  filtered), just marked, same "shown, flagged" rule that view's own
   *  dagger marker already renders for the identical case. */
  isDeleted: boolean;
  sectionId: string;
  sectionTitle: string;
  homeworkId: string;
  homeworkTitle: string;
  flaggedAt: string;
}

export interface FeedbackDashboardData {
  items: FeedbackListItem[];
  total: number;
  limit: number;
  offset: number;
}

export type FeedbackDashboardProps = {
  data: FeedbackDashboardData;
  onBack: () => void;
  onOpenTranscript: (item: FeedbackListItem) => void;
  onChangeOffset: (offset: number) => void;
  /** #440 audit fix (Major, Accessibility): true while App.tsx's
   *  FeedbackDashboardDataLoader has a page fetch in flight. The loader no
   *  longer unmounts this whole view between pages (it keeps rendering the
   *  previous page's `data`), so this drives a small, non-disruptive "still
   *  here" indicator instead -- the DOM (and any focus in it) stays put. */
  isFetching?: boolean;
};

/** Plain-text preview of a flagged response's snapshot -- same "text parts
 *  only, joined" extraction apps/web's messageTextOf/transcriptSnippet use
 *  server-side, duplicated here rather than imported: apps/admin never
 *  imports apps/web code (see this file's own doc comment). A row with no
 *  text part (a bare tool call) previews as "" rather than throwing. */
function responseSnapshotPreview(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter(
      (p): p is { type: "text"; text: string } =>
        typeof p === "object" &&
        p !== null &&
        (p as { type?: unknown }).type === "text" &&
        typeof (p as { text?: unknown }).text === "string",
    )
    .map((p) => p.text)
    .join(" ")
    .trim();
}

const PREVIEW_MAX_CHARS = 160;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function FeedbackDashboard({
  data,
  onBack,
  onOpenTranscript,
  onChangeOffset,
  isFetching = false,
}: FeedbackDashboardProps) {
  const pageStart = data.total === 0 ? 0 : data.offset + 1;
  const pageEnd = Math.min(data.offset + data.limit, data.total);
  const canPrev = data.offset > 0;
  const canNext = pageEnd < data.total;
  const currentPage = Math.floor(data.offset / data.limit) + 1;
  const totalPages = Math.max(1, Math.ceil(data.total / data.limit));

  const reasonCounts: Record<FeedbackReason, number> = {
    incorrect: 0,
    gave_away_answer: 0,
    confusing: 0,
    other: 0,
  };
  for (const item of data.items) reasonCounts[item.reason] += 1;

  /* #440 audit fix (Major, Accessibility) — Fix 2. Same defect class #298
   *  closed for ResponseFeedback (apps/web/src/client/components/
   *  ResponseFeedback.tsx) and App.tsx's HomeworkLoadError: a state
   *  transition that drops the focused element out of the accessibility
   *  tree in the same commit leaves nothing for focus to land on, so it
   *  falls back to <body>. There, the whole element unmounted; here, Fix 1
   *  (App.tsx's FeedbackDashboardDataLoader) stops that from happening at
   *  the view level, but a narrower version of the same defect survives at
   *  the button level: Previous/Next are `disabled={!canPrev}` /
   *  `disabled={!canNext}`, and a native `disabled` button cannot hold
   *  focus. Paging onto a boundary page (first or last) with the very
   *  button that caused the page turn still focused disables that button
   *  the instant the new page's data lands.
   *
   *  Mirrored fix, same *shape* as ResponseFeedback's: a stable, otherwise
   *  inert element (`tabIndex={-1}`) that an effect explicitly `.focus()`es
   *  the moment the boundary flips underneath the focused button. Unlike
   *  ResponseFeedback -- which detects the loss by checking whether focus
   *  has already fallen to `<body>` -- this tracks, per button, whether IT
   *  was the one last focused (via onFocus/onBlur), and reacts the instant
   *  that specific button's own `disabled` prop flips from false to true.
   *  That's deliberately independent of what the DOM's `document.
   *  activeElement` happens to read at effect time: a native `disabled`
   *  button losing focus to `<body>` is a real, spec'd browser behavior,
   *  but it isn't something every DOM implementation performs synchronously
   *  in step with React's own commit -- tying the fix to "was THIS button
   *  focused when it became disabled" holds regardless of exactly when (or
   *  whether, in a given environment) the browser gets around to blurring
   *  it. */
  const pageIndicatorRef = useRef<HTMLSpanElement>(null);
  const wasPrevFocusedRef = useRef(false);
  const wasNextFocusedRef = useRef(false);
  const prevCanPrevRef = useRef(canPrev);
  const prevCanNextRef = useRef(canNext);
  useEffect(() => {
    const prevJustDisabled = prevCanPrevRef.current && !canPrev;
    const nextJustDisabled = prevCanNextRef.current && !canNext;
    prevCanPrevRef.current = canPrev;
    prevCanNextRef.current = canNext;
    if ((prevJustDisabled && wasPrevFocusedRef.current) || (nextJustDisabled && wasNextFocusedRef.current)) {
      pageIndicatorRef.current?.focus();
    }
  }, [canPrev, canNext]);

  return (
    <div className="admin-view">
      <button type="button" className="admin-back" onClick={onBack}>
        <ArrowLeft size={14} weight="regular" aria-hidden="true" />
        Back
      </button>

      <PageHeader
        eyebrow="FEEDBACK"
        title="Flagged responses"
        subtitle={
          data.total === 0
            ? "No flags"
            : `${pageStart}–${pageEnd} of ${data.total} flag${data.total === 1 ? "" : "s"}`
        }
      />

      {data.items.length > 0 && (
        /* #440 audit fix (Minor, Usability+Accessibility) — Fix 3.
           `role="group"` (not `role="region"` -- this is a cluster of
           related counts, not a page-level landmark) so the `aria-label`
           below is reliably exposed to AT: a bare <div> with only
           `aria-label` and no role is not guaranteed to be announced as a
           group by every screen reader.
           The "(this page)" qualifier used to live ONLY in that aria-label
           -- a sighted user had no visual cue these counts are scoped to
           the current page rather than course-wide totals. The leading
           "This page:" chip below says the same thing visibly, so sighted
           and AT users get identical information; the aria-label is
           shortened to match rather than repeating the qualifier twice in
           two different wordings for AT users alone. */
        <div className="admin-filter-row" role="group" aria-label="Reason breakdown">
          {/* Plain style prop, not a new CSS class -- this task's brief scopes
              edits to this file and App.tsx only, so a modifier class with no
              stylesheet to back it isn't an option here. */}
          <span className="admin-record-row__meta-chip" style={{ opacity: 0.7 }}>
            This page:
          </span>
          {(Object.keys(REASON_LABELS) as FeedbackReason[]).map((reason) => (
            <span key={reason} className="admin-record-row__meta-chip">
              {REASON_LABELS[reason]}: {reasonCounts[reason]}
            </span>
          ))}
        </div>
      )}

      <section className="admin-record-list" aria-label="Flagged responses">
        {data.items.map((item, idx) => (
          <article
            key={item.id}
            className="admin-record-row admin-record-row--enterable"
            style={{ animationDelay: `${idx * 40}ms` }}
          >
            <div className="admin-record-row__body">
              <button
                type="button"
                className="admin-record-row__title"
                onClick={() => onOpenTranscript(item)}
              >
                <Flag size={13} weight="fill" aria-hidden="true" />
                {item.studentName || "(unnamed student)"}
                {/* #90 review (Minor #5): same dagger convention
                    TranscriptListView already uses -- a soft-deleted
                    conversation stays listed (the flag it belongs to is
                    never hidden), just marked. */}
                {item.isDeleted && (
                  <sup aria-label="deleted conversation" title="Deleted conversation">
                    †
                  </sup>
                )}
              </button>
              <div className="admin-record-row__meta">
                <span className="admin-record-row__meta-chip">{REASON_LABELS[item.reason]}</span>
                {/* #90 review (Minor #6): homeworkTitle was fetched/typed/
                    threaded all the way here and never rendered -- shown
                    alongside the section so a flag on a course with many
                    homeworks is placeable without opening the transcript. */}
                <span className="admin-record-row__meta-chip">{item.homeworkTitle}</span>
                <span className="admin-record-row__meta-chip">{item.sectionTitle}</span>
                <span className="admin-record-row__meta-chip">{formatTimestamp(item.flaggedAt)}</span>
              </div>
              <p className="admin-record-row__desc">
                {truncate(responseSnapshotPreview(item.responseSnapshot), PREVIEW_MAX_CHARS) || "(no text)"}
              </p>
              {item.comment && (
                <p className="admin-record-row__desc admin-record-row__desc--quote">
                  &ldquo;{item.comment}&rdquo;
                </p>
              )}
            </div>
          </article>
        ))}

        {data.items.length === 0 && (
          <div className="admin-empty">
            <ClipboardText size={22} weight="regular" aria-hidden="true" />
            <p>No flagged responses yet.</p>
          </div>
        )}
      </section>

      {data.total > data.limit && (
        <nav className="admin-filter-row" aria-label="Feedback pages">
          <button
            type="button"
            data-testid="feedback-prev-page"
            className="admin-button admin-button--ghost"
            onClick={() => onChangeOffset(Math.max(0, data.offset - data.limit))}
            onFocus={() => { wasPrevFocusedRef.current = true; }}
            onBlur={() => { wasPrevFocusedRef.current = false; }}
            disabled={!canPrev}
          >
            <CaretLeft size={14} weight="regular" aria-hidden="true" />
            Previous
          </button>
          {/* Fix 2's focus-restoration target (see the effect above) --
              doubles as a small visible "Page N of M" indicator, which this
              nav had no equivalent of before (only the two buttons). */}
          <span ref={pageIndicatorRef} data-testid="feedback-page-indicator" tabIndex={-1} className="admin-record-row__meta-chip">
            Page {currentPage} of {totalPages}
          </span>
          {/* Fix 1: a subtle, non-disruptive "still here" signal for a page
              fetch in flight -- NOT a disabled/opacity change on the buttons
              themselves, which would reintroduce the very focus-loss problem
              Fix 1/Fix 2 exist to remove if the button a click just fired
              from happens to still be focused. `aria-live="polite"` so a
              screen-reader user hears it without anything being forced into
              focus. */}
          <span role="status" aria-live="polite" className="admin-record-row__meta-chip" style={{ opacity: isFetching ? 1 : 0 }}>
            {isFetching ? "Loading…" : ""}
          </span>
          <button
            type="button"
            data-testid="feedback-next-page"
            className="admin-button admin-button--ghost"
            onClick={() => onChangeOffset(data.offset + data.limit)}
            onFocus={() => { wasNextFocusedRef.current = true; }}
            onBlur={() => { wasNextFocusedRef.current = false; }}
            disabled={!canNext}
          >
            Next
            <CaretRight size={14} weight="regular" aria-hidden="true" />
          </button>
        </nav>
      )}
    </div>
  );
}
