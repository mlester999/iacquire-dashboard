#!/usr/bin/env node
/**
 * Builds the pinned Hermes runtime the compatibility proof (C6) runs against, in a directory that did not exist before. Nothing is installed globally and nothing outside <out> is changed
 * (uv's managed Python and cache are kept inside it too).
 *
 *   node services/hermes-business-mcp-acceptance/prepare-runtime.mjs --out <new directory>
 *
 * What it does, in order, and stops at the first thing that does not match:
 *   1. fetches exactly the upstream commit named below (Hermes v2026.9.24 = 0.21.5) from GitHub and checks the commit id and the version in pyproject.toml;
 *   2. makes a copy of the source, verifies services/hermes-provisioner/catalog-overlay against its SHA256SUMS, and applies those eight files to the copy (the same eight files the production
 *      gateway's catalog backport replaces). The pristine checkout is kept as the "no overlay" control;
 *   3. installs the dependencies EXACTLY as upstream's own container build does: `uv sync --frozen` against upstream's uv.lock (hash-pinned), with the extras that carry the MCP client and the
 *      API server (mcp, messaging), on Python 3.13, the interpreter upstream's image uses;
 *   4. checks that the patched copy exposes the complete-inventory route and the pristine one does not, and writes runtime.json (versions and hashes, no secrets).
 *
 * It prints the three variables the test reads. This is not the production container (see docs/hermes-d3-c6-results-2026-10-30.md for what that does and does not prove).
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERMES_REPOSITORY = "https://github.com/NousResearch/hermes-agent.git";
const HERMES_COMMIT = "f97608f178d1ffeca59860195ab7da295f7c8e5f"; // v2026.9.24
const HERMES_VERSION = "0.21.5";
const PYTHON = "3.13";
const EXTRAS = ["mcp", "messaging"];
// Directories of the checkout that the gateway does not need (front ends, docs, tests). Top-level only: `plugins/web` is source.
const SKIP_TOP_LEVEL = new Set([".git", "apps", "web", "website", "ui-tui", "node_modules", "tests", "tests-js", "evals"]);

const here = path.dirname(fileURLToPath(import.meta.url));
const overlayDir = path.resolve(here, "../hermes-provisioner/catalog-overlay");

function fail(message) {
  console.error(`prepare-runtime stopped: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", cwd: tmpdir(), windowsHide: true, ...options, env: { ...process.env, ...(options.env ?? {}) } });
  if (result.status !== 0) fail(`${command} ${args.slice(0, 3).join(" ")} failed (exit ${result.status}): ${String(result.stderr || result.stdout).trim().split(/\r?\n/).slice(-4).join(" | ").slice(0, 400)}`);
  return result.stdout.trim();
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const outIndex = process.argv.indexOf("--out");
if (outIndex < 0 || !process.argv[outIndex + 1]) fail("give --out <a directory that does not exist yet or is empty>");
const out = path.resolve(process.argv[outIndex + 1]);
if (existsSync(out) && readdirSync(out).length) fail(`${out} is not empty. Use a new directory so nothing is mixed with an earlier runtime.`);
if (process.platform === "win32" && out.length > 60) console.warn("Warning: Windows limits paths to 260 characters and upstream's source tree is deep. Use a short --out (for example S:\\c6 or C:\\h) if the checkout reports 'Filename too long'.");
mkdirSync(out, { recursive: true });

const upstream = path.join(out, "upstream");
mkdirSync(upstream);
run("git", ["-C", upstream, "init", "-q"]);
run("git", ["-C", upstream, "remote", "add", "origin", HERMES_REPOSITORY]);
run("git", ["-C", upstream, "fetch", "--depth", "1", "origin", HERMES_COMMIT]);
run("git", ["-C", upstream, "-c", "core.longpaths=true", "checkout", "-q", "-f", "--detach", "FETCH_HEAD"]);
const head = run("git", ["-C", upstream, "rev-parse", "HEAD"]);
if (head !== HERMES_COMMIT) fail(`fetched ${head}, expected ${HERMES_COMMIT}`);
const pyproject = readFileSync(path.join(upstream, "pyproject.toml"), "utf8");
const version = /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1];
if (version !== HERMES_VERSION) fail(`the checkout is Hermes ${version}, expected ${HERMES_VERSION}`);

const patched = path.join(out, "hermes-overlay");
cpSync(upstream, patched, { recursive: true, filter: (source) => !SKIP_TOP_LEVEL.has(path.relative(upstream, source).split(path.sep)[0]) });
const sums = readFileSync(path.join(overlayDir, "SHA256SUMS"), "utf8").split(/\r?\n/).filter((line) => line.trim());
if (sums.length !== 8) fail(`expected 8 overlay files in SHA256SUMS, found ${sums.length}`);
for (const line of sums) {
  const [expected, name] = line.trim().split(/\s+/, 2);
  const actual = sha256(path.join(overlayDir, name));
  if (actual !== expected) fail(`overlay file ${name} does not match SHA256SUMS`);
}
for (const line of sums) {
  const name = line.trim().split(/\s+/, 2)[1];
  mkdirSync(path.dirname(path.join(patched, name)), { recursive: true });
  cpSync(path.join(overlayDir, name), path.join(patched, name));
}

const venv = path.join(out, "venv");
const uvEnv = { UV_PROJECT_ENVIRONMENT: venv, UV_CACHE_DIR: path.join(out, "uv-cache"), UV_PYTHON_INSTALL_DIR: path.join(out, "uv-python"), UV_NO_CONFIG: "1" };
run("uv", ["--project", upstream, "sync", "--frozen", "--no-install-project", ...EXTRAS.flatMap((extra) => ["--extra", extra]), "--python", PYTHON], { env: uvEnv });
const python = process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
if (!existsSync(python)) fail("the virtual environment has no Python");

const probe = (source) => run(python, ["-c", "import json,sys; from gateway.platforms.api_server import APIServerAdapter; print(json.dumps({'catalog_route': hasattr(APIServerAdapter, '_handle_tools')}))"], { env: { PYTHONPATH: source, PYTHONDONTWRITEBYTECODE: "1" } });
const withOverlay = JSON.parse(probe(patched));
const without = JSON.parse(probe(upstream));
if (!withOverlay.catalog_route) fail("the patched copy has no complete-inventory route");
if (without.catalog_route) fail("the pristine copy already has a complete-inventory route, so it is not a valid control");
const versions = JSON.parse(run(python, ["-c", "import importlib.metadata as m, json, sys; print(json.dumps({'python': sys.version.split()[0], 'mcp': m.version('mcp'), 'aiohttp': m.version('aiohttp'), 'httpx': m.version('httpx')}))"]));

const record = {
  hermes: { version: HERMES_VERSION, commit: HERMES_COMMIT, repository: HERMES_REPOSITORY },
  dependencies: { lockfileSha256: sha256(path.join(upstream, "uv.lock")), extras: EXTRAS, frozen: true, ...versions },
  overlay: { directory: "services/hermes-provisioner/catalog-overlay", sha256sumsSha256: sha256(path.join(overlayDir, "SHA256SUMS")), files: sums.length },
  platform: process.platform,
};
writeFileSync(path.join(out, "runtime.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
console.log(JSON.stringify(record, null, 2));
console.log("");
console.log("Use it:");
console.log(`  IACQUIRE_C6_PYTHON=${python}`);
console.log(`  IACQUIRE_C6_HERMES_SOURCE=${patched}`);
console.log(`  IACQUIRE_C6_BASELINE_SOURCE=${upstream}`);
