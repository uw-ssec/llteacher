import { describe, it, expect } from "vitest";
import { statusKind, statusLabel } from "./knowledgeStatus";

describe("knowledgeStatus", () => {
  it.each([
    ["pending", "scheduled", "Pending"],
    ["processing", "in_progress", "Processing"],
    ["ready", "active", "Ready"],
    ["indexed", "active", "Indexed"],
    ["failed", "missing", "Failed"],
  ] as const)("maps %s to kind %s labelled %s", (status, kind, label) => {
    expect(statusKind(status)).toBe(kind);
    expect(statusLabel(status)).toBe(label);
  });
});
