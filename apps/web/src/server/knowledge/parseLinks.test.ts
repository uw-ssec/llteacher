import { describe, it, expect } from "vitest";
import { parseLinks } from "./parseLinks";

describe("parseLinks", () => {
  it("resolves a bundle-absolute link", () => {
    expect(parseLinks("see [regression](/stats/regression)", "intro")).toEqual([
      { rawHref: "/stats/regression", targetPath: "stats/regression" },
    ]);
  });

  it("resolves a relative link against the source directory", () => {
    expect(parseLinks("see [b](b)", "stats/a")).toEqual([
      { rawHref: "b", targetPath: "stats/b" },
    ]);
  });

  it("resolves a parent-relative link", () => {
    expect(parseLinks("see [x](../x)", "stats/week1/a")).toEqual([
      { rawHref: "../x", targetPath: "stats/x" },
    ]);
  });

  it("strips the .md suffix, because paths are concept ids", () => {
    expect(parseLinks("[a](/stats/a.md)", "intro")[0].targetPath).toBe("stats/a");
  });

  it("strips anchors", () => {
    expect(parseLinks("[a](/stats/a#heading)", "intro")[0].targetPath).toBe("stats/a");
  });

  it("ignores external and non-document links", () => {
    const body = "[w](https://x.test) [m](mailto:a@b.test) [h](#local)";
    expect(parseLinks(body, "intro")).toEqual([]);
  });

  it("ignores links inside fenced code blocks", () => {
    const body = "```\n[a](/stats/a)\n```\n[b](/stats/b)";
    expect(parseLinks(body, "intro")).toEqual([
      { rawHref: "/stats/b", targetPath: "stats/b" },
    ]);
  });

  it("deduplicates repeated links to the same target", () => {
    expect(parseLinks("[a](/x) and [again](/x)", "intro")).toHaveLength(1);
  });

  it("returns an empty array for a body with no links", () => {
    expect(parseLinks("plain prose", "intro")).toEqual([]);
  });
});
