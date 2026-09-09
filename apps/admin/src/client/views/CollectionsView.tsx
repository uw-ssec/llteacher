/* --------------------------------------------------------------------------
   CollectionsView — named selections over the bundle (#42).

   The "attached to" column is the payload of this view. Resolution is
   most-specific-wins, so an instructor's real question is not "what is in
   this collection" but "where does it apply, and does something narrower
   override it". Showing every attachment on the row is the cheapest honest
   answer to that.

   Fix round 1 (#42): create and delete were wired into the api-client from
   the start but never reachable from anywhere -- an instructor had no path
   to make a collection exist at all. Both live here rather than as a
   separate view: creation only needs a name and an optional description (the
   contents picker is CollectionEditView, opened right after), and deletion
   is a row action, matching the roster and TA lists' own delete-in-place
   pattern rather than inventing a new one.
   -------------------------------------------------------------------------- */

import { useState } from "react";
import { Plus, Warning } from "@phosphor-icons/react";
import { PageHeader } from "../components/PageHeader";
import { RecordId } from "../components/RecordId";
import { ViewEmpty, ViewError, ViewLoading } from "../components/ViewState";
import { apiClient } from "../lib/api-client";
import { useApiResource } from "../lib/useApiResource";
import type {
  AttachmentListPayload,
  AttachmentScopePayload,
  CollectionListPayload,
  CollectionPayload,
} from "@llteacher/ui/api";

export type CollectionsViewProps = {
  courseId: string;
  onEditCollection: (collectionId: string) => void;
};

function describeScope(scope: AttachmentScopePayload): string {
  switch (scope.kind) {
    case "course":
      return "Course default";
    case "homework":
      return "Homework";
    case "section":
      return "Section";
    case "llmConfig":
      return "Tutor config";
  }
}

export function CollectionsView({ courseId, onEditCollection }: CollectionsViewProps) {
  const collections = useApiResource<CollectionListPayload>(
    (opts) => apiClient.knowledge.listCollections(courseId, opts),
    [courseId],
  );
  // A failed attachments load does not block the collections list -- the two
  // are independently useful -- but a collection whose attachments could not
  // be read shows that honestly rather than reading as "not attached".
  const attachments = useApiResource<AttachmentListPayload>(
    (opts) => apiClient.knowledge.listAttachments(courseId, opts),
    [courseId],
  );

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const rows = collections.data?.collections ?? [];

  async function submitCreate(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (createBusy || trimmed.length === 0) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      await apiClient.knowledge.createCollection(
        courseId,
        { name: trimmed, description: description.trim() || null },
        { signal: null },
      );
      setName("");
      setDescription("");
      setCreating(false);
      collections.reload();
    } catch (err) {
      setCreateError((err as Error)?.message ?? "Could not create that collection. Try again.");
    } finally {
      setCreateBusy(false);
    }
  }

  /** Cascades its items and attachments server-side, so the confirmation
   *  says what that means rather than just asking "are you sure" -- a
   *  collection currently grounding a homework is exactly the case where a
   *  vague confirmation is dangerous. */
  async function handleDelete(collection: CollectionPayload) {
    const mine =
      attachments.data?.attachments.filter((a) => a.collectionId === collection.id) ?? [];
    const attachedNote =
      mine.length > 0
        ? ` It is currently attached in ${mine.length} place${mine.length === 1 ? "" : "s"} (${mine
            .map((a) => describeScope(a.scope))
            .join(", ")}), which will stop grounding on it immediately.`
        : "";
    const confirmed = window.confirm(
      `Delete "${collection.name}"?\n\nThis permanently removes its folder and document selections (${collection.directoryCount} folder${collection.directoryCount === 1 ? "" : "s"}, ${collection.documentCount} document${collection.documentCount === 1 ? "" : "s"}).${attachedNote} This cannot be undone.`,
    );
    if (!confirmed) return;

    setDeletingId(collection.id);
    setDeleteError(null);
    try {
      await apiClient.knowledge.deleteCollection(courseId, collection.id, { signal: null });
      collections.reload();
      attachments.reload();
    } catch (err) {
      setDeleteError((err as Error)?.message ?? "Could not delete that collection. Try again.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="admin-view">
      <PageHeader
        eyebrow={`COLLECTIONS · ${rows.length} RECORDS`}
        title="Collections"
        subtitle="A collection is what an assignment grounds on. The narrowest attachment wins: section, then homework, then course, then tutor config."
        actions={
          <button
            type="button"
            className="admin-button admin-button--primary"
            onClick={() => setCreating((c) => !c)}
          >
            <Plus size={14} weight="bold" aria-hidden="true" />
            New collection
          </button>
        }
      />

      {creating && (
        <form className="admin-form admin-collections__create" onSubmit={(e) => void submitCreate(e)} noValidate>
          <div className="admin-form-field">
            <label htmlFor="col-name">Name</label>
            <input
              id="col-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </div>
          <div className="admin-form-field">
            <label htmlFor="col-description">Description (optional)</label>
            <textarea
              id="col-description"
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          {createError && (
            <p role="alert" className="admin-field-error">
              {createError}
            </p>
          )}
          <div className="admin-collections__create-actions">
            <button
              type="submit"
              className="admin-button admin-button--primary"
              disabled={createBusy || name.trim().length === 0}
            >
              {createBusy ? "Creating…" : "Create collection"}
            </button>
            <button
              type="button"
              className="admin-link-button"
              onClick={() => {
                setCreating(false);
                setName("");
                setDescription("");
                setCreateError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {deleteError && (
        <div className="admin-alert" role="alert">
          <span className="admin-alert__icon" aria-hidden="true">
            <Warning size={16} />
          </span>
          <span>{deleteError}</span>
        </div>
      )}

      {collections.loading && <ViewLoading label="Loading collections…" />}
      {collections.error && (
        <ViewError
          error={collections.error}
          onRetry={collections.reload}
          detail={`GET /api/courses/${courseId}/knowledge/collections`}
        />
      )}

      {collections.data &&
        (rows.length === 0 ? (
          <ViewEmpty
            title="No collections yet."
            body="Create one to ground an assignment on specific materials."
          />
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Contents</th>
                <th>Attached to</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((collection, i) => {
                const mine =
                  attachments.data?.attachments.filter((a) => a.collectionId === collection.id) ??
                  [];
                return (
                  <tr key={collection.id}>
                    <td>
                      <RecordId prefix="COL" index={i + 1} size="sm" />
                    </td>
                    <td>
                      {/* A button, not a row-level onClick: a bare <tr onClick>
                          is invisible to keyboard navigation and to a screen
                          reader's interactive-elements list. */}
                      <button
                        type="button"
                        className="admin-link-button"
                        onClick={() => onEditCollection(collection.id)}
                      >
                        {collection.name}
                      </button>
                    </td>
                    <td>
                      {collection.directoryCount} folder
                      {collection.directoryCount === 1 ? "" : "s"}, {collection.documentCount}{" "}
                      document{collection.documentCount === 1 ? "" : "s"}
                    </td>
                    <td>
                      {attachments.error
                        ? "Could not load"
                        : mine.length === 0
                          ? "Not attached"
                          : mine.map((a) => describeScope(a.scope)).join(", ")}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="admin-link-button admin-link-button--danger"
                        aria-label={`Delete ${collection.name}`}
                        disabled={deletingId === collection.id}
                        onClick={() => void handleDelete(collection)}
                      >
                        {deletingId === collection.id ? "Deleting…" : "Delete"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
    </div>
  );
}
