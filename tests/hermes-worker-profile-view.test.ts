import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// O2: the six inference workers must see exactly SOUL.md, config.yaml and the DeepSeek settings of their own employee,
// never the rest of a live Hermes profile (state.db, sessions, memories, backups, every other secret in .env and, once
// business tools are on, the employee's business MCP credential). scripts/hermes-worker-profile-view.sh builds and
// verifies that view. These tests run it on synthetic profiles with planted secrets. One baseline view is built once and
// copied for each test, because every script run costs real time on Windows.

const root = resolve(__dirname, "..");
const scriptPath = join(root, "scripts/hermes-worker-profile-view.sh");
const script = readFileSync(scriptPath, "utf8");
const compose = readFileSync(join(root, "services/hermes-inference-worker/compose.internal.yaml"), "utf8");
const workerDir = join(root, "services/hermes-inference-worker");

const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
const pythonCommand = process.platform === "win32" ? "python" : "python3";
const hasPython = spawnSync(pythonCommand, ["-c", "import sys"]).status === 0;
const posixOs = process.platform !== "win32";
const posix = (p: string) => p.replace(/\\/g, "/");

const PROFILES = [
  "iacquire-operations-manager", "iacquire-lead-hunter", "iacquire-appointment-setter",
  "iacquire-sales-assistant", "iacquire-crm-manager", "iacquire-analyst",
];
const WORKER_ROLES: Record<string, string> = {
  "operations-manager": "iacquire-operations-manager", "lead-hunter": "iacquire-lead-hunter", "appointment-setter": "iacquire-appointment-setter",
  "sales-assistant": "iacquire-sales-assistant", "crm-manager": "iacquire-crm-manager", "performance-analyst": "iacquire-analyst",
};

const planted = (profile: string) => ({
  api: `planted-api-server-key-${profile}-0001`,
  slack: `xoxb-planted-slack-${profile}-0002`,
  mcp: `iamcp1.planted-credential.${profile}.0003`,
  deepseek: `sk-synthetic-deepseek-${profile}-0004`,
  history: `planted-conversation-text-${profile}-0005`,
  backup: `planted-old-backup-secret-${profile}-0006`,
});
const allPlanted = () => PROFILES.flatMap((profile) => Object.values(planted(profile)));

