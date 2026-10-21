// Prepares the isolated Automation Studio QA database: node scripts/run-automation-qa-seed.mjs
// First run: copies the Native CRM QA database (fictional workspaces, .data/crm-qa) into .data/automation-qa and its credentials file with the QA address
// swapped in; later runs reuse what is there. Then gives Brightside Roofing (QA) an active plan (scripts/ui-qa-automation-seed.qa.ts).
// Stop the QA server first (the embedded database allows one process). To start over, stop it and delete .data/automation-qa.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { CRM_QA_DATA_DIR, CRM_QA_PORT } from "./crm-qa-env.mjs";
import { AUTOMATION_QA_DATA_DIR, AUTOMATION_QA_ENV, AUTOMATION_QA_PORT, AUTOMATION_QA_URL, assertAutomationQaIsolated } from "./automation-qa-env.mjs";

const root = path.resolve(import.meta.dirname, "..");
try {
  assertAutomationQaIsolated({ root });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const busy = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(800, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
if (await busy(AUTOMATION_QA_PORT)) {
  console.error(`Something is running on port ${AUTOMATION_QA_PORT}. Stop the Automation Studio QA server first: the embedded database allows one process.`);
  process.exit(1);
}
const target = path.join(root, AUTOMATION_QA_DATA_DIR);
const source = path.join(root, CRM_QA_DATA_DIR);
if (!fs.existsSync(path.join(target, "database"))) {
  if (!fs.existsSync(path.join(source, "database")) || !fs.existsSync(path.join(source, "credentials.local.json"))) {
    console.error("The Native CRM QA database isn't seeded. Run node scripts/run-crm-qa-seed.mjs first.");
    process.exit(1);
  }
  if (await busy(CRM_QA_PORT)) {
    console.error(`The Native CRM QA server is running on port ${CRM_QA_PORT}; stop it so its database can be copied safely.`);
    process.exit(1);
  }
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(path.join(source, "database"), path.join(target, "database"), { recursive: true });
  const creds = JSON.parse(fs.readFileSync(path.join(source, "credentials.local.json"), "utf8"));
  creds.baseUrl = AUTOMATION_QA_URL;
  creds.note = "Local QA passwords for the isolated Automation Studio QA database only (.data/automation-qa), copied from the Native CRM QA seed. Fictional accounts. Gitignored; never commit or share.";
  fs.writeFileSync(path.join(target, "credentials.local.json"), JSON.stringify(creds, null, 2));
  console.log(`Copied the Native CRM QA database to ${AUTOMATION_QA_DATA_DIR}.`);
}
const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "scripts/automation-qa.vitest.config.ts", "--disableConsoleIntercept"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ...AUTOMATION_QA_ENV, NODE_ENV: "test", SECRET_STORE: "test-memory" },
});
process.exit(r.status ?? 1);
