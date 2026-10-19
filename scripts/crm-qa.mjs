// Starts the application for isolated local browser QA of the Native CRM on CRM_QA_URL (default http://127.0.0.1:3230): embedded database, local sign-in,
// its own build directory (.next-crm-qa), and every variable pinned by scripts/crm-qa-env.mjs so nothing is read from the hosted .env.
//   node scripts/crm-qa.mjs   (or the "crm-qa" entry in .claude/launch.json)
// Seed it first, with this server stopped (the embedded database allows one process): node scripts/run-crm-qa-seed.mjs
// The local synthetic auth guard deliberately refuses production mode, so browser QA runs in the isolated dev server.
// Next telemetry is off. See scripts/crm-qa-env.mjs for the permitted build-time network requests.
import { spawn, spawnSync } from "node:child_process";
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
const maxRestarts = 20;
const nextServerPath = path.join(root, "node_modules", "next", "dist", "server", "lib", "start-server.js");
const serverLockPath = path.join(root, CRM_QA_DATA_DIR, "server.lock");
let serverLock = { supervisorPid: process.pid, nextPid: null };
let ownsServerLock = false;
let restartCount = 0;
let stopping = false;
let next = null;
let restartTimer = null;

function readServerLock() {
  try {
    const parsed = JSON.parse(fs.readFileSync(serverLockPath, "utf8"));
    const supervisorPid = Number(parsed.supervisorPid);
    const nextPid = Number(parsed.nextPid);
    if (!Number.isSafeInteger(supervisorPid) || supervisorPid < 1) return null;
    return { supervisorPid, nextPid: Number.isSafeInteger(nextPid) && nextPid > 0 ? nextPid : null };
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Next 16 forks its dev server. On Windows, a parent restart can leave that child holding the QA port. */
function clearOrphanedWindowsQaServer(expectedParentPid) {
  if (process.platform !== "win32") return true;
  if (!Number.isSafeInteger(Number(expectedParentPid)) || Number(expectedParentPid) < 1) return true;
  const probe = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "$connection = Get-NetTCPConnection -State Listen -LocalPort $env:CRM_QA_PORT -ErrorAction SilentlyContinue | Select-Object -First 1; " +
      "if (-not $connection) { exit 0 }; " +
      "$owner = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $connection.OwningProcess); " +
      "if ($owner -and $owner.ParentProcessId -eq [int]$env:CRM_QA_NEXT_PID -and $owner.CommandLine -and $owner.CommandLine.IndexOf($env:CRM_QA_NEXT_SERVER_PATH, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $owner.CommandLine.IndexOf($env:CRM_QA_ROOT, [StringComparison]::OrdinalIgnoreCase) -ge 0) { [Console]::Write($owner.ProcessId); exit 0 }; " +
      "exit 3",
  ], {
    encoding: "utf8",
    timeout: 8_000,
    windowsHide: true,
    env: { ...env, CRM_QA_ROOT: root, CRM_QA_NEXT_SERVER_PATH: nextServerPath, CRM_QA_NEXT_PID: String(expectedParentPid) },
  });
  if (probe.status !== 0) {
    console.error(`[crm-qa] Port ${CRM_QA_PORT} is held by a process that is not the isolated Next QA server; refusing to terminate it.`);
    return false;
  }
  const pid = String(probe.stdout ?? "").trim();
  if (!pid) return true;
  if (!/^\d+$/.test(pid)) {
    console.error(`[crm-qa] Could not identify the isolated Next QA server process holding port ${CRM_QA_PORT}.`);
    return false;
  }
  const killed = spawnSync("taskkill.exe", ["/PID", pid, "/T", "/F"], {
    encoding: "utf8",
    timeout: 8_000,
    windowsHide: true,
    stdio: "ignore",
  });
  if (killed.status !== 0) {
    console.error(`[crm-qa] Could not stop orphaned isolated Next server process ${pid}.`);
    return false;
  }
  console.error(`[crm-qa] Stopped orphaned isolated Next server process ${pid} before restart.`);
  return true;
}

