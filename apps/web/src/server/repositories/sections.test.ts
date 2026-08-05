import { describe, it, expect } from "vitest";
import { planSectionDiff, type ExistingSection } from "./sections";

const existing: ExistingSection[] = [
  { id: "s1", order: 1, title: "Sample spaces", content: "c1", solutionId: "sol1" },
  { id: "s2", order: 2, title: "Events", content: "c2", solutionId: null },
  { id: "s3", order: 3, title: "Conditional prob", content: "c3", solutionId: "sol3" },
];

describe("planSectionDiff", () => {
  it("creates sections with no id", () => {
    const plan = planSectionDiff([], [{ title: "New", content: "c", order: 1 }]);
    expect(plan.toCreate).toEqual([{ title: "New", content: "c", order: 1, solutionContent: undefined }]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it("updates a section whose id matches an existing row (title/content/order/solution)", () => {
    const plan = planSectionDiff(existing, [
      { id: "s1", title: "Sample spaces (revised)", content: "c1-new", order: 1, solutionContent: "sol text" },
      { id: "s2", title: "Events", content: "c2", order: 2 },
      { id: "s3", title: "Conditional prob", content: "c3", order: 3, solutionContent: "sol3 text" },
    ]);
    expect(plan.toUpdate).toEqual([
      { id: "s1", title: "Sample spaces (revised)", content: "c1-new", order: 1, solutionContent: "sol text", solutionAction: "update" },
      { id: "s3", title: "Conditional prob", content: "c3", order: 3, solutionContent: "sol3 text", solutionAction: "update" },
    ]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it("deletes existing rows omitted from the incoming array", () => {
    const plan = planSectionDiff(existing, [
      { id: "s1", title: "Sample spaces", content: "c1", order: 1 },
    ]);
    expect(plan.toDelete.map((d) => d.id).sort()).toEqual(["s2", "s3"]);
  });

  it("reorders by keeping id but changing order", () => {
    const plan = planSectionDiff(existing, [
      { id: "s1", title: "Sample spaces", content: "c1", order: 3 },
      { id: "s2", title: "Events", content: "c2", order: 1 },
      { id: "s3", title: "Conditional prob", content: "c3", order: 2 },
    ]);
    expect(plan.toUpdate.map((u) => ({ id: u.id, order: u.order }))).toEqual([
      { id: "s1", order: 3 },
      { id: "s2", order: 1 },
      { id: "s3", order: 2 },
    ]);
  });

  it("adds a solution to a section that had none", () => {
    const plan = planSectionDiff(existing, [
      { id: "s1", title: "Sample spaces", content: "c1", order: 1 },
      { id: "s2", title: "Events", content: "c2", order: 2, solutionContent: "new solution" },
      { id: "s3", title: "Conditional prob", content: "c3", order: 3 },
    ]);
    const s2 = plan.toUpdate.find((u) => u.id === "s2")!;
    expect(s2.solutionContent).toBe("new solution");
    expect(s2.solutionAction).toBe("create");
  });

  it("removes a solution from a section that had one (solutionContent omitted)", () => {
    const plan = planSectionDiff(existing, [
      { id: "s1", title: "Sample spaces", content: "c1", order: 1 },
      { id: "s2", title: "Events", content: "c2", order: 2 },
      { id: "s3", title: "Conditional prob", content: "c3", order: 3 }, // s3 had solutionId: "sol3", now omitted
    ]);
    const s3 = plan.toUpdate.find((u) => u.id === "s3")!;
    expect(s3.solutionAction).toBe("delete");
  });

  it("throws when two incoming sections share the same order", () => {
    expect(() =>
      planSectionDiff([], [
        { title: "A", content: "c", order: 1 },
        { title: "B", content: "c", order: 1 },
      ]),
    ).toThrow(/duplicate order/i);
  });

  it("throws when an incoming section references an id not in existing", () => {
    expect(() =>
      planSectionDiff(existing, [{ id: "does-not-exist", title: "X", content: "c", order: 1 }]),
    ).toThrow(/unknown section id/i);
  });
});
