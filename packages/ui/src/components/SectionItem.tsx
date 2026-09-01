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
  /** #167: this section was submitted by the scheduled overdue sweep, not
      by the student. Only meaningful with status "submitted"; ignored
      otherwise. Changes what the row *says*, not how it looks -- the ✓ is
      accurate either way (the work was submitted), but a student who never
      pressed submit should be told why their section shows as done rather
      than being left to assume they did it and forgot. */
  autoSubmitted?: boolean;
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

export function SectionItem({ number, title, status, justSubmitted = false, autoSubmitted = false, onSelect }: SectionItemProps) {
  const submittedLabel = autoSubmitted
    ? " (submitted automatically when the due date passed)"
    : " (submitted)";
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
      /* Sighted parity for the sr-only note above: the row is a ✓ and a
         title either way, so without this the auto/manual distinction
         would be available to screen-reader users only. */
      title={status === "submitted" && autoSubmitted ? `${title}${submittedLabel}` : undefined}
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
          {status === "submitted" ? submittedLabel : ""}
          {status === "current" ? " (current)" : ""}
        </span>
      </span>
    </li>
  );
}