function writeServerLock() {
  if (!ownsServerLock) return;
  fs.writeFileSync(serverLockPath, JSON.stringify(serverLock), "utf8");
}

function acquireServerLock() {
  fs.mkdirSync(path.dirname(serverLockPath), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(serverLockPath, JSON.stringify(serverLock), { flag: "wx" });
      ownsServerLock = true;
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const existing = readServerLock();
    if (!existing) {
      console.error(`[crm-qa] The QA server lock at ${CRM_QA_DATA_DIR}/server.lock is unreadable; refusing to start a second server.`);
      return false;
    }
    if (isProcessRunning(existing.supervisorPid)) {
      console.error(`[crm-qa] Another isolated QA server is already running (supervisor ${existing.supervisorPid}).`);
      return false;
    }
    if (existing.nextPid && !clearOrphanedWindowsQaServer(existing.nextPid)) return false;
    try {
      fs.unlinkSync(serverLockPath);
    } catch (unlinkError) {
      if (unlinkError?.code !== "ENOENT") throw unlinkError;
    }
  }
  console.error("[crm-qa] Could not acquire the isolated QA server lock.");
  return false;
}

function releaseServerLock() {
  if (!ownsServerLock) return;
  clearOrphanedWindowsQaServer(serverLock.nextPid);
  const existing = readServerLock();
  if (existing?.supervisorPid !== process.pid) return;
  try {
    fs.unlinkSync(serverLockPath);
  } catch {
    // A missing lock at process exit is already clean.
  }
}

if (!acquireServerLock()) process.exit(1);
process.once("exit", releaseServerLock);

function restartNext(reason, code = null, signal = null) {
  if (stopping) {
    process.exit(0);
    return;
  }
  if (restartCount >= maxRestarts) {
    console.error(`[crm-qa] Isolated Next server stopped after ${restartCount} restarts (${reason}).`);
    process.exit(typeof code === "number" && code !== 0 ? code : 1);
    return;
  }
  restartCount += 1;
  const delay = Math.min(restartCount * 1_000, 5_000);
  const status = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
  console.error(`[crm-qa] Isolated Next server ended (${status}: ${reason}); restarting in ${delay} ms (${restartCount}/${maxRestarts}).`);
  restartTimer = setTimeout(startNext, delay);
}

function startNext() {
  if (stopping) return;
  restartTimer = null;
  if (restartCount > 0 && !clearOrphanedWindowsQaServer(serverLock.nextPid)) process.exit(1);
  let child;
  try {
    child = spawn(process.execPath, [
      cli, "dev", "--webpack",
      "--hostname", "127.0.0.1", "-p", String(CRM_QA_PORT),
    ], {
      cwd: root,
      stdio: "inherit",
      env,
    });
  } catch (error) {
    restartNext(error instanceof Error ? error.message : String(error));
    return;
  }
  next = child;
  serverLock.nextPid = child.pid ?? null;
  writeServerLock();
  let handled = false;
  child.once("error", (error) => {
    if (handled) return;
    handled = true;
    if (next === child) next = null;
    serverLock.nextPid = null;
    writeServerLock();
    restartNext(error instanceof Error ? error.message : String(error));
  });
  child.once("exit", (code, signal) => {
    if (handled) return;
    handled = true;
    if (next === child) next = null;
    serverLock.nextPid = child.pid ?? serverLock.nextPid;
    writeServerLock();
    if (stopping || (code === 0 && !signal)) {
      if (stopping) clearOrphanedWindowsQaServer(serverLock.nextPid);
      process.exit(0);
      return;
    }
    restartNext("Next dev worker exited unexpectedly", code, signal);
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (next && !next.killed) next.kill(sig);
    else process.exit(0);
  });
}

startNext();
