/* --------------------------------------------------------------------------
   CdsRule (`showCdsRule`) -- a clinical decision support rule, evaluated
   against one patient.

   A rule card: the IF (all / any), each condition with the patient's value
   substituted and its result (✓ met / ✗ not met / ? missing -- symbol and
   word, never colour alone), then THEN: whether the rule fires and what it
   recommends. Every result and the verdict are computed (lib/clinical.ts)
   with the missing-data semantics stated on the card, because a value that
   was never recorded is the most common reason a rule stays silent.
   -------------------------------------------------------------------------- */

import {
  OPERATOR_SYMBOL,
  evaluateRule,
  type CdsCondition,
  type ConditionResult,
  type PatientValue,
  type RuleEvaluation,
} from "../../lib/clinical";
import { FigurePlate } from "../../figure/FigurePlate";

export interface CdsRuleProps {
  /** e.g. "Sepsis alert: suspected infection with organ dysfunction" */
  name: string;
  logic: "all" | "any";
  /** 1-8 conditions. */
  conditions: CdsCondition[];
  /** The patient's data by field; null (or absent) means not recorded. */
  patient: Record<string, PatientValue>;
  /** What the alert recommends when it fires. */
  action?: string;
  isPartial?: boolean;
}

/** Static class lookups (design-system lint: classes stay literal). */
const ROW: Record<ConditionResult, string> = {
  met: "gen-cds__row gen-cds__row--met",
  "not-met": "gen-cds__row gen-cds__row--not-met",
  missing: "gen-cds__row gen-cds__row--missing",
};
const MARK: Record<ConditionResult, string> = { met: "✓", "not-met": "✗", missing: "?" };
const WORD: Record<ConditionResult, string> = { met: "Met", "not-met": "Not met", missing: "Missing" };
const OUTCOME = {
  fires: "gen-cds__outcome gen-cds__outcome--fires",
  silent: "gen-cds__outcome",
  blocked: "gen-cds__outcome gen-cds__outcome--blocked",
} as const;

const show = (v: number | string) => (typeof v === "string" ? `"${v}"` : String(v));
const withUnit = (v: number | string, unit?: string) => (typeof v === "number" && unit ? `${v} ${unit}` : show(v));

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The computed verdict, as one plain-language sentence. */
function verdictSentence(logic: "all" | "any", n: number, ev: RuleEvaluation, missingLabels: string[]): string {
  const isAre = missingLabels.length === 1 ? "is" : "are";
  switch (ev.outcome) {
    case "fires":
      return logic === "all"
        ? `The rule fires: all ${n} conditions are met.`
        : `The rule fires: ${ev.met} of ${n} conditions ${ev.met === 1 ? "is" : "are"} met, and any one is enough.`;
    case "does-not-fire":
      return logic === "all"
        ? `The rule does not fire: ${ev.notMet} of ${n} conditions ${ev.notMet === 1 ? "is" : "are"} not met.`
        : `The rule does not fire: none of the ${n} conditions is met.`;
    case "blocked-by-missing":
      return logic === "all"
        ? `The rule does not fire, but only because ${list(missingLabels)} ${isAre} missing: a missing value counts as not met. Every recorded value meets its condition, so it would fire if the missing ${missingLabels.length === 1 ? "value meets its condition" : "values meet theirs"}.`
        : `The rule does not fire: no recorded value meets a condition, but ${list(missingLabels)} ${isAre} missing, so it could fire once recorded.`;
  }
}

export function CdsRule({ name, logic, conditions, patient, action, isPartial = false }: CdsRuleProps) {
  const ev = evaluateRule(logic, conditions, patient);
  const n = conditions.length;
  const missingLabels = conditions.filter((_, i) => ev.results[i] === "missing").map((c) => c.label);
  const sentence = verdictSentence(logic, n, ev, missingLabels);
  const fires = ev.outcome === "fires";
  const semantics = logic === "all"
    ? "Fires only when ALL conditions are met. A missing value counts as not met."
    : "Fires when ANY condition is met. A missing value is skipped, so a silent rule may only lack data.";

  const rows = conditions.map((c, i) => {
    const raw = Object.prototype.hasOwnProperty.call(patient, c.field) ? patient[c.field] : null;
    const value = raw === null || raw === undefined ? null : raw;
    const rule = `${c.field} ${OPERATOR_SYMBOL[c.operator]} ${withUnit(c.value, c.unit)}`;
    const substituted = value === null ? "not recorded" : `${show(value)} ${OPERATOR_SYMBOL[c.operator]} ${show(c.value)}`;
    return { c, result: ev.results[i]!, rule, value, substituted, key: i };
  });

  const aria = `Decision support rule "${name}" (${logic === "all" ? "all conditions" : "any condition"}): ${rows.map((r) => `${r.c.label} ${WORD[r.result].toLowerCase()}`).join("; ")}. ${sentence}`;

  return (
    <FigurePlate
      kicker="Decision support"
      title={name}
      isPartial={isPartial}
      label={aria}
      takeaway={<>{sentence}</>}
      table={{
        caption: "Each condition evaluated against the patient",
        head: ["Condition", "Rule", "Patient value", "Result"],
        rows: rows.map((r) => [r.c.label, r.rule, r.value === null ? "not recorded" : withUnit(r.value, r.c.unit), WORD[r.result]]),
      }}
    >
      <div className="gen-cds">
        <p className="gen-cds__logic"><span className="gen-cds__keyword">IF</span> {semantics}</p>
        <ol className="gen-cds__list">
          {rows.map((r) => (
            <li key={r.key} className={ROW[r.result]}>
              <span className="gen-cds__mark" aria-hidden="true">{MARK[r.result]}</span>
              <span className="gen-cds__body">
                <span className="gen-cds__label">{r.c.label}</span>
                <code className="gen-cds__expr">{r.rule}</code>
                <span className="gen-cds__value">
                  {r.value === null
                    ? "Patient: not recorded"
                    : typeof r.value === "string"
                      ? `Patient: ${show(r.value)}`
                      : `Patient: ${withUnit(r.value, r.c.unit)} → ${r.substituted}`}
                </span>
              </span>
              <span className="gen-cds__result">{WORD[r.result]}</span>
            </li>
          ))}
        </ol>
        <div className={fires ? OUTCOME.fires : ev.outcome === "blocked-by-missing" ? OUTCOME.blocked : OUTCOME.silent}>
          <p className="gen-cds__verdict">
            <span className="gen-cds__keyword">THEN</span> {fires ? "Rule fires" : "Rule does not fire"}
            <span className="gen-cds__tally">{` · ${ev.met} met, ${ev.notMet} not met, ${ev.missing} missing`}</span>
          </p>
          {action ? (
            <p className="gen-cds__action">{fires ? `Recommended: ${action}` : `When it fires, it recommends: ${action}`}</p>
          ) : null}
        </div>
      </div>
    </FigurePlate>
  );
}
