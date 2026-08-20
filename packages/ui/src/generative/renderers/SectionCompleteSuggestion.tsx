/* --------------------------------------------------------------------------
   SectionCompleteSuggestion — the tutor's stopping-rule suggestion (#168).

   Rendered inline inside an AI message when the model calls the
   markSectionComplete tool (chat.ts's TOOLS catalog): a distinct,
   purely-informational card, not a plain text message and not an
   interactive control. Issue #168's own requirements are what shape this
   component's whole design:

     "Completion is surfaced to the student as a suggestion, not an
      automatic irreversible submit"
     "Students can keep working after the tool fires -- it must not lock
      the conversation"

   So this component has NO submit affordance of its own -- it does not
   call the submissions API, does not know the section's real submit
   handler (App.tsx's handleSubmit), and cannot trigger one. The existing
   Submit button (Sidebar, wired in App.tsx, #22) remains the only way a
   section is ever actually turned in; this card only nudges the student
   toward it in words. Deliberately the simplest possible design for that
   reason -- a second, parallel "submit" button here would risk becoming a
   de facto auto-submit path the moment anything wired it up, exactly what
   the issue says not to build.

   isPartial mirrors DefinitionCard/CodeExecution's own convention, even
   though markSectionComplete is a zero-argument tool with nothing to
   stream -- kept for consistency with render.tsx's dispatch shape and in
   case a future streaming state (e.g. a "the tutor is wrapping up..."
   micro-animation) wants it; today it collapses to an instant
   input-streaming -> output-available transition.
   -------------------------------------------------------------------------- */

export interface SectionCompleteSuggestionProps {
  /** True only for the brief instant between the tool call being emitted
   *  and its (sentinel) result resolving -- there are no args to stream
   *  for a zero-argument tool, so this never lingers the way
   *  DefinitionCard's/CodeExecution's own isPartial can. */
  isPartial?: boolean;
}

export function SectionCompleteSuggestion({ isPartial = false }: SectionCompleteSuggestionProps) {
  return (
    <aside
      className={
        isPartial
          ? "section-complete-suggestion section-complete-suggestion--partial"
          : "section-complete-suggestion"
      }
      aria-label="Section complete suggestion"
    >
      <div className="section-complete-suggestion__title">Looks like you've got this</div>
      <div className="section-complete-suggestion__body">
        Your tutor thinks you've shown a good understanding of this section. Keep chatting if you have more
        questions, or use the Submit button whenever you're ready to turn it in.
      </div>
    </aside>
  );
}
