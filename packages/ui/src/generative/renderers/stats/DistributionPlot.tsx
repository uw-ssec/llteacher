/* --------------------------------------------------------------------------
   DistributionPlot (`showDistribution`, #35) -- a probability distribution
   with an optional shaded region and the probability of that region.

   Continuous families (normal, t, chi-square) draw the density with the
   region as a filled area; the binomial draws one bar per outcome, the
   region's bars in the series colour and the rest muted. The shaded
   probability is COMPUTED (lib/stats.ts), never the model's number, and it
   is the figure's takeaway.
   -------------------------------------------------------------------------- */

import { displayDomain, intervalProbability, mean, pdf, type DistributionKind, type DistributionParams } from "../../lib/stats";
import { FigurePlate } from "../../figure/FigurePlate";

export interface DistributionRegion {
  from?: number;
  to?: number;
  label?: string;
}

export interface DistributionPlotProps {
  distribution: DistributionKind;
  params: DistributionParams;
  region?: DistributionRegion;
  title?: string;
  isPartial?: boolean;
}

const VB_W = 440;
const VB_H = 230;
const PX0 = 16;
const PX1 = 424;
const PY0 = 18;
const PY1 = 190;

const NAMES: Record<DistributionKind, string> = {
  normal: "Normal",
  t: "Student's t",
  binomial: "Binomial",
  "chi-square": "Chi-square",
};

function paramText(kind: DistributionKind, p: DistributionParams): string {
  switch (kind) {
    case "normal": return `μ = ${p.mean ?? 0}, σ = ${p.sd ?? 1}`;
    case "t": return `df = ${p.df}`;
    case "chi-square": return `df = ${p.df}`;
    case "binomial": return `n = ${p.n}, p = ${p.p}`;
  }
}

/** "P(X ≥ 1.96)", "P(−1.96 ≤ X ≤ 1.96)", "P(X ≤ 2)". */
export function regionText(region: DistributionRegion | undefined, symbol = "X"): string {
  if (!region || (region.from === undefined && region.to === undefined)) return `P(${symbol})`;
  const f = (v: number) => (v < 0 ? `−${Math.abs(v)}` : `${v}`);
  if (region.from !== undefined && region.to !== undefined) return `P(${f(region.from)} ≤ ${symbol} ≤ ${f(region.to)})`;
  if (region.from !== undefined) return `P(${symbol} ≥ ${f(region.from)})`;
  return `P(${symbol} ≤ ${f(region.to!)})`;
}

function formatProb(p: number): string {
  if (p > 0 && p < 0.0001) return "< 0.0001";
  return p.toFixed(4);
}

function niceTicks(lo: number, hi: number, count = 6): number[] {
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return ticks;
}

