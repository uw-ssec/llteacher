/* --------------------------------------------------------------------------
   DiagnosticAccuracy (`showDiagnosticAccuracy`) -- a test against a
   reference standard, from the four counts of the 2x2 table.

   A mosaic: one column per truth (with / without the condition), each as
   wide as its share of the sample, split by test result -- so the top cell
   of the left column is sensitivity and the top cell of the right column is
   the false-positive rate, and how thin the left column is shows why PPV
   collapses when a condition is rare. Below it, the 2x2 table with its
   marginals and the eight measures, all computed (lib/clinical.ts). A ratio
   with a zero denominator is reported as "undefined", never NaN.
   -------------------------------------------------------------------------- */

import type { ReactNode } from "react";
import { diagnosticMetrics, fmtCount, fmtPct, fmtRatio, type DiagnosticMetrics, type TwoByTwo } from "../../lib/clinical";
import { FigurePlate, SWATCH } from "../../figure/FigurePlate";

export interface DiagnosticAccuracyProps extends TwoByTwo {
  /** e.g. "Sepsis screening alert" */
  testName?: string;
  /** e.g. "sepsis" -- the condition the reference standard confirms. */
  conditionName?: string;
  isPartial?: boolean;
}

const VB_W = 440;
const VB_H = 214;
const MX0 = 2;
const MX1 = 438;
const MY0 = 26;
const MY1 = 206;
const COL_GAP = 6;
const CELL_GAP = 2;

/** Static class lookups: test positive is slot 1, test negative slot 2. */
const CELL = { 1: "gen-mosaic__cell gen-mosaic__cell--1", 2: "gen-mosaic__cell gen-mosaic__cell--2" } as const;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Why each undefined measure is undefined, in plain words. */
function undefinedNote(m: DiagnosticMetrics): string | null {
  const why: string[] = [];
  if (m.diseased === 0) why.push("no one in the table has the condition, so sensitivity and both likelihood ratios are undefined");
  if (m.healthy === 0) why.push("everyone in the table has the condition, so specificity and both likelihood ratios are undefined");
  if (m.testPositive === 0) why.push("no result was positive, so PPV is undefined");
  if (m.testNegative === 0) why.push("no result was negative, so NPV is undefined");
  if (m.diseased > 0 && m.healthy > 0 && m.lrPositive === null) why.push("there are no false positives (specificity 100%), so LR+ is undefined");
  if (m.diseased > 0 && m.healthy > 0 && m.lrNegative === null) why.push("specificity is 0%, so LR− is undefined");
  if (!why.length) return null;
  const s = why.join("; ");
  return `Undefined means the denominator is zero: ${s}.`;
}

