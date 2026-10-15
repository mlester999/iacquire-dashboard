// Isolated local QA. No hosted providers, production database, DNS or deployment.
import { spawn } from "node:child_process";
import { SITES_QA_ENV } from "./sites-qa-env.mjs";
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "-p", "3210"], {
  stdio: "inherit",
  env: { ...process.env, ...SITES_QA_ENV, IAQ_DIST_DIR: ".next-studio-premium-qa", PGLITE_DATA_DIR: ".data/studio-premium-qa/database", UPLOAD_DIR: ".data/studio-premium-qa/uploads" },
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
