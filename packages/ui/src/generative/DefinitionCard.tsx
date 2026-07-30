/* --------------------------------------------------------------------------
   DefinitionCard — formal definition rendered as a dictionary entry inside
   an AI message.

   Produced by the LLM via the `showDefinition` tool. Typographic
   presentation only — no card chrome. Hairline rules top and bottom
   bracket the entry like a printed reference work; a Heritage Gold
   pilcrow (¶) sits in the left margin as an ornament; the term is set
   in larger semibold Geist with an italic "n." part-of-speech mark
   trailing it (OED convention); the body is body type.

   When the LLM is still streaming the args, the entry renders at reduced
   opacity to telegraph "still being generated."
   -------------------------------------------------------------------------- */

export interface DefinitionCardProps {
  term: string;
  body: string;
  /** True while the LLM is still streaming the args; renders muted */
  isPartial?: boolean;
}

export function DefinitionCard({
  term,
  body,
  isPartial = false,
}: DefinitionCardProps) {
  return (
    <aside
      className={
        isPartial
          ? "definition-card definition-card--partial"
          : "definition-card"
      }
      aria-label={`Definition of ${term}`}
    >
      <div className="definition-card__term">{term}</div>
      {/* Signature flourish — a hand-drawn-feeling SVG underline in Heritage
          Gold that animates in. The single piece of visual identity for the
          card. Slightly shorter than the term so it reads as a signature
          mark rather than a uniform rule. */}
      <svg
        className="definition-card__signature"
        viewBox="0 0 120 8"
        aria-hidden="true"
        preserveAspectRatio="none"
      >
        <path
          d="M2 5 Q 25 1, 50 4 T 95 3 T 118 4"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      <div className="definition-card__body">{body}</div>
    </aside>
  );
}
