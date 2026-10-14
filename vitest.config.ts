import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "tests/support/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: "forks",
    env: {
      NODE_ENV: "test",
      AUTH_PROVIDER: "local",
      SECRET_STORE: "test-memory",
      APP_ENCRYPTION_KEY: "test-only-key-0123456789abcdef0123456789abcdef",
      DATABASE_DRIVER: "pglite-memory",
      ALLOW_INSECURE_HERMES_URLS: "true",
      HERMES_RUN_TIMEOUT_MS: "8000",
      UPLOAD_DIR: ".data/test-uploads",
    },
  },
});
