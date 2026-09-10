/* --------------------------------------------------------------------------
   #89 review (final-review fix, Minor #3): unit coverage for `modeMismatch`,
   the guard that stops tutor-behavior.ts's regression gate from comparing a
   `--mode=live` run against a `--mode=recorded` baseline (or vice versa) as
   if the two numbers meant the same thing -- see that function's own doc
   comment in tutor-behavior.ts and README.md's "On the current baseline".

   Only `modeMismatch` is imported here, deliberately -- it's a pure
   function with no I/O and no model calls, so importing it does not pull in
   any live-model behavior: `main()` only runs behind tutor-behavior.ts's
   own `isMain` guard (`process.argv[1] === fileURLToPath(import.meta.url)`),
   which is false when this module is imported from a test rather than
   invoked directly via `tsx`/`npm run tutor:eval`. This keeps the harness's
   "no live model calls in `npm test`" guarantee (vitest.config.ts's own
   comment) intact while still giving the guard itself real test coverage
   instead of only prose asserting it exists.
   -------------------------------------------------------------------------- */
import { describe, expect, it } from "vitest";
import { modeMismatch } from "./tutor-behavior";

describe("modeMismatch (#89 review, Minor #3)", () => {
  it("is false when the baseline and current run share a mode", () => {
    expect(modeMismatch({ mode: "live" }, { mode: "live" })).toBe(false);
    expect(modeMismatch({ mode: "recorded" }, { mode: "recorded" })).toBe(false);
  });

  it("is true when a live run is diffed against a recorded baseline", () => {
    expect(modeMismatch({ mode: "recorded" }, { mode: "live" })).toBe(true);
  });

  it("is true when a recorded run is diffed against a live baseline", () => {
    expect(modeMismatch({ mode: "live" }, { mode: "recorded" })).toBe(true);
  });
});
