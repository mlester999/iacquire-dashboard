import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const probe = fileURLToPath(new URL("../scripts/growth-partner-persistence-probe.ts", import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iaq-gp-persist-"));

function cleanTestEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    SYSTEMROOT: process.env.SYSTEMROOT,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    NODE_ENV: "test",
    AUTH_PROVIDER: "local",
    SECRET_STORE: "test-memory",
    APP_ENCRYPTION_KEY: "test-only-key-0123456789abcdef0123456789abcdef",
    DATABASE_DRIVER: "pglite",
    PGLITE_DATA_DIR: dataDir,
  };
}

function run(mode: "seed" | "verify", state?: unknown) {
  const args = ["--conditions=react-server", "--import", "tsx", probe, mode, dataDir];
  if (state) args.push(JSON.stringify(state));
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: cleanTestEnvironment(),
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  expect(result.status, `${mode} process failed\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout;
}

afterAll(() => {
  const tempRoot = path.resolve(os.tmpdir());
  const target = path.resolve(dataDir);
  expect(path.dirname(target)).toBe(tempRoot);
  expect(path.basename(target)).toMatch(/^iaq-gp-persist-/);
  fs.rmSync(target, { recursive: true, force: true });
});

describe("Growth Partner conversation recovery from a persistent database", () => {
  it("recovers two tenant conversations in a new process without exposing either to the other", () => {
    const seeded = run("seed");
    const marker = seeded.split("\n").find((line) => line.startsWith("PERSISTENCE_SEEDED:"));
    expect(marker).toBeTruthy();
    const state = JSON.parse(marker!.slice("PERSISTENCE_SEEDED:".length));
    const recovered = run("verify", state);
    expect(recovered).toContain("PERSISTENCE_RESTART_PASS tenants=2 own_conversations=2 own_markers=2 foreign_reads=0");
  }, 120_000);
});
