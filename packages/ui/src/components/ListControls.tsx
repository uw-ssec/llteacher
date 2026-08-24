/* --------------------------------------------------------------------------
   ListControls — search, filter, and sort for the console's record lists.

   One component for all three lists deliberately. The rows on Homeworks,
   Submissions, and LLM configs drifted apart once already (see the row-grid
   fix that shipped alongside this), and three separate search boxes would
   recreate exactly that: the same task, three different shapes, and an
   instructor relearning the page every time they move between them.

   Every section is optional, so a page takes only what its data justifies. A
   list of three LLM configs gets a sort and nothing else -- a search box over
   three rows is not neutral, it tells the reader the list is long enough to
   need searching, which is a lie the chrome keeps telling every time they
   visit.

   ACCESSIBILITY NOTES, since three separate things here are easy to get
   subtly wrong and impossible to notice by looking:

   · The result summary is a live region that is ALWAYS mounted, even while
     empty. A live region inserted at the same moment its text appears is
     frequently missed entirely -- the announcement has to land in a region
     the screen reader was already watching.
   · That announcement is debounced while the filtering is not. Filtering on
     every keystroke is what makes the list feel immediate; announcing on
     every keystroke means a screen-reader user hears a new count for each
     character and can never hear one to its end.
   · The filter is a real radio group, not the tablist this replaces. The
     previous markup claimed role="tab"/aria-selected with no tabpanel behind
     it and no arrow-key handling, so assistive tech announced "tab, 1 of 3"
     and then the arrow keys the user pressed did nothing. Native radios carry
     mutual exclusivity and roving arrow-key focus for free, which is what the
     chips meant all along.
   -------------------------------------------------------------------------- */

import { useEffect, useId, useRef, useState } from "react";
import { MagnifyingGlass, X } from "@phosphor-icons/react";

export interface FilterOption {
  value: string;
  label: string;
  /** Shown as a chip count. Counts should reflect the unfiltered list, so the
   *  numbers stay stable as the reader clicks between them. */
  count?: number;
}

export interface SortOption {
  value: string;
  label: string;
}

export interface ListControlsProps {
  /** Omit to render no search field. */
  search?: {
    value: string;
    onChange: (value: string) => void;
    /** Visually hidden, so the field still has a name without a visible one. */
    label: string;
    placeholder?: string;
  };
  /** Omit to render no filter chips. */
  filter?: {
    value: string;
    onChange: (value: string) => void;
    label: string;
    options: FilterOption[];
  };
  /** Omit to render no sort control. */
  sort?: {
    value: string;
    onChange: (value: string) => void;
    label: string;
    options: SortOption[];
  };
  /** Announced and displayed, e.g. "Showing 12 of 212 students". */
  summary: string;
}

/** Long enough that a moderate typist finishes a word first, short enough
 *  that the count still feels like a response to what was typed. */
const ANNOUNCE_DELAY_MS = 500;

export function ListControls({ search, filter, sort, summary }: ListControlsProps) {
  const id = useId();
  const searchId = `${id}-search`;
  const sortId = `${id}-sort`;

  /* The delayed copy of `summary` that assistive tech actually reads. The
     visible text uses `summary` directly, so sighted readers see the count
     update instantly while the announcement waits for a pause in typing. */
  const [announced, setAnnounced] = useState(summary);
  const firstRun = useRef(true);

  useEffect(() => {
    // Skip the debounce on mount: the initial count is not a change anyone is
    // waiting to hear, and delaying it would announce the list half a second
    // after the page settles for no reason.
    if (firstRun.current) {
      firstRun.current = false;
      setAnnounced(summary);
      return;
    }
    const t = setTimeout(() => setAnnounced(summary), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(t);
  }, [summary]);

  return (
    <div className="list-controls">
      <div className="list-controls__bar">
        {search && (
          <div className="list-controls__search">
            <label className="sr-only" htmlFor={searchId}>
              {search.label}
            </label>
            <span className="list-controls__search-icon" aria-hidden="true">
              <MagnifyingGlass size={15} weight="regular" />
            </span>
            <input
              id={searchId}
              // type="search" gives the platform's own clear affordance and
              // the right on-screen keyboard; the explicit button below covers
              // the browsers that render none.
              type="search"
              className="list-controls__search-input"
              value={search.value}
              placeholder={search.placeholder}
              onChange={(e) => search.onChange(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            {search.value && (
              <button
                type="button"
                className="list-controls__search-clear"
                onClick={() => search.onChange("")}
              >
                <X size={13} weight="bold" aria-hidden="true" />
                <span className="sr-only">Clear search</span>
              </button>
            )}
          </div>
        )}

        {sort && (
          <div className="list-controls__sort">
            <label className="list-controls__sort-label" htmlFor={sortId}>
              {sort.label}
            </label>
            <select
              id={sortId}
              className="list-controls__sort-select"
              value={sort.value}
              onChange={(e) => sort.onChange(e.target.value)}
            >
              {sort.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {filter && (
        <div className="list-controls__filters" role="radiogroup" aria-label={filter.label}>
          {filter.options.map((o) => {
            const active = o.value === filter.value;
            return (
              <label
                key={o.value}
                className={active ? "admin-filter admin-filter--active" : "admin-filter"}
              >
                <input
                  type="radio"
                  className="sr-only"
                  name={`${id}-filter`}
                  value={o.value}
                  checked={active}
                  onChange={() => filter.onChange(o.value)}
                />
                <span className="admin-filter__label">{o.label}</span>
                {o.count !== undefined && <span className="admin-filter__count">{o.count}</span>}
              </label>
            );
          })}
        </div>
      )}

      {/* Always mounted -- see the note at the top of this file. */}
      <p className="list-controls__summary">
        <span aria-hidden="true">{summary}</span>
        <span className="sr-only" role="status" aria-live="polite">
          {announced}
        </span>
      </p>
    </div>
  );
}
