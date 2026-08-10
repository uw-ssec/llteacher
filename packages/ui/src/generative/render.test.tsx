// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { renderToolPart, parseShowDefinitionInput, isToolPart, type ToolPart } from "./render";

afterEach(cleanup);

/* #144: the LLM's tool-call `input` is untrusted JSON -- these lock down
   the deny-by-default validation that replaced the old raw
   `part.input as Partial<{ term; body }>` cast, which let a malformed
   shape (e.g. `term` as an object) reach `<DefinitionCard term={term}>` as
   a JSX child and throw "Objects are not valid as a React child". */
describe("parseShowDefinitionInput", () => {
  it("parses a valid string term and body", () => {
    expect(parseShowDefinitionInput({ term: "p-value", body: "the probability..." })).toEqual({
      term: "p-value",
      body: "the probability...",
    });
  });

  it("defaults body to an empty string when omitted (still-streaming args)", () => {
    expect(parseShowDefinitionInput({ term: "p-value" })).toEqual({ term: "p-value", body: "" });
  });

  it("returns null when input is undefined (no args streamed yet)", () => {
    expect(parseShowDefinitionInput(undefined)).toBeNull();
  });

  it("returns null when input is not an object", () => {
    expect(parseShowDefinitionInput("p-value")).toBeNull();
    expect(parseShowDefinitionInput(42)).toBeNull();
    expect(parseShowDefinitionInput(null)).toBeNull();
  });

  it("returns null when term is missing (no term yet to anchor the card)", () => {
    expect(parseShowDefinitionInput({ body: "no term here" })).toBeNull();
  });

  it("returns null -- not the object itself -- when term is an object instead of a string", () => {
    expect(parseShowDefinitionInput({ term: { malformed: true }, body: "b" })).toBeNull();
  });

  it("returns null when body is an array instead of a string", () => {
    expect(parseShowDefinitionInput({ term: "p-value", body: ["not", "a", "string"] })).toBeNull();
  });

  it("returns null when term is an empty string", () => {
    expect(parseShowDefinitionInput({ term: "", body: "b" })).toBeNull();
  });
});

describe("isToolPart", () => {
  it("accepts any object with a string `type`", () => {
    expect(isToolPart({ type: "tool-showDefinition", input: {} })).toBe(true);
    expect(isToolPart({ type: "step-start" })).toBe(true);
  });

  it("rejects non-objects and objects without a string type", () => {
    expect(isToolPart(null)).toBe(false);
    expect(isToolPart(undefined)).toBe(false);
    expect(isToolPart("tool-showDefinition")).toBe(false);
    expect(isToolPart({})).toBe(false);
    expect(isToolPart({ type: 123 })).toBe(false);
  });
});

describe("renderToolPart", () => {
  it("returns null for unknown tool types (graceful degradation, not a throw)", () => {
    const part: ToolPart = { type: "tool-someFutureTool", input: { anything: true } };
    expect(renderToolPart(part, "k")).toBeNull();
  });

  it("renders a DefinitionCard for valid showDefinition input", () => {
    const part: ToolPart = {
      type: "tool-showDefinition",
      state: "output-available",
      input: { term: "p-value", body: "the probability of..." },
    };
    const { getByText } = render(<>{renderToolPart(part, "k")}</>);
    expect(getByText("p-value")).toBeTruthy();
    expect(getByText("the probability of...")).toBeTruthy();
  });

  it("does not throw and renders nothing when the model emits term as a malformed object", () => {
    const part: ToolPart = {
      type: "tool-showDefinition",
      state: "output-available",
      // Model-generated malformed shape -- the exact case #144 reports.
      input: { term: { nested: "object" }, body: "b" },
    };
    expect(() => render(<>{renderToolPart(part, "k")}</>)).not.toThrow();
  });

  it("does not throw and renders nothing when the model emits body as an array", () => {
    const part: ToolPart = {
      type: "tool-showDefinition",
      state: "output-available",
      input: { term: "p-value", body: ["not", "a", "string"] },
    };
    expect(() => render(<>{renderToolPart(part, "k")}</>)).not.toThrow();
  });

  it("returns null while args are still streaming and no term has arrived yet", () => {
    const part: ToolPart = { type: "tool-showDefinition", state: "input-streaming", input: {} };
    expect(renderToolPart(part, "k")).toBeNull();
  });
});
