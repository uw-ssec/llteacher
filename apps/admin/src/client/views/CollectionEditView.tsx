/* --------------------------------------------------------------------------
   CollectionEditView — choosing what a collection contains (#42).

   A checked FOLDER is a live subtree, not a snapshot: files added to it
   later join the collection automatically. That is what "select the folders
   that make up a collection" means, and the copy says so, because the
   alternative reading (a one-time expansion) produces a very different
   mental model.

   The resolved pane mirrors the server's own rule (listDocumentsInCollections
   in knowledgeCollections.ts) exactly, trailing slash included: without it,
   folder "week" would also match "weekend/b". Getting this pane wrong would
   show the instructor a preview that disagrees with what the tutor actually
   retrieves.

   It also shows how many of the resolved documents are not yet indexed.
   Without that count, an instructor attaches a collection of freshly
   uploaded PDFs, sees a healthy document count, and has no way to know the
   tutor can currently retrieve none of them.
   -------------------------------------------------------------------------- */

import { useMemo, useState } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import { PageHeader } from "../components/PageHeader";
import { ViewError, ViewLoading } from "../components/ViewState";
import { apiClient } from "../lib/api-client";
import { useApiResource } from "../lib/useApiResource";
import { depthOf, directoriesOf, nameOf } from "../lib/documentTree";
import type { CollectionItemBody, KnowledgeDocumentListPayload } from "@llteacher/ui/api";

export type CollectionEditViewProps = {
  courseId: string;
  collectionId: string;
  onBack: () => void;
};

export function CollectionEditView({ courseId, collectionId, onBack }: CollectionEditViewProps) {
  const [directories, setDirectories] = useState<Set<string>>(new Set());
  const [documentIds, setDocumentIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const documents = useApiResource<KnowledgeDocumentListPayload>(
    (opts) => apiClient.knowledge.listDocuments(courseId, opts),
    [courseId],
  );

  const all = documents.data?.documents ?? [];
  const concepts = useMemo(() => all.filter((d) => d.kind === "concept"), [all]);
  const folders = useMemo(() => directoriesOf(all).filter((d) => d !== ""), [all]);

  /** Mirrors the server's live-subtree rule (knowledgeCollections.ts) so the
   *  count shown here is the count the tutor will retrieve. The trailing
   *  slash matters: without it "week" would also match "weekend/b". */
  const selected = useMemo(() => {
    return concepts.filter(
      (d) =>
        documentIds.has(d.id) || [...directories].some((dir) => d.path.startsWith(`${dir}/`)),
    );
  }, [concepts, directories, documentIds]);

  const notIndexed = selected.filter((d) => d.indexStatus !== "indexed").length;

  function toggle<T>(set: Set<T>, value: T, apply: (next: Set<T>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  }

  async function save() {
    setSaving(true);
    try {
      const items: CollectionItemBody[] = [
        ...[...directories].map((directoryPath) => ({ directoryPath })),
        ...[...documentIds].map((documentId) => ({ documentId })),
      ];
      await apiClient.knowledge.setCollectionItems(courseId, collectionId, items, { signal: null });
      onBack();
    } finally {
      setSaving(false);
    }
  }

  const backButton = (
    <button type="button" className="admin-back" onClick={onBack}>
      <ArrowLeft size={14} aria-hidden="true" /> Collections
    </button>
  );

  if (documents.loading) {
    return (
      <div className="admin-view">
        {backButton}
        <ViewLoading label="Loading knowledge base…" />
      </div>
    );
  }

  if (documents.error) {
    return (
      <div className="admin-view">
        {backButton}
        <ViewError
          error={documents.error}
          onRetry={documents.reload}
          detail={`GET /api/courses/${courseId}/knowledge/documents`}
        />
      </div>
    );
  }

  return (
    <div className="admin-view">
      {backButton}

      <PageHeader
        eyebrow="COLLECTION"
        title="Choose contents"
        subtitle="A checked folder stays live — documents added to it later join this collection automatically."
        actions={
          <button
            type="button"
            className="admin-button admin-button--primary"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        }
      />

      <div className="admin-collection-edit">
        <fieldset className="admin-collection-edit__picker">
          <legend>Folders</legend>
          {folders.length === 0 ? (
            <p className="admin-form-hint">No folders in the knowledge base yet.</p>
          ) : (
            folders.map((dir) => (
              <label key={dir} style={{ paddingInlineStart: `${depthOf(dir) * 14}px` }}>
                <input
                  type="checkbox"
                  checked={directories.has(dir)}
                  onChange={() => toggle(directories, dir, setDirectories)}
                />
                {nameOf(dir)}
              </label>
            ))
          )}

          <legend>Documents</legend>
          {concepts.length === 0 ? (
            <p className="admin-form-hint">No documents in the knowledge base yet.</p>
          ) : (
            concepts.map((document) => (
              <label key={document.id}>
                <input
                  type="checkbox"
                  checked={documentIds.has(document.id)}
                  onChange={() => toggle(documentIds, document.id, setDocumentIds)}
                />
                {document.title ?? document.path}
              </label>
            ))
          )}
        </fieldset>

        <aside className="admin-collection-edit__resolved">
          <h2>Resolved contents</h2>
          <p>
            {selected.length} document{selected.length === 1 ? "" : "s"}
            {notIndexed > 0 &&
              ` · ${notIndexed} not yet indexed`}
          </p>
          {selected.length === 0 ? (
            <p className="admin-form-hint">Nothing selected yet resolves to no documents.</p>
          ) : (
            <ul>
              {selected.map((document) => (
                <li key={document.id}>{document.path}</li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
