/* --------------------------------------------------------------------------
   MacroModelDiagram (`showMacroModel`) -- the ECON 201 curve-shift diagram.

   AD-AS, loanable funds, or the money market, drawn the way the textbook
   draws them: stylised straight curves, the curve that moved left dashed in
   its old position, an arrow for the shift, E1/E2 with guides to both axes.
   The model only names WHICH curves shift and WHICH way; every position and
   the stated outcome are computed (lib/econ.ts), so the picture and the
   sentence under it cannot disagree with each other or with economics.
   -------------------------------------------------------------------------- */

import {
  MACRO_MODELS,
  applyShifts,
  type Curve,
  type MacroModelKind,
  type Movement,
  type ShiftDirection,
} from "../../lib/econ";
import { FigurePlate, LINE, type Slot } from "../../figure/FigurePlate";

export interface MacroShift {
  curve: string;
  direction: ShiftDirection;
  /** Why it shifted, in the student's terms ("consumer confidence falls"). */
  reason?: string;
}

export interface MacroModelDiagramProps {
  model: MacroModelKind;
  shifts: MacroShift[];
  title?: string;
  isPartial?: boolean;
}

// Plot geometry: model space 0..10 on both axes.
const VB_W = 440;
const VB_H = 330;
const PX0 = 56;
const PX1 = 336;
const PY0 = 26;
const PY1 = 280;
const sx = (x: number) => PX0 + (x / 10) * (PX1 - PX0);
const sy = (y: number) => PY1 - (y / 10) * (PY1 - PY0);

const LO = 0.5;
const HI = 9.5;

/** Visible segment of a curve inside the plot, as model-space endpoints. */
function segment(c: Curve): [{ x: number; y: number }, { x: number; y: number }] | null {
  if (c.vertical !== undefined) {
    if (c.vertical < LO || c.vertical > HI) return null;
    return [{ x: c.vertical, y: LO }, { x: c.vertical, y: HI }];
  }
  // x-range where LO <= y <= HI, intersected with [LO, HI].
  const xa = (LO - c.intercept) / c.slope;
  const xb = (HI - c.intercept) / c.slope;
  const xmin = Math.max(LO, Math.min(xa, xb));
  const xmax = Math.min(HI, Math.max(xa, xb));
  if (xmin >= xmax) return null;
  return [
    { x: xmin, y: c.slope * xmin + c.intercept },
    { x: xmax, y: c.slope * xmax + c.intercept },
  ];
}

/** Where a curve's label sits: past its upper-right end. */
function labelAnchor(c: Curve): { x: number; y: number } | null {
  const seg = segment(c);
  if (!seg) return null;
  if (c.vertical !== undefined) return { x: sx(c.vertical), y: sy(HI) - 8 };
  const end = seg[1]; // larger x
  return { x: sx(end.x) + 6, y: sy(end.y) + 4 };
}

/** Height (model units) for a curve's shift arrow: the first candidate at
 *  which BOTH the old and the new position are inside the visible plot, so
 *  the arrow always joins two drawn lines. */
function arrowHeight(from: Curve, to: Curve): number {
  const candidates = from.vertical !== undefined ? [8.6, 7.6] : from.slope < 0 ? [6.8, 6, 5.2, 7.6] : [2.8, 3.6, 4.4, 2];
  const inside = (c: Curve, y: number) => {
    const x = xAt(c, y);
    return x >= LO + 0.25 && x <= HI - 0.25;
  };
  return candidates.find((y) => inside(from, y) && inside(to, y)) ?? candidates[0]!;
}

function xAt(c: Curve, y: number): number {
  return c.vertical !== undefined ? c.vertical : (y - c.intercept) / c.slope;
}

const VERB: Record<Movement, string> = { rises: "rises", falls: "falls", unchanged: "is unchanged" };

function lowerFirst(s: string) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function resolveCurveId(model: MacroModelKind, name: string): string | null {
  const spec = MACRO_MODELS[model];
  const wanted = name.trim().toLowerCase();
  const hit = spec.curves.find((c) => c.id.toLowerCase() === wanted || c.label.toLowerCase() === wanted);
  return hit ? hit.id : null;
}