const workDirs: string[] = [];
function makeWritable(path: string) {
  try {
    const info = statSync(path);
    chmodSync(path, info.isDirectory() ? 0o700 : 0o600);
    if (info.isDirectory()) for (const entry of readdirSync(path)) makeWritable(join(path, entry));
  } catch { /* already gone */ }
}
afterAll(() => {
  for (const dir of workDirs) {
    makeWritable(dir);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const CONFIG = [
  "model:", "  provider: deepseek", "  default: deepseek-flash",
  // What a live profile looks like once business tools are on: an MCP entry that refers to the credential by name only.
  "mcp_servers:", "  iacquire_business:", "    url: https://example.invalid/api/internal/hermes-business/mcp",
  "    headers:", '      Authorization: "Bearer ${IACQUIRE_BUSINESS_MCP_TOKEN}"', "",
].join("\n");

function liveEnv(profile: string): string {
  const p = planted(profile);
  return [
    `API_SERVER_KEY=${p.api}`, `SLACK_BOT_TOKEN=${p.slack}`, `IACQUIRE_BUSINESS_MCP_TOKEN=${p.mcp}`,
    `export DEEPSEEK_API_KEY="${p.deepseek}"`, "DEEPSEEK_BASE_URL=https://api.deepseek.com", "DEEPSEEK_API_KEY_ALT=not-the-key-0007", "",
  ].join("\n");
}

function makeLive(live: string) {
  for (const profile of PROFILES) {
    const dir = join(live, profile);
    mkdirSync(join(dir, "sessions"), { recursive: true });
    mkdirSync(join(dir, "memories"), { recursive: true });
    const p = planted(profile);
    writeFileSync(join(dir, "SOUL.md"), `Synthetic SOUL for ${profile}\n`);
    writeFileSync(join(dir, "config.yaml"), CONFIG);
    writeFileSync(join(dir, ".env"), liveEnv(profile));
    writeFileSync(join(dir, "state.db"), `sqlite-bytes ${p.history}`);
    writeFileSync(join(dir, "sessions", "s1.json"), JSON.stringify({ text: p.history }));
    writeFileSync(join(dir, "memories", "m1.md"), `remember ${p.history}`);
    writeFileSync(join(dir, ".env.backup-20261010"), `OLD=${p.backup}\n`);
  }
}

function run(mode: string, live: string, view: string, extra: string[] = [], env: Record<string, string | undefined> = {}) {
  const result = spawnSync("bash", [posix(scriptPath), mode, "--live", posix(live), "--view", posix(view), ...extra], {
    encoding: "utf8", env: { ...process.env, ...env }, timeout: 150_000,
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function snapshot(dir: string, base = dir): Record<string, string> {
  const found: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    const key = posix(full.slice(base.length));
    if (info.isDirectory()) Object.assign(found, snapshot(full, base));
    else found[key] = createHash("sha256").update(readFileSync(full)).digest("hex");
  }
  return found;
}

const names = (dir: string) => readdirSync(dir).sort();
const viewText = (view: string) => PROFILES.flatMap((profile) => names(join(view, profile)).map((file) => readFileSync(join(view, profile, file), "utf8"))).join("\n");

// ---- the baseline: live profiles with planted secrets, synced once ------------------------------------------------------------
let baselineDir = "";
let baselineRun = { status: null as number | null, out: "" };
let liveBefore: Record<string, string> = {};

beforeAll(() => {
  if (!hasBash) return;
  baselineDir = mkdtempSync(join(tmpdir(), "worker-view-base-"));
  workDirs.push(baselineDir);
  makeLive(join(baselineDir, "live"));
  liveBefore = snapshot(join(baselineDir, "live"));
  baselineRun = run("sync", join(baselineDir, "live"), join(baselineDir, "view"));
  makeWritable(baselineDir); // the copies below must be writable by the test; modes are tested on their own run
}, 240_000);

/** A fresh, writable copy of the baseline (live profiles plus a synced view). */
function built() {
  const dir = mkdtempSync(join(tmpdir(), "worker-view-"));
  workDirs.push(dir);
  cpSync(baselineDir, dir, { recursive: true });
  makeWritable(dir);
  return { dir, live: join(dir, "live"), view: join(dir, "view") };
}

/** Live profiles only, no view yet. */
function liveOnly() {
  const dir = mkdtempSync(join(tmpdir(), "worker-view-live-"));
  workDirs.push(dir);
  makeLive(join(dir, "live"));
  return { dir, live: join(dir, "live"), view: join(dir, "view") };
}

describe.skipIf(!hasBash)("worker profile view: build", () => {
  it("passes bash -n", () => {
    expect(spawnSync("bash", ["-n", scriptPath]).status).toBe(0);
  });

  it("gives each worker exactly SOUL.md, config.yaml and a DeepSeek-only .env of its own employee", () => {
    const live = join(baselineDir, "live");
    const view = join(baselineDir, "view");
    expect(baselineRun.out).toContain("RESULT: PASS");
    expect(baselineRun.status).toBe(0);
    expect(names(view)).toEqual([...PROFILES].sort());
    for (const profile of PROFILES) {
      expect(names(join(view, profile))).toEqual([".env", "SOUL.md", "config.yaml"].sort());
      expect(readFileSync(join(view, profile, "SOUL.md"))).toEqual(readFileSync(join(live, profile, "SOUL.md")));
      expect(readFileSync(join(view, profile, "config.yaml"))).toEqual(readFileSync(join(live, profile, "config.yaml")));
      expect(readFileSync(join(view, profile, ".env"), "utf8")).toBe(`DEEPSEEK_API_KEY=${planted(profile).deepseek}\nDEEPSEEK_BASE_URL=https://api.deepseek.com\n`);
    }
  });

  it("copies no other secret, session, memory, database or backup, and prints none", () => {
    const everything = viewText(join(baselineDir, "view"));
    // The DeepSeek key is the one secret a worker is meant to have, so it is the only planted value allowed in the view; no planted value may appear in what the script prints.
    const notForTheView = PROFILES.flatMap((profile) => { const { deepseek: _allowed, ...others } = planted(profile); return Object.values(others); });
    for (const secret of notForTheView) expect(everything).not.toContain(secret);
    for (const secret of allPlanted()) expect(baselineRun.out).not.toContain(secret);
    for (const profile of PROFILES) expect(everything).toContain(planted(profile).deepseek);
    // The business credential stays out too, even though the config that refers to it by name is copied unchanged.
    expect(everything).not.toMatch(/iamcp1\./);
    expect(everything).toContain("${IACQUIRE_BUSINESS_MCP_TOKEN}");
    expect(everything).not.toContain("DEEPSEEK_API_KEY_ALT");
  });

  it("never changes anything in the live profiles", () => {
    expect(snapshot(join(baselineDir, "live"))).toEqual(liveBefore);
    const { live, view } = built();
    const before = snapshot(live);
    run("check", live, view);
    expect(snapshot(live)).toEqual(before);
  }, 120_000);

  it("is repeatable, and replaces the files inside the same directories so a running worker keeps a valid mount", () => {
    const { live, view } = built();
    const inodes = PROFILES.map((profile) => statSync(join(view, profile)).ino);
    writeFileSync(join(live, PROFILES[1], "SOUL.md"), "Changed persona text\n");
    const again = run("sync", live, view);
    expect(again.status).toBe(0);
    expect(readFileSync(join(view, PROFILES[1], "SOUL.md"), "utf8")).toBe("Changed persona text\n");
    if (posixOs) expect(PROFILES.map((profile) => statSync(join(view, profile)).ino)).toEqual(inodes);
  }, 120_000);

  it.skipIf(!posixOs)("leaves the view read-only to everyone but its owner", () => {
    const { live, view } = liveOnly();
    expect(run("sync", live, view).status).toBe(0);
    for (const profile of PROFILES) {
      expect(statSync(join(view, profile)).mode & 0o777).toBe(0o500);
      for (const file of [".env", "SOUL.md", "config.yaml"]) expect(statSync(join(view, profile, file)).mode & 0o777).toBe(0o400);
    }
  }, 120_000);

  it("validates all six profiles before writing anything, and says so", () => {
    const { live, view } = liveOnly();
    writeFileSync(join(live, "iacquire-sales-assistant", "SOUL.md"), "x".repeat(16_385));
    const result = run("sync", live, view);
    expect(result.status).toBe(1);
    expect(result.out).toContain("live SOUL.md is 16385 bytes; the worker accepts 1 to 16384");
    expect(result.out).toContain("RESULT: FAIL (nothing was written)");
    expect(existsSync(view)).toBe(false);
  }, 60_000);

  it("refuses a live .env without a usable DeepSeek key", () => {
    const { live, view } = liveOnly();
    writeFileSync(join(live, "iacquire-crm-manager", ".env"), "API_SERVER_KEY=planted-only-0001\nDEEPSEEK_API_KEY=short\n");
    const result = run("sync", live, view);
    expect(result.status).toBe(1);
    expect(result.out).toContain("iacquire-crm-manager: the live .env has no usable DEEPSEEK_API_KEY");
    expect(existsSync(view)).toBe(false);
  }, 60_000);

  it("refuses a missing live file", () => {
    const { live, view } = liveOnly();
    unlinkSync(join(live, "iacquire-analyst", "config.yaml"));
    const result = run("sync", live, view);
    expect(result.status).toBe(1);
    expect(result.out).toContain("live config.yaml is missing");
    expect(existsSync(view)).toBe(false);
  }, 60_000);

  it("--dry-run validates and writes nothing", () => {
    const { live, view } = liveOnly();
    const result = run("sync", live, view, ["--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.out).toContain("dry run: nothing was written");
    expect(existsSync(view)).toBe(false);
  }, 60_000);

  it("refuses a symlinked live file", () => {
    const { dir, live, view } = liveOnly();
    const target = join(dir, "elsewhere.md");
    writeFileSync(target, "Linked SOUL\n");
    const link = join(live, "iacquire-lead-hunter", "SOUL.md");
    unlinkSync(link);
    try { symlinkSync(target, link); } catch { return; /* this machine cannot create symlinks */ }
    const result = run("sync", live, view);
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/live SOUL\.md is missing, is not a regular file or is a symlink/);
  }, 60_000);

  it("refuses a view that is, is inside or contains the live profiles, relative paths and bad usage", () => {
    const { dir, live } = liveOnly();
    expect(run("sync", live, live).status).toBe(2);
    expect(run("sync", live, join(live, "inner")).status).toBe(2);
    expect(run("sync", join(dir, "live"), dir).status).toBe(2);
    expect(spawnSync("bash", [posix(scriptPath), "sync", "--live", "live", "--view", "view"], { encoding: "utf8" }).status).toBe(2);
    expect(spawnSync("bash", [posix(scriptPath)], { encoding: "utf8" }).status).toBe(2);
    expect(spawnSync("bash", [posix(scriptPath), "check", "--live", posix(live), "--view", posix(join(dir, "v")), "--dry-run"], { encoding: "utf8" }).status).toBe(2);
  }, 60_000);
});

describe.skipIf(!hasBash)("worker profile view: verify", () => {
  it("reports drift in SOUL.md, config.yaml and the DeepSeek key until the view is synced again", () => {
    const { live, view } = built();
    expect(run("check", live, view).status).toBe(0);

    writeFileSync(join(live, PROFILES[0], "SOUL.md"), "A changed persona\n");
    let result = run("check", live, view);
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/iacquire-operations-manager: SOUL\.md differs from the live file: DRIFT/);

    writeFileSync(join(live, PROFILES[2], ".env"), liveEnv(PROFILES[2]).replace(planted(PROFILES[2]).deepseek, "sk-rotated-deepseek-key-123456"));
    result = run("check", live, view);
    expect(result.out).toMatch(/iacquire-appointment-setter: the view's \.env is not what the live \.env would give the worker/);

    expect(run("sync", live, view).status).toBe(0);
    expect(run("check", live, view).status).toBe(0);
    expect(readFileSync(join(view, PROFILES[2], ".env"), "utf8")).toContain("sk-rotated-deepseek-key-123456");
  }, 240_000);

  it("reports drift in config.yaml", () => {
    const { live, view } = built();
    writeFileSync(join(live, PROFILES[4], "config.yaml"), `${CONFIG}extra: 1\n`);
    const result = run("check", live, view);
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/iacquire-crm-manager: config\.yaml differs from the live file: DRIFT/);
  }, 60_000);

  it("fails on any extra entry in a view directory, and sync does not delete it", () => {
    const { live, view } = built();
    const extra = join(view, PROFILES[3], "state.db");
    writeFileSync(extra, "not for a worker");
    const result = run("check", live, view);
    expect(result.status).toBe(1);
    expect(result.out).toContain("iacquire-sales-assistant: unexpected entry in the view: state.db");
    expect(run("sync", live, view).status).toBe(1);
    expect(existsSync(extra)).toBe(true);
  }, 120_000);

  it("removes only its own temporary leftovers", () => {
    const { live, view } = built();
    writeFileSync(join(view, PROFILES[4], ".new.SOUL.md.123"), "half-written");
    const result = run("sync", live, view);
    expect(result.status).toBe(0);
    expect(names(join(view, PROFILES[4]))).toEqual([".env", "SOUL.md", "config.yaml"].sort());
  }, 120_000);

  it("fails when a secret from the live .env turns up inside SOUL.md or config.yaml, naming the variable but not its value", () => {
    const { live, view } = liveOnly();
    const slack = planted(PROFILES[5]).slack;
    writeFileSync(join(live, PROFILES[5], "SOUL.md"), `Persona text with a pasted token ${slack}\n`);
    const result = run("sync", live, view);
    expect(result.status).toBe(1);
    expect(result.out).toContain("the value of SLACK_BOT_TOKEN from the live .env appears in the view's SOUL.md");
    expect(result.out).not.toContain(slack);
  }, 120_000);

  it("does not call a value a leak when it is the very same string as a DeepSeek setting", () => {
    const { live, view } = liveOnly();
    const key = planted(PROFILES[0]).deepseek;
    writeFileSync(join(live, PROFILES[0], ".env"), `API_SERVER_KEY=${key}\nDEEPSEEK_API_KEY=${key}\n`);
    const result = run("sync", live, view);
    expect(result.status).toBe(0);
    expect(result.out).toContain("RESULT: PASS");
  }, 120_000);

  it("fails when the view's .env carries a line that is not a DeepSeek setting", () => {
    const { live, view } = built();
    writeFileSync(join(view, PROFILES[0], ".env"), `${readFileSync(join(view, PROFILES[0], ".env"), "utf8")}SLACK_BOT_TOKEN=${planted(PROFILES[0]).slack}\n`);
    const result = run("check", live, view);
    expect(result.status).toBe(1);
    expect(result.out).not.toContain(planted(PROFILES[0]).slack);
  }, 60_000);

  it("reports a missing view directory", () => {
    const { live, view } = liveOnly();
    const result = run("check", live, view);
    expect(result.status).toBe(1);
    expect(result.out).toContain("no worker view directory (run sync)");
  }, 60_000);

  it("changes nothing when it only checks, even when it finds drift", () => {
    const { live, view } = built();
    writeFileSync(join(live, PROFILES[0], "SOUL.md"), "drift\n");
    const before = { view: snapshot(view), live: snapshot(live) };
    expect(run("check", live, view).status).toBe(1);
    expect({ view: snapshot(view), live: snapshot(live) }).toEqual(before);
  }, 60_000);
});

// The bash filter must keep exactly what the worker's own filter keeps (_provider_dotenv in worker.py). If the two ever
// disagree, the view would hold a key the worker rejects, or drop one it accepts.
describe.skipIf(!hasBash || !hasPython)("worker profile view: the DeepSeek filter equals the worker's own", () => {
  const key = (n: number, c = "k") => `sk-${c.repeat(n)}`;
  const CASES: Array<[string, string]> = [
    ["plain pair", `DEEPSEEK_API_KEY=${key(20)}\nDEEPSEEK_BASE_URL=https://api.deepseek.com\n`],
    ["export prefix and double quotes", `export DEEPSEEK_API_KEY="${key(20)}"\n`],
    ["single quotes", `DEEPSEEK_API_KEY='${key(20)}'\n`],
    ["a later line overrides an earlier one", `DEEPSEEK_API_KEY=${key(20, "a")}\nDEEPSEEK_API_KEY=${key(20, "b")}\n`],
    ["whitespace around the name and the value", `  DEEPSEEK_API_KEY  =   ${key(20)}   \n`],
    ["CRLF line endings", `DEEPSEEK_API_KEY=${key(20)}\r\nDEEPSEEK_BASE_URL=https://api.deepseek.com\r\n`],
    ["a value of exactly 8 characters is kept", "DEEPSEEK_API_KEY=abcdefgh\n"],
    ["a value of 512 characters is kept", `DEEPSEEK_API_KEY=${"a".repeat(512)}\n`],
    ["no trailing newline", `DEEPSEEK_API_KEY=${key(20)}`],
    ["the order of the two names does not matter", `DEEPSEEK_BASE_URL=https://api.deepseek.com\nDEEPSEEK_API_KEY=${key(20)}\n`],
    ["other secrets are never kept", `API_SERVER_KEY=${key(20, "z")}\nSLACK_BOT_TOKEN=${key(20, "y")}\nDEEPSEEK_API_KEY=${key(20)}\n`],
    ["a base URL alone is not enough, but is kept next to a key", `DEEPSEEK_API_KEY=${key(20)}\nDEEPSEEK_BASE_URL='https://api.deepseek.com/v1'\n`],
    // The worker could not run on any of these (no usable key), so the script must refuse them instead of writing a view that cannot work.
    ["a value of 7 characters is dropped", "DEEPSEEK_API_KEY=abcdefg\nDEEPSEEK_BASE_URL=https://api.deepseek.com\n"],
    ["a value of 513 characters is dropped", `DEEPSEEK_API_KEY=${"a".repeat(513)}\nDEEPSEEK_BASE_URL=https://api.deepseek.com\n`],
    ["a value with a space is dropped", `DEEPSEEK_API_KEY=${key(10)} ${key(10)}\nDEEPSEEK_BASE_URL=https://api.deepseek.com\n`],
    ["a value with shell characters is dropped", `DEEPSEEK_API_KEY=${key(10)}$(x)\nDEEPSEEK_BASE_URL=https://api.deepseek.com\n`],
    ["a value with a hash or a semicolon is dropped", `DEEPSEEK_API_KEY=${key(10)};${key(10)}\nDEEPSEEK_BASE_URL=${key(10)}#x\n`],
    ["near names and other cases of the name are ignored", `DEEPSEEK_API_KEY_ALT=${key(20)}\ndeepseek_api_key=${key(20)}\nDEEPSEEK_BASE_URL=https://api.deepseek.com\n`],
    ["a commented line is ignored", `# DEEPSEEK_API_KEY=${key(20)}\nDEEPSEEK_BASE_URL=https://api.deepseek.com\n`],
    ["mismatched quotes drop the value", `DEEPSEEK_API_KEY="${key(20)}'\nDEEPSEEK_BASE_URL=https://api.deepseek.com\n`],
    ["an empty value is dropped", "DEEPSEEK_API_KEY=\nDEEPSEEK_BASE_URL=https://api.deepseek.com\n"],
    ["a non-ASCII value is dropped", `DEEPSEEK_API_KEY=${key(10)}é${key(10)}\nDEEPSEEK_BASE_URL=https://api.deepseek.com\n`],
  ];

  function workerFilter(raw: string): string {
    // Bytes, not text: Python on Windows turns "\n" into "\r\n" when it writes text to a pipe.
    const code = `import sys; sys.path.insert(0, ${JSON.stringify(posix(workerDir))}); import worker; sys.stdout.buffer.write(worker._provider_dotenv(sys.stdin.buffer.read()).encode("ascii"))`;
    const result = spawnSync(pythonCommand, ["-c", code], { input: Buffer.from(raw, "utf8"), encoding: "utf8" });
    if (result.status !== 0) throw new Error(`the worker's filter could not be run: ${String(result.stderr).slice(-300)}`);
    return result.stdout;
  }

  const expectations = CASES.map(([label, raw]) => ({ label, raw, expected: hasPython ? workerFilter(raw) : "" }));
  const usable = expectations.filter((entry) => entry.expected.includes("DEEPSEEK_API_KEY="));
  const unusable = expectations.filter((entry) => !entry.expected.includes("DEEPSEEK_API_KEY="));

  it("agrees with the worker on every input the worker can run with, six at a time", () => {
    expect(usable.length).toBeGreaterThanOrEqual(11);
    for (let start = 0; start < usable.length; start += PROFILES.length) {
      const batch = usable.slice(start, start + PROFILES.length);
      const { live, view } = liveOnly();
      batch.forEach((entry, index) => writeFileSync(join(live, PROFILES[index], ".env"), entry.raw, "utf8"));
      const result = run("sync", live, view);
      expect(result.status, result.out).toBe(0);
      batch.forEach((entry, index) => {
        expect(readFileSync(join(view, PROFILES[index], ".env"), "utf8"), entry.label).toBe(entry.expected);
      });
    }
  }, 300_000);

  it("refuses every input the worker could not run with, naming the profile", () => {
    expect(unusable.length).toBeGreaterThanOrEqual(9);
    for (let start = 0; start < unusable.length; start += PROFILES.length) {
      const batch = unusable.slice(start, start + PROFILES.length);
      const { live, view } = liveOnly();
      batch.forEach((entry, index) => writeFileSync(join(live, PROFILES[index], ".env"), entry.raw, "utf8"));
      const result = run("sync", live, view);
      expect(result.status).toBe(1);
      expect(existsSync(view)).toBe(false);
      batch.forEach((entry, index) => expect(result.out, entry.label).toContain(`${PROFILES[index]}: the live .env has no usable DEEPSEEK_API_KEY`));
    }
  }, 300_000);
});

// docker is faked: the script reads running workers' mounts with `docker ps` and `docker inspect` only.
describe.skipIf(!hasBash)("worker profile view: the running workers' mounts", () => {
  const container = (role: string) => `iacquire-hermes-inference-iacquire-hermes-inference-worker-${role}-1`;

  // The fake docker is a script the view script has to execute. CI mounts /tmp noexec, so it goes in the first scratch directory where a script can actually run: the system
  // temp directory, else the workspace's node_modules/.cache (ignored by git). The A1 preflight test does the same.
  function executableScratchDir(): string | null {
    for (const base of [tmpdir(), join(root, "node_modules", ".cache")]) {
      let dir: string | null = null;
      try {
        mkdirSync(base, { recursive: true });
        dir = mkdtempSync(join(base, "worker-view-bin-"));
        const probe = join(dir, "probe");
        writeFileSync(probe, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
        // Run it through bash, the way the view script does, so a noexec mount fails here and Windows still works.
        if (spawnSync("bash", ["-c", '"$1"', "probe", posix(probe)]).status === 0) return dir;
      } catch {
        // try the next location
      }
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    return null;
  }

  function fakeDocker(mounts: (role: string, profile: string, view: string) => string[], running = Object.keys(WORKER_ROLES)) {
    const bin = executableScratchDir();
    if (!bin) throw new Error("no scratch directory allows running scripts, so the fake docker cannot run");
    workDirs.push(bin);
    const arms = (view: string) => running.map((role) => `    ${container(role)}) printf '%s\\n' ${mounts(role, WORKER_ROLES[role], view).map((line) => `'${line}'`).join(" ")} ;;`).join("\n");
    return { bin, write: (view: string) => {
      writeFileSync(join(bin, "docker"), [
        "#!/usr/bin/env bash", 'cmd=$1; shift', 'case "$cmd" in',
        `  ps) ${running.length ? `printf '%s\\n' ${running.map((role) => container(role)).join(" ")}` : "true"} ;;`,
        '  inspect) name=${*: -1}; case "$name" in', arms(view), "    esac ;;", "  *) exit 1 ;;", "esac", "",
      ].join("\n"), { mode: 0o755 });
    } };
  }

  const good = (_role: string, profile: string, view: string) => [
    `bind|${posix(view)}/${profile}|/profiles/${profile}|false`,
    "bind|/etc/iacquire-hermes-inference/inference_hmac|/run/secrets/inference_hmac|false",
    "volume|/var/lib/docker/volumes/anon/_data|/opt/data|true",
  ];

  function runContainers(mounts: Parameters<typeof fakeDocker>[0], running?: string[]) {
    const { live, view } = built();
    const fake = fakeDocker(mounts, running);
    fake.write(view);
    return run("check", live, view, ["--containers"], { PATH: `${posix(fake.bin)}:${process.env.PATH}` });
  }

  it("passes when every worker mounts only its own view, read-only, plus the HMAC file (the known anonymous volume is a warning)", () => {
    const result = runContainers(good);
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/worker-lead-hunter-1: iacquire-lead-hunter is mounted read-only from the worker view/);
    expect(result.out).toMatch(/known item O3/);
  }, 120_000);

  it("fails when a worker still mounts the live profile directory", () => {
    const result = runContainers((role, profile, view) => role === "lead-hunter"
      ? [`bind|${posix(view)}/../live/${profile}|/profiles/${profile}|false`, "bind|/etc/iacquire-hermes-inference/inference_hmac|/run/secrets/inference_hmac|false"]
      : good(role, profile, view));
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/worker-lead-hunter-1: the profile mount for iacquire-lead-hunter comes from outside the worker view/);
    expect(result.out).toMatch(/worker-lead-hunter-1: a mount reads from the live profiles directory/);
  }, 120_000);

  it("fails when a profile mount is writable", () => {
    const result = runContainers((role, profile, view) => role === "crm-manager"
      ? [`bind|${posix(view)}/${profile}|/profiles/${profile}|true`, "bind|/etc/iacquire-hermes-inference/inference_hmac|/run/secrets/inference_hmac|false"]
      : good(role, profile, view));
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/worker-crm-manager-1: the profile mount for iacquire-crm-manager is writable/);
  }, 120_000);

  it("fails on the Docker socket or any other extra mount", () => {
    const result = runContainers((role, profile, view) => role === "operations-manager"
      ? [...good(role, profile, view), "bind|/var/run/docker.sock|/var/run/docker.sock|true", "bind|/root|/host|true"]
      : good(role, profile, view));
    expect(result.status).toBe(1);
    expect(result.out).toContain("unexpected mount at /var/run/docker.sock");
    expect(result.out).toContain("unexpected mount at /host");
  }, 120_000);

  it("fails when a worker mounts another employee's profile", () => {
    const result = runContainers((role, profile, view) => role === "sales-assistant"
      ? good(role, "iacquire-crm-manager", view)
      : good(role, profile, view));
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/the sales-assistant worker mounts iacquire-crm-manager, not its own profile iacquire-sales-assistant/);
  }, 120_000);

  it("warns, rather than passing silently, when no worker is running", () => {
    const result = runContainers(good, []);
    expect(result.status).toBe(0);
    expect(result.out).toContain("no running worker containers were found");
  }, 120_000);
});

describe("worker profile view: what the script is allowed to do", () => {
  const codeLines = script.split("\n").filter((line) => !/^\s*#/.test(line));

  it("uses only docker ps and docker inspect, and nothing that sends data or reaches another machine", () => {
    const docker = codeLines.filter((line) => /\bdocker\b/.test(line) && !/have docker|"docker is not available|docker ps --format|docker inspect -f/.test(line) && !/^\s*(?:warn|info|fail|ok)\b/.test(line));
    expect(docker).toEqual([]);
    for (const pattern of [/\bcurl\b/, /\bwget\b/, /\bssh\b/, /\bscp\b/, /\bnc\b/, /\beval\b/, /\bset -x\b/, /\bsudo\b/, /\bchattr\b/, /\bsystemctl\b/, /\bufw\b/, /\biptables\b/]) {
      expect(codeLines.filter((line) => pattern.test(line)), String(pattern)).toEqual([]);
    }
  });

  it("deletes only its own .new.* leftovers, and never recursively", () => {
    const removals = codeLines.filter((line) => /\brm\b/.test(line));
    expect(removals.length).toBeGreaterThan(0);
    for (const line of removals) {
      expect(line).toMatch(/rm -f --/);
      expect(line).not.toMatch(/rm -[a-zA-Z]*r/);
    }
    expect(script).toMatch(/case "\$entry" in \.new\.\*\) rm -f -- "\$view\/\$entry"/);
  });

  it("writes only inside the view: the one redirect into a file is the temporary file next to its destination", () => {
    const redirects = codeLines.filter((line) => /(?:^|[^<>&0-9-])>>?\s*["$/]/.test(line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''")) || />\s*"\$tmp"/.test(line));
    expect(redirects.filter((line) => !/>\s*"\$tmp"/.test(line) && !/>\s*\/dev\/null/.test(line) && !/2>&1/.test(line))).toEqual([]);
    expect(script).not.toMatch(/(?:>|>>|tee)\s*"?\$LIVE/);
  });

  it("prints a secret nowhere: the derived .env text leaves derive_dotenv only through the pipes that write or compare it", () => {
    const printsValue = codeLines.filter((line) => /\b(?:printf|echo)\b/.test(line) && /\$\{?(?:value|derived|actual|kept|text|line)\b/.test(line));
    expect(printsValue).toHaveLength(1);
    expect(printsValue[0]).toContain('printf \'%s=%s\\n\' "$key" "${kept[$key]}"');
    for (const line of codeLines.filter((candidate) => /^\s*(?:ok|warn|fail|info)\b/.test(candidate))) {
      expect(line, line).not.toMatch(/\$\{?(?:value|derived|actual|kept|text|line)\b/);
    }
  });

  it("matches the worker's limits and key names", () => {
    const worker = readFileSync(join(workerDir, "worker.py"), "utf8");
    expect(worker).toContain('PROFILE_HOME_FILE_LIMITS = {"SOUL.md": 16_384, "config.yaml": 65_536}');
    expect(worker).toContain("PROVIDER_DOTENV_LIMIT_BYTES = 65_536");
    expect(worker).toContain('PROVIDER_DOTENV_KEYS = ("DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL")');
    expect(worker).toContain("PROVIDER_DOTENV_VALUE_RE = re.compile(r\"[A-Za-z0-9_.:/+=@~-]{8,512}\")");
    expect(script).toContain("SOUL_LIMIT=16384 CONFIG_LIMIT=65536 DOTENV_LIMIT=65536");
    expect(script).toContain("DOTENV_KEYS=(DEEPSEEK_API_KEY DEEPSEEK_BASE_URL)");
    expect(script).toContain("VALUE_MIN=8 VALUE_MAX=512");
    expect(script).toContain("VALUE_RE='^[A-Za-z0-9_.:/+=@~-]+$'");
  });

  it("names the same six profile directories the Compose file mounts", () => {
    for (const profile of PROFILES) {
      expect(script).toContain(profile);
      expect(compose).toContain(`/${profile}`);
    }
  });
});
