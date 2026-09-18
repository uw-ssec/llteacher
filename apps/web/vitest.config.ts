import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
    // #303: teardown used to be hand-rolled per file (every App.test.tsx
    // test that called vi.stubGlobal had no matching unstub, relying on
    // the next test's own vi.stubGlobal call to clobber it). unstubGlobals
    // restores every vi.stubGlobal'd global after each test; restoreMocks
    // restores every vi.fn()/vi.spyOn() mock's original implementation and
    // clears its call history, so a leftover spy from one test (e.g. the
    // Element.prototype.scrollIntoView spy) can't leak into the next.
    unstubGlobals: true,
    restoreMocks: true,
  },
});
