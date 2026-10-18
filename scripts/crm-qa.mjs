// Starts the application for isolated local browser QA of the Native CRM on CRM_QA_URL (default http://127.0.0.1:3230): embedded database, local sign-in,
// its own build directory (.next-crm-qa), and every variable pinned by scripts/crm-qa-env.mjs so nothing is read from the hosted .env.
//   node scripts/crm-qa.mjs   (or the "crm-qa" entry in .claude/launch.json)
// Seed it first, with this server stopped (the embedded database allows one process): node scripts/run-crm-qa-seed.mjs
// The local synthetic auth guard deliberately refuses production mode, so browser QA runs in the isolated dev server.
// Next telemetry is off. See scripts/crm-qa-env.mjs for the permitted build-time network requests.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CRM_QA_DATA_DIR, CRM_QA_ENV, CRM_QA_PORT, assertIsolated } from "./crm-qa-env.mjs";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (args.length) {
  console.error("Usage: node scripts/crm-qa.mjs");
  process.exit(1);
}
const qaEnv = CRM_QA_ENV;
const nodeOptions = String(process.env.NODE_OPTIONS ?? "").trim();
const maxOldSpaceSizeSet = /(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s)/.test(nodeOptions);
const qaNodeOptions = maxOldSpaceSizeSet ? nodeOptions : [nodeOptions, "--max-old-space-size=8192"].filter(Boolean).join(" ");
try {
  assertIsolated({ root, env: qaEnv });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
if (!fs.existsSync(path.join(root, CRM_QA_DATA_DIR, "seed-summary.json"))) {
  console.warn(`[crm-qa] ${CRM_QA_DATA_DIR} has no seed yet; the app starts on an empty database. Stop it and run node scripts/run-crm-qa-seed.mjs first.`);
}

const env = { ...process.env, ...qaEnv, NODE_OPTIONS: qaNodeOptions };
const cli = path.join("node_modules", "next", "dist", "bin", "next");
const next = spawn(process.execPath, [
  cli, "dev", "--webpack",
  "--hostname", "127.0.0.1", "-p", String(CRM_QA_PORT),
], {
  cwd: root,
  stdio: "inherit",
  env,
});
next.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => next.kill(sig));
