/* --------------------------------------------------------------------------
   KnowledgeDocumentView — one OKF concept (#42).

   The links panel is the reason this view exists rather than a modal. OKF
   relationships are ordinary markdown links, and the spec says consumers
   "MUST tolerate broken links" -- tolerating is not hiding. An instructor
   who renames a document needs to see what it broke, so broken links are
   listed and marked rather than filtered out. A links-load failure gets the
   same treatment KnowledgeView gives a materials-load failure: reported
   inline, not silently rendered as "there are no links".

   Editing is the escape hatch for formats #40 cannot extract yet: an
   instructor can write the markdown by hand and the document becomes real
   grounding material with no model involved. Saving resets index_status to
   pending, which the copy says out loud -- a silent re-queue would leave
   someone wondering why their edit had not taken effect.

   The "dirty" flag is compared against `savedBody`, not against
   `document.data.body`. A save's PUT response already tells this view the
   edit landed; waiting for the *following* document reload to say the same
   thing ties "you have unsaved changes" to a second network round trip that
   can race the first one (or simply return an older snapshot), which would
   flip the just-saved warning back on for no reason.
   -------------------------------------------------------------------------- */

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, LinkBreak, LinkSimple, Warning } from "@phosphor-icons/react";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { ViewError, ViewLoading } from "../components/ViewState";
import { apiClient, ApiError } from "../lib/api-client";
import { useApiResource } from "../lib/useApiResource";
import { statusKind, statusLabel } from "../lib/knowledgeStatus";
import type { DocumentLinksPayload, KnowledgeDocumentPayload } from "@llteacher/ui/api";

export type KnowledgeDocumentViewProps = {
  courseId: string;
  documentId: string;
  onBack: () => void;
};

