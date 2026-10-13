/* --------------------------------------------------------------------------
   LaborForce (`showLaborForce`) -- who counts as unemployed.

   The adult population split into employed / unemployed / not in the labor
   force, with the three rates intro macro teaches computed from the counts:
     unemployment rate = U / (E + U)
     participation rate = (E + U) / adult population
     employment-population ratio = E / adult population
   The common mistake -- dividing by the population instead of the labor
   force -- is exactly what computing it here rules out.
   -------------------------------------------------------------------------- */

import { formatAmount } from "../../lib/econ";
import { FigurePlate, FILL, SWATCH, type Slot } from "../../figure/FigurePlate";

export interface LaborForceProps {
  employed: number;
  unemployed: number;
  notInLaborForce: number;
  label?: string;
  unit?: string;
  isPartial?: boolean;
}

const VB_W = 440;

const pct = (n: number, d: number) => `${((n / d) * 100).toFixed(1)}%`;

export function LaborForce({ employed, unemployed, notInLaborForce, label, unit, isPartial = false }: LaborForceProps) {
  const laborForce = employed + unemployed;
  const population = laborForce + notInLaborForce;
  const parts: Array<{ name: string; value: number; slot: Slot }> = [
    { name: "Employed", value: employed, slot: 1 },
    { name: "Unemployed", value: unemployed, slot: 2 },
    { name: "Not in the labor force", value: notInLaborForce, slot: 3 },
  ];
  const scale = VB_W / population;
  let x = 0;
  const unitSuffix = unit ? ` ${unit}` : "";
  const uRate = pct(unemployed, laborForce);
  const aria = `Labor force${label ? `, ${label}` : ""}: employed ${formatAmount(employed)}, unemployed ${formatAmount(unemployed)}, not in the labor force ${formatAmount(notInLaborForce)}${unitSuffix}. Unemployment rate ${uRate}.`;

  return (
    <FigurePlate
      kicker="Unemployment"
      title={label ? `The labor force · ${label}` : "The labor force"}
      isPartial={isPartial}
      label={aria}
      takeaway={
        <>
          Unemployment rate = U / (E + U) = {formatAmount(unemployed)} / {formatAmount(laborForce)} ={" "}
          <strong>{uRate}</strong>. It is measured against the labor force, not the whole adult population.
        </>
      }
      table={{
        caption: "Labor force counts and rates",
        head: ["", `Count${unit ? ` (${unit})` : ""}`],
        rows: [
          ...parts.map((p) => [p.name, formatAmount(p.value)]),
          ["Labor force (E + U)", formatAmount(laborForce)],
          ["Adult population", formatAmount(population)],
        ],
        numeric: [false, true],
      }}
    >
      <svg className="gen-svg" viewBox={`0 0 ${VB_W} 64`} role="img" aria-label={aria}>
        {parts.map((p) => {
          const w = p.value * scale;
          const rect = (
            <rect key={p.name} className={FILL[p.slot]} x={x + 1} y={8} width={Math.max(1, w - 2)} height={28} rx={2}>
              <title>{`${p.name}: ${formatAmount(p.value)}${unitSuffix}`}</title>
            </rect>
          );
          x += w;
          return rect;
        })}
        {/* Bracket the labor force: the denominator of the unemployment rate. */}
        <path className="gen-axis" d={`M1,42 L1,48 L${laborForce * scale - 1},48 L${laborForce * scale - 1},42`} />
        <text className="gen-svg__label" x={(laborForce * scale) / 2} y={62} textAnchor="middle">Labor force</text>
      </svg>
      <ul className="gen-legend">
        {parts.map((p) => (
          <li key={p.name} className="gen-legend__item">
            <span className={SWATCH[p.slot]} aria-hidden="true" />
            <span>{`${p.name} ${formatAmount(p.value)}`}</span>
          </li>
        ))}
      </ul>
      <dl className="gen-stats">
        <div className="gen-stat"><dt>Unemployment rate</dt><dd>{uRate}</dd></div>
        <div className="gen-stat"><dt>Participation rate</dt><dd>{pct(laborForce, population)}</dd></div>
        <div className="gen-stat"><dt>Employment-population</dt><dd>{pct(employed, population)}</dd></div>
      </dl>
    </FigurePlate>
  );
}