export function DistributionPlot({ distribution: kind, params, region, title, isPartial = false }: DistributionPlotProps) {
  const [lo, hi] = displayDomain(kind, params);
  const sx = (x: number) => PX0 + ((x - lo) / (hi - lo)) * (PX1 - PX0);
  const inRegion = (x: number) =>
    !!region && (region.from !== undefined || region.to !== undefined) &&
    (region.from === undefined || x >= region.from - 1e-12) && (region.to === undefined || x <= region.to + 1e-12);
  const hasRegion = !!region && (region.from !== undefined || region.to !== undefined);
  const prob = hasRegion ? intervalProbability(kind, params, region!.from, region!.to) : null;
  const discrete = kind === "binomial";

  // Continuous: sample the density; the peak sets the vertical scale.
  const samples = discrete
    ? []
    : Array.from({ length: 241 }, (_, i) => {
        const x = lo + ((hi - lo) * i) / 240;
        return { x, y: pdf(kind, params, x) };
      }).filter((s) => Number.isFinite(s.y));
  const bars = discrete ? Array.from({ length: params.n! + 1 }, (_, k) => ({ k, y: pdf(kind, params, k) })) : [];
  const peak = discrete ? Math.max(...bars.map((b) => b.y)) : Math.max(...samples.map((s) => s.y));
  const sy = (y: number) => PY1 - (Math.min(y, peak) / peak) * (PY1 - PY0);

  const curve = samples.map((s, i) => `${i === 0 ? "M" : "L"}${sx(s.x).toFixed(2)},${sy(s.y).toFixed(2)}`).join(" ");
  const shaded = hasRegion && !discrete ? samples.filter((s) => inRegion(s.x)) : [];
  const area = shaded.length > 1
    ? `M${sx(shaded[0]!.x)},${PY1} ` + shaded.map((s) => `L${sx(s.x).toFixed(2)},${sy(s.y).toFixed(2)}`).join(" ") + ` L${sx(shaded[shaded.length - 1]!.x)},${PY1} Z`
    : "";

  const ticks = discrete ? niceTicks(0, params.n!, Math.min(10, params.n!)).filter((t) => Number.isInteger(t)) : niceTicks(lo, hi);
  const band = discrete ? (PX1 - PX0) / (params.n! + 1) : 0;
  const barX = (k: number) => PX0 + band * k + band * 0.15;
  const barW = Math.max(1, Math.min(24, band * 0.7));
  const bxs = (k: number) => PX0 + band * k + band / 2;
  const rText = regionText(region);
  const name = `${NAMES[kind]} (${paramText(kind, params)})`;
  const aria = `${name} distribution${hasRegion ? `; shaded ${rText} = ${formatProb(prob!)}` : ""}. Mean ${mean(kind, params)}.`;

  // Boundary markers at finite region edges inside the domain.
  const edges = hasRegion ? [region!.from, region!.to].filter((v): v is number => v !== undefined && v >= lo && v <= hi) : [];

  return (
    <FigurePlate
      kicker="Probability distribution"
      title={title ?? name}
      isPartial={isPartial}
      label={aria}
      takeaway={hasRegion ? (
        <>
          {region!.label ? `${region!.label}: ` : ""}
          <strong>{rText} = {formatProb(prob!)}</strong>
          {prob! >= 0.0001 ? ` (${(prob! * 100).toFixed(2)}%)` : ""} of the distribution.
        </>
      ) : <>The {NAMES[kind].toLowerCase()} distribution with {paramText(kind, params)}; mean {mean(kind, params)}.</>}
      table={hasRegion ? {
        caption: "Shaded region",
        head: ["Distribution", "Region", "Probability"],
        rows: [[name, rText, formatProb(prob!)]],
        numeric: [false, false, true],
      } : undefined}
    >
      <svg className="gen-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label={aria}>
        {discrete ? (
          bars.map((b) => (
            <rect
              key={b.k}
              className={inRegion(b.k) ? "gen-fill--1" : "gen-fill--muted"}
              x={barX(b.k)}
              y={sy(b.y)}
              width={barW}
              height={Math.max(0.5, PY1 - sy(b.y))}
              rx={2}
            >
              <title>{`P(X = ${b.k}) = ${formatProb(b.y)}`}</title>
            </rect>
          ))
        ) : (
          <>
            {area ? <path className="gen-area-shade" d={area} /> : null}
            <path className="gen-line gen-line--1" d={curve} />
          </>
        )}
        {edges.map((v) => (
          <g key={v}>
            <line className="gen-guide" x1={discrete ? bxs(v) : sx(v)} y1={PY0} x2={discrete ? bxs(v) : sx(v)} y2={PY1} />
            <text className="gen-svg__label" x={discrete ? bxs(v) : sx(v)} y={PY0 - 4} textAnchor="middle">{v}</text>
          </g>
        ))}
        <line className="gen-axis" x1={PX0} y1={PY1} x2={PX1} y2={PY1} />
        {ticks.map((t) => (
          <text key={t} className="gen-svg__mono" x={discrete ? bxs(t) : sx(t)} y={PY1 + 16} textAnchor="middle">{t}</text>
        ))}
        <text className="gen-svg__axis-title" x={PX1} y={VB_H - 2} textAnchor="end">{discrete ? "Number of successes (x)" : "x"}</text>
      </svg>
    </FigurePlate>
  );
}
