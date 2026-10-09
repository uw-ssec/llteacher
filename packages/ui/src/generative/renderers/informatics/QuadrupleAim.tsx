/* --------------------------------------------------------------------------
   QuadrupleAim (`showQuadrupleAim`) -- one health IT intervention judged
   against the Quadruple Aim (Bodenheimer & Sinsky, 2014), with health
   equity as an optional fifth aim (Nundy, Cooper & Mate, 2022).

   The figure owns the aims, their order and definitions; the model gives
   each one an effect, a rationale and a measure. The tally, the trade-offs
   and the summary sentence are computed (lib/frameworks.ts). An effect is
   always a symbol and a word, never colour alone.
   -------------------------------------------------------------------------- */

import { aimsInPlay, summarizeAims, type AimEffect, type AimInputs } from "../../lib/frameworks";
import { FigurePlate, SWATCH } from "../../figure/FigurePlate";

export interface QuadrupleAimProps {
  /** The intervention, e.g. "Patient portal with open notes". */
  intervention: string;
  /** Every aim in play must be present: four, or five with equity. */
  aims: AimInputs;
  /** Adds health equity as a fifth aim (the Quintuple Aim). */
  includeEquity?: boolean;
  isPartial?: boolean;
}

/** Static class lookups (design-system lint: classes stay literal). */
const CARD: Record<AimEffect, string> = {
  improves: "gen-fw-aim gen-fw-aim--improves",
  worsens: "gen-fw-aim gen-fw-aim--worsens",
  mixed: "gen-fw-aim gen-fw-aim--mixed",
  unclear: "gen-fw-aim gen-fw-aim--unclear",
};
const MARK: Record<AimEffect, string> = { improves: "↑", worsens: "↓", mixed: "↕", unclear: "?" };
const WORD: Record<AimEffect, string> = { improves: "Improves", worsens: "Worsens", mixed: "Mixed", unclear: "Unclear" };

export function QuadrupleAim({ intervention, aims, includeEquity = false, isPartial = false }: QuadrupleAimProps) {
  const defs = aimsInPlay(includeEquity);
  const s = summarizeAims(aims, includeEquity);
  const tradeOffIds = new Set(s.tradeOffs.map((d) => d.id));
  const frame = includeEquity ? "Quintuple Aim" : "Quadruple Aim";
  const aria = `${frame} for ${intervention}: ${defs.map((d) => `${d.name} ${aims[d.id]!.effect}`).join("; ")}. ${s.sentence}`;

  return (
    <FigurePlate
      kicker={frame}
      title={intervention}
      isPartial={isPartial}
      label={aria}
      takeaway={<>{s.sentence}</>}
      note={
        includeEquity
          ? "Quadruple Aim: Bodenheimer & Sinsky, 2014. Health equity as a fifth aim: Nundy, Cooper & Mate, 2022."
          : "Quadruple Aim: Bodenheimer & Sinsky, 2014."
      }
      table={{
        caption: `The intervention's effect on each aim of the ${frame}`,
        head: ["Aim", "Effect", "Why", "How to measure it"],
        rows: defs.map((d) => [d.name, WORD[aims[d.id]!.effect], aims[d.id]!.rationale, aims[d.id]!.measure]),
      }}
    >
      <div className="gen-fw-aims">
        <dl className="gen-stats gen-fw-aims__tally">
          {(["improves", "worsens", "mixed", "unclear"] as const).map((e) => (
            <div key={e} className="gen-stat">
              <dt>{`${MARK[e]} ${WORD[e]}`}</dt>
              <dd>{s.counts[e]}</dd>
            </div>
          ))}
        </dl>
        <ul className="gen-fw-aims__grid">
          {defs.map((d) => {
            const a = aims[d.id]!;
            return (
              <li key={d.id} className={CARD[a.effect]}>
                <div className="gen-fw-aim__head">
                  <span className={SWATCH[d.slot]} aria-hidden="true" />
                  <span className="gen-fw-aim__name">{d.name}</span>
                </div>
                <p className="gen-fw-aim__def">{d.definition}</p>
                <p className="gen-fw-aim__effect">
                  <span className="gen-fw-aim__mark" aria-hidden="true">{MARK[a.effect]}</span>
                  <span>{WORD[a.effect]}</span>
                  {tradeOffIds.has(d.id) ? <span className="gen-fw-aim__flag">Trade-off</span> : null}
                </p>
                <p className="gen-fw-aim__why">{a.rationale}</p>
                <p className="gen-fw-aim__measure">
                  <span className="gen-fw-label">Measure</span> {a.measure}
                </p>
              </li>
            );
          })}
        </ul>
      </div>
    </FigurePlate>
  );
}
