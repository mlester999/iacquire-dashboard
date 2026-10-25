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
  test: { environment: "node", include: ["scripts/ui-qa-messaging-seed.qa.ts", "scripts/ui-qa-sites-seed.qa.ts", "scripts/ui-qa-crm-seed.qa.ts", "scripts/ui-qa-inbox-seed.qa.ts", "scripts/ui-qa-phase2-seed.qa.ts", "scripts/ui-qa-phase3-seed.qa.ts", "scripts/ui-qa-phase4-seed.qa.ts", "scripts/ui-qa-proposals-seed.qa.ts", "scripts/ui-qa-invoices-seed.qa.ts", "scripts/ui-qa-demo-seed.qa.ts", "scripts/ui-qa-checkout-seed.qa.ts","scripts/ui-qa-support-seed.qa.ts", "scripts/ui-qa-ops-seed.qa.ts", "scripts/ui-qa-reputation-seed.qa.ts"], pool: "forks", testTimeout: 120000, hookTimeout: 120000 },
});
