import { defineConfig } from "vitest/config";
import path from "node:path";

// Runs the synthetic QA seed with the application's own module resolution. It never sets a database: the caller must point it
// at the isolated embedded QA database, and the seed refuses anything else.
export default defineConfig({
  root: path.resolve(import.meta.dirname, ".."),
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "../src"),
      "server-only": path.resolve(import.meta.dirname, "../tests/support/server-only-stub.ts"),
    },
  },
  test: { environment: "node", include: ["scripts/ui-qa-messaging-seed.qa.ts"], pool: "forks", testTimeout: 120000, hookTimeout: 120000 },
});
