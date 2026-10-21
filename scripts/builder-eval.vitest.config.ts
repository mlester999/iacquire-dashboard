import { defineConfig } from "vitest/config";
import path from "node:path";

// Runs scripts/builder-eval.qa.ts with the application's own module resolution, on an in-memory database. It never loads a .env file: the model
// connection comes only from the EVAL_LLM_* variables that scripts/run-builder-eval.mjs passes.
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
    include: ["scripts/builder-eval.qa.ts"],
    pool: "forks",
    testTimeout: 3 * 60 * 60_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: "test",
      AUTH_PROVIDER: "local",
      SECRET_STORE: "test-memory",
      APP_ENCRYPTION_KEY: "test-only-key-0123456789abcdef0123456789abcdef",
      DATABASE_DRIVER: "pglite-memory",
      UPLOAD_DIR: ".data/test-uploads",
    },
  },
});
