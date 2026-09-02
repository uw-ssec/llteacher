import { defineConfig } from "vitest/config";

// Fixture-only: scoring/*.test.ts and datasets/pii-scan.test.ts. No live
// model calls anywhere in this suite -- see README.md's "what runs where"
// section. tutor-behavior.ts (the live/recorded harness) is a script, not
// a test, and is never imported from here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
  },
});
