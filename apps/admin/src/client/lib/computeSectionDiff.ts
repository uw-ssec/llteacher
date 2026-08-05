export interface FormSection {
  id?: string;
  title: string;
  content: string;
  solutionContent?: string;
}

export interface SectionDiffOutput {
  id?: string;
  title: string;
  content: string;
  order: number;
  solutionContent?: string;
}

/** Mirrors apps/web/src/server/repositories/sections.ts's planSectionDiff
 *  input shape (IncomingSection) exactly -- order is always renumbered 1..N
 *  from the form's current array order, so a drag-reorder or explicit
 *  add/remove never produces a duplicate/gapped order the server would
 *  reject with a 422. */
export function computeSectionDiff(form: FormSection[]): SectionDiffOutput[] {
  return form.map((s, i) => ({
    ...(s.id !== undefined && { id: s.id }),
    title: s.title,
    content: s.content,
    order: i + 1,
    solutionContent: s.solutionContent,
  }));
}
