/* --------------------------------------------------------------------------
   SectionItem — a single row in the sidebar section progress list.

   Status variants:
     submitted — ✓ tick (Husky Purple), muted title
     current   — ● filled dot (Husky Purple), full-weight title
     pending   — ○ border dot (muted), secondary title

   Clicking a section item fires onSelect; no routing is wired at this stage.
   -------------------------------------------------------------------------- */

export type SectionStatus = "submitted" | "current" | "pending";

export interface SectionItemProps {
  /** Section number, e.g. 3 */
  number: number;
  /** Section title text */
  title: string;
  /** Status of this section */
  status: SectionStatus;
  /** When true, the ✓ indicator plays a brief gold-halo success animation.
      Consumer is responsible for clearing this back to false after ~800ms. */
  justSubmitted?: boolean;
  /** Called when the item is clicked */
  onSelect?: (number: number) => void;
}

const INDICATOR: Record<SectionStatus, string> = {
  submitted: "✓",
  current:   "●",
  pending:   "○",
};

const INDICATOR_CLASS: Record<SectionStatus, string> = {
  submitted: "section-item__indicator section-item__indicator--submitted",
  current:   "section-item__indicator section-item__indicator--current",
  pending:   "section-item__indicator section-item__indicator--pending",
};

const ITEM_CLASS: Record<SectionStatus, string> = {
  submitted: "section-item section-item--submitted",
  current:   "section-item section-item--current",
  pending:   "section-item",
};

export function SectionItem({ number, title, status, justSubmitted = false, onSelect }: SectionItemProps) {
  const handleClick = () => onSelect?.(number);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect?.(number);
    }
  };

  return (
    <li
      className={ITEM_CLASS[status]}
      role="button"
      tabIndex={0}
      aria-current={status === "current" ? "step" : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <span
        className={
          justSubmitted
            ? `${INDICATOR_CLASS[status]} section-item__indicator--just-submitted`
            : INDICATOR_CLASS[status]
        }
        aria-hidden="true"
      >
        {INDICATOR[status]}
      </span>
      <span className="section-item__number" aria-hidden="true">
        {number}
      </span>
      <span className="section-item__title">
        {title}
        <span className="sr-only">
          {status === "submitted" ? " (submitted)" : ""}
          {status === "current" ? " (current)" : ""}
        </span>
      </span>
    </li>
  );
}