export function KnowledgeDocumentView({
  courseId,
  documentId,
  onBack,
}: KnowledgeDocumentViewProps) {
  const [draft, setDraft] = useState<string | null>(null);
  // The dirty-detection baseline. Seeded alongside `draft` and re-pointed at
  // a save's own response -- see the file header for why this is not simply
  // `document.data.body`.
  const [savedBody, setSavedBody] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const document = useApiResource<KnowledgeDocumentPayload>(
    (opts) => apiClient.knowledge.getDocument(courseId, documentId, opts),
    [courseId, documentId],
  );
  const links = useApiResource<DocumentLinksPayload>(
    (opts) => apiClient.knowledge.documentLinks(courseId, documentId, opts),
    [courseId, documentId],
  );

  // Seed the editor once the document arrives; never on every render, or a
  // keystroke would be overwritten by the last fetched value.
  useEffect(() => {
    if (document.data && draft === null) {
      setDraft(document.data.body);
      setSavedBody(document.data.body);
    }
  }, [document.data, draft]);

  const backButton = (
    <button type="button" className="admin-back" onClick={onBack}>
      <ArrowLeft size={14} aria-hidden="true" /> Knowledge base
    </button>
  );

  if (document.loading) {
    return (
      <div className="admin-view">
        {backButton}
        <ViewLoading label="Loading document…" />
      </div>
    );
  }

  if (document.error) {
    return (
      <div className="admin-view">
        {backButton}
        <ViewError
          error={document.error}
          onRetry={document.reload}
          detail={`GET /api/courses/${courseId}/knowledge/documents/${documentId}`}
        />
      </div>
    );
  }

  // Not expected in practice -- useApiResource settles data and loading in
  // the same tick -- but a defensive fallback beats a crash if that ever
  // stops being true.
  if (!document.data) return null;

  const record = document.data;
  const dirty = draft !== null && savedBody !== null && draft !== savedBody;

  async function save() {
    if (draft === null) return;
    const sentBody = draft;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await apiClient.knowledge.updateDocument(
        courseId,
        documentId,
        { body: sentBody },
        { signal: null },
      );
      setSavedBody(updated.body);
      // Only snap the editor to the server's own text if nothing was typed
      // while the request was in flight -- otherwise a slow save would
      // clobber keystrokes made during it.
      setDraft((current) => (current === sentBody ? updated.body : current));
      // The document's own metadata (index_status, editedAt, ...) is worth
      // refreshing, but the dirty flag no longer depends on this round trip
      // landing -- see the file header.
      document.reload();
      // Outbound links are derived server-side from the body just saved;
      // nothing else refreshes them.
      links.reload();
    } catch (err) {
      setSaveError(
        err instanceof ApiError ? err.message : "Could not save this document. Try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  function revertToExtraction() {
    if (record.bodyOriginal !== null) setDraft(record.bodyOriginal);
  }

  return (
    <div className="admin-view">
      {backButton}

      <PageHeader
        eyebrow={<span>{record.path}</span>}
        title={record.title ?? record.path}
        subtitle={record.description ?? undefined}
        actions={
          <>
            <button
              type="button"
              className="admin-button admin-button--ghost"
              onClick={() => setPreview((p) => !p)}
            >
              {preview ? "Edit" : "Preview"}
            </button>
            {/* Only when there is something to revert to -- a hand-authored
                document has no extraction, and offering the control anyway
                would be a lie. */}
            {record.bodyOriginal !== null && (
              <button
                type="button"
                className="admin-button admin-button--ghost"
                onClick={revertToExtraction}
              >
                Revert to extraction
              </button>
            )}
            <button
              type="button"
              className="admin-button admin-button--primary"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        }
      />

      <dl className="admin-knowledge-doc__meta">
        <div>
          <dt>Type</dt>
          <dd>{record.type ?? "—"}</dd>
        </div>
        <div>
          <dt>Indexing</dt>
          <dd>
            <StatusBadge kind={statusKind(record.indexStatus)}>
              {statusLabel(record.indexStatus)}
            </StatusBadge>
          </dd>
        </div>
      </dl>

      {dirty && (
        <p className="admin-inline-note">
          Saving re-queues this document to be re-indexed before the tutor uses the change.
        </p>
      )}

      {saveError && (
        <div className="admin-alert" role="alert">
          <span className="admin-alert__icon" aria-hidden="true">
            <Warning size={16} />
          </span>
          <span>{saveError}</span>
        </div>
      )}

      {preview ? (
        <div className="admin-knowledge-doc__preview">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {draft || "*Nothing written yet.*"}
          </ReactMarkdown>
        </div>
      ) : (
        <textarea
          aria-label="Document body"
          className="admin-knowledge-doc__editor"
          value={draft ?? ""}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}

      <section className="admin-knowledge-doc__links">
        <h2>Links</h2>
        {links.error ? (
          <div className="admin-alert">
            <span className="admin-alert__icon" aria-hidden="true">
              <Warning size={16} />
            </span>
            <span>
              The links couldn't be loaded.{" "}
              {links.canRetry && (
                <button type="button" className="admin-link-button" onClick={links.reload}>
                  Try again
                </button>
              )}
            </span>
          </div>
        ) : (
          <ul>
            {links.data?.outbound.map((link) => (
              <li key={link.rawHref}>
                {link.isBroken ? (
                  <LinkBreak size={14} aria-hidden="true" />
                ) : (
                  <LinkSimple size={14} aria-hidden="true" />
                )}
                <code>{link.rawHref}</code>
                {link.isBroken && <span className="admin-knowledge-doc__broken">broken</span>}
              </li>
            ))}
            {links.data && links.data.outbound.length === 0 && <li>No outbound links.</li>}
          </ul>
        )}

        <h2>Referenced by</h2>
        {!links.error && (
          <ul>
            {links.data?.backlinks.map((backlink) => (
              <li key={backlink.sourceDocumentId}>{backlink.sourcePath}</li>
            ))}
            {links.data && links.data.backlinks.length === 0 && <li>Nothing links here yet.</li>}
          </ul>
        )}
      </section>
    </div>
  );
}
