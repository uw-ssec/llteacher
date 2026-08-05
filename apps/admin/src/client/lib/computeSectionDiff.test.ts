import { describe, it, expect } from "vitest";
import { computeSectionDiff, type FormSection } from "./computeSectionDiff";

describe("computeSectionDiff", () => {
  it("omits id for new sections and renumbers order 1..N", () => {
    const form: FormSection[] = [
      { id: undefined, title: "New", content: "c", solutionContent: undefined },
    ];
    expect(computeSectionDiff(form)).toEqual([
      { title: "New", content: "c", order: 1, solutionContent: undefined },
    ]);
  });

  it("preserves ids for existing sections and renumbers by current form order", () => {
    const form: FormSection[] = [
      { id: "s2", title: "Second", content: "c2", solutionContent: undefined },
      { id: "s1", title: "First", content: "c1", solutionContent: "sol" },
    ];
    expect(computeSectionDiff(form)).toEqual([
      { id: "s2", title: "Second", content: "c2", order: 1, solutionContent: undefined },
      { id: "s1", title: "First", content: "c1", order: 2, solutionContent: "sol" },
    ]);
  });

  it("a removed section (deleted from the form array) is simply absent from the output", () => {
    // The server infers deletion from omission (Phase 1's planSectionDiff) --
    // this function doesn't need a "deleted" marker, just doesn't include it.
    const form: FormSection[] = [{ id: "s1", title: "Kept", content: "c", solutionContent: undefined }];
    const result = computeSectionDiff(form);
    expect(result.find((s) => "id" in s && s.id === "s2")).toBeUndefined();
    expect(result).toHaveLength(1);
  });
});
