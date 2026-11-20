/** Run with node scripts/workforce-scheduler-http-qa.mjs using a free CRM_QA_PORT. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CRM_QA_DATA_DIR, CRM_QA_ENV, CRM_QA_PORT, CRM_QA_URL, assertIsolated } from "./crm-qa-env.mjs";

const preloadKey = "IAQ_LOCAL_SCHEDULER_SOCKET_GUARD";
const root = path.resolve(import.meta.dirname, "..");
const jobs = ["aiWorkRunQueued", "aiWorkSchedules"];

function blockRemoteSockets() {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const [first, host] = args;
    const options = Array.isArray(first) ? first[0] : first;
    const target = typeof options === "object" && options !== null ? options
      : typeof options === "number" ? { host } : { path: options };
    const hostname = String(target.host ?? "localhost");
    if (!target.path && !["localhost", "127.0.0.1", "::1"].includes(hostname)) {
      process.nextTick(() => this.destroy(new Error("The isolated scheduler QA process blocked a remote socket.")));
      return this;
    }
    return connect.apply(this, args);
  };
}

function childEnvironment(directory, tsconfig) {
  // Do not inherit application credentials or Node preloads from the host.
  const systemKeys = new Set(["APPDATA", "COMSPEC", "LOCALAPPDATA", "PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "WINDIR"]);
  const system = Object.fromEntries(Object.entries(process.env).filter(([key]) => systemKeys.has(key.toUpperCase())));
  const env = {
    ...CRM_QA_ENV,
    CRON_SECRET: `local-scheduler-qa-${randomUUID()}`,
    IAQ_TSCONFIG: path.relative(root, tsconfig).split(path.sep).join("/"),
    PGLITE_DATA_DIR: path.join(directory, "database"),
    UPLOAD_DIR: path.join(directory, "uploads"),
    PAYMONGO_API_BASE: "", PAYMONGO_SECRET_KEY: "", PAYMONGO_WEBHOOK_SECRET: "",
    PAYPAL_API_BASE: "", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_WEBHOOK_ID: "", PAYPAL_MAINTENANCE_PLAN_ID: "",
    SCHEDULER_JOBS_ONLY: jobs.join(","),
    WORKFORCE_SCHEDULES_ENABLED: "true",
    WORKFORCE_TRIGGERS_ENABLED: "false",
    WORKFORCE_HEALTH_PROBE_ENABLED: "false",
    [preloadKey]: "1",
  };
  assertIsolated({ root, env });
  return { ...system, ...env, NODE_OPTIONS: `--import=${import.meta.url}`, CI: "true" };
}

async function waitForFreePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(CRM_QA_PORT, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
}

function openNext(env) {
  const child = spawn(process.execPath, [
    "node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(CRM_QA_PORT),
  ], { cwd: root, env, stdio: ["ignore", "pipe", "inherit"], windowsHide: true, detached: process.platform !== "win32" });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("The isolated Next dev server did not become ready.")), 120_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Next dev exited before readiness (${code}).`)); });
    child.stdout.on("data", (chunk) => {
      const output = chunk.toString();
      process.stdout.write(output);
      if (/Ready in/.test(output)) { clearTimeout(timeout); resolve(); }
    });
  });

  return { child, ready };
}

async function closeNext(child) {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    if (process.platform === "win32") {
      // The CLI forks a Next worker. Stop this run's process tree before reopening its PGlite directory.
      const stopped = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
      if (stopped.status !== 0 && child.exitCode === null) throw new Error("Could not stop the isolated Next dev process tree.");
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
    await Promise.race([exited, delay(12_000, undefined, { ref: false }).then(() => { throw new Error("Next dev is still running."); })]);
  }
  await waitForFreePort();
}

async function withNext(env, run) {
  await waitForFreePort();
  const { child, ready } = openNext(env);
  try {
    await ready;
    return await run();
  } finally {
    await closeNext(child);
  }
}

async function tick(token, expectedJobs) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const response = await fetch(`${CRM_QA_URL}/api/internal/tick`, {
    method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(240_000),
  });
  if (!token) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized." });
    return { status: 401 };
  }
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  if (expectedJobs === "lease") {
    assert.deepEqual(body, { ok: true, skipped: "another scheduler tick is active" });
    return { status: response.status, skipped: body.skipped };
  }
  assert.ok(body.ran, "The tick should have acquired its lease.");
  assert.deepEqual(Object.keys(body.ran).sort(), [...jobs].sort());
  assert.ok(Number.isInteger(body.ran.aiWorkRunQueued));
  assert.equal(body.ran.aiWorkSchedules, expectedJobs);
  return { status: response.status, ...body.ran };
}

function fixture(phase, statePath, env) {
  const result = spawnSync(process.execPath, [
    "--import", "./scripts/hermes-provisioner-acceptance-loader.mjs", "--import", "tsx",
    "scripts/workforce-scheduler-http-fixture.ts", phase, statePath,
  ], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], windowsHide: true, timeout: 90_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Scheduler fixture phase "${phase}" failed.`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

async function main() {
  assert.equal(process.argv.length, 2, "Usage: node scripts/workforce-scheduler-http-qa.mjs");
  const qaRoot = path.resolve(root, CRM_QA_DATA_DIR);
  await mkdir(qaRoot, { recursive: true });
  assert.equal(await realpath(qaRoot), qaRoot);
  const directory = await mkdtemp(path.join(qaRoot, "scheduler-http-"));
  try {
    const tsconfig = path.join(directory, "tsconfig.json");
    await writeFile(tsconfig, JSON.stringify({ extends: path.relative(directory, path.join(root, "tsconfig.json")).split(path.sep).join("/") }));
    const env = childEnvironment(directory, tsconfig);
    const statePath = path.join(directory, "fixture.json");
    fixture("seed", statePath, env);
    assert.deepEqual(fixture("empty", statePath, env), { jobs: 0 });
    const beforeRestart = await withNext(env, async () => {
      const unauthorized = await tick();
      const first = await tick(env.CRON_SECRET, 1);
      const immediate = await tick(env.CRON_SECRET, "lease");
      // The real tick route has a 30-second lease cooldown even after success.
      await delay(31_000);
      const repeated = await tick(env.CRON_SECRET, 0);
      return { unauthorized, first, immediate, repeated };
    });
    const eligibleAt = Date.now() + 31_000;
    const completed = fixture("completed", statePath, env);
    const afterRestart = await withNext(env, async () => {
      await delay(Math.max(0, eligibleAt - Date.now()));
      return tick(env.CRON_SECRET, 0);
    });
    assert.deepEqual(fixture("completed", statePath, env), completed);

    const report = { origin: CRM_QA_URL, checkedAt: new Date().toISOString(), beforeRestart, afterRestart, persistentWork: completed };
    const reportPath = path.join(qaRoot, `${path.basename(directory)}.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.log(`Scheduler HTTP acceptance passed. Evidence written to ${reportPath}`);
  } finally {
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved), qaRoot);
    assert.match(path.basename(resolved), /^scheduler-http-[A-Za-z0-9]+$/);
    await rm(resolved, { recursive: true, force: true });
  }
}

if (process.env[preloadKey] === "1") {
  blockRemoteSockets();
} else {
  await main();
}
