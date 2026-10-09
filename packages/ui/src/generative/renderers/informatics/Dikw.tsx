/* --------------------------------------------------------------------------
   Dikw (`showDikw`) -- the data → information → knowledge → wisdom
   continuum (Nelson's adaptation, used by the ANA's Nursing Informatics:
   Scope and Standards of Practice), with one concrete example per level.

   The figure owns the four levels, their order and definitions; the model
   gives one example per level and, optionally, the action that follows.
   Drawn as a staircase rising from data to wisdom (stacked on a phone);
   each level is numbered and named, never told apart by colour alone. The
   takeaway is assembled from the inputs (lib/frameworks.ts) and adds no
   claim of its own.
   -------------------------------------------------------------------------- */

import { DIKW_LEVELS, dikwSentence, type DikwExamples } from "../../lib/frameworks";
import { FigurePlate, SWATCH } from "../../figure/FigurePlate";

export interface DikwProps {
  /** The scenario, e.g. "Early signs of sepsis on a night shift". */
  scenario: string;
  /** One concrete example per level, all four required. */
  examples: DikwExamples;
  /** What the nurse does as a result, e.g. "Calls the rapid response team". */
  action?: string;
  isPartial?: boolean;
}

/** Static class lookups (design-system lint: classes stay literal). */
const STEP = {
  1: "gen-fw-dikw__step gen-fw-dikw__step--1",
  2: "gen-fw-dikw__step gen-fw-dikw__step--2",
  3: "gen-fw-dikw__step gen-fw-dikw__step--3",
  4: "gen-fw-dikw__step gen-fw-dikw__step--4",
} as const;

export function Dikw({ scenario, examples, action, isPartial = false }: DikwProps) {
  const sentence = dikwSentence(examples, action);
  const aria = `Data, information, knowledge, wisdom for "${scenario}": ${DIKW_LEVELS.map((l) => `${l.name}: ${examples[l.id]}`).join("; ")}.${action ? ` Action: ${action}.` : ""}`;

  return (
    <FigurePlate
      kicker="Data → wisdom"
      title={scenario}
      isPartial={isPartial}
      label={aria}
      takeaway={<>{sentence}</>}
      note="The DIKW continuum as used in the ANA's Nursing Informatics: Scope and Standards of Practice (after Nelson)."
      table={{
        caption: "Each level of the data, information, knowledge, wisdom continuum with its example",
        head: ["Level", "What it is", "In this scenario"],
        rows: [
          ...DIKW_LEVELS.map((l) => [`${l.n}. ${l.name}`, l.definition, examples[l.id]]),
          ...(action ? [["Action", "What the nurse does as a result", action]] : []),
        ],
      }}
    >
      <div className="gen-fw-dikw">
        <ol className="gen-fw-dikw__stairs">
          {DIKW_LEVELS.map((l) => (
            <li key={l.id} className={STEP[l.n]}>
              <span className="gen-fw-dikw__level">
                <span className={SWATCH[l.n]} aria-hidden="true" />
                <span className="gen-fw-dikw__n">{l.n}</span>
                <span className="gen-fw-dikw__name">{l.name}</span>
              </span>
              <span className="gen-fw-dikw__def">{l.definition}</span>
              <span className="gen-fw-dikw__example">{examples[l.id]}</span>
            </li>
          ))}
        </ol>
        {action ? (
          <p className="gen-fw-dikw__action">
            <span className="gen-fw-label">Action</span> <span aria-hidden="true">→</span> {action}
          </p>
        ) : null}
      </div>
    </FigurePlate>
  );
}
