/* --------------------------------------------------------------------------
   KnowledgeStatusStrip — the health numbers that stay visible.

   Four counts answer "is the base healthy?" without scrolling. Pending and
   failed are buttons because each is also the filter that shows exactly
   those uploads in the pane below.
   -------------------------------------------------------------------------- */

import type { KnowledgeDocumentSummaryPayload, MaterialPayload } from "@llteacher/ui/api";

export type UploadFilter = "pending" | "failed";

export type KnowledgeStatusStripProps = {
  documents: readonly KnowledgeDocumentSummaryPayload[];
  materials: readonly MaterialPayload[];
  filter: UploadFilter | null;
  onFilter: (filter: UploadFilter | null) => void;
};

export function isInFlight(material: MaterialPayload): boolean {
  return material.status === "pending" || material.status === "processing";
}

export function KnowledgeStatusStrip({ documents, materials, filter, onFilter }: KnowledgeStatusStripProps) {
  const concepts = documents.filter((d) => d.kind === "concept");
  const indexed = concepts.filter((d) => d.indexStatus === "indexed").length;
  const pending = materials.filter(isInFlight).length;
  const failed = materials.filter((m) => m.status === "failed").length;
  const fmt = (n: number) => n.toLocaleString("en-US");
  const toggle = (next: UploadFilter) => onFilter(filter === next ? null : next);
  return (
    <div className="admin-knowledge__strip" role="group" aria-label="Knowledge base status">
      <span className="admin-knowledge__chip"><b>{fmt(concepts.length)}</b><span>documents</span></span>
      <span className="admin-knowledge__chip admin-knowledge__chip--ok"><i className="admin-knowledge__dot" aria-hidden="true" /><b>{fmt(indexed)}</b><span>indexed</span></span>
      <button
        type="button"
        className="admin-knowledge__chip admin-knowledge__chip--progress admin-knowledge__chip--button"
        aria-pressed={filter === "pending"}
        onClick={() => toggle("pending")}
      >
        <i className="admin-knowledge__dot" aria-hidden="true" /><b>{fmt(pending)}</b><span>pending</span>
      </button>
      <button
        type="button"
        className="admin-knowledge__chip admin-knowledge__chip--warn admin-knowledge__chip--button"
        aria-pressed={filter === "failed"}
        onClick={() => toggle("failed")}
      >
        <i className="admin-knowledge__dot" aria-hidden="true" /><b>{fmt(failed)}</b><span>failed</span>
      </button>
      <span className="admin-knowledge__strip-sep" aria-hidden="true" />
      <span className="admin-knowledge__chip"><b>{fmt(materials.length)}</b><span>uploads</span></span>
    </div>
  );
}
