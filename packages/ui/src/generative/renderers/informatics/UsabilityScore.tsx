/* --------------------------------------------------------------------------
   UsabilityScore (`showUsabilityScore`) -- the System Usability Scale.

   The figure owns Brooke's (1996) ten statements and the scoring rule: odd
   items contribute (response − 1), even items (5 − response), and the sum
   × 2.5 gives each respondent 0–100. It computes the mean, range and n,
   draws every respondent on a 0–100 scale with the mean and the commonly
   cited average of 68 (Sauro) marked, and breaks the score down by item so
   students can see which statements pull it down. The model sends only the
   raw 1–5 responses.
   -------------------------------------------------------------------------- */

import { closestAdjective, fmt1, fmtNum, SUS_AVERAGE, SUS_ITEMS, SUS_SHORT, susSummary } from "../../lib/measurement";
import { FigurePlate } from "../../figure/FigurePlate";

export interface UsabilityScoreProps {
  /** e.g. "Flowsheet redesign, med-surg" */
  systemName: string;
  /** 1–50 respondents, each exactly ten integers 1–5 in item order. */
  respondents: number[][];
  isPartial?: boolean;
}

const VB_W = 440;
const PX0 = 20;
const PX1 = 420;
const DOT_STEP = 10;

const BAR_VB_H = 10 * 24 + 34;
const LX = 160;
const BX0 = 168;
const BX1 = 340;

