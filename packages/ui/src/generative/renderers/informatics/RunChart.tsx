/* --------------------------------------------------------------------------
   RunChart (`showRunChart`) -- a quality-improvement run chart.

   The IHI method (Perla, Provost & Murray, BMJ Qual Saf 2011): the figure
   computes the median (of a baseline, or of every point) and applies two run
   chart rules -- a SHIFT (6+ consecutive points on one side of the median)
   and a TREND (5+ consecutive points all rising or all falling). Signal
   points get an ink ring and a bracketed label, never colour alone. The
   takeaway only calls something an improvement when a signal runs in the
   direction the model said is better; with no signal it says so.
   -------------------------------------------------------------------------- */

import {
  analyseRunChart,
  fmtNum,
  niceTicks,
  ratePct,
  signalFavourable,
  type Direction,
  type RunSignal,
} from "../../lib/measurement";
import { FigurePlate, SWATCH } from "../../figure/FigurePlate";

export type RunChartPoint = { label: string; value: number } | { label: string; numerator: number; denominator: number };

export interface RunChartProps {
  /** What is measured, e.g. "BCMA scanning compliance, 4 West". */
  measure: string;
  /** Value mode only, e.g. "minutes per shift". Rate points are always percent. */
  unit?: string;
  /** 10–60 points in time order: all {label, value} or all {label, numerator, denominator}. */
  points: RunChartPoint[];
  /** Which direction is better. */
  improvement?: Direction;
  /** Label of the point after which a change was introduced. */
  changeAfter?: string;
  /** Name of that change, e.g. "BCMA re-education". */
  changeLabel?: string;
  /** Median from the first N points (the baseline); default all points. */
  baselineCount?: number;
  isPartial?: boolean;
}

const VB_W = 440;
const PX0 = 48;
const PX1 = 356;
const PAD = 6;
const ROW = 22;
const PLOT_H = 170;

const isRate = (p: RunChartPoint): p is { label: string; numerator: number; denominator: number } => "numerator" in p;

function signalText(s: RunSignal, n: number): string {
  return s.kind === "shift"
    ? `A shift of ${n} points ${s.direction === "up" ? "above" : "below"} the median`
    : `A trend of ${n} ${s.direction === "up" ? "increasing" : "decreasing"} points`;
}

