/* --------------------------------------------------------------------------
   TranscriptDetailView — read-only rendering of one student conversation,
   for an instructor/grader (#29).

   Reuses ConversationView/Message from @llteacher/ui exactly as they render
   for a live chat -- markdown text, generative-UI tool parts (DefinitionCard,
   CodeExecution), R code + execution output, system messages -- with two
   differences, both opt-in props ConversationView already supported or
   gained for this task:

     - No onSendMessage/onRunRCode/onStop/etc. passed: every one of those
       props is already optional (ConversationView renders a fully static
       transcript without a live useChat instance behind it -- confirmed by
       reading the component, not assumed).
     - hideComposer (new prop, this task): omits the Composer entirely.
       ConversationView otherwise always rendered a Composer textarea even
       with no send handler wired up (merely inert, not absent) -- a visible
       edit affordance the issue's "copy-safe: no edit affordances"
       requirement rules out for this surface. See that prop's own doc
       comment in packages/ui for the full reasoning.

   R code + its execution output specifically reuses CodeExecution
   (packages/ui/src/generative/renderers/CodeExecution.tsx, #28) via
   renderTextWithCode/renderToolPart with no `onRun` handler -- the component
   was built to degrade to a read-only code block in exactly that case, so
   this view builds no second R-output renderer.
   -------------------------------------------------------------------------- */

import { ArrowLeft } from "@phosphor-icons/react";
import { ConversationView, renderTextWithCode, renderToolPart, isToolPart, type MessageData } from "@llteacher/ui";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "system";
  /** The AI SDK's UIMessage.parts shape, as persisted -- untrusted JSON from
   *  the wire, narrowed defensively below the same way App.tsx's own
   *  buildMessageData does for the live chat. */
  parts: unknown;
  createdAt: string;
}

