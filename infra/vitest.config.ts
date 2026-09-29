import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Shell/workflow integration tests in scripts use Node's native runner.
    include: ["src/**/*.test.ts"],
  },
});
