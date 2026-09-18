import { describe, it, expect } from "vitest";
import { sourcesFromParts } from "./sourcesFromParts";

describe("sourcesFromParts", () => {
  it("collects distinct completed showKnowledge outputs and ignores everything else", () => {
    const parts = [
      { type: "text", text: "hi" },
      { type: "tool-searchKnowledge", state: "output-available", output: { hits: [] } },
      { type: "tool-showKnowledge", state: "output-available", output: { conceptId: "a", title: "A" } },
      { type: "tool-showKnowledge", state: "output-available", output: { conceptId: "a", title: "A" } },
      { type: "tool-showKnowledge", state: "output-available", output: { error: "not_found" } },
      { type: "tool-showKnowledge", state: "input-available", input: { conceptId: "b" } },
    ];
    expect(sourcesFromParts(parts)).toEqual([{ conceptId: "a", title: "A" }]);
    expect(sourcesFromParts(undefined)).toEqual([]);
  });
});
