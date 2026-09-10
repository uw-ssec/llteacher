import { defineConfig } from "vitest/config";

// Fixture-only: scoring/*.test.ts, datasets/pii-scan.test.ts, and
// tutor-behavior.test.ts. No live model calls anywhere in this suite -- see
// README.md's "what runs where" section. tutor-behavior.test.ts imports
// only `modeMismatch`, a pure function with no I/O -- tutor-behavior.ts's
// `main()` (the live/recorded CLI harness) stays behind its own `isMain`
// guard and is never invoked by that import, so this doesn't pull a live
// model call into `npm test`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
  },
});
