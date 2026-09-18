/* --------------------------------------------------------------------------
   KnowledgeSearchResults — one list, one toggle.

   "Inside documents" is the tutor's own BM25 search over the bundle, so
   what an instructor sees ranked here is what a student's question would
   retrieve. "File names" is the instant client-side match over titles and
   paths of the documents already loaded. Both respect the folder scope;
   the content search sends it as `dir` so the server can fill the limit
   from inside that folder rather than from the global top hits.

   Ten rows show; the rest sit behind Show all. The gold bar is score
   relative to the top hit -- not just what the tutor finds, but how
   confidently.
   -------------------------------------------------------------------------- */

import { useEffect, useMemo, useState } from "react";
import { Warning } from "@phosphor-icons/react";
import { StatusBadge } from "./StatusBadge";
import { KnowledgeDownloadTools } from "./KnowledgeDownloadTools";
import { apiClient } from "../lib/api-client";
import { statusKind, statusLabel } from "../lib/knowledgeStatus";
import type { KnowledgeDocumentSummaryPayload } from "@llteacher/ui/api";

const PREVIEW_ROWS = 10;

type Hit = { conceptId: string; title: string; type: string; description: string; score: number };
type Mode = "content" | "names";
type Sort = "relevance" | "name" | "updated";

export type KnowledgeSearchResultsProps = {
  courseId: string;
  /** What is in the field right now: drives the instant name matches. */
  query: string;
  /** The last query the instructor asked to search inside documents, or
   *  null if they have not yet. */
  submittedQuery: string | null;
  scope: string | null;
  documents: readonly KnowledgeDocumentSummaryPayload[];
  onOpenDocument: (documentId: string) => void;
  onRevealFolder: (directory: string) => void;
};

function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function inScope(path: string, scope: string | null): boolean {
  return scope === null || path === scope || path.startsWith(`${scope}/`);
}

