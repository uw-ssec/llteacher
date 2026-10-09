/* --------------------------------------------------------------------------
   AdoptionCurve (`showAdoptionCurve`) -- Rogers' diffusion of innovations
   applied to a staff rollout.

   The figure owns the five adopter categories and their idealised shares
   (2.5 / 13.5 / 34 / 34 / 16%). It draws the bell curve cut into those
   categories with the share already adopted shaded, computes the percent
   adopted and which category the next adopters fall in, and -- given counts
   over time -- draws observed adoption as a cumulative S-curve on its own
   small chart (never a second y-axis) and finds when each mark was reached.
   -------------------------------------------------------------------------- */

import {
  ADOPTER_CATEGORIES,
  ADOPTION_MARKS,
  adoptionZ,
  firstReached,
  fmtAdoptedPct,
  nextCategoryIndex,
  normalPdf,
} from "../../lib/measurement";
import { FigurePlate } from "../../figure/FigurePlate";

export interface AdoptionPoint {
  label: string;
  adoptedCount: number;
}

export interface AdoptionCurveProps {
  /** e.g. "Secure messaging" */
  innovation: string;
  /** Everyone who could adopt, e.g. the unit's nurses. */
  staffCount: number;
  /** How many have adopted now (when there is no series). */
  adoptedCount?: number;
  /** Counts over time, oldest first, non-decreasing; the last is "now". */
  series?: AdoptionPoint[];
  /** Plural noun for the staff, e.g. "nurses"; default "staff". */
  staffLabel?: string;
  isPartial?: boolean;
}

/* Bell curve geometry: z from -3 to 3 SD. */
const VB_W = 440;
const BX0 = 10;
const BX1 = 430;
const B_TOP = 34;
const B_BASE = 176;
const B_VB_H = B_BASE + 44;
const zx = (z: number) => BX0 + ((Math.max(-3, Math.min(3, z)) + 3) / 6) * (BX1 - BX0);
const zy = (z: number) => B_BASE - (normalPdf(z) / normalPdf(0)) * (B_BASE - B_TOP);

/** Closed area under the curve between z0 and z1. */
function areaPath(z0: number, z1: number): string {
  const a = Math.max(-3, z0);
  const b = Math.min(3, z1);
  if (b <= a) return "";
  const steps = Math.max(2, Math.ceil((b - a) * 24));
  const pts = Array.from({ length: steps + 1 }, (_, i) => a + ((b - a) * i) / steps);
  return `M${zx(a).toFixed(2)},${B_BASE} ${pts.map((z) => `L${zx(z).toFixed(2)},${zy(z).toFixed(2)}`).join(" ")} L${zx(b).toFixed(2)},${B_BASE} Z`;
}

const CURVE = Array.from({ length: 145 }, (_, i) => -3 + i / 24)
  .map((z, i) => `${i === 0 ? "M" : "L"}${zx(z).toFixed(2)},${zy(z).toFixed(2)}`)
  .join(" ");

/* Category names in two staggered rows so neighbours never collide at phone size. */
const NAME_ROWS = [0, 1, 0, 1, 0];
const nameX = (i: number) => {
  const c = ADOPTER_CATEGORIES[i]!;
  return i === 0 ? BX0 : zx((Math.max(-3, c.zFrom) + Math.min(3, c.zTo)) / 2);
};

/* Series chart. */
const S_VB_H = 220;
const SX0 = 44;
const SX1 = 384;
const SY0 = 30;
const SY1 = 180;
const S_TICKS = [0, 16, 50, 84, 100];

const STATUS = {
  adopted: { cls: "gen-ms-cat gen-ms-cat--adopted", word: "Adopted" },
  next: { cls: "gen-ms-cat gen-ms-cat--next", word: "Adopting next" },
  ahead: { cls: "gen-ms-cat gen-ms-cat--ahead", word: "Not yet" },
} as const;

