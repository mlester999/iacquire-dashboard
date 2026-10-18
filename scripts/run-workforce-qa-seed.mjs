// Adds synthetic workforce rows to the isolated CRM QA database for browser QA. Stop the QA server first (the embedded
// database allows one process), run the CRM QA seed if the database is empty, then run this and start the QA server.
import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { CRM_QA_ENV, CRM_QA_PORT } from "./crm-qa-env.mjs";

const root = path.resolve(import.meta.dirname, "..");
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
  console.error(`Something is running on port ${CRM_QA_PORT}. Stop the QA server before seeding.`);
  process.exit(1);
}
const r = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "--config", "scripts/workforce-qa.vitest.config.ts", "--disableConsoleIntercept"],
  { cwd: root, stdio: "inherit", env: { ...process.env, ...CRM_QA_ENV, NODE_ENV: "test", SECRET_STORE: "test-memory" } },
);
process.exit(r.status ?? 1);