/** Wraps every occurrence of a query term in <mark>. */
function Highlight({ text, query }: { text: string; query: string }) {
  const t = terms(query);
  if (t.length === 0 || text === "") return <>{text}</>;
  const re = new RegExp(`(${t.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig");
  return (
    <>
      {text.split(re).map((part, i) =>
        t.includes(part.toLowerCase()) ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

function PathCrumbs({ path, onRevealFolder }: { path: string; onRevealFolder: (dir: string) => void }) {
  const parts = path.split("/");
  return (
    <span className="admin-knowledge__result-path">
      {parts.slice(0, -1).map((segment, i) => {
        const dir = parts.slice(0, i + 1).join("/");
        return (
          <span key={dir}>
            <button type="button" className="admin-knowledge__crumb" aria-label={`Show folder ${dir}`} onClick={() => onRevealFolder(dir)}>
              {segment}
            </button>
            <span aria-hidden="true"> / </span>
          </span>
        );
      })}
      <span>{parts[parts.length - 1]}</span>
    </span>
  );
}

export function KnowledgeSearchResults({
  courseId, query, submittedQuery, scope, documents, onOpenDocument, onRevealFolder,
}: KnowledgeSearchResultsProps) {
  const [mode, setMode] = useState<Mode>("content");
  const [sort, setSort] = useState<Sort>("relevance");
  const [showAll, setShowAll] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A new query or scope starts the list over: nothing from the previous
  // search should survive into the next.
  useEffect(() => { setShowAll(false); }, [query, scope, mode]);

  useEffect(() => {
    if (submittedQuery === null) { setHits(null); setError(null); return; }
    const controller = new AbortController();
    setBusy(true); setError(null);
    apiClient.knowledge.search(courseId, submittedQuery, { signal: controller.signal }, scope ?? undefined)
      .then((r) => { if (!controller.signal.aborted) setHits(r.hits); })
      .catch((err) => { if (!controller.signal.aborted) setError((err as Error)?.message ?? "Search failed."); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [courseId, submittedQuery, scope]);

  const byPath = useMemo(() => new Map(documents.map((d) => [d.path, d])), [documents]);

  const nameMatches = useMemo(() => {
    const t = terms(query);
    if (t.length === 0) return [];
    return documents.filter(
      (d) => d.kind === "concept" && inScope(d.path, scope) &&
        t.every((x) => (d.title ?? "").toLowerCase().includes(x) || d.path.toLowerCase().includes(x)),
    );
  }, [documents, query, scope]);

  const contentRows = useMemo(() => {
    if (!hits) return [];
    const rows = hits.map((h) => ({ hit: h, doc: byPath.get(h.conceptId) ?? null }));
    if (sort === "name") rows.sort((a, b) => a.hit.title.localeCompare(b.hit.title, undefined, { numeric: true }));
    if (sort === "updated") rows.sort((a, b) => (b.doc?.updatedAt ?? "").localeCompare(a.doc?.updatedAt ?? ""));
    return rows;
  }, [hits, byPath, sort]);

  const nameRows = useMemo(() => {
    const rows = [...nameMatches];
    if (sort === "updated") rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    else rows.sort((a, b) => (a.title ?? a.path).localeCompare(b.title ?? b.path, undefined, { numeric: true }));
    return rows;
  }, [nameMatches, sort]);

  const topScore = contentRows.reduce((m, r) => Math.max(m, r.hit.score), 0) || 1;
  const cap = <T,>(rows: T[]) => (showAll ? rows : rows.slice(0, PREVIEW_ROWS));
  const showAllButton = (total: number) =>
    total > PREVIEW_ROWS && !showAll ? (
      <div className="admin-knowledge__show-all">
        <button type="button" className="admin-button admin-button--ghost" onClick={() => setShowAll(true)}>
          Show all {total}
        </button>
      </div>
    ) : null;

  function switchMode(next: Mode) {
    setMode(next);
    if (next === "names" && sort === "relevance") setSort("name");
    if (next === "content" && sort === "name") setSort("relevance");
  }

  return (
    <section className="admin-knowledge__results" aria-label="Search results">
      <div className="admin-knowledge__section-head">
        <h2 className="admin-knowledge__label">Results for “{query}”</h2>
        <span className="admin-knowledge__hint">
          {scope && <><span className="admin-knowledge__mono">{scope}</span> · </>}
          {mode === "content" ? "what the tutor retrieves for this query" : "titles and paths containing these words"}
        </span>
      </div>
      <div className="admin-knowledge__toolbar">
        <div className="admin-knowledge__seg" role="group" aria-label="Match type">
          <button type="button" aria-pressed={mode === "content"} onClick={() => switchMode("content")}>
            Inside documents <span className="admin-knowledge__seg-count">{busy ? "…" : hits ? hits.length : "↵"}</span>
          </button>
          <button type="button" aria-pressed={mode === "names"} onClick={() => switchMode("names")}>
            File names <span className="admin-knowledge__seg-count">{nameMatches.length}</span>
          </button>
        </div>
        <label className="admin-knowledge__sort">
          Sort
          <select aria-label="Sort results" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            {mode === "content" && <option value="relevance">Relevance</option>}
            <option value="name">Name</option>
            <option value="updated">Last updated</option>
          </select>
        </label>
      </div>

      {error && (
        <div className="admin-alert" role="alert">
          <span className="admin-alert__icon" aria-hidden="true"><Warning size={16} /></span>
          <span>{error}</span>
        </div>
      )}

      {mode === "content" ? (
        busy && !hits ? (
          <p className="admin-loading">Searching the way the tutor does…</p>
        ) : submittedQuery === null ? (
          <p className="admin-knowledge__empty">
            Press Enter to search inside every document for <b>{query}</b>. That is the same search the tutor runs when a student asks.
          </p>
        ) : hits && hits.length === 0 ? (
          <p className="admin-knowledge__empty">
            <b>Nothing inside the documents matched “{submittedQuery}”.</b> Try the words a student would use, or switch to File names.
          </p>
        ) : (
          <>
            <ol className="admin-knowledge__result-list">
              {cap(contentRows).map(({ hit, doc }) => (
                <li key={hit.conceptId} className="admin-knowledge__result">
                  <div className="admin-knowledge__result-main">
                    <button type="button" className="admin-knowledge__result-open" aria-label={`Open ${hit.title}`} onClick={() => onOpenDocument(hit.conceptId)}>
                      <span className="admin-knowledge__result-title"><Highlight text={hit.title} query={query} /></span>
                      {hit.description && (
                        <span className="admin-knowledge__result-desc"><Highlight text={hit.description} query={query} /></span>
                      )}
                    </button>
                    <div className="admin-knowledge__result-meta">
                      {hit.type && <span className="admin-knowledge__type">{hit.type}</span>}
                      {doc && doc.indexStatus !== "indexed" && (
                        <StatusBadge kind={statusKind(doc.indexStatus)}>{statusLabel(doc.indexStatus)}</StatusBadge>
                      )}
                      <PathCrumbs path={hit.conceptId} onRevealFolder={onRevealFolder} />
                    </div>
                  </div>
                  <div className="admin-knowledge__result-side">
                    <span className="admin-knowledge__score" title={`Relevance ${hit.score.toFixed(1)}`}>
                      <span className="admin-knowledge__score-bar"><i style={{ width: `${Math.round((hit.score / topScore) * 100)}%` }} /></span>
                      {hit.score.toFixed(1)}
                    </span>
                    <KnowledgeDownloadTools courseId={courseId} documentPath={hit.conceptId} title={hit.title} sourceMaterialId={doc?.sourceMaterialId ?? null} />
                  </div>
                </li>
              ))}
            </ol>
            {showAllButton(contentRows.length)}
          </>
        )
      ) : nameRows.length === 0 ? (
        <p className="admin-knowledge__empty">No titles or paths contain “{query}”.</p>
      ) : (
        <>
          <ol className="admin-knowledge__result-list">
            {cap(nameRows).map((d) => (
              <li key={d.id} className="admin-knowledge__result admin-knowledge__result--name">
                <div className="admin-knowledge__result-main">
                  <button type="button" className="admin-knowledge__result-open" aria-label={`Open ${d.title ?? d.path}`} onClick={() => onOpenDocument(d.id)}>
                    <span className="admin-knowledge__result-title"><Highlight text={d.title ?? d.path} query={query} /></span>
                  </button>
                  <div className="admin-knowledge__result-meta">
                    {d.type && <span className="admin-knowledge__type">{d.type}</span>}
                    {d.indexStatus !== "indexed" && (
                      <StatusBadge kind={statusKind(d.indexStatus)}>{statusLabel(d.indexStatus)}</StatusBadge>
                    )}
                    <PathCrumbs path={d.path} onRevealFolder={onRevealFolder} />
                  </div>
                </div>
                <div className="admin-knowledge__result-side">
                  <KnowledgeDownloadTools courseId={courseId} documentPath={d.path} title={d.title ?? d.path} sourceMaterialId={d.sourceMaterialId} />
                </div>
              </li>
            ))}
          </ol>
          {showAllButton(nameRows.length)}
        </>
      )}
    </section>
  );
}
