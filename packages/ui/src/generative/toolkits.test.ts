import { describe, it, expect } from "vitest";
import { TOOLKITS, TOOLKIT_TOOL_NAMES, isToolEnabled, normalizeToolkitIds } from "./toolkits";
import { RENDERABLE_TOOL_NAMES } from "./renderableTools";
import { FIGURE_TOOL_PART_TYPES } from "./render";

describe("subject figure packs (toolkits.ts)", () => {
  it("every pack tool is renderable and has a figure renderer (drift guard)", () => {
    const figures = new Set(FIGURE_TOOL_PART_TYPES.map((t) => t.slice("tool-".length)));
    for (const name of TOOLKIT_TOOL_NAMES) {
      expect(RENDERABLE_TOOL_NAMES.has(name), `${name} not in RENDERABLE_TOOL_NAMES`).toBe(true);
      expect(figures.has(name), `${name} has no renderer`).toBe(true);
    }
  });

  it("ids are unique and no pack lists a tool twice", () => {
    expect(new Set(TOOLKITS.map((t) => t.id)).size).toBe(TOOLKITS.length);
    for (const t of TOOLKITS) expect(new Set(t.tools).size, t.id).toBe(t.tools.length);
  });

  it("a tool shared by two packs is offered when either is enabled", () => {
    expect(isToolEnabled("showPrevalenceEffect", ["clinical-informatics"])).toBe(true);
    expect(isToolEnabled("showPrevalenceEffect", ["test-evaluation"])).toBe(true);
    expect(isToolEnabled("showRocCurve", ["clinical-informatics"])).toBe(false);
    expect(isToolEnabled("showCdsRule", ["test-evaluation"])).toBe(false);
  });

  it("gates pack tools on their pack, leaves subject-neutral tools alone", () => {
    expect(isToolEnabled("showMacroModel", [])).toBe(false);
    expect(isToolEnabled("showMacroModel", ["economics"])).toBe(true);
    expect(isToolEnabled("showMacroModel", ["clinical-informatics"])).toBe(false);
    for (const neutral of ["showDefinition", "showWorkedSteps", "knowledgeCheck", "executeRCode"]) {
      expect(isToolEnabled(neutral, []), neutral).toBe(true);
    }
  });

  it("normalises ids: known only, de-duplicated, catalog order", () => {
    expect(normalizeToolkitIds(["statistics", "nope", "economics", "statistics", 3])).toEqual(["economics", "statistics"]);
  });
});