export function RunChart({ measure, unit, points, improvement, changeAfter, changeLabel, baselineCount, isPartial = false }: RunChartProps) {
  const rate = isRate(points[0]!);
  const values = points.map((p) => (isRate(p) ? ratePct(p.numerator, p.denominator) : p.value));
  const n = points.length;
  const base = baselineCount ?? n;
  const a = analyseRunChart(values, base);
  const m = a.median;
  const fmtV = (v: number) => (rate ? `${fmtNum(v)}%` : fmtNum(v));
  const unitText = rate ? "" : unit ? ` ${unit}` : "";

  const changeIdx = changeAfter === undefined ? -1 : points.findIndex((p) => p.label === changeAfter);
  const changeName = changeLabel ?? "the change";
  const shifts = a.signals.filter((s) => s.kind === "shift");
  const trends = a.signals.filter((s) => s.kind === "trend");

  /* -- Sentences ------------------------------------------------------------ */
  const basis = base === n ? `from all ${n} points` : `from the first ${base} points (the baseline), extended to the rest`;
  const sentences = a.signals.map((s) => {
    const start = s.points[0]!;
    const when = changeIdx < 0 ? "" : start > changeIdx ? `, after ${changeName}` : `, before ${changeName}`;
    const fav = signalFavourable(s, improvement);
    const verdict = fav === null ? "" : fav ? ": an improvement" : ": a change in the worse direction";
    return `${signalText(s, s.points.length)} began at ${points[start]!.label}${when}${verdict}.`;
  });
  const noSignal = "No shift (6 or more points on one side of the median) and no trend (5 or more points all rising or all falling): no non-random signal yet, so this chart does not show an improvement.";
  const medianSentence = `Median ${fmtV(m)}${unitText}, ${basis}.`;
  const aria = `Run chart of ${measure}, ${n} points from ${points[0]!.label} to ${points[n - 1]!.label}. ${medianSentence} ${sentences.length ? sentences.join(" ") : noSignal}`;

  /* -- Geometry ------------------------------------------------------------- */
  const rows = { change: -1, shift: -1, trend: -1, ytitle: 0 };
  let r = 0;
  if (changeIdx >= 0) rows.change = r++;
  if (shifts.length) rows.shift = r++;
  if (trends.length) rows.trend = r++;
  rows.ytitle = r++;
  const rowY = (i: number) => 15 + i * ROW;
  const PY0 = r * ROW + 12;
  const PY1 = PY0 + PLOT_H;
  const VB_H = PY1 + 30;

  let lo = Math.min(m, ...values);
  let hi = Math.max(m, ...values);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  let ticks = niceTicks(lo, hi);
  if (rate) ticks = ticks.filter((t) => t >= 0 && t <= 100);
  const tLo = Math.min(ticks[0]!, lo);
  const tHi = Math.max(ticks[ticks.length - 1]!, hi);
  const sx = (i: number) => PX0 + PAD + (n === 1 ? 0 : (i / (n - 1)) * (PX1 - PX0 - 2 * PAD));
  const sy = (v: number) => PY1 - ((v - tLo) / (tHi - tLo)) * (PY1 - PY0);
  const step = (PX1 - PX0 - 2 * PAD) / (n - 1);
  const path = values.map((v, i) => `${i === 0 ? "M" : "L"}${sx(i).toFixed(2)},${sy(v).toFixed(2)}`).join(" ");

  // The median: solid over the baseline, dashed where it is extended.
  const baseEnd = base === n ? PX1 : Math.min(PX1, sx(base - 1) + step / 2);

  // X labels: as many as fit (labels can be long ISO dates), always the last.
  const maxLen = Math.max(...points.map((p) => p.label.length));
  const fit = Math.max(2, Math.floor((PX1 - PX0) / (maxLen * 10.5 + 14)));
  const every = Math.max(1, Math.ceil((n - 1) / (fit - 1)));
  const xLabels = points.flatMap((_, i) => (i === n - 1 || (i % every === 0 && n - 1 - i >= every * 0.6) ? [i] : []));
  const longLabels = maxLen > 5;

  // Signal points are ringed; points on the median inside a shift are not.
  const signalAt = new Map<number, string[]>();
  for (const s of a.signals) {
    for (const i of s.points) {
      const t = s.kind === "shift" ? (s.direction === "up" ? "Shift above" : "Shift below") : s.direction === "up" ? "Trend up" : "Trend down";
      signalAt.set(i, [...(signalAt.get(i) ?? []), t]);
    }
  }

  // Bracket labels; a label that would run into the previous one in its row is left off (the bracket stays).
  const bracketLabels = (list: RunSignal[]) => {
    let lastEnd = -Infinity;
    return list.map((s) => {
      const x0 = sx(s.points[0]!);
      const x1 = sx(s.points[s.points.length - 1]!);
      const text = `${s.kind === "shift" ? "Shift" : "Trend"} · ${s.points.length} ${s.kind === "shift" ? (s.direction === "up" ? "above" : "below") : s.direction === "up" ? "rising" : "falling"}`;
      const w = text.length * 8.5;
      const atEnd = x0 + w > VB_W - 4;
      const left = atEnd ? x1 - w : x0;
      const show = left > lastEnd + 6;
      if (show) lastEnd = left + w;
      return { s, x0, x1, text, anchor: atEnd ? ("end" as const) : ("start" as const), tx: atEnd ? x1 : x0, show };
    });
  };

  const changeX = changeIdx < 0 ? 0 : changeIdx === n - 1 ? Math.min(PX1, sx(n - 1) + step / 2) : (sx(changeIdx) + sx(changeIdx + 1)) / 2;
  const changeText = changeLabel ?? "Change";
  const changeRight = changeX < (PX0 + PX1) / 2;

  const yTitle = rate ? "Percent" : unit ?? "";
  const verdictNote =
    improvement === undefined
      ? " Which direction is better was not given, so no signal is called an improvement."
      : ` ${improvement === "up" ? "Higher" : "Lower"} is better.`;

  return (
    <FigurePlate
      kicker="Run chart"
      title={measure}
      isPartial={isPartial}
      label={aria}
      takeaway={
        <>
          Median <strong>{fmtV(m)}</strong>
          {unitText}, {basis}. {sentences.length ? sentences.join(" ") : noSignal}
        </>
      }
      note={`Run chart rules (Perla, Provost & Murray, 2011): a shift is 6 or more consecutive points all above or all below the median, and a trend is 5 or more consecutive points all rising or all falling. Points on the median, and repeated values within a trend, are skipped. The number-of-runs rule is not applied. A signal says the change is unlikely to be chance, not what caused it.${verdictNote}`}
      table={{
        caption: `${measure}: each point, its side of the median and any signal`,
        head: rate ? ["Point", "Numerator", "Denominator", "Rate", "Side of median", "Signal"] : ["Point", unit ? `Value (${unit})` : "Value", "Side of median", "Signal"],
        rows: points.map((p, i) => {
          const side = a.sides[i] === "on" ? "On median" : a.sides[i] === "above" ? "Above" : "Below";
          const sig = signalAt.get(i)?.join("; ") ?? "—";
          const label = i === changeIdx ? `${p.label} (then ${changeText})` : p.label;
          return isRate(p) ? [label, p.numerator, p.denominator, fmtV(values[i]!), side, sig] : [label, fmtNum(p.value), side, sig];
        }),
        numeric: rate ? [false, true, true, true, false, false] : [false, true, false, false],
      }}
    >
      <svg className="gen-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label={aria}>
        <text className="gen-svg__axis-title" x={PX0 - 2} y={rowY(rows.ytitle)}>{yTitle}</text>
        {ticks.map((t) => (
          <g key={t}>
            <line className="gen-grid" x1={PX0} y1={sy(t)} x2={PX1} y2={sy(t)} />
            <text className="gen-svg__mono" x={PX0 - 6} y={sy(t) + 4} textAnchor="end">{rate ? `${fmtNum(t)}%` : fmtNum(t)}</text>
          </g>
        ))}
        <line className="gen-axis" x1={PX0} y1={PY1} x2={PX1} y2={PY1} />
        {xLabels.map((i) => (
          <text
            key={i}
            className="gen-svg__mono"
            x={sx(i)}
            y={PY1 + 18}
            textAnchor={longLabels && i === 0 ? "start" : longLabels && i === n - 1 ? "end" : "middle"}
          >
            {points[i]!.label}
          </text>
        ))}

        {/* The change: between the point it follows and the next one. */}
        {changeIdx >= 0 ? (
          <g>
            <line className="gen-guide" x1={changeX} y1={rowY(rows.change) + 6} x2={changeX} y2={PY1} />
            <text className="gen-svg__label" x={changeX + (changeRight ? 5 : -5)} y={rowY(rows.change)} textAnchor={changeRight ? "start" : "end"}>
              {changeText}
            </text>
          </g>
        ) : null}

        {/* The median, and where it is a baseline extended forward. */}
        <line className="gen-ms-median" x1={PX0} y1={sy(m)} x2={baseEnd} y2={sy(m)}>
          <title>{`Median ${fmtV(m)}`}</title>
        </line>
        {baseEnd < PX1 ? <line className="gen-ms-median gen-ms-median--ext" x1={baseEnd} y1={sy(m)} x2={PX1} y2={sy(m)} /> : null}
        <text className="gen-svg__axis-title" x={PX1 + 6} y={sy(m) - 4}>Median</text>
        <text className="gen-svg__label" x={PX1 + 6} y={sy(m) + 12}>{fmtV(m)}</text>

        <path className="gen-line gen-line--1" d={path} />
        {values.map((v, i) => (
          <circle key={i} className="gen-dot gen-fill--1" cx={sx(i)} cy={sy(v)} r={4}>
            <title>{`${points[i]!.label}: ${fmtV(v)}${signalAt.has(i) ? ` (${signalAt.get(i)!.join("; ")})` : ""}`}</title>
          </circle>
        ))}
        {[...signalAt.keys()].map((i) => (
          <circle key={`ring-${i}`} className="gen-ms-ring" cx={sx(i)} cy={sy(values[i]!)} r={7.5} />
        ))}

        {/* Signal brackets above the plot. */}
        {(
          [
            [rows.shift, shifts],
            [rows.trend, trends],
          ] as const
        ).flatMap(([row, list]) =>
          row < 0
            ? []
            : bracketLabels(list).map((b) => (
                <g key={`${b.s.kind}-${b.s.points[0]}`}>
                  <path className="gen-ms-bracket" d={`M${b.x0},${rowY(row) + 10} L${b.x0},${rowY(row) + 5} L${b.x1},${rowY(row) + 5} L${b.x1},${rowY(row) + 10}`}>
                    <title>{b.text}</title>
                  </path>
                  {b.show ? (
                    <text className="gen-svg__label" x={b.tx} y={rowY(row)} textAnchor={b.anchor}>{b.text}</text>
                  ) : null}
                </g>
              )),
        )}
      </svg>
      <ul className="gen-legend">
        <li className="gen-legend__item"><span className={SWATCH[1]} aria-hidden="true" /><span>{rate ? `${measure} (%)` : measure}</span></li>
        <li className="gen-legend__item"><span className="gen-ms-key-median" aria-hidden="true" /><span>{base === n ? "Median" : "Baseline median (dashed where extended)"}</span></li>
        {a.signals.length ? (
          <li className="gen-legend__item"><span className="gen-ms-key-ring" aria-hidden="true" /><span>Point in a shift or trend</span></li>
        ) : null}
        {changeIdx >= 0 ? (
          <li className="gen-legend__item"><span className="gen-ms-key-change" aria-hidden="true" /><span>{`${changeText} introduced`}</span></li>
        ) : null}
      </ul>
    </FigurePlate>
  );
}
