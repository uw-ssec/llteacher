/* --------------------------------------------------------------------------
   Knowledge statuses as StatusBadge kinds (#42).

   StatusBadge's `kind` is a closed union driving one CSS class each, and none
   of its members are `pending`/`ready`/`indexed`. Mapping onto the existing
   kinds rather than widening the union keeps a shared component free of a new
   domain's vocabulary and needs no new CSS -- and costs nothing legible,
   because the exact status word is the badge's visible text either way.
   -------------------------------------------------------------------------- */

import type { StatusKind } from "../components/StatusBadge";
import type { KnowledgeIndexStatus, MaterialStatus } from "@llteacher/ui/api";

const KIND: Record<MaterialStatus | KnowledgeIndexStatus, StatusKind> = {
  pending: "scheduled",
  processing: "in_progress",
  ready: "active",
  indexed: "active",
  failed: "missing",
};

const LABEL: Record<MaterialStatus | KnowledgeIndexStatus, string> = {
  pending: "Pending",
  processing: "Processing",
  ready: "Ready",
  indexed: "Indexed",
  failed: "Failed",
};

export function statusKind(status: MaterialStatus | KnowledgeIndexStatus): StatusKind {
  return KIND[status];
}

export function statusLabel(status: MaterialStatus | KnowledgeIndexStatus): string {
  return LABEL[status];
}
