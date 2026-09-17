/* --------------------------------------------------------------------------
   KnowledgeAttention — uploads the pipeline could not finish on its own.

   This is where the honest-status rule lives now: a PDF sitting at
   `pending` with its reason showing is listed here, not buried in a
   thousand-row upload list. Five rows by default; the rest behind Show all.
   -------------------------------------------------------------------------- */

import { ArrowClockwise } from "@phosphor-icons/react";
import { StatusBadge } from "./StatusBadge";
import { isInFlight, type UploadFilter } from "./KnowledgeStatusStrip";
import { materialLabel, statusKind, statusLabel } from "../lib/knowledgeStatus";
import type { MaterialPayload } from "@llteacher/ui/api";

const PREVIEW_ROWS = 5;

export type KnowledgeAttentionProps = {
  materials: readonly MaterialPayload[];
  filter: UploadFilter | null;
  showAll: boolean;
  onShowAll: () => void;
  onRetry: (materialId: string) => void;
  onRetryAllFailed: () => void;
};

export function needsAttention(material: MaterialPayload): boolean {
  return isInFlight(material) || material.status === "failed";
}

function reasonFor(material: MaterialPayload): string {
  if (material.errorDetail) return material.errorDetail;
  return material.status === "processing" ? "Converting…" : "Waiting for conversion.";
}

export function KnowledgeAttention({ materials, filter, showAll, onShowAll, onRetry, onRetryAllFailed }: KnowledgeAttentionProps) {
  const rows = materials.filter((m) =>
    filter === "pending" ? isInFlight(m) : filter === "failed" ? m.status === "failed" : needsAttention(m),
  );
  const visible = showAll ? rows : rows.slice(0, PREVIEW_ROWS);
  const hidden = rows.length - visible.length;
  const failedCount = rows.filter((m) => m.status === "failed").length;

  if (rows.length === 0) {
    return <p className="admin-knowledge__empty">Nothing here. Every upload has been converted.</p>;
  }
  return (
    <div className="admin-knowledge__attention">
      <ul className="admin-knowledge__attention-list">
        {visible.map((material) => {
          const label = materialLabel(material);
          return (
            <li
              key={material.id}
              className={
                material.status === "failed"
                  ? "admin-knowledge__attention-row admin-knowledge__attention-row--failed"
                  : "admin-knowledge__attention-row"
              }
            >
              <span className="admin-knowledge__attention-stripe" aria-hidden="true" />
              <div className="admin-knowledge__attention-body">
                <span className="admin-knowledge__attention-name">{label}</span>
                <span className="admin-knowledge__attention-reason">{reasonFor(material)}</span>
              </div>
              <StatusBadge kind={statusKind(material.status)}>{statusLabel(material.status)}</StatusBadge>
              <button
                type="button"
                className="admin-button admin-button--minimal"
                onClick={() => onRetry(material.id)}
                aria-label={`Retry ingestion for ${label}`}
              >
                <ArrowClockwise size={13} weight="bold" aria-hidden="true" /> Retry
              </button>
            </li>
          );
        })}
      </ul>
      {(hidden > 0 || failedCount > 0) && (
        <div className="admin-knowledge__attention-foot">
          <span>{hidden > 0 ? `${hidden} more` : ""}</span>
          <span className="admin-knowledge__attention-actions">
            {hidden > 0 && (
              <button type="button" className="admin-button admin-button--minimal" onClick={onShowAll}>
                Show all {rows.length}
              </button>
            )}
            {failedCount > 0 && (
              <button type="button" className="admin-button admin-button--minimal" onClick={onRetryAllFailed}>
                Retry all failed
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
