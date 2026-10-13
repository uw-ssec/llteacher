/* --------------------------------------------------------------------------
   PrevalenceEffect (`showPrevalenceEffect`) -- why a good test makes a poor
   alert when the condition is rare.

   Sensitivity and specificity are held fixed; PPV (slot 1) and NPV (slot 2)
   are computed by Bayes' theorem across a range of prevalence and drawn as
   two lines, with the population the tool is used in marked and its values
   labelled. The takeaway turns PPV into the alert-fatigue sentence clinicians
   recognise -- "about 9 of every 10 positive alerts are false positives" --
   and the natural frequencies behind it, all computed (lib/clinical.ts).
   -------------------------------------------------------------------------- */

import {
  falseAlertPhrase,
  fmtCount,
  fmtPct,
  fmtRate,
  naturalFrequencies,
  npvAt,
  ppvAt,
  prevalenceDomain,
} from "../../lib/clinical";
import { FigurePlate, LINE, SWATCH } from "../../figure/FigurePlate";

export interface PrevalenceEffectProps {
  sensitivity: number;
  specificity: number;
  /** Prevalence in the population the tool is used in, 0 < p < 1. */
  prevalence: number;
  /** e.g. "Sepsis screening alert" */
  testName?: string;
  isPartial?: boolean;
}

const VB_W = 440;
const VB_H = 268;
const PX0 = 44;
const PX1 = 384;
const PY0 = 40;
const PY1 = 232;
const SAMPLES = 120;

