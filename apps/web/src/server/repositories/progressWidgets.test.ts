import { describe, it, expect } from "vitest";
import { planWidgetDiff, type ExistingWidget } from "./progressWidgets";

const existing: ExistingWidget[] = [
  { id: "w1", order: 1, prePrompt: "How confident before?", postPrompt: "How confident after?" },
  { id: "w2", order: 2, prePrompt: "Rate your understanding before", postPrompt: "Rate your understanding after" },
];

describe("planWidgetDiff", () => {
  it("creates widgets with no id", () => {
    const plan = planWidgetDiff([], [{ prePrompt: "pre", postPrompt: "post", order: 1 }]);
    expect(plan.toCreate).toEqual([{ prePrompt: "pre", postPrompt: "post", order: 1 }]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it("updates a widget whose id matches an existing row (prompt/order change)", () => {
    const plan = planWidgetDiff(existing, [
      { id: "w1", prePrompt: "How confident before? (revised)", postPrompt: "How confident after?", order: 1 },
      { id: "w2", prePrompt: "Rate your understanding before", postPrompt: "Rate your understanding after", order: 2 },
    ]);
    expect(plan.toUpdate).toEqual([
      { id: "w1", prePrompt: "How confident before? (revised)", postPrompt: "How confident after?", order: 1 },
    ]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it("omits unchanged widgets from toUpdate", () => {
    const plan = planWidgetDiff(existing, [
      { id: "w1", prePrompt: "How confident before?", postPrompt: "How confident after?", order: 1 },
      { id: "w2", prePrompt: "Rate your understanding before", postPrompt: "Rate your understanding after", order: 2 },
    ]);
    expect(plan.toUpdate).toEqual([]);
  });

  it("deletes existing widgets omitted from the incoming array", () => {
    const plan = planWidgetDiff(existing, [
      { id: "w1", prePrompt: "How confident before?", postPrompt: "How confident after?", order: 1 },
    ]);
    expect(plan.toDelete).toEqual([{ id: "w2" }]);
  });

  it("reorders by keeping id but changing order", () => {
    const plan = planWidgetDiff(existing, [
      { id: "w1", prePrompt: "How confident before?", postPrompt: "How confident after?", order: 2 },
      { id: "w2", prePrompt: "Rate your understanding before", postPrompt: "Rate your understanding after", order: 1 },
    ]);
    expect(plan.toUpdate.map((u) => ({ id: u.id, order: u.order }))).toEqual([
      { id: "w1", order: 2 },
      { id: "w2", order: 1 },
    ]);
  });

  it("throws when two incoming widgets share the same order", () => {
    expect(() =>
      planWidgetDiff([], [
        { prePrompt: "a", postPrompt: "a", order: 1 },
        { prePrompt: "b", postPrompt: "b", order: 1 },
      ]),
    ).toThrow(/duplicate order/i);
  });

  it("throws when an incoming widget references an id not in existing", () => {
    expect(() =>
      planWidgetDiff(existing, [{ id: "does-not-exist", prePrompt: "x", postPrompt: "x", order: 1 }]),
    ).toThrow(/unknown widget id/i);
  });
});
