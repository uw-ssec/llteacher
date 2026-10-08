import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@llteacher/ui";
import type { StudentProgressWidget, WidgetResponseResponse } from "../../shared/types";

/* --------------------------------------------------------------------------
   SelfAssessmentPanel — the student side of #165's pre/post self-assessment
   widgets.

   The instructor attaches widgets to a homework (admin homework form); each
   carries a `prePrompt` asked before the student opens the first section and
   a `postPrompt` asked after the last section is submitted, both answered on
   a 0-10 scale. App.tsx decides WHEN to show this (see its own
   pendingSelfAssessment logic); this component only renders the prompts for
   one phase and records the answers through PATCH /api/widgets/:id/response.

   Lives in apps/web, not packages/ui, for the same reason ResponseFeedback
   does: it owns a real API call.

   "Skip for now" is a first-class action, not an escape hatch: partial
   completion is a valid state by design (a student may answer pre and never
   post, #165), so declining must never block the homework. Skipping records
   nothing; the prompt can come back on a later visit while it still applies.
   -------------------------------------------------------------------------- */

export type SelfAssessmentPhase = "pre" | "post";

export interface SelfAssessmentPanelProps {
  phase: SelfAssessmentPhase;
  /** Only the widgets still unanswered for `phase`; ordered by `order`. */
  widgets: StudentProgressWidget[];
  /** Called with the server's recorded rows once every widget is saved. */
  onSubmitted: (responses: WidgetResponseResponse[]) => void;
  onSkip: () => void;
}

const SCALE_MIN = 0;
const SCALE_MAX = 10;
/** The scale's midpoint, so the starting position does not suggest an answer
 *  at either end. Nothing is recorded until the student presses Save. */
const SCALE_START = 5;

export function SelfAssessmentPanel({ phase, widgets, onSubmitted, onSkip }: SelfAssessmentPanelProps) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(widgets.map((w) => [w.id, SCALE_START])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The panel replaces the chat (pre) or appears above it (post); move focus
  // to its heading so keyboard and screen-reader users land on it.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const recorded: WidgetResponseResponse[] = [];
      // Sequential, not Promise.all: each call is a small upsert, and a
      // failure part-way should report which answers were not saved
      // rather than race.
      for (const widget of widgets) {
        const res = await fetch(`/api/widgets/${widget.id}/response`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ which: phase, value: values[widget.id] ?? SCALE_START }),
        });
        if (!res.ok) throw new Error(`widget response failed: ${res.status}`);
        recorded.push((await res.json()) as WidgetResponseResponse);
      }
      onSubmitted(recorded);
    } catch (err) {
      console.error("[SelfAssessmentPanel] failed to save", err);
      setError("Your answers couldn't be saved. Please try again, or skip for now.");
      setSaving(false);
    }
  };

  const title = phase === "pre" ? "Before you start" : "Now that you're done";
  const intro =
    phase === "pre"
      ? "A quick self-check before the first section. There are no right answers."
      : "You've submitted every section. One more quick self-check.";

  return (
    <section className="self-assessment" aria-labelledby={headingId}>
      <h2 id={headingId} ref={headingRef} tabIndex={-1} className="self-assessment__title">
        {title}
      </h2>
      <p className="self-assessment__intro">{intro}</p>

      {widgets.map((widget) => {
        const prompt = phase === "pre" ? widget.prePrompt : widget.postPrompt;
        const value = values[widget.id] ?? SCALE_START;
        const inputId = `self-assessment-${widget.id}`;
        return (
          <div key={widget.id} className="self-assessment__item">
            <label htmlFor={inputId} className="self-assessment__prompt">
              {prompt}
            </label>
            <div className="self-assessment__scale">
              <span aria-hidden="true">{SCALE_MIN}</span>
              <input
                id={inputId}
                type="range"
                min={SCALE_MIN}
                max={SCALE_MAX}
                step={1}
                value={value}
                aria-valuetext={`${value} out of ${SCALE_MAX}`}
                onChange={(e) => setValues((prev) => ({ ...prev, [widget.id]: Number(e.target.value) }))}
              />
              <span aria-hidden="true">{SCALE_MAX}</span>
              <output htmlFor={inputId} className="self-assessment__value">
                {value}
              </output>
            </div>
          </div>
        );
      })}

      {error && (
        <p role="alert" className="self-assessment__error">
          {error}
        </p>
      )}

      <div className="self-assessment__actions">
        <Button variant="accent" onClick={() => void handleSave()} loading={saving}>
          Save
        </Button>
        <Button variant="ghost" onClick={onSkip} disabled={saving}>
          Skip for now
        </Button>
      </div>
    </section>
  );
}
