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

export function FeedbackDashboard({ data, onBack, onOpenTranscript, onChangeOffset }: FeedbackDashboardProps) {
  const pageStart = data.total === 0 ? 0 : data.offset + 1;
  const pageEnd = Math.min(data.offset + data.limit, data.total);
  const canPrev = data.offset > 0;
  const canNext = pageEnd < data.total;

  const reasonCounts: Record<FeedbackReason, number> = {
    incorrect: 0,
    gave_away_answer: 0,
    confusing: 0,
    other: 0,
  };
  for (const item of data.items) reasonCounts[item.reason] += 1;

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
        <div className="admin-filter-row" aria-label="Reason breakdown (this page)">
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
            className="admin-button admin-button--ghost"
            onClick={() => onChangeOffset(Math.max(0, data.offset - data.limit))}
            disabled={!canPrev}
          >
            <CaretLeft size={14} weight="regular" aria-hidden="true" />
            Previous
          </button>
          <button
            type="button"
            className="admin-button admin-button--ghost"
            onClick={() => onChangeOffset(data.offset + data.limit)}
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