export function DiagnosticAccuracy({ tp, fp, fn, tn, testName, conditionName, isPartial = false }: DiagnosticAccuracyProps) {
  const m = diagnosticMetrics({ tp, fp, fn, tn });
  const cond = conditionName?.trim() || "the condition";
  // Short column headers; a long condition name falls back to generic ones.
  const short = conditionName && conditionName.trim().length <= 14 ? conditionName.trim() : null;
  const headWith = short ? `With ${short}` : "Condition present";
  const headWithout = short ? `Without ${short}` : "Condition absent";

  // Columns as wide as their share of the sample (a non-empty column keeps
  // at least 3 units so it stays visible).
  const avail = MX1 - MX0 - (m.diseased && m.healthy ? COL_GAP : 0);
  const wWith = m.diseased === 0 ? 0 : m.healthy === 0 ? avail : Math.max(3, Math.min(avail - 3, (m.diseased / m.total) * avail));
  const wWithout = m.healthy === 0 ? 0 : avail - wWith;
  const xWith = MX0;
  const xWithout = MX0 + wWith + (m.diseased && m.healthy ? COL_GAP : 0);
  const H = MY1 - MY0;

  type Cell = { key: string; abbr: string; name: string; n: number; of: number; x: number; w: number; slot: 1 | 2; top: boolean };
  const cells: Cell[] = [
    { key: "tp", abbr: "TP", name: "True positives", n: tp, of: m.diseased, x: xWith, w: wWith, slot: 1, top: true },
    { key: "fn", abbr: "FN", name: "False negatives", n: fn, of: m.diseased, x: xWith, w: wWith, slot: 2, top: false },
    { key: "fp", abbr: "FP", name: "False positives", n: fp, of: m.healthy, x: xWithout, w: wWithout, slot: 1, top: true },
    { key: "tn", abbr: "TN", name: "True negatives", n: tn, of: m.healthy, x: xWithout, w: wWithout, slot: 2, top: false },
  ];
  const geom = (c: Cell) => {
    const topN = c.top ? c.n : c.of - c.n;
    const gap = c.n > 0 && topN > 0 && c.of - topN > 0 ? CELL_GAP / 2 : 0;
    const hTop = (topN / c.of) * H;
    return c.top ? { y: MY0, h: Math.max(0, hTop - gap) } : { y: MY0 + hTop + gap, h: Math.max(0, H - hTop - gap) };
  };

  const posN = m.testPositive;
  const negN = m.testNegative;
  const ppvSentence: ReactNode = posN === 0
    ? <>No result was positive, so PPV is undefined.</>
    : (
      <>
        Of {fmtCount(posN)} positive {plural(posN, "result", "results")}, {fmtCount(tp)} {plural(tp, "has", "have")} {cond}: PPV = {fmtCount(tp)} / {fmtCount(posN)} ={" "}
        <strong>{fmtPct(m.ppv)}</strong>. {fp === 0 ? "None are false positives." : <>The other {fmtCount(fp)} {plural(fp, "is a false positive", "are false positives")}.</>}
      </>
    );
  const npvSentence: ReactNode = negN === 0
    ? <> No result was negative, so NPV is undefined.</>
    : <> Of {fmtCount(negN)} negative {plural(negN, "result", "results")}, {fmtCount(tn)} {plural(tn, "does", "do")} not have {cond} (NPV {fmtPct(m.npv)}).</>;

  const note = undefinedNote(m)
    ?? `Sensitivity and specificity describe the test; PPV and NPV also depend on how common ${cond} is in the people tested (here ${fmtPct(m.prevalence)}).`;

  const measures: Array<[string, string, string]> = [
    ["Sensitivity", `TP / (TP + FN) = ${fmtCount(tp)} / ${fmtCount(m.diseased)}`, fmtPct(m.sensitivity)],
    ["Specificity", `TN / (TN + FP) = ${fmtCount(tn)} / ${fmtCount(m.healthy)}`, fmtPct(m.specificity)],
    ["PPV", `TP / (TP + FP) = ${fmtCount(tp)} / ${fmtCount(posN)}`, fmtPct(m.ppv)],
    ["NPV", `TN / (TN + FN) = ${fmtCount(tn)} / ${fmtCount(negN)}`, fmtPct(m.npv)],
    ["Accuracy", `(TP + TN) / total = ${fmtCount(tp + tn)} / ${fmtCount(m.total)}`, fmtPct(m.accuracy)],
    ["Prevalence", `(TP + FN) / total = ${fmtCount(m.diseased)} / ${fmtCount(m.total)}`, fmtPct(m.prevalence)],
    ["LR+", "sensitivity / (1 − specificity)", fmtRatio(m.lrPositive)],
    ["LR−", "(1 − sensitivity) / specificity", fmtRatio(m.lrNegative)],
  ];

  const aria = `${testName ?? "Test"} against ${cond}: ${fmtCount(tp)} true positives, ${fmtCount(fp)} false positives, ${fmtCount(fn)} false negatives, ${fmtCount(tn)} true negatives. Sensitivity ${fmtPct(m.sensitivity)}, specificity ${fmtPct(m.specificity)}, PPV ${fmtPct(m.ppv)}, NPV ${fmtPct(m.npv)}.`;

  return (
    <FigurePlate
      kicker="Diagnostic accuracy"
      title={testName ?? "Test results against the reference standard"}
      isPartial={isPartial}
      label={aria}
      takeaway={<>{ppvSentence}{npvSentence}</>}
      note={note}
      table={{
        caption: "Accuracy measures computed from the 2 × 2 table",
        head: ["Measure", "Calculation", "Value"],
        rows: measures,
        numeric: [false, false, true],
      }}
    >
      <svg className="gen-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label={aria}>
        {m.diseased > 0 ? <text className="gen-svg__label" x={xWith} y={16}>{headWith}</text> : null}
        {m.healthy > 0 ? <text className="gen-svg__label" x={MX1} y={16} textAnchor="end">{headWithout}</text> : null}
        {cells.map((c) => {
          if (c.of === 0 || c.n === 0) return null;
          const g = geom(c);
          const fits = c.w >= 64 && g.h >= 26;
          return (
            <g key={c.key}>
              <rect className={CELL[c.slot]} x={c.x} y={g.y} width={c.w} height={Math.max(1, g.h)} rx={2}>
                <title>{`${c.name} (${c.abbr}): ${fmtCount(c.n)} of ${fmtCount(c.of)} ${c.key === "tp" || c.key === "fn" ? "with" : "without"} ${cond}`}</title>
              </rect>
              {fits ? (
                <text className="gen-svg__label" x={c.x + c.w / 2} y={g.y + g.h / 2 + 5} textAnchor="middle">{`${c.abbr} ${fmtCount(c.n)}`}</text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <ul className="gen-legend">
        <li className="gen-legend__item"><span className={SWATCH[1]} aria-hidden="true" /><span>Test positive (top)</span></li>
        <li className="gen-legend__item"><span className={SWATCH[2]} aria-hidden="true" /><span>Test negative (bottom)</span></li>
        <li className="gen-legend__item"><span>Column width = share of the sample</span></li>
      </ul>
      <div className="gen-figure__table-wrap">
        <table className="gen-figure__table">
          <caption className="sr-only">2 × 2 table with totals</caption>
          <thead>
            <tr>
              <td />
              <th scope="col" className="gen-num">{headWith}</th>
              <th scope="col" className="gen-num">{headWithout}</th>
              <th scope="col" className="gen-num">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Test positive</th>
              <td className="gen-num">{`TP ${fmtCount(tp)}`}</td>
              <td className="gen-num">{`FP ${fmtCount(fp)}`}</td>
              <td className="gen-num">{fmtCount(posN)}</td>
            </tr>
            <tr>
              <th scope="row">Test negative</th>
              <td className="gen-num">{`FN ${fmtCount(fn)}`}</td>
              <td className="gen-num">{`TN ${fmtCount(tn)}`}</td>
              <td className="gen-num">{fmtCount(negN)}</td>
            </tr>
            <tr>
              <th scope="row">Total</th>
              <td className="gen-num">{fmtCount(m.diseased)}</td>
              <td className="gen-num">{fmtCount(m.healthy)}</td>
              <td className="gen-num">{fmtCount(m.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <dl className="gen-stats gen-mosaic__stats">
        {measures.map(([name, , value]) => (
          <div key={name} className="gen-stat"><dt>{name}</dt><dd>{value}</dd></div>
        ))}
      </dl>
    </FigurePlate>
  );
}
