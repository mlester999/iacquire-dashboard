import { defineConfig } from "vitest/config";
import path from "node:path";

// Runs the Automation Studio QA seed with the application's own module resolution. The caller points it at the isolated embedded QA database
// (scripts/run-automation-qa-seed.mjs does), and the seed refuses anything else.
export default defineConfig({
  root: path.resolve(import.meta.dirname, ".."),
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "../src"),
      "server-only": path.resolve(import.meta.dirname, "../tests/support/server-only-stub.ts"),
    },
  },
  test: { environment: "node", include: ["scripts/ui-qa-automation-seed.qa.ts"], pool: "forks", testTimeout: 120000, hookTimeout: 120000 },
});
