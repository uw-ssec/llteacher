// Isolated in its own file (rather than a describe block inside
// service.test.ts) because it vi.mock()s "./okfCli" for the whole module
// graph of this file. Doing that inside service.test.ts would make every
// other test in that file -- which deliberately runs against the real okf
// binary -- receive the mock too.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("./okfCli", () => ({
  runOkf: vi.fn(),
  okfAvailable: () => true,
}));

import { runOkf } from "./okfCli";
import { OkfKnowledgeService } from "./service";

const COURSE_A = "11111111-2222-4333-8444-555555555555";

describe("OkfKnowledgeService.create rollback on partial failure", () => {
  let root: string;
  let svc: OkfKnowledgeService;
  let dir: string;
  let file: string;

  beforeEach(() => {
    vi.mocked(runOkf).mockReset();
    root = mkdtempSync(path.join(tmpdir(), "kb-rollback-"));
    svc = new OkfKnowledgeService({ root, binary: "okf" });
    dir = path.join(root, "courses", COURSE_A, "knowledge");
    file = path.join(dir, "a.md");
  });

  it("removes the concept file and regenerates the index when the body update fails", async () => {
    vi.mocked(runOkf).mockImplementation(async (_binary: string, args: string[]) => {
      if (args[0] === "create") {
        // Stand in for okf actually landing the concept file on disk.
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(file, '---\ntitle: "A"\ndescription: "d"\ntype: "note"\n---\n\nold\n');
        return null;
      }
      if (args[0] === "update") {
        throw new Error("boom");
      }
      return null;
    });

    await expect(
      svc.create(COURSE_A, { id: "a", type: "note", title: "A", description: "d", body: "new body" }),
    ).rejects.toThrow("boom");

    await expect(fs.access(file)).rejects.toThrow();
    expect(await svc.show(COURSE_A, "a")).toBeNull();
  });
});
