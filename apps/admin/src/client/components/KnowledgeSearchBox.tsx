import { useState } from "react";
import { apiClient } from "../lib/api-client";

type Hit = { conceptId: string; title: string; type: string; description: string; score: number };

/** The instructor's way to confirm material is findable. Same server
 *  function the student tools call, so what it finds is what the tutor
 *  can find. */
export function KnowledgeSearchBox({ courseId, onOpenDocument }: { courseId: string; onOpenDocument: (conceptId: string) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (q.trim() === "") return;
    setBusy(true); setError(null);
    try {
      setHits((await apiClient.knowledge.search(courseId, q.trim(), { signal: null })).hits);
    } catch (err) {
      setError((err as Error)?.message ?? "Search failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-knowledge-search">
      <form role="search" onSubmit={(e) => void submit(e)} className="admin-knowledge-search__form">
        {/* "admin-input" does not exist in this stylesheet; inputs elsewhere
         *  are styled either through a form-field wrapper (which targets
         *  input[type="text"], not "search") or through this genuinely
         *  shared search-input class from ListControls -- the real class
         *  a search field like this one gets. */}
        <input type="search" role="searchbox" aria-label="Search the knowledge base" className="list-controls__search-input" value={q}
          onChange={(e) => setQ(e.target.value)} placeholder="Search as a student would…" />
        <button type="submit" className="admin-button" disabled={busy}>Search</button>
      </form>
      {error && <p className="admin-field-error">{error}</p>}
      {hits && hits.length === 0 && <p className="admin-form-hint">No documents matched. Try the words a student would use.</p>}
      {hits && hits.length > 0 && (
        <ol className="admin-knowledge-search__results">
          {hits.map((h) => (
            <li key={h.conceptId}>
              <button type="button" className="admin-link-button" onClick={() => onOpenDocument(h.conceptId)}>
                {h.title} <span className="admin-muted">{h.conceptId}</span>
              </button>
              {h.description && <div className="admin-form-hint">{h.description}</div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
