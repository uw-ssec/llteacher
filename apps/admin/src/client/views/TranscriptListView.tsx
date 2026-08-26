/* --------------------------------------------------------------------------
   TranscriptListView — the per-cell conversation list an instructor lands
   on after drilling into a submission-matrix cell (#29, closing #23's own
   remaining "drill-in navigation to transcript viewer" checkbox).

   One row per section conversation the viewer may see (#246: grader tier),
   newest-activity first. Soft-deleted conversations are NOT filtered out
   here -- they're shown, flagged -- a different rule than the student-facing
   conversation list, which does filter them (see this view's own "Deleted"
   marker below, the same dagger convention SubmissionsView's own
   hasDeletedConversation badge already uses, rather than inventing a second
   visual language for the same fact).

   Presentational + a `data` prop, no fetch of its own -- same split as
   SubmissionsView/SubmissionsDataLoader in App.tsx, which this view's own
   drill-in flow extends by one more hop (submissions -> transcript list ->
   transcript detail).
   -------------------------------------------------------------------------- */

import { ArrowLeft, CaretLeft, CaretRight, ChatCircleDots, ClipboardText } from "@phosphor-icons/react";
import { PageHeader } from "../components/PageHeader";

export interface TranscriptListItem {
  conversationId: string;
  studentId: string;
  studentName: string;
  sectionId: string;
  sectionTitle: string;
  homeworkId: string;
  homeworkTitle: string;
  isTeacherTest: boolean;
  isDeleted: boolean;
  messageCount: number;
  lastMessageSnippet: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptListData {
  items: TranscriptListItem[];
  total: number;
  limit: number;
  offset: number;
}

export type TranscriptListViewProps = {
  data: TranscriptListData;
  /** Narrowing context this list was opened with, for the header -- e.g.
   *  "Ada Lovelace · Section 2: Confidence intervals" for a submission-cell
   *  drill-in. Optional: a future unfiltered "all transcripts in course"
   *  entry point has no single student/section to name. */
  contextLabel?: string;
  onBack: () => void;
  onOpenTranscript: (conversationId: string) => void;
  onChangeOffset: (offset: number) => void;
};

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function TranscriptListView({
  data,
  contextLabel,
  onBack,
  onOpenTranscript,
  onChangeOffset,
}: TranscriptListViewProps) {
  const pageStart = data.total === 0 ? 0 : data.offset + 1;
  const pageEnd = Math.min(data.offset + data.limit, data.total);
  const canPrev = data.offset > 0;
  const canNext = pageEnd < data.total;

  return (
    <div className="admin-view">
      <button type="button" className="admin-back" onClick={onBack}>
        <ArrowLeft size={14} weight="regular" aria-hidden="true" />
        Back
      </button>

      <PageHeader
        eyebrow="TRANSCRIPTS"
        title={contextLabel ?? "Conversation transcripts"}
        subtitle={
          data.total === 0
            ? "No conversations"
            : `${pageStart}–${pageEnd} of ${data.total} conversation${data.total === 1 ? "" : "s"}`
        }
      />

      <section className="admin-record-list" aria-label="Transcripts">
        {data.items.map((item, idx) => (
          <article
            key={item.conversationId}
            className="admin-record-row admin-record-row--enterable"
            style={{ animationDelay: `${idx * 40}ms` }}
          >
            <div className="admin-record-row__body">
              <button
                type="button"
                className="admin-record-row__title"
                onClick={() => onOpenTranscript(item.conversationId)}
              >
                {item.studentName || "(unnamed student)"}
                {item.isDeleted && (
                  <sup aria-label="deleted conversation" title="Deleted conversation">
                    †
                  </sup>
                )}
              </button>
              <div className="admin-record-row__meta">
                <span className="admin-record-row__meta-chip">{item.sectionTitle}</span>
                <span className="admin-record-row__meta-chip">
                  <ChatCircleDots size={12} weight="regular" aria-hidden="true" />
                  {item.messageCount} {item.messageCount === 1 ? "message" : "messages"}
                </span>
                <span className="admin-record-row__meta-chip">{formatTimestamp(item.updatedAt)}</span>
                {item.isTeacherTest && <span className="admin-record-row__meta-chip">test conversation</span>}
              </div>
              {item.lastMessageSnippet && (
                <p className="admin-record-row__desc">{item.lastMessageSnippet}</p>
              )}
            </div>
          </article>
        ))}

        {data.items.length === 0 && (
          <div className="admin-empty">
            <ClipboardText size={22} weight="regular" aria-hidden="true" />
            <p>No conversations yet.</p>
          </div>
        )}
      </section>

      {data.total > data.limit && (
        <nav className="admin-filter-row" aria-label="Transcript pages">
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
