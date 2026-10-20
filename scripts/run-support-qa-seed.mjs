// Seeds the Support & Requests browser-QA data (embedded database, never hosted): node scripts/run-support-qa-seed.mjs
// Stop the QA server first: the embedded database allows one process. Idempotent. It writes .data/crm-qa/support-credentials.local.json (gitignored).
import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { CRM_QA_ENV, CRM_QA_PORT, assertIsolated } from "./crm-qa-env.mjs";

const root = path.resolve(import.meta.dirname, "..");
try {
  assertIsolated({ root });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

/** True when something answers on the QA port (the server would hold the embedded database open). */
const portInUse = (host) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port: CRM_QA_PORT });
    const done = (v) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(800, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
if ((await portInUse("127.0.0.1")) || (await portInUse("::1"))) {
  console.error(`Something is running on port ${CRM_QA_PORT}. Stop the QA server before seeding: the embedded database allows one process.`);
  process.exit(1);
}

const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "scripts/ui-qa.vitest.config.ts", "scripts/ui-qa-support-seed.qa.ts", "--disableConsoleIntercept"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ...CRM_QA_ENV, NODE_ENV: "test", SECRET_STORE: "test-memory" },
});
process.exit(r.status ?? 1);
