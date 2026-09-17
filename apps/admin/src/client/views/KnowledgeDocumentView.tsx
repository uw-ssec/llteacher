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
   grounding material with no model involved. Saving updates the OKF body immediately for the next search.

   The "dirty" flag is compared against `savedBody`, not against
   `document.data.body`. A save's PUT response already tells this view the
   edit landed; waiting for the *following* document reload to say the same
   thing ties "you have unsaved changes" to a second network round trip that
   can race the first one (or simply return an older snapshot), which would
   flip the just-saved warning back on for no reason.
   -------------------------------------------------------------------------- */

import { useEffect, useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { diffLines } from "diff";
import "katex/dist/katex.min.css";
import "./knowledge-cleanup.css";
import { ArrowCounterClockwise, ArrowLeft, DownloadSimple, Eye, FileArrowDown, LinkBreak, LinkSimple, PencilSimple, Sparkle, Warning } from "@phosphor-icons/react";
import { ActionMenu, type ActionMenuItem } from "../components/ActionMenu";
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

export function KnowledgeDocumentView(props: KnowledgeDocumentViewProps) {
  return <DocumentEditor key={`${props.courseId}:${props.documentId}`} {...props} />;
}

function DocumentEditor({
  courseId,
  documentId,
  onBack,
}: KnowledgeDocumentViewProps) {
  const [draft, setDraft] = useState<string | null>(null);
  // The dirty-detection baseline. Seeded alongside `draft` and re-pointed at
  // a save's own response -- see the file header for why this is not simply
  // `document.data.body`.
  const [savedBody, setSavedBody] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{ body: string; warnings: string[]; source: string } | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const changes = useMemo(() => proposal ? diffLines(proposal.source, proposal.body) : [], [proposal]);
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

  async function save(cleanedBody?: string) {
    if (draft === null) return;
    const sentBody = cleanedBody ?? draft;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await apiClient.knowledge.updateDocument(
        courseId,
        documentId,
        { body: sentBody, ...(cleanedBody !== undefined ? { expectedBody: savedBody ?? record.body } : {}) },
        { signal: null },
      );
      setSavedBody(updated.body);
      // Only snap the editor to the server's own text if nothing was typed
      // while the request was in flight -- otherwise a slow save would
      // clobber keystrokes made during it.
      setDraft((current) => (cleanedBody !== undefined || current === sentBody ? updated.body : current));
      if (cleanedBody !== undefined) { setProposal(null); setPreview(true); }
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

  async function cleanUp() {
    if (!draft?.trim()) return;
    setCleaning(true);
    setSaveError(null);
    try {
      const result = await apiClient.knowledge.cleanupDocument(courseId, documentId, draft, { signal: null });
      setProposal({ ...result, source: draft });
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not clean up this document. Try again.");
    } finally { setCleaning(false); }
  }

  function revertToExtraction() {
    if (record.bodyOriginal !== null) setDraft(record.bodyOriginal);
  }

  const busy = cleaning || saving || proposal !== null;
  const menuItems: ActionMenuItem[] = [
    {
      kind: "action",
      label: cleaning ? "Cleaning up…" : "Clean up Markdown",
      hint: "AI",
      icon: <Sparkle size={16} />,
      disabled: busy || !draft?.trim() || draft.length > 60_000,
      onSelect: () => void cleanUp(),
    },
    // Only when there is something to revert to -- a hand-authored document
    // has no extraction, and offering the control anyway would be a lie.
    ...(record.bodyOriginal !== null
      ? [{ kind: "action" as const, label: "Restore original", icon: <ArrowCounterClockwise size={16} />, disabled: busy, onSelect: revertToExtraction }]
      : []),
    { kind: "group", label: "Download" },
    {
      kind: "link",
      label: "Markdown",
      hint: ".md",
      icon: <DownloadSimple size={16} />,
      href: apiClient.knowledge.documentDownloadUrl(courseId, record.path),
      download: `${record.path.split("/").pop() ?? record.path}.md`,
    },
    ...(record.sourceMaterialId
      ? [{
          kind: "link" as const,
          label: "Original upload",
          icon: <FileArrowDown size={16} />,
          href: apiClient.knowledge.materialDownloadUrl(courseId, record.sourceMaterialId),
          download: "",
        }]
      : []),
  ];

  return (
    <div className="admin-view">
      {backButton}

      <PageHeader
        eyebrow={<span>{record.path}</span>}
        title={record.title ?? record.path}
        subtitle={record.description ?? undefined}
        actions={
          <>
            {dirty && <span className="admin-knowledge-doc__unsaved">Unsaved changes</span>}
            {/* The view toggle and Save stay visible: Save is the one action
                with state, and the toggle is used constantly. Everything
                else is one click away in the menu (progressive disclosure). */}
            <div className="admin-knowledge-doc__view" role="group" aria-label="View">
              <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
                <PencilSimple size={15} aria-hidden="true" /> Edit
              </button>
              <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
                <Eye size={15} aria-hidden="true" /> Preview
              </button>
            </div>
            <button
              type="button"
              className="admin-button admin-button--primary"
              disabled={!dirty || saving || cleaning || proposal !== null}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <ActionMenu label="More actions" items={menuItems} />
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
          Saving updates the searchable document the tutor uses.
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

      {draft !== null && draft.length > 60_000 && <p className="admin-inline-note">Cleanup supports up to 60,000 characters. Split this document into smaller sections first.</p>}
      {cleaning && <p role="status">Preparing a formatting proposal. Your saved document is unchanged.</p>}
      {proposal && (
        <section className="knowledge-cleanup" aria-label="Cleanup proposal">
          <h2>Review cleanup</h2>
          <p>Check wording, numbers, tables, and equations before applying. Apply saves and updates search; the original is preserved.</p>
          {proposal.warnings.length > 0 && <ul role="status">{proposal.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
          <h3>Preview</h3>
          <div className="admin-knowledge-doc__preview"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{proposal.body}</ReactMarkdown></div>
          <details open><summary>Changes: removed (−), added (+)</summary>
            <pre className="knowledge-cleanup__diff">{changes.map((part, i) => <span key={i} className={part.added ? "diff-added" : part.removed ? "diff-removed" : undefined}>{part.value.split(/(?<=\n)/).map((line) => `${part.added ? "+ " : part.removed ? "− " : "  "}${line}`).join("")}</span>)}</pre>
          </details>
          <div className="knowledge-cleanup__actions">
            <button className="admin-button admin-button--primary" disabled={saving} onClick={() => void save(proposal.body)}>{saving ? "Applying…" : "Apply cleanup"}</button>
            <button className="admin-button admin-button--ghost" disabled={saving} onClick={() => setProposal(null)}>Discard</button>
          </div>
        </section>
      )}

      {preview ? (
        <div className="admin-knowledge-doc__preview">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
            {draft || "*Nothing written yet.*"}
          </ReactMarkdown>
        </div>
      ) : (
        <textarea
          aria-label="Document body"
          disabled={cleaning || proposal !== null}
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