export function MacroModelDiagram({ model, shifts, title, isPartial = false }: MacroModelDiagramProps) {
  const spec = MACRO_MODELS[model];
  const outcome = applyShifts(spec, shifts);
  if (!outcome) return null;

  const shifted = new Set(shifts.map((s) => s.curve));
  const before = new Map(spec.curves.map((c) => [c.id, c]));
  const after = new Map(outcome.curvesAfter.map((c) => [c.id, c]));
  const hasShift = shifts.length > 0;
  const e1 = outcome.before;
  const e2 = outcome.after;

  const xName = spec.xAxis;
  const yName = spec.yAxis;
  const sub = (n: 1 | 2) => (n === 1 ? "₁" : "₂");

  const shiftSentence = shifts
    .map((s) => `${before.get(s.curve)!.label} shifts ${s.direction}`)
    .join(" and ");
  const outcomeSentence = hasShift
    ? `${yName} ${VERB[outcome.yMovement]} and ${lowerFirst(xName)} ${VERB[outcome.xMovement]}.`
    : `Equilibrium where ${spec.equilibrium.join(" meets ")}.`;

  // AD-AS: where the new short-run equilibrium sits relative to potential.
  let gapNote: string | null = null;
  const lras = after.get("LRAS");
  if (model === "ad-as" && lras?.vertical !== undefined && hasShift) {
    const diff = e2.x - lras.vertical;
    gapNote = Math.abs(diff) < 1e-6
      ? "Output is at potential (long-run equilibrium)."
      : diff > 0
        ? "Output is above potential: an inflationary gap."
        : "Output is below potential: a recessionary gap.";
  }

  const ariaLabel = `${spec.title} diagram. ${hasShift ? `${shiftSentence}. ` : ""}${outcomeSentence}${gapNote ? ` ${gapNote}` : ""}`;

  // Axis tick labels for the equilibria; merged when the value didn't move.
  const yTicks = hasShift && outcome.yMovement !== "unchanged"
    ? [{ v: e1.y, t: `${spec.ySymbol}${sub(1)}` }, { v: e2.y, t: `${spec.ySymbol}${sub(2)}` }]
    : [{ v: e2.y, t: hasShift ? `${spec.ySymbol}${sub(1)} = ${spec.ySymbol}${sub(2)}` : `${spec.ySymbol}*` }];
  const xTicks = hasShift && outcome.xMovement !== "unchanged"
    ? [{ v: e1.x, t: `${spec.xSymbol}${sub(1)}` }, { v: e2.x, t: `${spec.xSymbol}${sub(2)}` }]
    : [{ v: e2.x, t: hasShift ? `${spec.xSymbol}${sub(1)} = ${spec.xSymbol}${sub(2)}` : `${spec.xSymbol}*` }];

  const markerId = `gen-arrow-${model}`;

  return (
    <FigurePlate
      kicker="Macro model"
      title={title ?? spec.title}
      isPartial={isPartial}
      label={ariaLabel}
      takeaway={hasShift ? <>{shiftSentence}. {outcomeSentence}</> : outcomeSentence}
      note={gapNote}
      table={hasShift ? {
        caption: "Direction of change in equilibrium",
        head: ["", "Before", "After", "Change"],
        rows: [
          [yName, `${spec.ySymbol}₁`, `${spec.ySymbol}₂`, VERB[outcome.yMovement]],
          [xName, `${spec.xSymbol}₁`, `${spec.xSymbol}₂`, VERB[outcome.xMovement]],
        ],
      } : undefined}
    >
      <svg className="gen-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label={ariaLabel}>
        <defs>
          <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path className="gen-arrowhead" d="M0,0 L10,5 L0,10 z" />
          </marker>
        </defs>

        {/* Axes: the textbook L, titles horizontal (never rotated text). */}
        <path className="gen-axis" d={`M${PX0},${PY0 - 6} L${PX0},${PY1} L${PX1 + 6},${PY1}`} />
        <text className="gen-svg__axis-title" x={PX0 - 2} y={PY0 - 12}>{`${yName} (${spec.ySymbol})`}</text>
        <text className="gen-svg__axis-title" x={PX1 + 6} y={PY1 + 38} textAnchor="end">{`${xName} (${spec.xSymbol})`}</text>

        {/* Guides from each equilibrium to the axes. */}
        {(hasShift ? [e1, e2] : [e2]).map((e, i) => (
          <path key={i} className="gen-guide" d={`M${PX0},${sy(e.y)} L${sx(e.x)},${sy(e.y)} L${sx(e.x)},${PY1}`} />
        ))}
        {yTicks.map((t) => (
          <text key={t.t} className="gen-svg__mono" x={PX0 - 6} y={sy(t.v) + 4} textAnchor="end">{t.t}</text>
        ))}
        {/* Two close x ticks are anchored apart (lower one ends at its guide,
            higher one starts at its guide) so they can never overlap. */}
        {xTicks.map((t, i) => {
          const other = xTicks[1 - i];
          const anchor = !other ? "middle" : t.v < other.v ? "end" : "start";
          const nudge = anchor === "end" ? 2 : anchor === "start" ? -2 : 0;
          return (
            <text key={t.t} className="gen-svg__mono" x={sx(t.v) + nudge} y={PY1 + 16} textAnchor={anchor}>{t.t}</text>
          );
        })}

        {/* Curves that moved: old position dashed + muted, labelled ₁. */}
        {spec.curves.filter((c) => shifted.has(c.id)).map((c) => {
          const seg = segment(c);
          const at = labelAnchor(c);
          if (!seg || !at) return null;
          return (
            <g key={`before-${c.id}`}>
              <line className="gen-line gen-line--before" x1={sx(seg[0].x)} y1={sy(seg[0].y)} x2={sx(seg[1].x)} y2={sy(seg[1].y)} />
              <text className="gen-svg__label" x={at.x} y={at.y} textAnchor={c.vertical !== undefined ? "middle" : "start"}>{`${c.id}${sub(1)}`}</text>
            </g>
          );
        })}

        {/* Current curves in their categorical colour. */}
        {[...after.values()].map((c) => {
          const seg = segment(c);
          const at = labelAnchor(c);
          if (!seg || !at) return null;
          const name = shifted.has(c.id) ? `${c.id}${sub(2)}` : c.id;
          return (
            <g key={`now-${c.id}`}>
              <line className={LINE[c.slot as Slot]} x1={sx(seg[0].x)} y1={sy(seg[0].y)} x2={sx(seg[1].x)} y2={sy(seg[1].y)} />
              <text className="gen-svg__label" x={at.x} y={at.y} textAnchor={c.vertical !== undefined ? "middle" : "start"}>{name}</text>
            </g>
          );
        })}

        {/* Shift arrows, between old and new position. */}
        {shifts.map((s) => {
          const from = before.get(s.curve)!;
          const to = after.get(s.curve)!;
          const h = arrowHeight(from, to);
          const x1 = xAt(from, h);
          const x2 = xAt(to, h);
          const pad = Math.sign(x2 - x1) * 0.18;
          return (
            <line
              key={`arrow-${s.curve}`}
              className="gen-arrow"
              x1={sx(x1 + pad)}
              y1={sy(h)}
              x2={sx(x2 - pad)}
              y2={sy(h)}
              markerEnd={`url(#${markerId})`}
            />
          );
        })}

        {/* Equilibria: E₁ muted, E₂ ink, 2px surface ring. Each label sits on
            the side facing away from the other point, so they never collide. */}
        {(() => {
          const dx = e2.x - e1.x;
          const dy = e2.y - e1.y;
          const len = Math.hypot(dx, dy) || 1;
          // Unit vector E1 -> E2 in screen space (y flipped).
          const ux = hasShift ? dx / len : 1;
          const uy = hasShift ? -dy / len : -1;
          const place = (px: number, py: number, dir: 1 | -1) => ({
            x: px + dir * ux * 14 + (Math.abs(ux) < 0.3 ? 12 : 0),
            y: py + dir * uy * 14 + 4,
            anchor: (dir * ux < -0.3 ? "end" : "start") as "end" | "start",
          });
          const l1 = place(sx(e1.x), sy(e1.y), -1);
          const l2 = place(sx(e2.x), sy(e2.y), 1);
          return (
            <>
              {hasShift ? (
                <>
                  <circle className="gen-dot gen-dot--before" cx={sx(e1.x)} cy={sy(e1.y)} r={5} />
                  <text className="gen-svg__label" x={l1.x} y={l1.y} textAnchor={l1.anchor}>E₁</text>
                </>
              ) : null}
              <circle className="gen-dot gen-dot--now" cx={sx(e2.x)} cy={sy(e2.y)} r={5} />
              <text className="gen-svg__label" x={l2.x} y={l2.y} textAnchor={l2.anchor}>{hasShift ? "E₂" : "E"}</text>
            </>
          );
        })()}
      </svg>
      {shifts.some((s) => s.reason) ? (
        <ul className="gen-legend">
          {shifts.filter((s) => s.reason).map((s) => (
            <li key={s.curve} className="gen-legend__item">
              <span>{`${before.get(s.curve)!.label} ${s.direction === "right" ? "→" : "←"}`}</span>
              <span>{s.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </FigurePlate>
  );
}