export function AdoptionCurve({ innovation, staffCount, adoptedCount, series, staffLabel = "staff", isPartial = false }: AdoptionCurveProps) {
  const adopted = series ? series[series.length - 1]!.adoptedCount : adoptedCount ?? 0;
  const pct = (adopted / staffCount) * 100;
  const pctText = fmtAdoptedPct(pct);
  const next = nextCategoryIndex(pct);
  const nextCat = next === null ? null : ADOPTER_CATEGORIES[next]!;
  const zNow = adoptionZ(pct);

  const pcts = series?.map((p) => (p.adoptedCount / staffCount) * 100) ?? [];
  const lastMark = [...ADOPTION_MARKS].reverse().find((mk) => pct >= mk.pct);
  const markIdx = series && lastMark ? firstReached(pcts, lastMark.pct) : null;

  /* -- Sentences -------------------------------------------------------------- */
  const range = (i: number) => {
    const c = ADOPTER_CATEGORIES[i]!;
    return `${c.from}–${c.to}%`;
  };
  let main: string;
  if (adopted === 0) main = `No ${staffLabel} have adopted ${innovation} yet (0 of ${staffCount}): the first to adopt would be the innovators (0–2.5%)`;
  else if (nextCat === null) main = `All ${staffCount} ${staffLabel} have adopted ${innovation} (100%): every adopter category is reached`;
  else main = `At ${pctText} adopted (${adopted} of ${staffCount} ${staffLabel}), the next ${staffLabel} to adopt are the ${nextCat.name.toLowerCase()} (${range(next!)})`;
  let markClause = "";
  if (series && lastMark && markIdx !== null) {
    const where = series[markIdx]!.label;
    markClause =
      markIdx === 0
        ? `; the ${lastMark.pct}% mark (${lastMark.meaning}) was already passed at the first count, ${where}`
        : `; the ${lastMark.pct}% mark (${lastMark.meaning}) was reached at ${where}`;
  }
  const takeaway = `${main}${markClause}.`;
  const aria = `Adoption of ${innovation} against Rogers' adopter categories. ${takeaway}`;

  const status = (i: number): keyof typeof STATUS => {
    const c = ADOPTER_CATEGORIES[i]!;
    return pct >= c.to ? "adopted" : i === next ? "next" : "ahead";
  };

  /* -- Now marker ---------------------------------------------------------------- */
  const nowX = zx(zNow);
  const nowAnchor = nowX < BX0 + 70 ? "start" : nowX > BX1 - 70 ? "end" : "middle";

  /* -- Series geometry --------------------------------------------------------------- */
  const n = series?.length ?? 0;
  const sx = (i: number) => SX0 + 6 + (n <= 1 ? 0 : (i / (n - 1)) * (SX1 - SX0 - 12));
  const sy = (p: number) => SY1 - (p / 100) * (SY1 - SY0);
  const maxLen = series ? Math.max(...series.map((p) => p.label.length)) : 0;
  const fit = Math.max(2, Math.floor((SX1 - SX0) / (maxLen * 10.5 + 14)));
  const every = Math.max(1, Math.ceil((n - 1) / (fit - 1)));
  const xLabels = series ? series.flatMap((_, i) => (i === n - 1 || (i % every === 0 && n - 1 - i >= every * 0.6) ? [i] : [])) : [];
  const longLabels = maxLen > 5;
  const sPath = pcts.map((p, i) => `${i === 0 ? "M" : "L"}${sx(i).toFixed(2)},${sy(p).toFixed(2)}`).join(" ");
  const showMarkLabel = markIdx !== null && markIdx !== n - 1;
  // Up and to the left (the empty side of a rising curve), unless that runs into the y-axis labels.
  const markLabelLeft = markIdx !== null && lastMark !== undefined && sx(markIdx) - 10 - `${lastMark.pct}% reached`.length * 8.5 >= SX0;

  return (
    <FigurePlate
      kicker="Diffusion of innovations"
      title={`${innovation}: who adopts next`}
      isPartial={isPartial}
      label={aria}
      takeaway={takeaway}
      note="Rogers' categories (innovators 2.5%, early adopters 13.5%, early majority 34%, late majority 34%, laggards 16%) are an idealised bell curve cut at 1 and 2 standard deviations from the average adoption time. They describe who tends to adopt when, not a prediction: they assume everyone eventually adopts, and real rollouts rarely follow the curve exactly."
      table={
        series
          ? {
              caption: `${innovation}: adoption over time`,
              head: ["When", "Adopted", `% of ${staffCount} ${staffLabel}`, "Next to adopt"],
              rows: series.map((p, i) => {
                const k = nextCategoryIndex(pcts[i]!);
                return [p.label, p.adoptedCount, fmtAdoptedPct(pcts[i]!), k === null ? "Everyone has adopted" : ADOPTER_CATEGORIES[k]!.name];
              }),
              numeric: [false, true, true, false],
            }
          : {
              caption: "Rogers' adopter categories and where this rollout is",
              head: ["Category", "Share", "Cumulative", "Status"],
              rows: ADOPTER_CATEGORIES.map((c, i) => [c.name, `${c.share}%`, range(i), STATUS[status(i)].word]),
              numeric: [false, true, true, false],
            }
      }
    >
      <svg className="gen-svg" viewBox={`0 0 ${VB_W} ${B_VB_H}`} role="img" aria-label={`Rogers' adoption bell curve with the first ${pctText} shaded as adopted.`}>
        {ADOPTER_CATEGORIES.map((c, i) => (
          <g key={c.name}>
            <path className="gen-ms-unreached" d={areaPath(Math.max(c.zFrom, zNow), c.zTo)} />
            <path className="gen-ms-reached" d={areaPath(c.zFrom, Math.min(c.zTo, zNow))}>
              <title>{`${c.name}, ${c.share}% of adopters: ${STATUS[status(i)].word.toLowerCase()}`}</title>
            </path>
          </g>
        ))}
        {[-2, -1, 0, 1].map((z) => (
          <line key={z} className="gen-ms-boundary" x1={zx(z)} y1={B_BASE} x2={zx(z)} y2={zy(z)} />
        ))}
        <path className="gen-ms-curve" d={CURVE} />
        <line className="gen-axis" x1={BX0} y1={B_BASE} x2={BX1} y2={B_BASE} />
        {ADOPTER_CATEGORIES.map((c, i) => (
          <text key={c.name} className="gen-svg__mono" x={nameX(i)} y={B_BASE + 18 + NAME_ROWS[i]! * 18} textAnchor={i === 0 ? "start" : "middle"}>
            {c.name}
          </text>
        ))}
        {adopted > 0 && adopted < staffCount ? (
          <g>
            <line className="gen-ms-now" x1={nowX} y1={18} x2={nowX} y2={B_BASE} />
            <text className="gen-svg__label" x={nowX} y={13} textAnchor={nowAnchor}>{`${pctText} adopted`}</text>
          </g>
        ) : null}
      </svg>

      <ol className="gen-ms-cats">
        {ADOPTER_CATEGORIES.map((c, i) => {
          const st = STATUS[status(i)];
          return (
            <li key={c.name} className={st.cls}>
              <span className="gen-ms-cat__name">{c.name}</span>
              <span className="gen-ms-cat__share">{`${c.share}% · ${range(i)}`}</span>
              <span className="gen-ms-cat__status">{st.word}</span>
            </li>
          );
        })}
      </ol>

      {series ? (
        <>
          <p className="gen-ms-subhead">{`Observed adoption, % of ${staffCount} ${staffLabel}`}</p>
          <svg className="gen-svg" viewBox={`0 0 ${VB_W} ${S_VB_H}`} role="img" aria-label={`Cumulative adoption of ${innovation} from ${series[0]!.label} to ${series[n - 1]!.label}: ${fmtAdoptedPct(pcts[0]!)} to ${pctText}.`}>
            {S_TICKS.map((t) => (
              <g key={t}>
                <line className="gen-grid" x1={SX0} y1={sy(t)} x2={SX1} y2={sy(t)} />
                <text className="gen-svg__mono" x={SX0 - 6} y={sy(t) + 4} textAnchor="end">{`${t}%`}</text>
              </g>
            ))}
            <text className="gen-svg__axis-title" x={SX0 - 2} y={14}>Cumulative % adopted (gridlines at Rogers' marks)</text>
            <line className="gen-axis" x1={SX0} y1={SY1} x2={SX1} y2={SY1} />
            {xLabels.map((i) => (
              <text key={i} className="gen-svg__mono" x={sx(i)} y={SY1 + 18} textAnchor={longLabels && i === 0 ? "start" : longLabels && i === n - 1 ? "end" : "middle"}>
                {series[i]!.label}
              </text>
            ))}
            <path className="gen-line gen-line--1" d={sPath} />
            {pcts.map((p, i) => (
              <circle key={i} className="gen-dot gen-fill--1" cx={sx(i)} cy={sy(p)} r={4}>
                <title>{`${series[i]!.label}: ${series[i]!.adoptedCount} of ${staffCount} (${fmtAdoptedPct(p)})`}</title>
              </circle>
            ))}
            {markIdx !== null && lastMark ? (
              <circle className="gen-ms-ring" cx={sx(markIdx)} cy={sy(pcts[markIdx]!)} r={7.5}>
                <title>{`${lastMark.pct}% mark reached at ${series[markIdx]!.label}`}</title>
              </circle>
            ) : null}
            {showMarkLabel && lastMark ? (
              <text className="gen-svg__label" x={markLabelLeft ? sx(markIdx!) - 10 : sx(markIdx!) + 10} y={sy(pcts[markIdx!]!) - 10} textAnchor={markLabelLeft ? "end" : "start"}>{`${lastMark.pct}% reached`}</text>
            ) : null}
            <text className="gen-svg__label" x={sx(n - 1) + 10} y={sy(pcts[n - 1]!) + 4}>{pctText}</text>
          </svg>
        </>
      ) : null}
    </FigurePlate>
  );
}
