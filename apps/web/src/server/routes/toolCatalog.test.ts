/* #38: the server's tool catalog and the client's renderer registry may not
   drift. Every tool the model can be offered is either drawn by the client
   (RENDERABLE_TOOL_NAMES, which renderToolPart dispatches on) or is listed
   here as server-only on purpose -- a side-effect tool with nothing to
   show. Adding a display tool to TOOLS without a renderer fails this test
   instead of shipping a blank bubble; so does listing a renderer for a tool
   the server no longer has. Every pack tool must exist in the catalog too. */
import { describe, it, expect } from "vitest";
import { TOOLS } from "./chat";
import { RENDERABLE_TOOL_NAMES } from "@llteacher/ui/generative/renderableTools";
import { TOOLKIT_TOOL_NAMES } from "@llteacher/ui/generative/toolkits";

const SERVER_ONLY = new Set(["requestHint", "searchKnowledge", "showKnowledge"]);

describe("tool catalog lockstep (#38)", () => {
  it("every server tool is renderable or deliberately server-only", () => {
    for (const name of Object.keys(TOOLS)) {
      expect(RENDERABLE_TOOL_NAMES.has(name) || SERVER_ONLY.has(name), `${name}: add a renderer or mark it server-only`).toBe(true);
    }
  });

  it("every renderable tool still exists on the server", () => {
    for (const name of RENDERABLE_TOOL_NAMES) expect(Object.keys(TOOLS), name).toContain(name);
  });

  it("every subject-pack tool is in the server catalog", () => {
    for (const name of TOOLKIT_TOOL_NAMES) expect(Object.keys(TOOLS), name).toContain(name);
  });
});
