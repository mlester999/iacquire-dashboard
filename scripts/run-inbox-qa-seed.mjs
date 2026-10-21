// Seeds the Unified Inbox browser-QA database (embedded, never hosted) with fictional data: node scripts/run-inbox-qa-seed.mjs
// Stop the QA server first: the embedded database allows one process. Idempotent: it does nothing when the Inbox QA workspace already exists.
// To start over, stop the server and delete .data/crm-qa.
// Writes .data/crm-qa/inbox-credentials.local.json (local passwords, gitignored, never printed) and .data/crm-qa/inbox-seed-summary.json.
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
  console.error(`Something is running on port ${CRM_QA_PORT}. Stop the CRM QA server before seeding: the embedded database allows one process.`);
  process.exit(1);
}

const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "scripts/ui-qa.vitest.config.ts", "scripts/ui-qa-inbox-seed.qa.ts", "--disableConsoleIntercept"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ...CRM_QA_ENV, NODE_ENV: "test", SECRET_STORE: "test-memory" },
});
process.exit(r.status ?? 1);
