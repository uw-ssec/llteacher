/* --------------------------------------------------------------------------
   CollectionsView — named selections over the bundle (#42).

   The "attached to" column is the payload of this view. Resolution is
   most-specific-wins, so an instructor's real question is not "what is in
   this collection" but "where does it apply, and does something narrower
   override it". Showing every attachment on the row is the cheapest honest
   answer to that.
   -------------------------------------------------------------------------- */

import { PageHeader } from "../components/PageHeader";
import { RecordId } from "../components/RecordId";
import { ViewEmpty, ViewError, ViewLoading } from "../components/ViewState";
import { apiClient } from "../lib/api-client";
import { useApiResource } from "../lib/useApiResource";
import type { AttachmentListPayload, AttachmentScopePayload, CollectionListPayload } from "@llteacher/ui/api";

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

  const rows = collections.data?.collections ?? [];

  return (
    <div className="admin-view">
      <PageHeader
        eyebrow={`COLLECTIONS · ${rows.length} RECORDS`}
        title="Collections"
        subtitle="A collection is what an assignment grounds on. The narrowest attachment wins: section, then homework, then course, then tutor config."
      />

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
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
    </div>
  );
}
