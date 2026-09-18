import { describe, it, expect } from "vitest";
import { parseFrontmatter, setFrontmatterKeys } from "./frontmatter";

const RAW = `---
type: Fact
title: "Title: with colon & \\"quotes\\""
description: A first concept
generated: { by: agent/cli, at: "2026-09-16T06:24:01Z" }
---

# Body
`;

describe("parseFrontmatter", () => {
  it("reads scalars, unquotes, and keeps the body", () => {
    const { frontmatter, body } = parseFrontmatter(RAW);
    expect(frontmatter.type).toBe("Fact");
    expect(frontmatter.title).toBe('Title: with colon & "quotes"');
    expect(frontmatter.generated).toBe('{ by: agent/cli, at: "2026-09-16T06:24:01Z" }');
    expect(body).toBe("\n# Body\n");
  });
  it("returns an empty map when there is no frontmatter", () => {
    expect(parseFrontmatter("just text")).toEqual({ frontmatter: {}, body: "just text" });
  });
  it("handles CRLF line endings", () => {
    const CRLF_RAW = RAW.replace(/\n/g, "\r\n");
    const { frontmatter: fm1, body: body1 } = parseFrontmatter(RAW);
    const { frontmatter: fm2, body: body2 } = parseFrontmatter(CRLF_RAW);
    expect(fm2).toEqual(fm1);
    expect(body2).toBe(body1);
  });
});

describe("setFrontmatterKeys", () => {
  it("inserts after description and quotes when needed", () => {
    const out = setFrontmatterKeys(RAW, { resource: "llteacher://materials/m1", status: "generated" });
    const lines = out.split("\n");
    expect(lines[3]).toBe("description: A first concept");
    expect(lines[4]).toBe('resource: "llteacher://materials/m1"');
    expect(lines[5]).toBe("status: generated");
    expect(out.endsWith("# Body\n")).toBe(true);
  });
  it("replaces an existing key in place", () => {
    const once = setFrontmatterKeys(RAW, { status: "generated" });
    const twice = setFrontmatterKeys(once, { status: "verified-by-instructor" });
    expect(twice.match(/^status:/gm)).toHaveLength(1);
    expect(twice).toContain("status: verified-by-instructor");
  });
  it("handles CRLF line endings with setFrontmatterKeys", () => {
    const CRLF_RAW = RAW.replace(/\n/g, "\r\n");
    const out = setFrontmatterKeys(CRLF_RAW, { status: "generated" });
    const statusLines = out.match(/^status:/gm);
    expect(statusLines).toHaveLength(1);
    const fences = out.match(/^---$/gm);
    expect(fences).toHaveLength(2);
  });
});
