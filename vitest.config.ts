import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

// tests/perf seeds tens of thousands of rows and takes minutes; it runs only when asked for (CRM_PERF=1 npx vitest run tests/perf).
const perf = process.env.CRM_PERF === "1";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "tests/support/server-only-stub.ts"),
      "next/font/google": path.resolve(import.meta.dirname, "tests/support/next-font-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Temporary tests may contain one-off environment-specific diagnostics. Keep them out of the
    // normal suite so `npm test` cannot unexpectedly execute them.
    exclude: perf
      ? [...configDefaults.exclude, "tests/**/*.tmp.test.ts"]
      : [...configDefaults.exclude, "tests/perf/**", "tests/**/*.tmp.test.ts"],
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
