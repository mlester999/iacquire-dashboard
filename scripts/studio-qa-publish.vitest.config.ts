import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  root: path.resolve(import.meta.dirname, ".."),
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "../src"), "server-only": path.resolve(import.meta.dirname, "../tests/support/server-only-stub.ts") } },
  test: { environment: "node", include: ["scripts/studio-qa-publish.qa.ts"], pool: "forks", testTimeout: 180000, hookTimeout: 180000 },
});
