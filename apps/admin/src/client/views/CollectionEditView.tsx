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

   Fix round 1 (#42): this view used to open with nothing checked, no matter
   what the collection already contained. Because setCollectionItems is a
   wholesale replacement, saving from that blank baseline silently replaced
   the entire collection with whatever few things happened to get checked in
   the meantime -- an instructor opening a populated collection to add one
   folder would erase the rest of it. GET .../items (added server-side to
   close this gap) is now loaded on mount and seeds the checkboxes, and Save
   is disabled -- with a visible reason -- for as long as that baseline is
   not known to be loaded, so a save can never proceed from an unknown state.
   -------------------------------------------------------------------------- */

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Warning } from "@phosphor-icons/react";
import { PageHeader } from "../components/PageHeader";
import { ViewError, ViewLoading } from "../components/ViewState";
import { apiClient } from "../lib/api-client";
import { useApiResource } from "../lib/useApiResource";
import { depthOf, directoriesOf, nameOf } from "../lib/documentTree";
import type {
  CollectionItemBody,
  CollectionItemsPayload,
  KnowledgeDocumentListPayload,
} from "@llteacher/ui/api";

export type CollectionEditViewProps = {
  courseId: string;
  collectionId: string;
  onBack: () => void;
};

export function CollectionEditView({ courseId, collectionId, onBack }: CollectionEditViewProps) {
  const [directories, setDirectories] = useState<Set<string>>(new Set());
  const [documentIds, setDocumentIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const documents = useApiResource<KnowledgeDocumentListPayload>(
    (opts) => apiClient.knowledge.listDocuments(courseId, opts),
    [courseId],
  );
  // The current baseline. Loaded independently of the document list because
  // it answers a different question -- not "what exists" but "what is
  // already selected" -- and a save must never fire before this specific
  // answer is in hand.
  const items = useApiResource<CollectionItemsPayload>(
    (opts) => apiClient.knowledge.getCollectionItems(courseId, collectionId, opts),
    [courseId, collectionId],
  );

  // Seeds the checkboxes exactly once per successful load of the baseline
  // (including a load that only succeeds after a retry). Items are read back
  // as documentId/directoryPath pairs, never as an expanded document list --
  // re-checking individual files instead of the folder they came from would
  // quietly turn a live subtree into a frozen snapshot on the next save.
  useEffect(() => {
    if (!items.data) return;
    const dirs = new Set<string>();
    const docs = new Set<string>();
    for (const item of items.data.items) {
      if (item.directoryPath) dirs.add(item.directoryPath);
      else if (item.documentId) docs.add(item.documentId);
    }
    setDirectories(dirs);
    setDocumentIds(docs);
  }, [items.data]);

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

  // A save can only ever proceed from a known baseline. `items.error` is
  // checked ahead of `items.loading`: a failed load is not "still loading",
  // and lumping them together would let a transient render read as loading
  // forever instead of as the failure it is.
  const baselineUnknown = !!items.error || items.loading || !items.data;

  // I-5 (final review): this had try/finally but no catch, so a failed
  // wholesale item write left the instructor on the page with the button
  // back at "Save" and no indication the collection's contents were not
  // replaced -- the exact "failure must never be invisible" rule this
  // feature holds itself to everywhere else. Reported through the same
  // admin-alert shape items.error already renders below.
  async function save() {
    if (baselineUnknown || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const itemsToSave: CollectionItemBody[] = [
        ...[...directories].map((directoryPath) => ({ directoryPath })),
        ...[...documentIds].map((documentId) => ({ documentId })),
      ];
      await apiClient.knowledge.setCollectionItems(courseId, collectionId, itemsToSave, {
        signal: null,
      });
      onBack();
    } catch (err) {
      setSaveError(
        (err as Error)?.message ?? "Could not save this collection's contents. Please try again.",
      );
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
            disabled={baselineUnknown || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        }
      />

      {/* Saving replaces this collection's entire contents, so it stays
          disabled -- visibly, with a reason -- until the current selection
          is confirmed loaded. Silently disabling it would look identical to
          a broken button; an instructor needs to know saving is blocked on
          purpose, not stuck. */}
      {items.loading && (
        <p className="admin-form-hint" role="status">
          Loading this collection's current selection… Saving is disabled until it finishes, so an
          incomplete load can't overwrite what's already selected.
        </p>
      )}
      {items.error && (
        <div className="admin-alert" role="alert">
          <span className="admin-alert__icon" aria-hidden="true">
            <Warning size={16} />
          </span>
          <span>
            This collection's current selection could not be loaded, so saving is disabled --
            saving now would replace its contents with only what's checked below, which may not be
            everything it already has.{" "}
            {items.canRetry && (
              <button type="button" className="admin-link-button" onClick={items.reload}>
                Try again
              </button>
            )}
          </span>
        </div>
      )}

      {saveError && (
        <div className="admin-alert" role="alert">
          <span className="admin-alert__icon" aria-hidden="true">
            <Warning size={16} />
          </span>
          <span>{saveError}</span>
        </div>
      )}

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
            {notIndexed > 0 && ` · ${notIndexed} not yet indexed`}
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
