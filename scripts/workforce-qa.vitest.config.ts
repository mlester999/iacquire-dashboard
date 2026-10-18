import { defineConfig } from "vitest/config";
import path from "node:path";

// Runs the workforce browser-QA seed against the isolated embedded CRM QA database. The caller must stop the QA server
// first (the embedded database allows one process) and points PGLITE_DATA_DIR at .data/crm-qa/database.
export default defineConfig({
  root: path.resolve(import.meta.dirname, ".."),
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "../src"),
      "server-only": path.resolve(import.meta.dirname, "../tests/support/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["scripts/workforce-qa-seed.qa.ts"],
    pool: "forks",
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
