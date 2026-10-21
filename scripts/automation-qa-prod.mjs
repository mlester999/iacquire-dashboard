// Serves the PRODUCTION build of the application (next build output, minified bundles, no hot reload) on the isolated QA address, with the same labelled stand-in for
// the AI model, so the browser run can look at what a production bundle does. Build it first, then run this and, in another terminal, the browser scripts:
//   node scripts/build-clean.mjs            (writes .next-clean-build)
//   node scripts/automation-qa-prod.mjs
//   node scripts/automation-browser-qa-c.mjs
//
// What this does and does not prove. The application refuses to start with NODE_ENV=production unless it has Supabase sign-in, a hosted Postgres address and an
// encryption key (src/server/env.ts), none of which exist in this sandbox, so the server itself runs with NODE_ENV=test: the pages, the client bundles (compiled
// for production by `next build`), the routing, the proxy and the CSP are the production ones, but the application's own production-only guards (Supabase sign-in,
// the model address policy, the database and encryption checks) are NOT exercised by this run. They are covered by unit tests with NODE_ENV forced to production.
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
const env = { ...process.env, ...AUTOMATION_QA_ENV, NODE_ENV: "test", IAQ_DIST_DIR: ".next-clean-build", SECRET_STORE: "test-memory" };
const llm = spawn(process.execPath, [path.join("scripts", "mock-automation-llm.mjs")], { cwd: root, stdio: "inherit", env });
const next = spawn(process.execPath, [path.join("node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "-p", String(AUTOMATION_QA_PORT)], { cwd: root, stdio: "inherit", env });
const stop = () => { llm.kill(); next.kill(); };
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stop(); process.exit(0); });
next.once("exit", (code) => { llm.kill(); process.exit(code ?? 0); });
llm.once("exit", (code) => { if (code) { console.error("[automation-qa-prod] The model stand-in stopped."); next.kill(); process.exit(code); } });
