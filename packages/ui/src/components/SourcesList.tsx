export interface SourceRef {
  conceptId: string;
  title: string;
}

/** Collapsible attribution under a grounded tutor reply. Concepts are whole
 *  documents this quarter, so there are no page numbers. */
export function SourcesList({ sources }: { sources: SourceRef[] }) {
  if (sources.length === 0) return null;
  return (
    <details className="message__sources">
      <summary className="message__sources-summary">Sources ({sources.length})</summary>
      <ul className="message__sources-list">
        {sources.map((s) => (
          <li key={s.conceptId} className="message__sources-item">
            <span className="message__sources-title">{s.title}</span>{" "}
            <span className="message__sources-id">{s.conceptId}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
