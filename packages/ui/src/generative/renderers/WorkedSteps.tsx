/* --------------------------------------------------------------------------
   WorkedSteps (`showWorkedSteps`) -- shared by every subject: a derivation
   or calculation laid out as numbered steps, each with an optional label,
   an expression set in mono, and a plain-language "why". Used for a GDP
   deflator calculation in ECON 201 as readily as for a Hardy-Weinberg
   problem in bioinformatics. The arithmetic is the tutor's own, so the
   figure presents it rather than vouching for it: there is no computed
   takeaway here, unlike the domain figures.
   -------------------------------------------------------------------------- */

import { FigurePlate } from "../figure/FigurePlate";

export interface WorkedStep {
  label?: string;
  expression?: string;
  explanation?: string;
}

export interface WorkedStepsProps {
  title: string;
  steps: WorkedStep[];
  result?: { label: string; value: string };
  isPartial?: boolean;
}

export function WorkedSteps({ title, steps, result, isPartial = false }: WorkedStepsProps) {
  return (
    <FigurePlate kicker="Worked steps" title={title} isPartial={isPartial}>
      <ol className="gen-steps">
        {steps.map((s, i) => (
          <li key={i} className="gen-steps__item">
            <div>
              {s.label ? <span className="gen-steps__label">{s.label}</span> : null}
              {s.expression ? <code className="gen-steps__expr">{s.expression}</code> : null}
              {s.explanation ? <p className="gen-steps__why">{s.explanation}</p> : null}
            </div>
          </li>
        ))}
      </ol>
      {result ? (
        <div className="gen-steps__result">
          <span className="gen-steps__result-label">{result.label}</span>
          <span className="gen-steps__result-value">{result.value}</span>
        </div>
      ) : null}
    </FigurePlate>
  );
}
