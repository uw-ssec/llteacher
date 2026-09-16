import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOkf, OkfError, okfAvailable } from "./okfCli";

const OKF = process.env.OKF_BINARY ?? "okf";

describe.skipIf(!okfAvailable(OKF))("runOkf (real binary)", () => {
  it("parses JSON output from okf init and okf validate", async () => {
    const bundle = realpathSync(mkdtempSync(path.join(tmpdir(), "okf-")));
    const initResult = await runOkf<string>(OKF, ["init", bundle], { json: false });
    expect(initResult).toMatch(/Initialized OKF/);
    const report = await runOkf<{ concept_count: number; is_conformant: boolean }>(OKF, ["validate", bundle]);
    expect(report.concept_count).toBe(0);
    expect(report.is_conformant).toBe(true);
  });
  it("resolves null when okf prints null", async () => {
    const bundle = realpathSync(mkdtempSync(path.join(tmpdir(), "okf-")));
    await runOkf<string>(OKF, ["init", bundle], { json: false });
    expect(await runOkf(OKF, ["search", "anything", bundle])).toBeNull();
  });
  it("rejects with OkfError carrying stderr on a bad id", async () => {
    const bundle = realpathSync(mkdtempSync(path.join(tmpdir(), "okf-")));
    await runOkf<string>(OKF, ["init", bundle], { json: false });
    await expect(runOkf(OKF, ["show", "../escape", bundle])).rejects.toBeInstanceOf(OkfError);
  });
});

describe("okfAvailable", () => {
  it("is false for a binary that does not exist", () => {
    expect(okfAvailable("/nonexistent/okf")).toBe(false);
  });
});
