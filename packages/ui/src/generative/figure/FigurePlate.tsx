/* --------------------------------------------------------------------------
   FigurePlate -- the shared frame every generative figure sits in.

   A textbook figure, not a dashboard card: kicker (with the tutor's gold
   tick, since the tutor produced it), title, a hairline-ruled figure area,
   an optional computed takeaway, and an optional "Show the numbers" table
   view -- the accessible alternative to the drawing, same idea as UW
   DawgPath's "Display data as a table".
   -------------------------------------------------------------------------- */

import type { ReactNode } from "react";

export interface FigurePlateProps {
  kicker: string;
  title: string;
  children: ReactNode;
  takeaway?: ReactNode;
  note?: ReactNode;
  /** Rows for the table view; omitted when the figure has no numbers. */
  table?: { caption: string; head: string[]; rows: Array<Array<string | number>>; numeric?: boolean[] };
  isPartial?: boolean;
  label?: string;
}

export function FigurePlate({ kicker, title, children, takeaway, note, table, isPartial = false, label }: FigurePlateProps) {
  return (
    <figure
      className={isPartial ? "gen-figure gen-figure--partial" : "gen-figure"}
      aria-label={label ?? title}
      aria-busy={isPartial || undefined}
    >
      <figcaption className="gen-figure__head">
        <span className="gen-figure__kicker">{kicker}</span>
        <span className="gen-figure__title">{title}</span>
      </figcaption>
      <div className="gen-figure__body">{children}</div>
      {takeaway ? <p className="gen-figure__takeaway">{takeaway}</p> : null}
      {note ? <p className="gen-figure__note">{note}</p> : null}
      {table && !isPartial ? (
        <details className="gen-figure__data">
          <summary>Show the numbers</summary>
          <div className="gen-figure__table-wrap">
            <table className="gen-figure__table">
              <caption className="sr-only">{table.caption}</caption>
              <thead>
                <tr>
                  {table.head.map((h, i) => (
                    <th key={h} scope="col" className={table.numeric?.[i] ? "gen-num" : undefined}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, i) => (
                      <td key={i} className={table.numeric?.[i] ? "gen-num" : undefined}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </figure>
  );
}

/** Shown while the model is still streaming a figure's arguments. */
export function FigureSkeleton({ kicker, title }: { kicker: string; title?: string }) {
  return (
    <FigurePlate kicker={kicker} title={title ?? "Drawing…"} isPartial>
      <p className="gen-figure__skeleton">Drawing the figure…</p>
    </FigurePlate>
  );
}

/** Static class lookups: classes stay literal strings (design-system lint). */
export const SWATCH = { 1: "gen-swatch gen-swatch--1", 2: "gen-swatch gen-swatch--2", 3: "gen-swatch gen-swatch--3", 4: "gen-swatch gen-swatch--4", 5: "gen-swatch gen-swatch--5" } as const;
export const LINE = { 1: "gen-line gen-line--1", 2: "gen-line gen-line--2", 3: "gen-line gen-line--3", 4: "gen-line gen-line--4", 5: "gen-line gen-line--5" } as const;
export const FILL = { 1: "gen-fill--1", 2: "gen-fill--2", 3: "gen-fill--3", 4: "gen-fill--4", 5: "gen-fill--5" } as const;
export type Slot = 1 | 2 | 3 | 4 | 5;
