// Runs one command while holding a named lock, so several people or agents sharing this machine do not start memory-heavy commands (tsc, vitest, eslint) at once:
//   node scripts/run-locked.mjs <lockName> -- <command> [args...]
// The lock is a directory under .data/locks. A lock whose owner process is gone is taken over. The command's exit code is passed through.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, ".data", "locks");
const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const name = argv[0];
const command = split >= 0 ? argv.slice(split + 1) : [];
if (!name || !/^[a-z0-9-]+$/.test(name) || command.length === 0) {
  console.error("usage: node scripts/run-locked.mjs <lockName> -- <command> [args...]");
  process.exit(2);
}
fs.mkdirSync(dir, { recursive: true });
const lock = path.join(dir, `${name}.lock`);
const pidFile = path.join(lock, "pid");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

async function acquire() {
  const started = Date.now();
  let announced = false;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(pidFile, String(process.pid));
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let owner = NaN;
    try {
      owner = Number(fs.readFileSync(pidFile, "utf8"));
    } catch {
      /* the owner is still writing its pid, or died between mkdir and write */
    }
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if ((Number.isFinite(owner) && !alive(owner)) || (!Number.isFinite(owner) && age > 30_000)) {
      fs.rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (!announced) {
      console.error(`waiting for the "${name}" lock (held by process ${Number.isFinite(owner) ? owner : "unknown"})...`);
      announced = true;
    }
    if (Date.now() - started > 45 * 60_000) {
      console.error(`gave up waiting for the "${name}" lock after 45 minutes`);
      process.exit(3);
    }
    await sleep(2_000);
  }
}

const release = () => fs.rmSync(lock, { recursive: true, force: true });
await acquire();
process.on("SIGINT", () => {
  release();
  process.exit(130);
});
// One command line through the shell (npx is a .cmd on Windows), with any argument that has a space or a quote wrapped in double quotes.
const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const child = spawn(command.map(quote).join(" "), { stdio: "inherit", shell: true, cwd: root });
child.on("error", (e) => {
  console.error(`could not start the command: ${e.message}`);
  release();
  process.exit(127);
});
child.on("exit", (code, signal) => {
  release();
  process.exit(code ?? (signal ? 1 : 0));
});
