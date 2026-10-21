// Starts the application for isolated local browser QA of Automation Studio on AUTOMATION_QA_URL (default http://127.0.0.1:3262), together with the labelled
// stand-in for the AI model (scripts/mock-automation-llm.mjs) on the loopback address. Embedded database, local sign-in, its own build directory
// (.next-automation-qa); every variable is the Native CRM QA one (scripts/crm-qa-env.mjs) apart from the few scripts/automation-qa-env.mjs lists.
//   node scripts/run-automation-qa-seed.mjs      (once, with this stopped)
//   node scripts/automation-qa.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { AUTOMATION_QA_ENV, AUTOMATION_QA_PORT, assertAutomationQaIsolated } from "./automation-qa-env.mjs";

const root = path.resolve(import.meta.dirname, "..");
try {
  assertAutomationQaIsolated({ root });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const nodeOptions = String(process.env.NODE_OPTIONS ?? "").trim();
const qaNodeOptions = /--max[-_]old[-_]space[-_]size/.test(nodeOptions) ? nodeOptions : [nodeOptions, "--max-old-space-size=8192"].filter(Boolean).join(" ");
const env = { ...process.env, ...AUTOMATION_QA_ENV, NODE_OPTIONS: qaNodeOptions };

const llm = spawn(process.execPath, [path.join("scripts", "mock-automation-llm.mjs")], { cwd: root, stdio: "inherit", env });
const next = spawn(process.execPath, [path.join("node_modules", "next", "dist", "bin", "next"), "dev", "--webpack", "--hostname", "127.0.0.1", "-p", String(AUTOMATION_QA_PORT)], { cwd: root, stdio: "inherit", env });
const stop = () => { llm.kill(); next.kill(); };
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stop(); process.exit(0); });
next.once("exit", (code) => { llm.kill(); process.exit(code ?? 0); });
llm.once("exit", (code) => { if (code) { console.error("[automation-qa] The model stand-in stopped."); next.kill(); process.exit(code); } });
