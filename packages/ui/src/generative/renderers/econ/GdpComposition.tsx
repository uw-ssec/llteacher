/* --------------------------------------------------------------------------
   GdpComposition (`showGdpComposition`) -- GDP by the expenditure approach.

   One stacked bar, C + I + G (+ NX), with net exports drawn to the LEFT of
   the zero line when they are negative, so a trade deficit visibly
   subtracts. GDP is computed from the components -- the model is never
   asked for, or trusted with, the total -- and the identity line spells
   the arithmetic out.
   -------------------------------------------------------------------------- */

import { formatAmount, gdpTotal, type GdpComponents } from "../../lib/econ";
import { FigurePlate, FILL, SWATCH, type Slot } from "../../figure/FigurePlate";

export interface GdpCompositionProps extends GdpComponents {
  /** e.g. "United States, 2023" */
  label?: string;
  /** e.g. "$ trillions" */
  unit?: string;
  isPartial?: boolean;
}

const PARTS: Array<{ key: keyof GdpComponents; letter: string; name: string; slot: Slot }> = [
  { key: "consumption", letter: "C", name: "Consumption", slot: 1 },
  { key: "investment", letter: "I", name: "Investment", slot: 2 },
  { key: "government", letter: "G", name: "Government purchases", slot: 3 },
  { key: "netExports", letter: "NX", name: "Net exports", slot: 4 },
];

const VB_W = 440;
const BAR_Y = 18;
const BAR_H = 28;
const GAP = 2;

export function GdpComposition(props: GdpCompositionProps) {
  const { label, unit, isPartial = false } = props;
  const total = gdpTotal(props);
  const nx = props.netExports;
  const positive = props.consumption + props.investment + props.government + Math.max(0, nx);
  const negative = Math.max(0, -nx);
  const span = positive + negative;
  const scale = (VB_W - 2) / span;
  const zeroX = negative * scale;

  // Positive segments left-to-right from zero; a negative NX sits left of it.
  let cursor = zeroX;
  const segments = PARTS.flatMap((p) => {
    const v = props[p.key];
    if (v === 0) return [];
    if (v < 0) return [{ ...p, value: v, x: zeroX - -v * scale, w: -v * scale }];
    const seg = { ...p, value: v, x: cursor, w: v * scale };
    cursor += v * scale;
    return [seg];
  });
  const totalX = zeroX + total * scale;
  const unitSuffix = unit ? ` ${unit}` : "";
  const share = (v: number) => `${((v / total) * 100).toFixed(1)}%`;
  const identity = `GDP = C + I + G + NX = ${PARTS.map((p) => {
    const v = props[p.key];
    return v < 0 ? `(${formatAmount(v)})` : formatAmount(v);
  }).join(" + ")} = ${formatAmount(total)}`;
  const aria = `GDP by expenditure${label ? `, ${label}` : ""}: ${PARTS.map((p) => `${p.name} ${formatAmount(props[p.key])}`).join(", ")}; GDP ${formatAmount(total)}${unitSuffix}.`;

  return (
    <FigurePlate
      kicker="National income"
      title={label ? `GDP by expenditure · ${label}` : "GDP by expenditure"}
      isPartial={isPartial}
      label={aria}
      takeaway={
        <>
          GDP is <strong>{formatAmount(total)}{unitSuffix}</strong>; consumption is {share(props.consumption)} of it
          {nx < 0 ? <>, and the trade deficit subtracts {formatAmount(-nx)}.</> : "."}
        </>
      }
      table={{
        caption: "GDP components",
        head: ["Component", `Value${unit ? ` (${unit})` : ""}`, "Share of GDP"],
        rows: [...PARTS.map((p) => [p.name, formatAmount(props[p.key]), share(props[p.key])]), ["GDP", formatAmount(total), "100%"]],
        numeric: [false, true, true],
      }}
    >
      <svg className="gen-svg" viewBox={`0 0 ${VB_W} 78`} role="img" aria-label={aria}>
        {segments.map((s) => (
          <g key={s.key}>
            <rect className={FILL[s.slot]} x={s.x + GAP / 2} y={BAR_Y} width={Math.max(1, s.w - GAP)} height={BAR_H} rx={2}>
              <title>{`${s.name}: ${formatAmount(s.value)}${unitSuffix}`}</title>
            </rect>
          </g>
        ))}
        {/* Zero line, then GDP's own position marked under the bar. */}
        <line className="gen-axis" x1={zeroX} y1={BAR_Y - 6} x2={zeroX} y2={BAR_Y + BAR_H + 6} />
        <line className="gen-arrow" x1={totalX} y1={BAR_Y + BAR_H + 2} x2={totalX} y2={BAR_Y + BAR_H + 12} />
        <text className="gen-svg__label" x={Math.min(totalX, VB_W - 4)} y={BAR_Y + BAR_H + 26} textAnchor={totalX > VB_W - 60 ? "end" : "middle"}>
          {`GDP ${formatAmount(total)}`}
        </text>
        {negative > 0 ? (
          <text className="gen-svg__mono" x={zeroX + 4} y={BAR_Y - 6}>0</text>
        ) : null}
      </svg>
      <ul className="gen-legend">
        {PARTS.map((p) => (
          <li key={p.key} className="gen-legend__item">
            <span className={SWATCH[p.slot]} aria-hidden="true" />
            <span>{`${p.letter} · ${p.name} ${formatAmount(props[p.key])} (${share(props[p.key])})`}</span>
          </li>
        ))}
      </ul>
      <code className="gen-steps__expr gen-identity">{identity}</code>
    </FigurePlate>
  );
}