export function PrevalenceEffect({ sensitivity: se, specificity: sp, prevalence: p, testName, isPartial = false }: PrevalenceEffectProps) {
  const xMax = prevalenceDomain(p);
  const sx = (x: number) => PX0 + (x / xMax) * (PX1 - PX0);
  const sy = (y: number) => PY1 - y * (PY1 - PY0);

  // Sample (0, xMax]; at p -> 0 the limits are PPV -> 0 (or 1 when Sp = 1)
  // and NPV -> 1, so the first sample sits just right of zero.
  const xs = Array.from({ length: SAMPLES }, (_, i) => (xMax * (i + 1)) / SAMPLES);
  const path = (f: (x: number) => number | null) =>
    xs.map((x, i) => `${i === 0 ? "M" : "L"}${sx(x).toFixed(2)},${sy(f(x) ?? 0).toFixed(2)}`).join(" ");
  const ppvPath = path((x) => ppvAt(se, sp, x));
  const npvPath = path((x) => npvAt(se, sp, x));

  const ppv = ppvAt(se, sp, p)!;
  const npv = npvAt(se, sp, p)!;
  // Natural frequencies in a cohort big enough to hold at least 10 cases.
  const cohort = p * 1000 >= 10 ? 1000 : p * 10_000 >= 10 ? 10_000 : 100_000;
  const nf = naturalFrequencies(se, sp, p, cohort);
  const positives = nf.truePositive + nf.falsePositive;

  // Labels beside the dots at the marked prevalence, on the side of each
  // curve that it bends away from: NPV falls with prevalence and PPV rises,
  // so to the right NPV's label goes above its line and PPV's below (to the
  // left, the reverse). A PPV dot near the axis keeps its label level.
  const px = sx(p);
  const right = px <= (PX0 + PX1) / 2;
  const anchor = right ? "start" : "end";
  const dx = right ? 9 : -9;
  let npvLabelY = right ? sy(npv) - 9 : sy(npv) + 18;
  let ppvLabelY = right ? (sy(ppv) + 18 <= PY1 - 4 ? sy(ppv) + 18 : sy(ppv) + 4) : sy(ppv) - 9;
  if (Math.abs(ppvLabelY - npvLabelY) < 16) {
    // Values too close for that: level with the dots, pushed apart.
    const mid = (sy(ppv) + sy(npv)) / 2 + 4;
    const ppvHigher = ppv >= npv;
    ppvLabelY = mid + (ppvHigher ? -8 : 8);
    npvLabelY = mid + (ppvHigher ? 8 : -8);
  }

  // Direct end labels on the right, nudged apart when the lines end close.
  const endPpv = ppvAt(se, sp, xMax) ?? 0;
  const endNpv = npvAt(se, sp, xMax) ?? 0;
  let yPpv = sy(endPpv) + 4;
  let yNpv = sy(endNpv) + 4;
  if (Math.abs(yPpv - yNpv) < 14) {
    const mid = (yPpv + yNpv) / 2;
    const up = endPpv >= endNpv;
    yPpv = mid + (up ? -7 : 7);
    yNpv = mid + (up ? 7 : -7);
  }

  const xTicks = (xMax === 0.5 ? [0, 0.2, 0.4, 0.6, 0.8, 1] : [0, 0.25, 0.5, 0.75, 1]).map((f) => f * xMax);
  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const name = testName ?? "The test";

  // Table: a fixed ladder of prevalences plus the one in use.
  const ladder = [...new Set([0.001, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, p])].sort((a, b) => a - b);

  const aria = `${name}, sensitivity ${fmtRate(se)} and specificity ${fmtRate(sp)}: PPV and NPV across prevalence 0 to ${fmtRate(xMax)}. At ${fmtRate(p)} prevalence, PPV ${fmtPct(ppv)} and NPV ${fmtPct(npv)}; ${falseAlertPhrase(ppv)}.`;

  return (
    <FigurePlate
      kicker="Predictive value"
      title={testName ? `${testName}: predictive value by prevalence` : "Predictive value by prevalence"}
      isPartial={isPartial}
      label={aria}
      takeaway={
        <>
          At {fmtRate(p)} prevalence, PPV is <strong>{fmtPct(ppv)}</strong>: {falseAlertPhrase(ppv)}. Test {fmtCount(cohort)} people:{" "}
          {fmtCount(nf.diseased)} have the condition and about {fmtCount(nf.truePositive)} of them test positive; {fmtCount(nf.healthy)} do
          not, and about {fmtCount(nf.falsePositive)} of them test positive anyway, so about {fmtCount(nf.truePositive)} of{" "}
          {fmtCount(positives)} positives are real.
        </>
      }
      note={`Sensitivity (${fmtRate(se)}) and specificity (${fmtRate(sp)}) stay the same at every prevalence; PPV and NPV do not. NPV here is ${fmtPct(npv)}.`}
      table={{
        caption: "PPV and NPV at selected prevalences",
        head: ["Prevalence", "PPV", "NPV", "False alerts per 10 positives"],
        rows: ladder.map((x) => {
          const v = ppvAt(se, sp, x)!;
          return [x === p ? `${fmtRate(x)} (this population)` : fmtRate(x), fmtPct(v), fmtPct(npvAt(se, sp, x)), ((1 - v) * 10).toFixed(1)];
        }),
        numeric: [false, true, true, true],
      }}
    >
      <svg className="gen-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label={aria}>
        {yTicks.map((t) => (
          <g key={t}>
            <line className="gen-grid" x1={PX0} y1={sy(t)} x2={PX1} y2={sy(t)} />
            <text className="gen-svg__mono" x={PX0 - 6} y={sy(t) + 4} textAnchor="end">{`${t * 100}%`}</text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} className="gen-svg__mono" x={sx(t)} y={PY1 + 16} textAnchor="middle">{fmtRate(t)}</text>
        ))}
        <line className="gen-axis" x1={PX0} y1={PY1} x2={PX1} y2={PY1} />
        <text className="gen-svg__axis-title" x={PX1} y={VB_H - 2} textAnchor="end">Prevalence</text>

        {/* The population the tool is used in. */}
        <line className="gen-guide" x1={px} y1={PY0 - 20} x2={px} y2={PY1} />
        <text className="gen-svg__mono" x={px + (right ? 4 : -4)} y={PY0 - 24} textAnchor={anchor}>{`${fmtRate(p)} (this population)`}</text>

        <path className={LINE[2]} d={npvPath}><title>{`NPV across prevalence 0–${fmtRate(xMax)}`}</title></path>
        <path className={LINE[1]} d={ppvPath}><title>{`PPV across prevalence 0–${fmtRate(xMax)}`}</title></path>

        <circle className="gen-dot gen-fill--2" cx={px} cy={sy(npv)} r={5}><title>{`NPV at ${fmtRate(p)}: ${fmtPct(npv)}`}</title></circle>
        <circle className="gen-dot gen-fill--1" cx={px} cy={sy(ppv)} r={5}><title>{`PPV at ${fmtRate(p)}: ${fmtPct(ppv)}`}</title></circle>
        <text className="gen-svg__label" x={px + dx} y={ppvLabelY} textAnchor={anchor}>{`PPV ${fmtPct(ppv)}`}</text>
        <text className="gen-svg__label" x={px + dx} y={npvLabelY} textAnchor={anchor}>{`NPV ${fmtPct(npv)}`}</text>

        <text className="gen-svg__label" x={PX1 + 6} y={yPpv}>PPV</text>
        <text className="gen-svg__label" x={PX1 + 6} y={yNpv}>NPV</text>
      </svg>
      <ul className="gen-legend">
        <li className="gen-legend__item"><span className={SWATCH[1]} aria-hidden="true" /><span>PPV: chance a positive result is a true positive</span></li>
        <li className="gen-legend__item"><span className={SWATCH[2]} aria-hidden="true" /><span>NPV: chance a negative result is a true negative</span></li>
      </ul>
    </FigurePlate>
  );
}