const joinNums = (xs: number[]) => (xs.length === 1 ? String(xs[0]) : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const listItems = (xs: number[]) => `${xs.length === 1 ? "item" : "items"} ${joinNums(xs)}`;

export function UsabilityScore({ systemName, respondents, isPartial = false }: UsabilityScoreProps) {
  const s = susSummary(respondents);
  const meanR = Math.round(s.mean * 10) / 10;
  const diff = Math.round((meanR - SUS_AVERAGE) * 10) / 10;
  const vsAverage =
    diff === 0 ? `equal to the commonly cited average of ${SUS_AVERAGE}` : `${fmt1(Math.abs(diff))} ${diff > 0 ? "above" : "below"} the commonly cited average of ${SUS_AVERAGE}`;
  const adj = closestAdjective(meanR);
  const low = s.lowestItems;
  const lowC = s.itemMeanContribution[low[0]! - 1]!;
  const lowSentence =
    low.length === 1
      ? `The lowest-scoring item is ${low[0]}, “${SUS_ITEMS[low[0]! - 1]}” (mean contribution ${lowC.toFixed(2)} of 4).`
      : `The lowest-scoring items are ${joinNums(low)} (mean contribution ${lowC.toFixed(2)} of 4 each).`;
  const who = s.n === 1 ? "1 respondent" : `${s.n} respondents`;
  const range = s.min === s.max ? fmtNum(s.min) : `${fmtNum(s.min)}–${fmtNum(s.max)}`;
  const aria = `System Usability Scale for ${systemName}: mean ${fmt1(meanR)} from ${who} (range ${range}), ${vsAverage}. ${lowSentence}`;

  /* -- Scale: one dot per respondent, stacked where scores tie. ---------------- */
  const sx = (v: number) => PX0 + (v / 100) * (PX1 - PX0);
  const stacks = new Map<number, number>();
  const dots = s.scores.map((score, i) => {
    const k = stacks.get(score) ?? 0;
    stacks.set(score, k + 1);
    return { score, i, k };
  });
  const maxStack = Math.max(...stacks.values());
  const TOP = 52;
  const BASE = TOP + Math.max(5, maxStack) * DOT_STEP + 6;
  const VB_H = BASE + 42;
  // The mean's and the average's labels sit on opposite sides of their lines, so neither crosses the other line.
  const meanLeft = meanR <= SUS_AVERAGE;
  const label = (x: number, y: number, text: string, cls: "gen-svg__label" | "gen-svg__axis-title", left: boolean) => {
    const w = text.length * 8.5;
    const toLeft = left ? x - 5 - w >= 0 : x + 5 + w > VB_W;
    return <text className={cls} x={toLeft ? x - 5 : x + 5} y={y} textAnchor={toLeft ? "end" : "start"}>{text}</text>;
  };

  /* -- Items: mean contribution, 0–4. ------------------------------------------ */
  const bx = (c: number) => BX0 + (c / 4) * (BX1 - BX0);
  const by = (i: number) => 8 + i * 24;

  return (
    <FigurePlate
      kicker="System Usability Scale"
      title={`SUS · ${systemName}`}
      isPartial={isPartial}
      label={aria}
      takeaway={
        <>
          Mean SUS score <strong>{fmt1(meanR)}</strong> from {who} (range {range}): {vsAverage}. Nearest adjective: “{adj.adjective}” (in Bangor, Kortum
          &amp; Miller, 2009, people who rated a system “{adj.adjective}” gave it a mean SUS of {adj.mean}). {lowSentence}
        </>
      }
      note={`SUS gives one overall usability score, not a diagnosis of what to fix: the item breakdown hints where users struggle, but watching nurses use the system (for example, think-aloud testing) finds the problems. Odd items are positively worded and contribute response − 1; even items are negatively worded and contribute 5 − response; the sum × 2.5 gives 0–100. A SUS score is not a percentage, and ${SUS_AVERAGE} is an average across many studies, not a pass mark.`}
      table={{
        caption: `SUS items for ${systemName}: mean response (1–5) and mean contribution (0–4)`,
        head: ["Item", "Statement", "Mean response", "Mean contribution"],
        rows: [
          ...SUS_ITEMS.map((text, i) => [String(i + 1), text, s.itemMeanResponse[i]!.toFixed(2), s.itemMeanContribution[i]!.toFixed(2)]),
          ["All", `Respondent scores: ${s.scores.map(fmtNum).join(", ")}`, "", `Mean SUS ${fmt1(meanR)}`],
        ],
        numeric: [false, false, true, true],
      }}
    >
      <dl className="gen-stats">
        <div className="gen-stat"><dt>Mean SUS</dt><dd>{fmt1(meanR)}</dd></div>
        <div className="gen-stat"><dt>Range</dt><dd>{range}</dd></div>
        <div className="gen-stat"><dt>Respondents</dt><dd>{s.n}</dd></div>
        <div className="gen-stat"><dt>Nearest adjective</dt><dd>{adj.adjective}</dd></div>
      </dl>

      <svg className="gen-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label={`Each respondent's SUS score on a 0 to 100 scale; mean ${fmt1(meanR)}, average across studies ${SUS_AVERAGE}.`}>
        {[0, 20, 40, 60, 80, 100].map((t) => (
          <g key={t}>
            <line className="gen-grid" x1={sx(t)} y1={TOP - 4} x2={sx(t)} y2={BASE} />
            <text className="gen-svg__mono" x={sx(t)} y={BASE + 18} textAnchor="middle">{t}</text>
          </g>
        ))}
        <line className="gen-axis" x1={PX0} y1={BASE} x2={PX1} y2={BASE} />
        <text className="gen-svg__axis-title" x={PX1} y={VB_H - 2} textAnchor="end">SUS score, 0–100 (not a percentage)</text>

        {/* The commonly cited average, and this system's mean. */}
        <line className="gen-guide" x1={sx(SUS_AVERAGE)} y1={36} x2={sx(SUS_AVERAGE)} y2={BASE} />
        {label(sx(SUS_AVERAGE), 32, `${SUS_AVERAGE} average`, "gen-svg__axis-title", !meanLeft)}
        <line className="gen-ms-mean" x1={sx(meanR)} y1={16} x2={sx(meanR)} y2={BASE}>
          <title>{`Mean ${fmt1(meanR)}`}</title>
        </line>
        {label(sx(meanR), 12, `Mean ${fmt1(meanR)}`, "gen-svg__label", meanLeft)}

        {dots.map((d) => (
          <circle key={d.i} className="gen-dot gen-fill--1" cx={sx(d.score)} cy={BASE - 6 - d.k * DOT_STEP} r={4}>
            <title>{`Respondent ${d.i + 1}: ${fmtNum(d.score)}`}</title>
          </circle>
        ))}
      </svg>

      <p className="gen-ms-subhead">Mean contribution by item (0–4; higher is better on every item)</p>
      <svg className="gen-svg" viewBox={`0 0 ${VB_W} ${BAR_VB_H}`} role="img" aria-label={`Mean contribution of each SUS item, 0 to 4. Lowest: ${listItems(low)}.`}>
        {[0, 1, 2, 3, 4].map((t) => (
          <g key={t}>
            <line className="gen-grid" x1={bx(t)} y1={4} x2={bx(t)} y2={by(10) - 2} />
            <text className="gen-svg__mono" x={bx(t)} y={by(10) + 14} textAnchor="middle">{t}</text>
          </g>
        ))}
        {SUS_SHORT.map((short, i) => {
          const c = s.itemMeanContribution[i]!;
          const isLow = low.includes(i + 1);
          const note = `Lowest, ${c.toFixed(2)}`;
          const noteX = Math.min(bx(c) + 6, VB_W - 2 - note.length * 8.5);
          return (
            <g key={short}>
              <text className={isLow ? "gen-svg__label" : undefined} x={LX} y={by(i) + 14} textAnchor="end">{`${i + 1} ${short}`}</text>
              <rect className="gen-fill--1" x={BX0} y={by(i) + 4} width={Math.max(0, bx(c) - BX0)} height={14}>
                <title>{`Item ${i + 1}, ${SUS_ITEMS[i]} Mean contribution ${c.toFixed(2)} of 4.`}</title>
              </rect>
              {isLow ? <text className="gen-svg__label" x={noteX} y={by(i) + 15}>{note}</text> : null}
            </g>
          );
        })}
        <line className="gen-axis" x1={BX0} y1={4} x2={BX0} y2={by(10) - 2} />
      </svg>
    </FigurePlate>
  );
}
