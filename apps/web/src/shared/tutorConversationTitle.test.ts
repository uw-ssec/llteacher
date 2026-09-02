import { describe, it, expect } from "vitest";
import { AUTO_TITLE_MAX_LENGTH, DEFAULT_TUTOR_CONVERSATION_TITLE, deriveTutorConversationTitle } from "./tutorConversationTitle";

describe("deriveTutorConversationTitle (#231/#287)", () => {
  it("derives a title from the first text part, trimmed", () => {
    expect(deriveTutorConversationTitle([{ type: "text", text: "  hi there  " }])).toBe("hi there");
  });

  it("returns null when parts is not an array", () => {
    expect(deriveTutorConversationTitle(undefined)).toBeNull();
    expect(deriveTutorConversationTitle(null)).toBeNull();
    expect(deriveTutorConversationTitle("not an array")).toBeNull();
  });

  it("returns null when there is no text part (falls back to the default title upstream)", () => {
    expect(deriveTutorConversationTitle([{ type: "step-start" }])).toBeNull();
  });

  it("returns null when the only text part is empty/whitespace-only", () => {
    expect(deriveTutorConversationTitle([{ type: "text", text: "   " }])).toBeNull();
  });

  it("uses the FIRST text part when multiple parts are present", () => {
    expect(
      deriveTutorConversationTitle([
        { type: "step-start" },
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first");
  });

  it("truncates a long first message to AUTO_TITLE_MAX_LENGTH characters plus an ellipsis", () => {
    const longText = "a".repeat(80);
    expect(deriveTutorConversationTitle([{ type: "text", text: longText }])).toBe(`${"a".repeat(AUTO_TITLE_MAX_LENGTH)}…`);
  });

  it("does not truncate a message exactly at the limit", () => {
    const exact = "a".repeat(AUTO_TITLE_MAX_LENGTH);
    expect(deriveTutorConversationTitle([{ type: "text", text: exact }])).toBe(exact);
  });

  it("trims trailing whitespace left dangling right at the truncation boundary", () => {
    // 59 a's + a space + more text -- slicing at 60 code points lands on
    // the space, which trimEnd() should remove before the ellipsis.
    const text = `${"a".repeat(59)} ${"b".repeat(20)}`;
    expect(deriveTutorConversationTitle([{ type: "text", text }])).toBe(`${"a".repeat(59)}…`);
  });

  // #287: the actual bug. String.prototype.slice cuts on UTF-16 CODE UNITS,
  // not Unicode code points -- a character outside the Basic Multilingual
  // Plane (an astral character, e.g. 😀 U+1F600) is stored as a surrogate
  // PAIR: two code units. If slice(0, 60) lands exactly between the two
  // halves of such a pair, the result contains a single, lone surrogate,
  // which has no valid UTF-8 encoding and corrupts on the way into a
  // Postgres text column. Array.from (used here) iterates by code point, so
  // it can only ever cut BETWEEN whole characters.
  it("does not split a surrogate pair straddling the truncation boundary (emoji-at-boundary)", () => {
    // 59 plain ASCII code points + one astral emoji (2 UTF-16 code units,
    // 1 code point) puts the emoji's code point exactly at index 59 -- the
    // last one Array.from(...).slice(0, 60) includes. The OLD
    // String.prototype.slice(0, 60) implementation would instead take the
    // first 60 UTF-16 code units: 59 ASCII chars + only the emoji's high
    // surrogate, producing a lone, unpaired surrogate at the end.
    const emoji = "😀"; // U+1F600, a surrogate pair in UTF-16
    const text = `${"a".repeat(59)}${emoji}${"b".repeat(20)}`;
    const result = deriveTutorConversationTitle([{ type: "text", text }]);

    expect(result).toBe(`${"a".repeat(59)}${emoji}…`);
    // Directly assert there is no lone surrogate anywhere in the result --
    // the actual defect this test guards against, spelled out explicitly
    // rather than only implied by the exact-string match above.
    // eslint-disable-next-line no-control-regex -- surrogate range check
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result ?? "")).toBe(false);
  });

  it("still fits a whole surrogate pair even when it is the very last character kept", () => {
    const emoji = "🎉"; // U+1F389
    const text = `${"a".repeat(AUTO_TITLE_MAX_LENGTH - 1)}${emoji}${"c".repeat(5)}`;
    const result = deriveTutorConversationTitle([{ type: "text", text }]);
    expect(result).toBe(`${"a".repeat(AUTO_TITLE_MAX_LENGTH - 1)}${emoji}…`);
  });
});

describe("DEFAULT_TUTOR_CONVERSATION_TITLE (#287)", () => {
  it("is the exact sentinel every 'still untouched' check compares against", () => {
    expect(DEFAULT_TUTOR_CONVERSATION_TITLE).toBe("New Conversation");
  });
});
