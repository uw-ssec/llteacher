import { describe, expect, it } from "vitest";
import { instructorConsoleUrl } from "./AccountShell";

describe("instructorConsoleUrl", () => {
  it("falls back to the same-origin production console", () => {
    expect(instructorConsoleUrl(undefined, "https://teacher.example.edu")).toBe(
      "https://teacher.example.edu/admin/",
    );
  });

  it("preserves an explicitly configured console URL", () => {
    expect(
      instructorConsoleUrl(
        "https://console.example.edu/custom",
        "https://teacher.example.edu",
      ),
    ).toBe("https://console.example.edu/custom");
  });

  it("maps the local student port to the paired admin port", () => {
    expect(instructorConsoleUrl(undefined, "http://localhost:2311")).toBe(
      "http://localhost:2312",
    );
  });
});
