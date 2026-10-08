// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { renderToolPart, FIGURE_TOOL_PART_TYPES, type ToolPart } from "./render";
import { RENDERABLE_TOOL_NAMES } from "./renderableTools";
import { FIGURE_FIXTURES } from "./figure/fixtures";
import { ToolPartErrorBoundary } from "./ToolPartErrorBoundary";
import { parseAlignmentInput, parseMacroModelInput, parseMultiplierInput, parseTranslationInput } from "./toolInputs";

afterEach(cleanup);

const part = (name: string, input: unknown, state: ToolPart["state"] = "input-available"): ToolPart => ({
  type: `tool-${name}`,
  state,
  input,
});
const show = (name: string, input: unknown, state?: ToolPart["state"]) => render(<>{renderToolPart(part(name, input, state), "k")}</>);

describe("registry lockstep (#38)", () => {
  it("every renderable figure tool has a fixture that actually renders", () => {
    for (const type of FIGURE_TOOL_PART_TYPES) {
      const name = type.slice("tool-".length);
      expect(RENDERABLE_TOOL_NAMES.has(name), `${name} missing from RENDERABLE_TOOL_NAMES`).toBe(true);
      expect(renderToolPart(part(name, FIGURE_FIXTURES[name]), "k"), `${name} rendered nothing`).not.toBeNull();
    }
  });

  it("every renderable name is either a figure tool or one of the original three", () => {
    const figures = new Set(FIGURE_TOOL_PART_TYPES.map((t) => t.slice("tool-".length)));
    for (const name of RENDERABLE_TOOL_NAMES) {
      expect(figures.has(name) || ["showDefinition", "executeRCode", "markSectionComplete"].includes(name), name).toBe(true);
    }
  });
});

describe.each(Object.keys(FIGURE_FIXTURES))("%s: the four tool states", (name) => {
  it("input-streaming without valid input holds a skeleton", () => {
    show(name, {}, "input-streaming");
    expect(screen.getByText("Drawing the figure…")).toBeTruthy();
  });
  it("input-available renders the figure", () => {
    show(name, FIGURE_FIXTURES[name]);
    expect(screen.getByRole("figure")).toBeTruthy();
  });
  it("output-available renders the same figure (replay of a persisted turn)", () => {
    show(name, FIGURE_FIXTURES[name], "output-available");
    expect(screen.getByRole("figure")).toBeTruthy();
  });
  it("output-error with malformed input renders nothing", () => {
    const { container } = show(name, { nonsense: true }, "output-error");
    expect(container.innerHTML).toBe("");
  });
});

describe("computed, not trusted", () => {
  it("AD-AS: AD left gives falling prices and output, and names the recessionary gap", () => {
    show("showMacroModel", FIGURE_FIXTURES.showMacroModel);
    const fig = screen.getByRole("figure");
    expect(fig.textContent).toContain("Price level falls and real GDP falls.");
    expect(fig.textContent).toContain("a recessionary gap");
    expect(within(fig).getAllByText("AD₁").length).toBeGreaterThan(0);
    expect(within(fig).getAllByText("AD₂").length).toBeGreaterThan(0);
  });

  it("money market: more money supply lowers the interest rate", () => {
    show("showMacroModel", { model: "money-market", shifts: [{ curve: "money supply", direction: "right" }] });
    expect(screen.getByRole("figure").textContent).toContain("Nominal interest rate falls and quantity of money rises.");
  });

  it("GDP: total is the sum of the components, net exports subtracting", () => {
    show("showGdpComposition", FIGURE_FIXTURES.showGdpComposition);
    const text = screen.getByRole("figure").textContent!;
    expect(text).toContain("GDP = C + I + G + NX = 18.8 + 4.8 + 4.7 + (-0.8) = 27.5");
    expect(text).toContain("trade deficit subtracts 0.8");
  });

  it("multiplier: 1/(1-MPC) and the total change", () => {
    show("showMultiplier", FIGURE_FIXTURES.showMultiplier);
    const text = screen.getByRole("figure").textContent!;
    expect(text).toContain("Multiplier = 1 / (1 − 0.8) = 5");
    expect(text).toContain("so GDP rises by 500 billion dollars in total");
  });

  it("labor force: unemployment is measured against the labor force", () => {
    show("showLaborForce", FIGURE_FIXTURES.showLaborForce);
    expect(screen.getByRole("figure").textContent).toContain("= 7.1 / 168.3 = 4.2%");
  });

  it("inflation: computed from the index values", () => {
    show("showInflation", FIGURE_FIXTURES.showInflation);
    expect(screen.getByRole("figure").textContent).toContain("(313.7 − 304.7) / 304.7 = +3.0%");
  });

  it("translation: the standard code, ending at the stop codon", () => {
    show("showTranslation", FIGURE_FIXTURES.showTranslation);
    const text = screen.getByRole("figure").textContent!;
    expect(text).toContain("MVHLTPEEKSAVTALWGKVNVDEVGGEALGR·");
    expect(text).toContain("ends at the TAA stop codon at position 94");
  });

  it("alignment: identity and score from the columns", () => {
    show("showAlignment", { kind: "dna", nameA: "a", nameB: "b", seqA: "GATTACA", seqB: "GA-TACC" });
    const text = screen.getByRole("figure").textContent!;
    expect(text).toContain("71.4% identity");
    expect(text).toContain("Score 2 = 5 × 1 (match) + 1 × -1 (mismatch) + 1 × -2 (gap)");
  });

  it("tree: says plainly when it has no branch lengths", () => {
    show("showPhyloTree", { newick: "((A,B),C);" });
    expect(screen.getByRole("figure").textContent).toContain("only the branching order is meaningful");
  });
});

describe("parsers refuse meaningless input", () => {
  it.each([
    ["an MPC of 1", () => parseMultiplierInput({ mpc: 1, initialChange: 100 })],
    ["aligned sequences of different length", () => parseAlignmentInput({ kind: "dna", seqA: "ACGT", seqB: "ACG" })],
    ["a column that is a gap in both rows", () => parseAlignmentInput({ kind: "dna", seqA: "A-GT", seqB: "A-GA" })],
    ["a non-DNA symbol", () => parseTranslationInput({ dna: "ATGXXX" })],
    ["a curve the model doesn't have", () => parseMacroModelInput({ model: "ad-as", shifts: [{ curve: "IS", direction: "left" }] })],
    ["the same curve shifted twice", () => parseMacroModelInput({ model: "ad-as", shifts: [{ curve: "AD", direction: "left" }, { curve: "ad", direction: "right" }] })],
  ])("%s", (_label, parse) => {
    expect(parse()).toBeNull();
  });
});

describe("ToolPartErrorBoundary (#38)", () => {
  it("contains a renderer crash to one figure", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Boom(): never {
      throw new Error("bad geometry");
    }
    render(
      <div>
        <p>earlier message</p>
        <ToolPartErrorBoundary toolName="showMacroModel"><Boom /></ToolPartErrorBoundary>
      </div>,
    );
    expect(screen.getByText("earlier message")).toBeTruthy();
    expect(screen.getByText(/couldn't be drawn/)).toBeTruthy();
  });
});
