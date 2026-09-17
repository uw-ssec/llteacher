/* --------------------------------------------------------------------------
   KnowledgeSearchField — the hero of the knowledge page.

   One field, two layers. Typing is reported upward so the caller can match
   file names instantly; Enter, the arrow button, or a 450 ms pause after
   three or more characters asks the caller to run the tutor's content
   search. The pause is a convenience over Enter, not a replacement: every
   content search spawns the okf process, so two letters never trigger one.

   The folder chosen in the rail appears inside the field as a chip, so the
   scope of what you are about to search is visible where you type.
   -------------------------------------------------------------------------- */

import { useEffect, useRef } from "react";
import { ArrowRight, MagnifyingGlass, X } from "@phosphor-icons/react";

const AUTO_SEARCH_MIN_CHARS = 3;
const AUTO_SEARCH_DELAY_MS = 450;

export type KnowledgeSearchFieldProps = {
  value: string;
  onChange: (value: string) => void;
  /** Run the content search for the current value. */
  onSubmit: () => void;
  onClear: () => void;
  /** Directory the search is scoped to, or null for the whole bundle. */
  scope: string | null;
  onClearScope: () => void;
  busy: boolean;
};

export function KnowledgeSearchField({ value, onChange, onSubmit, onClear, scope, onClearScope, busy }: KnowledgeSearchFieldProps) {
  // Latest callback without making it an effect dependency: the debounce
  // below must restart only when the text changes, not on every render.
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;

  useEffect(() => {
    if (value.trim().length < AUTO_SEARCH_MIN_CHARS) return;
    const timer = setTimeout(() => submitRef.current(), AUTO_SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value]);

  return (
    <div className="admin-knowledge__search">
      <form
        role="search"
        className="admin-knowledge__search-field"
        onSubmit={(e) => { e.preventDefault(); if (value.trim() !== "") onSubmit(); }}
      >
        <MagnifyingGlass size={20} className="admin-knowledge__search-lead" aria-hidden="true" />
        {scope !== null && (
          <span className="admin-knowledge__scope">
            in <span className="admin-knowledge__scope-name">{scope.split("/").pop()}</span>
            <button type="button" className="admin-knowledge__scope-clear" aria-label="Clear folder scope" onClick={onClearScope}>
              <X size={12} weight="bold" aria-hidden="true" />
            </button>
          </span>
        )}
        <input
          id="knowledge-search"
          type="search"
          role="searchbox"
          autoComplete="off"
          autoFocus
          aria-label="Search the knowledge base"
          className="admin-knowledge__search-input"
          placeholder="Search by name, or press Enter to search inside documents"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") onClear(); }}
        />
        {value !== "" && (
          <button type="button" className="admin-knowledge__search-clear" aria-label="Clear search" onClick={onClear}>
            <X size={16} aria-hidden="true" />
          </button>
        )}
        <button type="submit" className="admin-knowledge__search-go" aria-label="Search inside documents" aria-busy={busy || undefined}>
          <ArrowRight size={18} weight="bold" aria-hidden="true" />
        </button>
      </form>
      <p className="admin-knowledge__search-hint">
        <span><kbd>↵</kbd> search inside documents, the way the tutor does</span>
        <span><kbd>Esc</kbd> clear</span>
      </p>
    </div>
  );
}
