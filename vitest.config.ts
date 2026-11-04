import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: ["test/helpers/global-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/scripts/**", "src/cli.ts"],
      reporter: ["text-summary", "lcov"],
      // Enforced in CI (npm run test:coverage). Raise these, never lower them.
      thresholds: { lines: 90, statements: 88, functions: 88, branches: 75 },
    },
  },
});
