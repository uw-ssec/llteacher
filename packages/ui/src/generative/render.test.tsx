// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { renderToolPart, parseShowDefinitionInput, parseExecuteRCodeInput, isToolPart, type ToolPart } from "./render";

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

/* #28: same deny-by-default posture as parseShowDefinitionInput above --
   a tool-executeRCode part's `input` is model-generated JSON too. */
describe("parseExecuteRCodeInput", () => {
  it("parses a valid code string with no showSource", () => {
    expect(parseExecuteRCodeInput({ code: "sum(1:10)" })).toEqual({ code: "sum(1:10)", showSource: undefined });
  });

  it("parses showSource when present as a boolean", () => {
    expect(parseExecuteRCodeInput({ code: "1 + 1", showSource: false })).toEqual({ code: "1 + 1", showSource: false });
  });

  it("returns null while args are still streaming and no code has arrived yet", () => {
    expect(parseExecuteRCodeInput({})).toBeNull();
    expect(parseExecuteRCodeInput(undefined)).toBeNull();
  });

  it("returns null when code is an empty string", () => {
    expect(parseExecuteRCodeInput({ code: "" })).toBeNull();
  });

  it("returns null when code is not a string", () => {
    expect(parseExecuteRCodeInput({ code: 42 })).toBeNull();
    expect(parseExecuteRCodeInput({ code: ["not", "a", "string"] })).toBeNull();
  });

  it("returns null when showSource is present but not a boolean", () => {
    expect(parseExecuteRCodeInput({ code: "1+1", showSource: "yes" })).toBeNull();
  });

  it("returns null when input is not an object", () => {
    expect(parseExecuteRCodeInput("sum(1:10)")).toBeNull();
    expect(parseExecuteRCodeInput(null)).toBeNull();
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

  /* #28 */
  it("renders a CodeExecution for valid executeRCode input", () => {
    const part: ToolPart = {
      type: "tool-executeRCode",
      state: "output-available",
      input: { code: "sum(1:10)" },
    };
    const { getByText } = render(<>{renderToolPart(part, "k")}</>);
    expect(getByText("sum(1:10)")).toBeTruthy();
  });

  it("threads onRunRCode from handlers into the rendered CodeExecution's Run button", () => {
    const part: ToolPart = {
      type: "tool-executeRCode",
      state: "output-available",
      input: { code: "1 + 1" },
    };
    const onRunRCode = () => Promise.resolve({ status: "success" as const, output: "2", executionTimeMs: 1 });
    const { getByRole } = render(<>{renderToolPart(part, "k", { onRunRCode })}</>);
    expect(getByRole("button", { name: /run/i })).toBeTruthy();
  });

  it("shows no Run affordance when no handlers are passed (graceful degradation)", () => {
    const part: ToolPart = {
      type: "tool-executeRCode",
      state: "output-available",
      input: { code: "1 + 1" },
    };
    const { queryByRole } = render(<>{renderToolPart(part, "k")}</>);
    expect(queryByRole("button")).toBeNull();
  });

  it("returns null for executeRCode while args are still streaming and no code has arrived yet", () => {
    const part: ToolPart = { type: "tool-executeRCode", state: "input-streaming", input: {} };
    expect(renderToolPart(part, "k")).toBeNull();
  });

  /* #168: markSectionComplete is a zero-argument tool -- there is no
     model-generated `input` to validate the way showDefinition/executeRCode
     above need to, so the renderer only branches on `part.type`/`state`. */
  it("renders a SectionCompleteSuggestion for a resolved markSectionComplete tool call", () => {
    const part: ToolPart = {
      type: "tool-markSectionComplete",
      state: "output-available",
      input: {},
    };
    const { getByLabelText } = render(<>{renderToolPart(part, "k")}</>);
    expect(getByLabelText("Section complete suggestion")).toBeTruthy();
  });

  it("still renders the SectionCompleteSuggestion while input-streaming (zero-argument tool, nothing to wait for)", () => {
    const part: ToolPart = { type: "tool-markSectionComplete", state: "input-streaming", input: {} };
    expect(renderToolPart(part, "k")).not.toBeNull();
  });

  it("renders no interactive controls -- the suggestion is informational only, never an auto-submit affordance", () => {
    const part: ToolPart = { type: "tool-markSectionComplete", state: "output-available", input: {} };
    const { queryByRole } = render(<>{renderToolPart(part, "k")}</>);
    expect(queryByRole("button")).toBeNull();
  });
});
