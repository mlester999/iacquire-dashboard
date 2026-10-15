import { spawn } from "node:child_process";
import { SITES_QA_ENV } from "./sites-qa-env.mjs";
// Separate output and local-only services preserve concurrent dev/image work.
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "build", "--webpack"], {
  stdio: "inherit", env: { ...process.env, ...SITES_QA_ENV, NODE_ENV: "production", IAQ_DIST_DIR: ".next-studio-build-qa", PGLITE_DATA_DIR: ".data/studio-build-qa/database", UPLOAD_DIR: ".data/studio-build-qa/uploads" },
});
child.on("exit", (code) => process.exit(code ?? 0));
