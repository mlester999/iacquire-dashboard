import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Regression for the first A2 audit: Hermes writes its logs and state under its home directory, and the
// worker pointed that home at the read-only profile mount ("Read-only file system: .../logs/agent.log").
// The worker now builds a throwaway home per request, and CI runs the real worker path against a
// read-only profile mount. These checks keep both from being undone by an unrelated edit.

const root = resolve(__dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const worker = read("services/hermes-inference-worker/worker.py");
const smoke = read("services/hermes-inference-worker/pinned_readonly_profile_smoke.py");
const dockerfile = read("services/hermes-inference-worker/Dockerfile");
const compose = read("services/hermes-inference-worker/compose.internal.yaml");
const deployment = read("services/hermes-inference-worker/DEPLOYMENT.md");
const workflow = read(".github/workflows/hermes-inference-worker.yml");
const workerTests = read("services/hermes-inference-worker/test_worker.py");

describe("worker runtime home", () => {
  it("never points Hermes at the profile mount", () => {
    expect(worker).not.toMatch(/"HERMES_HOME":\s*str\(profile_path\)/);
    expect(worker).toContain('"HERMES_HOME": str(home)');
  });

  it("builds the throwaway home from SOUL.md and config.yaml only, and always removes it", () => {
    expect(worker).toContain('PROFILE_HOME_FILE_LIMITS = {"SOUL.md": 16_384, "config.yaml": 65_536}');
    expect(worker).toContain("home = build_runtime_home(profile_path, mode, temp_root)");
    expect(worker).toMatch(/finally:\n\s+shutil\.rmtree\(home, ignore_errors=True\)/);
  });

  it("gives only inference a .env, limited to the two DeepSeek settings", () => {
    expect(worker).toContain('PROVIDER_DOTENV_KEYS = ("DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL")');
    expect(worker).toContain('if mode == "inference":\n        dotenv = _provider_dotenv(');
  });

  it("writes the home with private permissions", () => {
    expect(worker).toContain("os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600");
  });
});

describe("read-only profile smoke in CI", () => {
  it("runs the real worker path with the pinned runtime and refuses to pass on a writable profile", () => {
    expect(smoke).toContain("worker.execute(request, worker.run_pinned_hermes)");
    expect(smoke).toContain("the profile mount is writable, so this smoke would prove nothing");
    expect(smoke).toContain("the read-only profile changed");
    expect(smoke).toContain("a throwaway Hermes home was left behind");
  });

  it("explains its own failure, because the worker hides child errors and job logs need a sign-in", () => {
    expect(smoke).toContain("def diagnose(");
    expect(smoke).toContain("DIAGNOSTIC_CHILD");
    expect(workflow).toContain("Read-only profile smoke failed");
    expect(workflow).toContain('report "Unexpected failing test files"');
  });

  it("is built into the image and compiled with the other smokes", () => {
    expect(dockerfile).toContain("pinned_readonly_profile_smoke.py /opt/iacquire-hermes/inference/pinned_readonly_profile_smoke.py");
    expect(dockerfile).toMatch(/py_compile \\\n\s+\/opt\/iacquire-hermes\/inference\/pinned_prompt_audit_smoke\.py \\\n\s+\/opt\/iacquire-hermes\/inference\/pinned_readonly_profile_smoke\.py/);
  });

  it("is run by the workflow with a read-only bind mount, no network and a read-only root", () => {
    const step = workflow.slice(workflow.indexOf("Run the real worker path against a read-only profile mount"));
    const command = step.slice(0, step.indexOf("- name: Re-run worker policy"));
    expect(command).toContain("--network none --read-only --user 10000:10000");
    expect(command).toContain("target=/profiles/iacquire-lead-hunter,readonly");
    expect(command).toContain("/opt/iacquire-hermes/inference/pinned_readonly_profile_smoke.py");
  });

  it("has unit tests for the home, including a real child against a read-only directory", () => {
    expect(workerTests).toContain("class ThrowawayRuntimeHomeTests");
    expect(workerTests).toContain("class RunnerEntryPointTests");
    expect(read("services/hermes-inference-worker/inference_runner.py")).toContain("from pathlib import Path\n");
    expect(workerTests).toContain("test_a_real_child_can_write_its_logs_while_the_profile_directory_is_read_only");
  });
});

describe("worker image tag", () => {
  it("moves to v2 everywhere so the fixed image is never confused with the running v1", () => {
    expect(compose.match(/image: iacquire\/hermes-inference-worker:0\.22\.5-v2/g)).toHaveLength(2);
    expect(compose).not.toContain("0.22.5-v1");
    expect(deployment).toContain("-t iacquire/hermes-inference-worker:0.22.5-v2 .");
    expect(deployment).not.toContain("0.22.5-v1");
    expect(dockerfile).toContain('org.opencontainers.image.version="0.22.5-iacquire-inference.v2"');
  });
});
