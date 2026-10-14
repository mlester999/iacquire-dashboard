// Starts the application for local website QA on http://localhost:3210 with the embedded database.
//   node scripts/sites-qa.mjs
// Customer sites answer on any other host name, for example http://brightside.sites.localhost:3210
import { spawn } from "node:child_process";
import { SITES_QA_ENV } from "./sites-qa-env.mjs";

const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", "3210"], { stdio: "inherit", env: { ...process.env, ...SITES_QA_ENV } });
next.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => next.kill(sig));
