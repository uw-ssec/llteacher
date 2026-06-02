/* --------------------------------------------------------------------------
   Sidebar — the homework section progress rail.

   This is the structurally distinctive element of LLTeacher: not a generic
   thread list, but the syllabus of the current homework assignment.

   Layout (top to bottom):
     HW label in mono small-caps
     Section list (SectionItem × N)
     Divider
     Utility links (hint history)
     Submit affordance (▸ text-link, Husky Purple, sliding arrow)
     Spacer
     Worker status colophon

   The current section is the only "conversation" visible in the main column.
   Clicking a section item fires onSectionSelect.
   -------------------------------------------------------------------------- */

import { useEffect, useRef, useState } from "react";
import { CaretDoubleLeft, CaretDoubleRight, Lightbulb, PaperPlaneTilt } from "@phosphor-icons/react";
import { SectionItem } from "./SectionItem";
import type { SectionStatus } from "./SectionItem";

export interface SidebarSection {
  number: number;
  title: string;
  status: SectionStatus;
}

export interface SidebarProps {
  /** Homework number, e.g. 3 */
  hwNumber: number;
  /** Homework title */
  hwTitle: string;
  /** All sections of this homework */
  sections: SidebarSection[];
  /** Currently active section number */
  currentSection: number;
  /** Number of hints used */
  hintCount?: number;
  /** Section number that was just submitted (plays gold-halo success animation
      for ~700ms on its ✓ indicator). Pass null or omit when nothing to flash. */
  justSubmittedSection?: number | null;
  /** When true, the sidebar collapses to a 64px rail showing only indicators. */
  isCollapsed?: boolean;
  /** Called when the collapse toggle is clicked. */
  onToggleCollapse?: () => void;
  /** Called when a section row is clicked */
  onSectionSelect?: (sectionNumber: number) => void;
  /** Called when "Submit Section N" is clicked */
  onSubmit?: (sectionNumber: number) => void;
  /** Worker status line — shown at the bottom */
  workerStatus?: string | null;
  /** Whether worker check is still loading */
  workerLoading?: boolean;
}

export function Sidebar({
  hwNumber,
  hwTitle,
  sections,
  currentSection,
  hintCount = 0,
  justSubmittedSection = null,
  isCollapsed = false,
  onToggleCollapse,
  onSectionSelect,
  onSubmit,
  workerStatus,
  workerLoading = false,
}: SidebarProps) {
  /* Detect hintCount increments and trigger the gold flash animation on
     the count numeral for ~600ms. Tracks previous value via ref. */
  const [hintFlashing, setHintFlashing] = useState(false);
  const prevHintCount = useRef(hintCount);
  useEffect(() => {
    if (hintCount > prevHintCount.current) {
      setHintFlashing(true);
      const t = setTimeout(() => setHintFlashing(false), 600);
      prevHintCount.current = hintCount;
      return () => clearTimeout(t);
    }
    prevHintCount.current = hintCount;
  }, [hintCount]);

  return (
    <nav
      className={isCollapsed ? "sidebar sidebar--collapsed" : "sidebar"}
      aria-label={`Homework ${hwNumber} sections`}
    >
      {/* Collapse toggle — chevron points away from the sidebar edge it'll move toward */}
      <div className="sidebar__top">
        <button
          className="sidebar__collapse-toggle"
          type="button"
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!isCollapsed}
          onClick={onToggleCollapse}
        >
          {isCollapsed
            ? <CaretDoubleRight size={14} weight="regular" />
            : <CaretDoubleLeft size={14} weight="regular" />}
        </button>
      </div>

      {/* Homework label */}
      <p className="sidebar__hw-label" aria-label={`Homework ${hwNumber}: ${hwTitle}`}>
        HW {hwNumber} · {hwTitle}
      </p>

      {/* Section list */}
      <ol className="sidebar__section-list" aria-label="Section progress">
        {sections.map((s) => (
          <SectionItem
            key={s.number}
            number={s.number}
            title={s.title}
            status={s.status}
            justSubmitted={s.number === justSubmittedSection}
            onSelect={onSectionSelect}
          />
        ))}
      </ol>

      <hr className="sidebar__divider" />

      {/* Utility links */}
      <div className="sidebar__utility">
        {/* Hint history — three-column row: indicator · label · count */}
        <button
          className="hint-history-row"
          type="button"
          aria-label={`Hint history, ${hintCount} hint${hintCount !== 1 ? "s" : ""} used`}
        >
          <span className="hint-history-row__indicator" aria-hidden="true">
            <Lightbulb size={14} weight="regular" />
          </span>
          <span className="hint-history-row__label">Hint history</span>
          <span
            className={
              hintFlashing
                ? "hint-history-row__count hint-history-row__count--flash"
                : "hint-history-row__count"
            }
            aria-label={`${hintCount} hints used`}
          >
            {hintCount}
          </span>
        </button>

        {/* Submit affordance — bordered button with two-line typography */}
        <button
          className="submit-action"
          type="button"
          onClick={() => onSubmit?.(currentSection)}
          aria-label={`Submit section ${currentSection} for grading`}
        >
          <span className="submit-action__arrow" aria-hidden="true">
            <PaperPlaneTilt size={14} weight="regular" />
          </span>
          <span className="submit-action__body">
            <span className="submit-action__label">Submit Section {currentSection}</span>
            <span className="submit-action__meta" aria-hidden="true">READY TO TURN IN</span>
          </span>
        </button>
      </div>

      {/* Push worker status to the bottom */}
      <div className="sidebar__spacer" />

      {/* Worker status — quiet mono colophon */}
      <div className="sidebar__worker" aria-live="polite">
        {workerLoading && (
          <span>worker: checking…</span>
        )}
        {!workerLoading && workerStatus && (
          <span>worker: ok · <span style={{ opacity: 0.7 }}>{workerStatus}</span></span>
        )}
        {!workerLoading && !workerStatus && (
          <span style={{ opacity: 0.5 }}>worker: —</span>
        )}
      </div>
    </nav>
  );
}
