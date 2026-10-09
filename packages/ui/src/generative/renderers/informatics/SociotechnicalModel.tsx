/* --------------------------------------------------------------------------
   SociotechnicalModel (`showSociotechnicalModel`) -- one health IT case
   read through Sittig & Singh's eight-dimension sociotechnical model
   (Qual Saf Health Care, 2010).

   The figure owns the eight dimensions, their order and definitions; the
   model marks the ones it assessed as contributing to the problem or
   protective, with a finding. A dimension it did not supply is "not
   assessed". A strip of eight numbered cells gives the overview; the list
   below carries the findings. The counts and the sentence naming the
   contributing dimensions are computed (lib/frameworks.ts). A role is
   always a symbol and a word, never colour alone.
   -------------------------------------------------------------------------- */

import { summarizeSociotechnical, type StmFinding, type StmRole } from "../../lib/frameworks";
import { FigurePlate } from "../../figure/FigurePlate";

export interface SociotechnicalModelProps {
  /** The case, e.g. "Smart infusion pump alerts overridden on a med-surg unit". */
  caseTitle: string;
  /** At most one per dimension; at least one assessed. */
  findings: StmFinding[];
  isPartial?: boolean;
}

/** Static class lookups (design-system lint: classes stay literal). */
const CELL: Record<StmRole, string> = {
  contributing: "gen-fw-stm__cell gen-fw-stm__cell--contributing",
  protective: "gen-fw-stm__cell gen-fw-stm__cell--protective",
  "not assessed": "gen-fw-stm__cell gen-fw-stm__cell--none",
};
const ROW: Record<StmRole, string> = {
  contributing: "gen-fw-stm__row gen-fw-stm__row--contributing",
  protective: "gen-fw-stm__row gen-fw-stm__row--protective",
  "not assessed": "gen-fw-stm__row gen-fw-stm__row--none",
};
const MARK: Record<StmRole, string> = { contributing: "!", protective: "✓", "not assessed": "–" };
const WORD: Record<StmRole, string> = { contributing: "Contributing", protective: "Protective", "not assessed": "Not assessed" };

export function SociotechnicalModel({ caseTitle, findings, isPartial = false }: SociotechnicalModelProps) {
  const s = summarizeSociotechnical(findings);
  const aria = `Sociotechnical model for "${caseTitle}": ${s.rows.map((r) => `${r.n} ${r.name}, ${WORD[r.role].toLowerCase()}`).join("; ")}. ${s.sentence}`;

  return (
    <FigurePlate
      kicker="Sociotechnical model"
      title={caseTitle}
      isPartial={isPartial}
      label={aria}
      takeaway={<>{s.sentence}</>}
      note="Sittig & Singh (2010) treat the eight dimensions as interdependent: a fix in one usually needs changes in others."
      table={{
        caption: "Each dimension of the sociotechnical model and what was found",
        head: ["#", "Dimension", "Role", "Finding"],
        numeric: [true, false, false, false],
        rows: s.rows.map((r) => [r.n, r.name, WORD[r.role], r.finding ?? "—"]),
      }}
    >
      <div className="gen-fw-stm">
        <ol className="gen-fw-stm__strip" aria-hidden="true">
          {s.rows.map((r) => (
            <li key={r.id} className={CELL[r.role]}>
              <span className="gen-fw-stm__n">{r.n}</span>
              <span className="gen-fw-stm__cell-mark">{MARK[r.role]}</span>
            </li>
          ))}
        </ol>
        <ul className="gen-legend gen-fw-stm__key" aria-hidden="true">
          {(["contributing", "protective", "not assessed"] as const).map((role) => (
            <li key={role} className="gen-legend__item">
              <span className={CELL[role]}>
                <span className="gen-fw-stm__cell-mark">{MARK[role]}</span>
              </span>
              {`${WORD[role]} (${role === "contributing" ? s.contributing.length : role === "protective" ? s.protective.length : s.notAssessed.length})`}
            </li>
          ))}
        </ul>
        <ol className="gen-fw-stm__list">
          {s.rows.map((r) => (
            <li key={r.id} className={ROW[r.role]}>
              <span className="gen-fw-stm__num" aria-hidden="true">{r.n}</span>
              <span className="gen-fw-stm__body">
                <span className="gen-fw-stm__name">{r.name}</span>
                <span className="gen-fw-stm__def">{r.definition}</span>
                {r.finding ? <span className="gen-fw-stm__finding">{r.finding}</span> : null}
              </span>
              <span className="gen-fw-stm__role">
                <span aria-hidden="true">{MARK[r.role]}</span> {WORD[r.role]}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </FigurePlate>
  );
}
