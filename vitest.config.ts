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
    // 30 s is enough for most files, but a few legitimate tests on this development host need longer: one drives a whole e-signature worker pass, one rolls the
    // whole migration chain back in a single transaction, and one renders the automation editor against a fully seeded CRM. Each passes alone; at a 30 s ceiling
    // they failed by timeout only, which reads like a defect in the product. The ceiling is a limit, not a target: a fast test still finishes in milliseconds.
    testTimeout: 120000,
    hookTimeout: 60000,
    pool: "forks",
    // No test may open a connection to another machine (see the file for why).
    setupFiles: [path.resolve(import.meta.dirname, "tests/support/no-network.ts")],
    env: {
      NODE_ENV: "test",
      AUTH_PROVIDER: "local",
      SECRET_STORE: "test-memory",
      APP_ENCRYPTION_KEY: "test-only-key-0123456789abcdef0123456789abcdef",
      DATABASE_DRIVER: "pglite-memory",
      ALLOW_INSECURE_HERMES_URLS: "true",
      HERMES_RUN_TIMEOUT_MS: "8000",
      UPLOAD_DIR: ".data/test-uploads",
      // The per-role tool allowlist enforces by default (src/lib/employee-tool-policy.ts), because it is a security boundary. Most of this suite's Hermes fixtures were
      // written against the older, shared toolset, so the suite runs them in report mode and two suites prove the enforced behaviour explicitly:
      // tests/employee-tool-policy.test.ts (every role against the shared set and against its own) and its provisioning/inventory cases. A suite that wants to
      // exercise enforcement deletes or overrides this variable; `roleToolEnforcement({})` still answers "enforce" for an unset variable, which a unit test pins.
      WORKFORCE_ROLE_TOOL_ENFORCEMENT: "report",
    },
  },
});
