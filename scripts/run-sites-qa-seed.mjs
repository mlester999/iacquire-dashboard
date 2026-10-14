// Seeds the website QA database (embedded, never hosted). Stop the QA server first: the embedded database allows one process.
import { spawnSync } from "node:child_process";
import { SITES_QA_ENV } from "./sites-qa-env.mjs";

const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "scripts/ui-qa.vitest.config.ts", "scripts/ui-qa-sites-seed.qa.ts"], {
  stdio: "inherit",
  env: { ...process.env, ...SITES_QA_ENV, NODE_ENV: "test", SECRET_STORE: "test-memory" },
});
process.exit(r.status ?? 1);
