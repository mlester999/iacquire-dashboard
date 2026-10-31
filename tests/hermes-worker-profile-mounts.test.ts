import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// O2 regression guards. The behaviour of the view script is tested in hermes-worker-profile-view.test.ts; this file keeps the
// Compose file, the CI steps, the smokes and the operator procedure from drifting apart or being weakened by an unrelated edit.

const root = resolve(__dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const compose = read("services/hermes-inference-worker/compose.internal.yaml");
const dockerfile = read("services/hermes-inference-worker/Dockerfile");
const deployment = read("services/hermes-inference-worker/DEPLOYMENT.md");
const workflow = read(".github/workflows/hermes-inference-worker.yml");
const mcpSmoke = read("services/hermes-inference-worker/pinned_mcp_config_smoke.py");
const viewSmoke = read("services/hermes-inference-worker/pinned_profile_view_smoke.py");

const codeLines = (source: string) => source.split("\n").filter((line) => !/^\s*#/.test(line));
const workers = [
  ["operations-manager", "iacquire-operations-manager"], ["lead-hunter", "iacquire-lead-hunter"], ["appointment-setter", "iacquire-appointment-setter"],
  ["sales-assistant", "iacquire-sales-assistant"], ["crm-manager", "iacquire-crm-manager"], ["performance-analyst", "iacquire-analyst"],
] as const;

describe("worker Compose mounts", () => {
  it("takes the profile directory from the required worker-view variable only", () => {
    expect(codeLines(compose).filter((line) => line.includes("HERMES_PROFILE_BASE"))).toEqual([]);
    const sources = codeLines(compose).filter((line) => /^\s*source: \$\{IACQUIRE_WORKER_PROFILE_BASE:\?/.test(line));
    expect(sources).toHaveLength(6);
    for (const [, profile] of workers) expect(sources.some((line) => line.endsWith(`}/${profile}`))).toBe(true);
  });

  it("mounts, per worker, only its own profile view and the HMAC file, both read-only binds", () => {
    const mounts = compose.slice(compose.indexOf("x-profile-mounts:"), compose.indexOf("services:"));
    expect(mounts.match(/type: bind/g)).toHaveLength(6);
    expect(mounts.match(/read_only: true/g)).toHaveLength(6);
    for (const [role, profile] of workers) {
      const service = compose.slice(compose.indexOf(`iacquire-hermes-inference-worker-${role}:`));
      const volumes = /volumes: \[([^\]]*)\]/.exec(service)?.[1] ?? "";
      const anchor = profile === "iacquire-analyst" ? "performance-analyst-profile" : `${role}-profile`;
      expect(volumes.replace(/\s+/g, "")).toBe(`*${anchor},*hmac-mount`);
    }
  });

  it("gives a worker no Docker socket, host path, device, published port, privilege or host namespace", () => {
    for (const pattern of [/docker\.sock/, /\/var\/run/, /privileged/, /network_mode/, /^\s*pid:/m, /^\s*ipc:/m, /^\s*devices:/m, /^\s*ports:/m, /volumes_from/, /cap_add/, /\/etc\/passwd/]) {
      expect(codeLines(compose).join("\n")).not.toMatch(pattern);
    }
    expect(compose.match(/cap_drop: \[ALL\]/g)).toHaveLength(2);
    expect(compose.match(/read_only: true\n/g)?.length).toBeGreaterThanOrEqual(8);
  });

  it("keeps the worker image at v4: this change adds no file to the image", () => {
    expect(compose.match(/image: iacquire\/hermes-inference-worker:0\.22\.5-v4/g)).toHaveLength(2);
    expect(dockerfile).toContain('org.opencontainers.image.version="0.22.5-iacquire-inference.v4"');
    expect(dockerfile).not.toContain("pinned_mcp_config_smoke");
    expect(dockerfile).not.toContain("pinned_profile_view_smoke");
    expect(dockerfile).not.toContain("hermes-worker-profile-view");
  });
});

describe("worker profile view in CI", () => {
  it("refuses to render Compose when only the old variable is set", () => {
    expect(workflow).toContain('env -u IACQUIRE_WORKER_PROFILE_BASE HERMES_PROFILE_BASE="$RUNNER_TEMP/live-profiles-must-not-be-used"');
    expect(workflow).toContain("Compose still accepts HERMES_PROFILE_BASE");
  });

  it("asserts each worker mounts exactly its own directory of the view, read-only, and nothing else but the HMAC file", () => {
    expect(workflow).toContain('profiles[0]["source"] == os.path.join(view_base, profile_dir)');
    expect(workflow).toContain('sorted(v.get("target") for v in service["volumes"]) == sorted([f"/profiles/{profile_dir}", "/run/secrets/inference_hmac"])');
    expect(workflow).toContain('all(v.get("type") == "bind" and v.get("read_only") is True for v in service["volumes"])');
    expect(workflow).not.toContain('export HERMES_PROFILE_BASE=');
  });

  it("builds a view with the real script from planted secrets, proves none is in it, and runs the real worker path against it", () => {
    const step = workflow.slice(workflow.indexOf("Build a worker-only profile view with the real script"));
    const command = step.slice(0, step.indexOf("- name: Re-run worker policy"));
    expect(command).toContain("sudo bash scripts/hermes-worker-profile-view.sh sync");
    expect(command).toContain("sudo bash scripts/hermes-worker-profile-view.sh check");
    expect(command).toContain('test "$(sudo find "$view" -mindepth 2 -type f | wc -l)" = 18');
    expect(command).toContain("planted-|iamcp1");
    expect(command).toContain("--network none --read-only --user 10000:10000");
    expect(command).toContain("target=/profiles/iacquire-lead-hunter,readonly");
    expect(command).toContain("target=/opt/iacquire-hermes/inference/pinned_profile_view_smoke.py,readonly");
    expect(command).toContain("Worker-only profile view smoke failed");
  });

  it("proves an mcp_servers entry cannot change the worker, from a read-only bind mount (not from the image)", () => {
    const step = workflow.slice(workflow.indexOf("Prove a business MCP entry in a profile config cannot change the worker"));
    const command = step.slice(0, step.indexOf("# O2: the workers are given"));
    expect(command).toContain("--network none --read-only --user 10000:10000");
    expect(command).toContain("target=/opt/iacquire-hermes/inference/pinned_mcp_config_smoke.py,readonly");
    expect(command).toContain("MCP config smoke failed");
  });
});

describe("the O2 smokes keep their teeth", () => {
  it("the MCP smoke fails on a changed audit, a connection to the entry's address, a started command, a blown time budget and a credential in the home", () => {
    for (const text of [
      "the audit changed when the profile config gained an mcp_servers entry",
      "the worker connected to the address in the mcp_servers entry",
      "the worker started the command in the mcp_servers entry",
      "not inside the worker's",
      "the business credential or another profile secret reached the worker's home",
      "config.yaml was not copied unchanged",
      "class Listener",
    ]) expect(mcpSmoke).toContain(text);
    expect(mcpSmoke).toContain("worker.execute(request, worker.run_pinned_hermes)");
  });

  it("the view smoke fails on extra files, a writable mount, a non-DeepSeek .env line, a planted secret and a refused audit", () => {
    for (const text of [
      "the worker's profile mount is not exactly the three files",
      "the profile mount is writable, so this smoke would prove nothing",
      "the view's .env is not limited to the DeepSeek settings",
      "a planted secret from the live profile is inside the worker's mount",
      "a business MCP credential is inside the worker's mount",
      "audit from the worker-only view was refused",
      "a planted secret reached the inference home",
      "the worker-only view changed",
    ]) expect(viewSmoke).toContain(text);
    expect(viewSmoke).toContain("worker.execute(request, worker.run_pinned_hermes)");
  });
});

describe("operator procedure", () => {
  it("documents the variable, the script, the dry run, the mounts check, the unchanged image and the rollback", () => {
    for (const text of [
      "## Worker-only profile view (O2)",
      "IACQUIRE_WORKER_PROFILE_BASE",
      "scripts/hermes-worker-profile-view.sh sync",
      "--dry-run",
      "check --live \"$LIVE\" --view \"$VIEW\" --containers",
      "so there is no\nrebuild and no new tag",
      "Rollback (the workers only",
      "the first business MCP credential is placed in a live profile `.env` only after",
    ]) expect(deployment).toContain(text);
  });

  it("never tells an operator to give the live directory to Compose", () => {
    expect(deployment).not.toMatch(/export IACQUIRE_WORKER_PROFILE_BASE="\$LIVE"/);
  });
});
