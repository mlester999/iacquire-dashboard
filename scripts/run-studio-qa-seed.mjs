// Stop the Studio QA server before running: PGLite uses a single process.
import { spawnSync } from "node:child_process";
import { SITES_QA_ENV } from "./sites-qa-env.mjs";

const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "scripts/studio-qa.vitest.config.ts"], {
  stdio: "inherit",
  env: { ...process.env, ...SITES_QA_ENV, NODE_ENV: "test", SECRET_STORE: "test-memory", IAQ_DIST_DIR: ".next-studio-premium-qa", PGLITE_DATA_DIR: ".data/studio-premium-qa/database", UPLOAD_DIR: ".data/studio-premium-qa/uploads" },
});
process.exit(result.status ?? 1);
