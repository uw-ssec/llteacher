/* --------------------------------------------------------------------------
   HealthItTimeline (`showHealthItTimeline`) -- milestones in the history of
   health IT and nursing informatics.

   A vertical timeline grouped by decade. Every reference entry (year,
   wording, category) comes from the figure's own curated list
   (lib/systems.ts); the model only chooses which to highlight and,
   optionally, the year range. Highlighted entries get a filled marker and
   bold text, the others a hollow marker, and a hidden word says which for
   screen readers. Each entry's category is a swatch and a word. Up to five
   course or organisation events may be added, and each is marked, in a
   dashed box and in words, as added by the tutor, not from the reference
   list. Vertical, so it reads the same on a phone.
   -------------------------------------------------------------------------- */

import {
  MILESTONE_CATEGORIES,
  MILESTONE_CATEGORY_LABEL,
  timelineSentence,
  timelineView,
  type LocalEvent,
  type MilestoneCategory,
} from "../../lib/systems";
import { FigurePlate } from "../../figure/FigurePlate";

export interface HealthItTimelineProps {
  /** 1-25 catalog ids to emphasise, or "all". */
  highlight: string[] | "all";
  /** Years to show; by default the years the highlighted entries and local events span. */
  range?: { from: number; to: number };
  /** 0-5 course- or organisation-specific events, shown as added by the tutor. */
  localEvents?: LocalEvent[];
  isPartial?: boolean;
}

/** Categories take the categorical slots in the fixed category order. */
const SWATCH: Record<MilestoneCategory, string> = {
  policy: "gen-swatch gen-swatch--1",
  report: "gen-swatch gen-swatch--2",
  standard: "gen-swatch gen-swatch--3",
  system: "gen-swatch gen-swatch--4",
  nursing: "gen-swatch gen-swatch--5",
};

const LOCAL_TAG = "Added by your tutor, not from the reference list";

type Row =
  | { kind: "ref"; year: number; label: string; category: MilestoneCategory; highlighted: boolean; key: string }
  | { kind: "local"; year: number; label: string; key: string };

export function HealthItTimeline({ highlight, range, localEvents = [], isPartial = false }: HealthItTimelineProps) {
  const view = timelineView(highlight, localEvents, range);
  const sentence = timelineSentence(view, localEvents.length);
  const allHighlighted = view.highlightedCount === view.shown.length;

  const rows: Row[] = [
    ...view.shown.map((m): Row => ({ kind: "ref", year: m.year, label: m.label, category: m.category, highlighted: m.highlighted, key: m.id })),
    ...localEvents.map((e, i): Row => ({ kind: "local", year: e.year, label: e.label, key: `local-${i}` })),
  ].sort((a, b) => a.year - b.year || (a.kind === b.kind ? 0 : a.kind === "ref" ? -1 : 1));

  const decades = view.decades.map((d) => ({ d, rows: rows.filter((r) => r.year >= d && r.year < d + 10) }));
  const used = MILESTONE_CATEGORIES.filter((c) => view.shown.some((m) => m.category === c));
  const years = view.from === view.to ? String(view.from) : `${view.from}–${view.to}`;

  return (
    <FigurePlate
      kicker="Health IT timeline"
      title={`Health IT and nursing informatics milestones, ${years}`}
      isPartial={isPartial}
      label={`Health IT timeline, ${years}. ${sentence}`}
      takeaway={<>{sentence}</>}
      note={localEvents.length ? "Dashed entries were added by your tutor for this course and are not part of the reference list." : undefined}
      table={{
        caption: "Milestones in year order",
        head: ["Year", "Milestone", "Category", "Source"],
        numeric: [true, false, false, false],
        rows: rows.map((r) =>
          r.kind === "ref"
            ? [r.year, r.label, MILESTONE_CATEGORY_LABEL[r.category], r.highlighted && !allHighlighted ? "Reference list (highlighted)" : "Reference list"]
            : [r.year, r.label, "", "Added by your tutor"],
        ),
      }}
    >
      <ul className="gen-legend gen-sy-tl-legend">
        {used.map((c) => (
          <li key={c} className="gen-legend__item">
            <span className={SWATCH[c]} aria-hidden="true" />
            <span>{MILESTONE_CATEGORY_LABEL[c]}</span>
          </li>
        ))}
        {!allHighlighted ? (
          <>
            <li className="gen-legend__item">
              <span className="gen-sy-tl__key gen-sy-tl__key--hi" aria-hidden="true" />
              <span>Highlighted</span>
            </li>
            <li className="gen-legend__item">
              <span className="gen-sy-tl__key" aria-hidden="true" />
              <span>Other milestones in range</span>
            </li>
          </>
        ) : null}
        {localEvents.length ? (
          <li className="gen-legend__item">
            <span className="gen-sy-tl__key gen-sy-tl__key--local" aria-hidden="true" />
            <span>Added by your tutor</span>
          </li>
        ) : null}
      </ul>
      <ol className="gen-sy-tl">
        {decades.map(({ d, rows: rs }) => (
          <li key={d} className="gen-sy-tl__decade">
            <h3 className="gen-sy-tl__decade-head">{d}s</h3>
            {rs.length === 0 ? (
              <p className="gen-sy-tl__empty">No milestones from the reference list in the {d}s.</p>
            ) : (
              <ul className="gen-sy-tl__list">
                {rs.map((r) =>
                  r.kind === "ref" ? (
                    <li key={r.key} className={r.highlighted && !allHighlighted ? "gen-sy-tl__item gen-sy-tl__item--hi" : allHighlighted ? "gen-sy-tl__item gen-sy-tl__item--all" : "gen-sy-tl__item"}>
                      <span className="gen-sy-tl__year">{r.year}</span>
                      <span className="gen-sy-tl__body">
                        <span className="gen-sy-tl__label">
                          {r.highlighted && !allHighlighted ? <span className="sr-only">Highlighted: </span> : null}
                          {r.label}
                        </span>
                        <span className="gen-sy-tl__cat">
                          <span className={SWATCH[r.category]} aria-hidden="true" />
                          {MILESTONE_CATEGORY_LABEL[r.category]}
                        </span>
                      </span>
                    </li>
                  ) : (
                    <li key={r.key} className="gen-sy-tl__item gen-sy-tl__item--local">
                      <span className="gen-sy-tl__year">{r.year}</span>
                      <span className="gen-sy-tl__body">
                        <span className="gen-sy-tl__label">{r.label}</span>
                        <span className="gen-sy-tl__local">{LOCAL_TAG}</span>
                      </span>
                    </li>
                  ),
                )}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </FigurePlate>
  );
}
