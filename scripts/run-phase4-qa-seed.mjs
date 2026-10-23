// Seeds the Phase 4 browser-QA data (social media) on top of the Unified Inbox QA workspace: node scripts/run-phase4-qa-seed.mjs
// Run node scripts/run-inbox-qa-seed.mjs first, and stop the QA server before either: the embedded database allows one process.
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

const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "scripts/ui-qa.vitest.config.ts", "scripts/ui-qa-phase4-seed.qa.ts", "--disableConsoleIntercept"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ...CRM_QA_ENV, NODE_ENV: "test", SECRET_STORE: "test-memory" },
});
process.exit(r.status ?? 1);
