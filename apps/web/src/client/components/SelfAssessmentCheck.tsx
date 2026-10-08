import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@llteacher/ui";
import type { StudentProgressWidget } from "../../shared/types";
import "./self-assessment.css";

export type SelfAssessmentPhase = "pre" | "post";

interface SelfAssessmentCheckProps {
  phase: SelfAssessmentPhase;
  /** Only the widgets still unanswered on this phase, in order. */
  widgets: StudentProgressWidget[];
  /** Records every rating; rejects if any could not be saved. */
  onSubmit: (values: Array<{ widgetId: string; value: number }>) => Promise<void>;
  /** Partial completion is a valid state (#165), so the check never traps
   *  the student: skipping records nothing and lets them carry on. */
  onSkip: () => void;
}

const COPY = {
  pre: {
    eyebrow: "Before you start",
    title: "How confident are you right now?",
    lede: "Rate each one from 0 (not at all) to 10 (completely). There are no right answers; this is for comparing with how you feel at the end.",
    submit: "Save and start",
  },
  post: {
    eyebrow: "You've finished",
    title: "How confident are you now?",
    lede: "Rate each one again from 0 (not at all) to 10 (completely), now that you've worked through the homework.",
    submit: "Save ratings",
  },
} as const;

const MIDPOINT = 5;

/** #165: the before/after self-assessment for a homework's progress widgets. */
export function SelfAssessmentCheck({ phase, widgets, onSubmit, onSkip }: SelfAssessmentCheckProps) {
  const copy = COPY[phase];
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [values, setValues] = useState<Record<string, number>>(
    () => Object.fromEntries(widgets.map((w) => [w.id, MIDPOINT])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The check replaces the conversation pane, so move focus to its heading
  // rather than leaving it on whatever control triggered the swap.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit(widgets.map((w) => ({ widgetId: w.id, value: values[w.id] ?? MIDPOINT })));
    } catch {
      setError("Your ratings couldn't be saved. Try again, or skip for now.");
      setSaving(false);
    }
  };

  return (
    <section className="self-assessment" aria-labelledby={headingId}>
      <form className="self-assessment__content" onSubmit={handleSubmit}>
        <p className="self-assessment__eyebrow">{copy.eyebrow}</p>
        <h1 id={headingId} ref={headingRef} tabIndex={-1} className="self-assessment__title">
          {copy.title}
        </h1>
        <p className="self-assessment__lede">{copy.lede}</p>

        <fieldset className="self-assessment__items" disabled={saving}>
          {widgets.map((w) => {
            const inputId = `${headingId}-${w.id}`;
            const value = values[w.id] ?? MIDPOINT;
            return (
              <div key={w.id} className="self-assessment__item">
                <label htmlFor={inputId} className="self-assessment__prompt">
                  {phase === "pre" ? w.prePrompt : w.postPrompt}
                </label>
                <div className="self-assessment__scale">
                  <span aria-hidden="true">0</span>
                  <input
                    id={inputId}
                    className="self-assessment__range"
                    type="range"
                    min={0}
                    max={10}
                    step={1}
                    value={value}
                    aria-valuetext={`${value} out of 10`}
                    onChange={(e) => setValues((prev) => ({ ...prev, [w.id]: Number(e.target.value) }))}
                  />
                  <span aria-hidden="true">10</span>
                  <output htmlFor={inputId} className="self-assessment__value" aria-hidden="true">
                    {value}
                  </output>
                </div>
              </div>
            );
          })}
        </fieldset>

        {error ? (
          <p role="alert" className="self-assessment__error">
            {error}
          </p>
        ) : null}

        <div className="self-assessment__actions">
          <Button type="submit" variant="accent" disabled={saving}>
            {saving ? "Saving…" : copy.submit}
          </Button>
          <Button type="button" variant="default" outlined onClick={onSkip} disabled={saving}>
            Skip for now
          </Button>
        </div>
      </form>
    </section>
  );
}