export interface TranscriptConversation {
  id: string;
  studentId: string;
  studentName: string;
  sectionId: string;
  sectionTitle: string;
  homeworkId: string;
  homeworkTitle: string;
  isTeacherTest: boolean;
  isDeleted: boolean;
  deletedAt: string | null;
  submission: { id: string; submittedAt: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptDetailData {
  conversation: TranscriptConversation;
  messages: TranscriptMessage[];
  hasMore: boolean;
  /** #371: the offset the server applied to produce `messages` -- echoed
   *  back so the loader can compute the next page's offset without
   *  duplicating TRANSCRIPT_DETAIL_MESSAGE_LIMIT client-side. */
  offset: number;
}

export type TranscriptDetailViewProps = {
  data: TranscriptDetailData;
  onBack: () => void;
  /** #371: fetches and appends the next page of messages -- present
   *  whenever `data.hasMore` is true. Mirrors TranscriptListView's own
   *  onChangeOffset prop (same offset-paging convention, this route just
   *  has no "previous page" affordance since a transcript is read forward
   *  from the start rather than paged back and forth). */
  onLoadMore: () => void;
  /** True while a "load more" fetch is in flight -- disables the button
   *  rather than letting a second click race the first. */
  loadingMore?: boolean;
  /** Review follow-up (#366 review): true when the most recent "load more"
   *  fetch failed. Distinct from a loader-level error boundary -- `data` is
   *  still the real, valid transcript read so far, so the failure renders
   *  inline in place of the "Load more" button rather than replacing this
   *  whole view. */
  loadMoreError?: boolean;
  /** Retries the same failed page (same offset, not the next one) -- present
   *  whenever `loadMoreError` is true. */
  onRetryLoadMore?: () => void;
};

function isTextPart(part: unknown): part is { type: "text"; text: string } {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  );
}

/** Static-transcript equivalent of App.tsx's own buildMessageData -- no
 *  chatStatus/isStreaming (nothing here is ever streaming), no
 *  stoppedMessageId (a stopped-mid-turn reply is never persisted, #342, so a
 *  saved transcript never contains one), no onRunRCode (read-only: passing
 *  none is what makes CodeExecution degrade to inert, per that component's
 *  own doc comment). `system`-role rows render their text rather than
 *  App.tsx's own "system role messages -- not user-facing, render empty" --
 *  that choice is specific to the LIVE chat surface (no system rows are
 *  written there today); the issue's own requirement for THIS surface is
 *  "system messages visually distinct", which means shown, not blanked. */
function buildTranscriptMessageData(messages: TranscriptMessage[]): MessageData[] {
  return messages.map((m) => {
    const parts = Array.isArray(m.parts) ? m.parts : [];

    if (m.role === "assistant") {
      const content = (
        <>
          {parts.map((part, i) => {
            if (isTextPart(part)) {
              return renderTextWithCode(part.text, { keyPrefix: `text-${m.id}-${i}` });
            }
            if (!isToolPart(part)) return null;
            return renderToolPart(part, `tool-${m.id}-${i}`);
          })}
        </>
      );
      return { id: m.id, role: "ai", content };
    }

    const text = parts
      .filter(isTextPart)
      .map((p) => p.text)
      .join("");

    if (m.role === "user") {
      return { id: m.id, role: "student", content: text };
    }
    return { id: m.id, role: "system", content: text };
  });
}

export function TranscriptDetailView({
  data,
  onBack,
  onLoadMore,
  loadingMore = false,
  loadMoreError = false,
  onRetryLoadMore,
}: TranscriptDetailViewProps) {
  const { conversation } = data;
  const breadcrumb = `${conversation.homeworkTitle} · ${conversation.sectionTitle}`;
  const messages = buildTranscriptMessageData(data.messages);

  return (
    <div className="admin-view admin-transcript-detail">
      <button type="button" className="admin-back" onClick={onBack}>
        <ArrowLeft size={14} weight="regular" aria-hidden="true" />
        Back to transcripts
      </button>

      <PageHeader
        eyebrow="TRANSCRIPT · READ-ONLY"
        title={conversation.studentName || "(unnamed student)"}
        subtitle={breadcrumb}
        actions={
          <>
            <StatusBadge kind={conversation.submission ? "submitted" : "missing"}>
              {conversation.submission ? "submitted" : "not submitted"}
            </StatusBadge>
            {conversation.isTeacherTest && <StatusBadge kind="draft">test conversation</StatusBadge>}
          </>
        }
      />

      <div className="admin-record-row__meta" role="group" aria-label="Transcript details">
        <span className="admin-record-row__meta-chip">Started {formatTimestamp(conversation.createdAt)}</span>
        <span className="admin-record-row__meta-chip">Last activity {formatTimestamp(conversation.updatedAt)}</span>
        {conversation.submission && (
          <span className="admin-record-row__meta-chip">
            Submitted {formatTimestamp(conversation.submission.submittedAt)}
          </span>
        )}
      </div>

      {conversation.isDeleted && (
        <div className="admin-alert" role="status">
          This conversation was deleted by the student
          {conversation.deletedAt ? ` on ${formatTimestamp(conversation.deletedAt)}` : ""}. It remains
          visible here for instructor review.
        </div>
      )}

      {/* Copy-safe: no onSendMessage/onRunRCode/onStop wired up (every one
          degrades to a static render, per this file's own module comment),
          and hideComposer removes the input affordance entirely rather than
          merely disabling it. */}
      <ConversationView breadcrumb={breadcrumb} messages={messages} hideComposer />

      {data.hasMore && (
        <div className="admin-record-row__meta" role="group" aria-label="Transcript pagination">
          <p className="admin-record-row__desc">
            Showing the first {data.messages.length} messages. This conversation continues beyond what's
            shown here.
          </p>
          {loadMoreError ? (
            /* Review follow-up (#366 review): inline, not a full-page error
               -- everything above is still a real, valid read of the
               conversation so far, so a failed page fetch must not hide it. */
            <div className="admin-alert" role="alert">
              <span>Couldn't load more messages. Nothing above has changed.</span>
              <button type="button" className="admin-link-button" onClick={onRetryLoadMore}>
                Retry
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="admin-button admin-button--ghost"
              onClick={onLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load more messages"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
