// Evaluates the AI Automation Builder against a real model: node scripts/run-builder-eval.mjs [--only <id>[,<id>]] [--repeat N] [--env-file <path>]
// The model connection is read from EVAL_LLM_BASE_URL / EVAL_LLM_API_KEY / EVAL_LLM_MODEL, or (with --env-file) from the LLM_BASE_URL, LLM_API_KEY and LLM_MODEL
// lines of that file ONLY: no other line of it is read or passed on, so a database address in the same file can never reach this run. The database is
// in memory. The key is never printed.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(DATABASE_|SUPABASE_|NEXT_PUBLIC_SUPABASE)/.test(k)) delete env[k];
const file = arg("--env-file");
if (file) {
  const wanted = { LLM_BASE_URL: "EVAL_LLM_BASE_URL", LLM_API_KEY: "EVAL_LLM_API_KEY", LLM_MODEL: "EVAL_LLM_MODEL" };
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^(LLM_BASE_URL|LLM_API_KEY|LLM_MODEL)=(.*)$/.exec(line);
    if (m) env[wanted[m[1]]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
for (const k of ["EVAL_LLM_BASE_URL", "EVAL_LLM_API_KEY", "EVAL_LLM_MODEL"]) {
  if (!env[k]) { console.error(`${k} is not set.`); process.exit(1); }
}
if (arg("--only")) env.EVAL_ONLY = arg("--only");
if (arg("--repeat")) env.EVAL_REPEAT = arg("--repeat");
console.log(`Evaluating ${env.EVAL_LLM_MODEL} at ${new URL(env.EVAL_LLM_BASE_URL).host} (in-memory database; the key is not printed).`);
const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "scripts/builder-eval.vitest.config.ts", "--disableConsoleIntercept"], { cwd: root, stdio: "inherit", env });
process.exit(r.status ?? 1);
