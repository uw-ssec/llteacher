/* --------------------------------------------------------------------------
   PriceIndex (`showInflation`) -- a price index over time and the inflation
   rate it implies. Inflation for each period is computed from the index
   values, (P_t - P_{t-1}) / P_{t-1}, never taken from the model. One series,
   one hue; the index is the line, the computed rates ride the table and the
   takeaway.
   -------------------------------------------------------------------------- */

import { FigurePlate } from "../../figure/FigurePlate";

export interface PricePoint {
  period: string;
  value: number;
}

export interface PriceIndexProps {
  series: PricePoint[];
  /** e.g. "CPI-U (1982-84 = 100)" */
  indexName?: string;
  isPartial?: boolean;
}

const VB_W = 440;
const VB_H = 220;
const PX0 = 48;
const PX1 = 420;
const PY0 = 16;
const PY1 = 184;

const pctChange = (from: number, to: number) => ((to - from) / from) * 100;
const fmtPct = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;

/** Rounded tick values spanning [lo, hi]. */
function niceTicks(lo: number, hi: number): number[] {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let t = start; t <= hi + step * 0.5; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return ticks;
}

export function PriceIndex({ series, indexName = "Price index", isPartial = false }: PriceIndexProps) {
  const values = series.map((p) => p.value);
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const sx = (i: number) => PX0 + (series.length === 1 ? 0 : (i / (series.length - 1)) * (PX1 - PX0));
  const sy = (v: number) => PY1 - ((v - lo) / (hi - lo || 1)) * (PY1 - PY0);
  const rates = series.map((p, i) => (i === 0 ? null : pctChange(series[i - 1]!.value, p.value)));
  const first = series[0]!;
  const last = series[series.length - 1]!;
  const lastRate = rates[rates.length - 1]!;
  const overall = pctChange(first.value, last.value);
  const path = series.map((p, i) => `${i === 0 ? "M" : "L"}${sx(i)},${sy(p.value)}`).join(" ");
  const aria = `${indexName} from ${first.period} to ${last.period}: ${first.value} to ${last.value}, ${fmtPct(overall)} overall; inflation ${fmtPct(lastRate)} in ${last.period}.`;
  // Label every period when they fit, otherwise every other one.
  const every = series.length > 8 ? 2 : 1;

  return (
    <FigurePlate
      kicker="Inflation"
      title={`${indexName}, ${first.period}–${last.period}`}
      isPartial={isPartial}
      label={aria}
      takeaway={
        <>
          Inflation from {series[series.length - 2]!.period} to {last.period} = ({last.value} − {series[series.length - 2]!.value}) /{" "}
          {series[series.length - 2]!.value} = <strong>{fmtPct(lastRate)}</strong>. Over the whole period, prices {overall >= 0 ? "rose" : "fell"} {Math.abs(overall).toFixed(1)}%.
        </>
      }
      table={{
        caption: `${indexName} and the inflation rate`,
        head: ["Period", indexName, "Inflation"],
        rows: series.map((p, i) => [p.period, p.value, rates[i] === null ? "—" : fmtPct(rates[i]!)]),
        numeric: [false, true, true],
      }}
    >
      <svg className="gen-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label={aria}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="gen-grid" x1={PX0} y1={sy(t)} x2={PX1} y2={sy(t)} />
            <text className="gen-svg__mono" x={PX0 - 6} y={sy(t) + 4} textAnchor="end">{t}</text>
          </g>
        ))}
        <path className="gen-line gen-line--1" d={path} />
        {series.map((p, i) => (
          <g key={p.period}>
            <circle className="gen-dot gen-fill--1" cx={sx(i)} cy={sy(p.value)} r={4}>
              <title>{`${p.period}: ${p.value}${rates[i] === null ? "" : ` (${fmtPct(rates[i]!)})`}`}</title>
            </circle>
            {i % every === 0 || i === series.length - 1 ? (
              <text className="gen-svg__mono" x={sx(i)} y={PY1 + 18} textAnchor="middle">{p.period}</text>
            ) : null}
          </g>
        ))}
        {/* End label: the value the story is about. */}
        <text className="gen-svg__label" x={sx(series.length - 1)} y={sy(last.value) - 10} textAnchor="end">{last.value}</text>
      </svg>
    </FigurePlate>
  );
}
