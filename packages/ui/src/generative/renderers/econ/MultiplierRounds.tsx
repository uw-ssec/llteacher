/* --------------------------------------------------------------------------
   MultiplierRounds (`showMultiplier`) -- the spending multiplier, round by
   round. Each column is one round of new spending (ΔG · MPC^k); the figure
   computes the multiplier 1/(1 - MPC), the eventual total, and how much of
   it the drawn rounds have reached. One series, one hue, no legend box.
   -------------------------------------------------------------------------- */

import { formatAmount, spendingMultiplier } from "../../lib/econ";
import { FigurePlate, FILL } from "../../figure/FigurePlate";

export interface MultiplierRoundsProps {
  mpc: number;
  initialChange: number;
  rounds?: number;
  /** What changed, e.g. "Government spending" */
  label?: string;
  unit?: string;
  isPartial?: boolean;
}

const VB_W = 440;
const VB_H = 220;
const PX0 = 44;
const PX1 = 432;
const PY0 = 14;
const PY1 = 186;

export function MultiplierRounds({ mpc, initialChange, rounds = 8, label, unit, isPartial = false }: MultiplierRoundsProps) {
  const n = Math.min(12, Math.max(3, Math.round(rounds)));
  const r = spendingMultiplier(mpc, Math.abs(initialChange), n);
  const sign = initialChange < 0 ? -1 : 1;
  const verb = sign < 0 ? "falls" : "rises";
  const what = label ?? "Spending";
  const unitSuffix = unit ? ` ${unit}` : "";
  const reached = r.cumulative[n - 1]!;
  const pct = Math.round((reached / r.total) * 100);

  const band = (PX1 - PX0) / n;
  const barW = Math.min(24, band * 0.62);
  const max = r.rounds[0]!;
  const h = (v: number) => (v / max) * (PY1 - PY0);
  // Clean y ticks: 0, half, full of the first round.
  const ticks = [0, max / 2, max];

  const aria = `Spending multiplier with MPC ${mpc}: ${what.toLowerCase()} ${verb} by ${formatAmount(Math.abs(initialChange))}${unitSuffix}; multiplier ${formatAmount(r.multiplier)}; total change in GDP ${formatAmount(sign * r.total)}${unitSuffix}.`;

  return (
    <FigurePlate
      kicker="Fiscal policy"
      title="The spending multiplier"
      isPartial={isPartial}
      label={aria}
      takeaway={
        <>
          Multiplier = 1 / (1 − {mpc}) = <strong>{formatAmount(r.multiplier)}</strong>. {what} {verb} by{" "}
          {formatAmount(Math.abs(initialChange))}{unitSuffix}, so GDP {verb} by <strong>{formatAmount(r.total)}{unitSuffix}</strong> in
          total. The first {n} rounds reach {pct}% of that.
        </>
      }
      table={{
        caption: "New spending in each round",
        head: ["Round", "New spending", "Running total"],
        rows: r.rounds.map((v, i) => [i + 1, formatAmount(sign * v), formatAmount(sign * r.cumulative[i]!)]),
        numeric: [true, true, true],
      }}
    >
      <svg className="gen-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label={aria}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="gen-grid" x1={PX0} y1={PY1 - h(t)} x2={PX1} y2={PY1 - h(t)} />
            <text className="gen-svg__mono" x={PX0 - 6} y={PY1 - h(t) + 4} textAnchor="end">{formatAmount(sign * t)}</text>
          </g>
        ))}
        {r.rounds.map((v, i) => {
          const cx = PX0 + band * i + band / 2;
          return (
            <g key={i}>
              <rect className={FILL[1]} x={cx - barW / 2} y={PY1 - h(v)} width={barW} height={Math.max(1, h(v))} rx={3}>
                <title>{`Round ${i + 1}: ${formatAmount(sign * v)}${unitSuffix} (running total ${formatAmount(sign * r.cumulative[i]!)})`}</title>
              </rect>
              <text className="gen-svg__mono" x={cx} y={PY1 + 16} textAnchor="middle">{i + 1}</text>
            </g>
          );
        })}
        {/* Selective direct labels: the first and last rounds only. */}
        <text className="gen-svg__label" x={PX0 + band / 2} y={PY1 - h(max) - 6} textAnchor="middle">{formatAmount(sign * max)}</text>
        <text className="gen-svg__label" x={PX0 + band * (n - 0.5)} y={PY1 - h(r.rounds[n - 1]!) - 6} textAnchor="middle">
          {formatAmount(sign * r.rounds[n - 1]!)}
        </text>
        <line className="gen-axis" x1={PX0} y1={PY1} x2={PX1} y2={PY1} />
        <text className="gen-svg__axis-title" x={PX1} y={VB_H - 2} textAnchor="end">Spending round</text>
      </svg>
      <dl className="gen-stats">
        <div className="gen-stat"><dt>MPC</dt><dd>{mpc}</dd></div>
        <div className="gen-stat"><dt>Multiplier</dt><dd>{formatAmount(r.multiplier)}</dd></div>
        <div className="gen-stat"><dt>Total ΔGDP</dt><dd>{formatAmount(sign * r.total)}</dd></div>
        <div className="gen-stat"><dt>{`After ${n} rounds`}</dt><dd>{formatAmount(sign * reached)}</dd></div>
      </dl>
    </FigurePlate>
  );
}
