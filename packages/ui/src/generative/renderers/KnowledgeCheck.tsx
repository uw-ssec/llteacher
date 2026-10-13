/* --------------------------------------------------------------------------
   KnowledgeCheck (`knowledgeCheck`, #36) -- an inline multiple-choice
   question the tutor poses, shared by every subject.

   Native radios in a fieldset (radio-group semantics, arrow-key navigation
   for free), one Submit, and then a locked record of what was chosen. The
   answer goes back as a chat message (knowledgeCheck.ts explains the
   contract); the TUTOR says whether it was right on its next turn, because
   no answer key is ever sent to the browser. Read-only (no onAnswer) on
   surfaces that can't answer, such as an instructor viewing a transcript.
   -------------------------------------------------------------------------- */

import { useId, useState, type FormEvent } from "react";
import { FigurePlate } from "../figure/FigurePlate";
import { optionLetter } from "../knowledgeCheck";

export interface KnowledgeCheckProps {
  question: string;
  options: string[];
  /** The option already chosen in this conversation, if any. */
  answeredIndex?: number;
  /** Sends the answer; rejects if it could not be sent. Absent = read-only. */
  onAnswer?: (selectedIndex: number) => Promise<void>;
  isPartial?: boolean;
}

export function KnowledgeCheck({ question, options, answeredIndex, onAnswer, isPartial = false }: KnowledgeCheckProps) {
  const name = useId();
  const [choice, setChoice] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = answeredIndex !== undefined;
  const readOnly = !onAnswer || isPartial;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (choice === null || !onAnswer || locked) return;
    setSending(true);
    setError(null);
    try {
      await onAnswer(choice);
    } catch {
      setError("Your answer didn't send. Try again in a moment.");
    } finally {
      setSending(false);
    }
  };

  const selected = locked ? answeredIndex : choice;

  return (
    <FigurePlate
      kicker="Check your understanding"
      title={question}
      isPartial={isPartial}
      label={`Knowledge check: ${question}`}
      note={locked ? `You chose ${optionLetter(answeredIndex!)}. The tutor will respond to your answer.` : undefined}
    >
      <form className="gen-check" onSubmit={submit}>
        <fieldset className="gen-check__options" disabled={locked || sending || readOnly}>
          <legend className="sr-only">{question}</legend>
          {options.map((option, i) => (
            <label key={i} className={selected === i ? "gen-check__option gen-check__option--selected" : "gen-check__option"}>
              <input
                type="radio"
                name={name}
                value={i}
                checked={selected === i}
                onChange={() => setChoice(i)}
                aria-label={`Option ${optionLetter(i)}: ${option}`}
              />
              <span className="gen-check__letter" aria-hidden="true">{optionLetter(i)}</span>
              <span className="gen-check__text">{option}</span>
            </label>
          ))}
        </fieldset>
        {error ? <p role="alert" className="gen-check__error">{error}</p> : null}
        {!locked && !readOnly ? (
          <button type="submit" className="gen-check__submit" disabled={choice === null || sending}>
            {sending ? "Sending…" : "Submit answer"}
          </button>
        ) : null}
      </form>
    </FigurePlate>
  );
}
