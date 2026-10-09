/* --------------------------------------------------------------------------
   RocCurve (`showRocCurve`) -- a test's trade-off across thresholds.

   Sensitivity (true-positive rate) against 1 − specificity (false-positive
   rate), one point per threshold, joined in FPR order and anchored at (0, 0)
   and (1, 1), over the chance diagonal. The figure computes the area under
   that curve by the trapezoid rule and finds the threshold with the largest
   Youden's J = sensitivity + specificity − 1 -- drawn as the vertical gap
   between the point and the diagonal, because that is what J is.
   -------------------------------------------------------------------------- */

import { fmtPct, rocCurve, type RocPoint } from "../../lib/clinical";
import { FigurePlate } from "../../figure/FigurePlate";

export interface RocCurveProps {
  /** 2-30 operating points, one per threshold. */
  points: RocPoint[];
  /** e.g. "Early warning score, ICU transfer within 24 h" */
  label?: string;
  isPartial?: boolean;
}

const VB_W = 440;
const VB_H = 318;
const PX0 = 48;
const PX1 = 318;
const PY0 = 28;
const PY1 = 288;
const sx = (fpr: number) => PX0 + fpr * (PX1 - PX0);
const sy = (tpr: number) => PY1 - tpr * (PY1 - PY0);

const thresholdText = (t: RocPoint["threshold"]) => (t === undefined ? null : String(t));
const pointName = (p: RocPoint, i: number) => {
  const t = thresholdText(p.threshold);
  return t === null ? `Point ${i + 1}` : `Threshold ${t}`;
};

export function RocCurve({ points, label, isPartial = false }: RocCurveProps) {
  const r = rocCurve(points);
  const auc = r.auc;
  const best = r.best;
  const bestThreshold = thresholdText(best.threshold);
  const aucText = auc.toFixed(2);
  const jText = best.j.toFixed(2);
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  const line = r.curve.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.fpr)},${sy(p.tpr)}`).join(" ");
  const area = `${line} L${sx(1)},${sy(0)} L${sx(0)},${sy(0)} Z`;

  const where = bestThreshold === null ? "at the point" : `at threshold ${bestThreshold}`;
  const quality = auc < 0.5
    ? "Below 0.5 the test ranks worse than chance: check whether a higher value should mean a negative result."
    : "0.5 is chance (the diagonal); 1.0 is perfect separation.";
  const aria = `ROC curve${label ? ` for ${label}` : ""} with ${points.length} thresholds: AUC ${aucText}. Youden's J is highest ${where}: sensitivity ${fmtPct(best.sensitivity)}, specificity ${fmtPct(best.specificity)}, J ${jText}.`;

  // The best point's label sits up and to the left, the empty side of a
  // concave curve, unless that would run into the y-axis labels.
  const bx = sx(best.fpr);
  const by = sy(best.tpr);
  const bestLabel = bestThreshold === null ? "Max J" : `Max J · ${bestThreshold}`;
  const labelLeft = bx - 10 - bestLabel.length * 9 >= PX0;

  return (
    <FigurePlate
      kicker="ROC analysis"
      title={label ? `ROC curve · ${label}` : "ROC curve"}
      isPartial={isPartial}
      label={aria}
      takeaway={
        <>
          AUC = <strong>{aucText}</strong> by the trapezoid rule. {quality} Youden&apos;s J (sensitivity + specificity − 1) is highest {where}:
          sensitivity {fmtPct(best.sensitivity)}, specificity {fmtPct(best.specificity)}, J = <strong>{jText}</strong>.
        </>
      }
      note="The area joins the given points with straight lines from (0, 0) to (1, 1). The best threshold by J weighs a missed case and a false alarm equally; a clinical setting rarely does."
      table={{
        caption: "Operating points, in order of false-positive rate",
        head: ["Threshold", "Sensitivity", "Specificity", "1 − specificity", "Youden's J"],
        rows: r.sorted.map((p) => [
          thresholdText(p.threshold) ?? "—",
          fmtPct(p.sensitivity),
          fmtPct(p.specificity),
          fmtPct(p.fpr),
          (p.sensitivity + p.specificity - 1).toFixed(2),
        ]),
        numeric: [false, true, true, true, true],
      }}
    >
      <svg className="gen-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label={aria}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="gen-grid" x1={PX0} y1={sy(t)} x2={PX1} y2={sy(t)} />
            <line className="gen-grid" x1={sx(t)} y1={PY0} x2={sx(t)} y2={PY1} />
            <text className="gen-svg__mono" x={PX0 - 6} y={sy(t) + 4} textAnchor="end">{t}</text>
            <text className="gen-svg__mono" x={sx(t)} y={PY1 + 16} textAnchor="middle">{t}</text>
          </g>
        ))}
        <path className="gen-axis" d={`M${PX0},${PY0 - 4} L${PX0},${PY1} L${PX1 + 4},${PY1}`} />
        <text className="gen-svg__axis-title" x={PX0 - 2} y={PY0 - 12}>Sensitivity (true-positive rate)</text>
        <text className="gen-svg__axis-title" x={PX1 + 4} y={VB_H - 2} textAnchor="end">1 − specificity (false-positive rate)</text>

        {/* Chance: a test no better than a coin. */}
        <line className="gen-guide" x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} />
        <text className="gen-svg__mono" x={sx(0.78) + 4} y={sy(0.78) + 16}>Chance</text>

        <path className="gen-roc__area" d={area} />
        <path className="gen-line gen-line--1" d={line} />

        {/* J is the vertical distance from the diagonal to the point. */}
        <line className="gen-arrow" x1={bx} y1={sy(best.fpr)} x2={bx} y2={by} />
        <text className="gen-svg__mono" x={bx + 6} y={(sy(best.fpr) + by) / 2 + 4}>{`J = ${jText}`}</text>

        {r.sorted.map((p, i) => (
          <circle key={i} className="gen-dot gen-fill--1" cx={sx(p.fpr)} cy={sy(p.tpr)} r={4}>
            <title>{`${pointName(p, i)}: sensitivity ${fmtPct(p.sensitivity)}, specificity ${fmtPct(p.specificity)}`}</title>
          </circle>
        ))}
        <circle className="gen-dot gen-dot--now" cx={bx} cy={by} r={6}>
          <title>{`Highest Youden's J ${where}: ${jText}`}</title>
        </circle>
        <text className="gen-svg__label" x={labelLeft ? bx - 10 : bx + 10} y={labelLeft ? by - 8 : by - 14} textAnchor={labelLeft ? "end" : "start"}>{bestLabel}</text>

        {/* AUC, stated beside the plot. */}
        <text className="gen-svg__axis-title" x={PX1 + 18} y={sy(0.5) - 8}>AUC</text>
        <text className="gen-svg__label" x={PX1 + 18} y={sy(0.5) + 10}>{aucText}</text>
      </svg>
    </FigurePlate>
  );
}
