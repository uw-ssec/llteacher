/* --------------------------------------------------------------------------
   KnowledgeUploads — every raw file as received, closed by default.

   Uploads are files, not content; nobody scrolls a thousand of them. What
   needs a human already surfaced in KnowledgeAttention, so this exists for
   the occasional "did that file actually arrive?" -- filter by name, page
   through, newest first.

   The rows render only once the disclosure is open. A thousand table rows
   parked in a closed <details> would still cost the browser, and every file
   name would sit in the DOM twice (here and in the attention list).
   -------------------------------------------------------------------------- */

import { useMemo, useState } from "react";
import { CaretRight, FileArrowDown } from "@phosphor-icons/react";
import { apiClient } from "../lib/api-client";
import { StatusBadge } from "./StatusBadge";
import { materialLabel, statusKind, statusLabel } from "../lib/knowledgeStatus";
import type { MaterialPayload } from "@llteacher/ui/api";

const PAGE_SIZE = 25;

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function KnowledgeUploads({ courseId, materials }: { courseId: string; materials: readonly MaterialPayload[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...materials]
      .filter((m) => q === "" || materialLabel(m).toLowerCase().includes(q))
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }, [materials, query]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const slice = rows.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);

  return (
    <details className="admin-knowledge__uploads" open={open}>
      <summary
        className="admin-knowledge__uploads-summary"
        onClick={(e) => { e.preventDefault(); setOpen((o) => !o); }}
      >
        <span className="admin-knowledge__chevron" aria-hidden="true"><CaretRight size={12} weight="bold" /></span>
        <h2 className="admin-knowledge__label">All uploads · {materials.length.toLocaleString("en-US")}</h2>
        <span className="admin-knowledge__hint">raw files as received, newest first</span>
      </summary>
      {!open ? null : materials.length === 0 ? (
        <p className="admin-form-hint">Nothing uploaded yet.</p>
      ) : (
        <>
          <div className="admin-knowledge__uploads-tools">
            <input
              type="search"
              className="list-controls__search-input admin-knowledge__uploads-filter"
              aria-label="Filter uploads by file name"
              placeholder="Filter uploads by file name"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(0); }}
            />
            <span className="admin-knowledge__hint">
              Showing {slice.length} of {rows.length.toLocaleString("en-US")}
            </span>
          </div>
          <div className="admin-knowledge__table-wrap">
            <table className="admin-table admin-knowledge__uploads-table">
              <thead>
                <tr><th>File</th><th>Type</th><th>Size</th><th>Status</th><th>Uploaded</th><th><span className="admin-visually-hidden">Download</span></th></tr>
              </thead>
              <tbody>
                {slice.length === 0 ? (
                  <tr><td colSpan={6} className="admin-muted">No uploads match.</td></tr>
                ) : slice.map((m) => (
                  <tr key={m.id}>
                    <td className="admin-knowledge__mono">{materialLabel(m)}</td>
                    <td>{m.sourceType}</td>
                    <td>{formatBytes(m.byteSize)}</td>
                    <td><StatusBadge kind={statusKind(m.status)}>{statusLabel(m.status)}</StatusBadge></td>
                    <td>{formatDate(m.uploadedAt)}</td>
                    <td>
                      <a
                        className="admin-knowledge__icon-link"
                        href={apiClient.knowledge.materialDownloadUrl(courseId, m.id)}
                        download=""
                        aria-label={`Download ${materialLabel(m)}`}
                        title="Download original"
                      >
                        <FileArrowDown size={16} aria-hidden="true" />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="admin-knowledge__pager">
            <span>Page {current + 1} of {pages}</span>
            <span>
              <button type="button" className="admin-button admin-button--minimal" disabled={current === 0} onClick={() => setPage(current - 1)}>
                ← Previous
              </button>
              <button type="button" className="admin-button admin-button--minimal" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                Next →
              </button>
            </span>
          </div>
        </>
      )}
    </details>
  );
}
