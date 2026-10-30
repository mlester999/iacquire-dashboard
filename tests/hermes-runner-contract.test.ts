import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 2026-10-30: the first real inference failed with `inference_failed` because the runner imported
// get_env_value_prefer_dotenv from hermes_cli.auth, where Hermes 0.22.5 does not define it (it lives in
// hermes_cli.config). The audit path never reaches that import and the pinned smoke drives AIAgent directly,
// so nothing saw it until the first real canary. The in-image unit tests now resolve every Hermes import for real;
// these checks keep the source and those tests from drifting back.

const root = resolve(__dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const runner = read("services/hermes-inference-worker/inference_runner.py");
const workerTests = read("services/hermes-inference-worker/test_worker.py");
const workflow = read(".github/workflows/hermes-inference-worker.yml");

describe("the inference runner's use of the pinned Hermes runtime", () => {
  it("imports get_env_value_prefer_dotenv from hermes_cli.config, not hermes_cli.auth", () => {
    expect(runner).toContain("from hermes_cli.config import get_env_value_prefer_dotenv, load_config");
    expect(runner).not.toMatch(/from hermes_cli\.auth import[^\n]*get_env_value_prefer_dotenv/);
  });

  it("is covered by in-image tests that resolve the imports and run the provider check for real", () => {
    expect(workerTests).toContain("class RunnerHermesContractTests");
    expect(workerTests).toContain("test_every_hermes_import_resolves_in_the_pinned_runtime");
    expect(workerTests).toContain("test_the_configured_provider_check_runs_against_the_pinned_runtime");
  });

  it("makes CI fail instead of skip when the pinned runtime is not the one under test", () => {
    const step = workflow.slice(workflow.indexOf("Re-run worker policy and failure tests with network disabled"));
    expect(step.slice(0, step.indexOf("- name: Validate role-specific Compose isolation"))).toContain("-e IACQUIRE_REQUIRE_PINNED_HERMES=1");
    expect(workerTests).toContain('os.environ.get("IACQUIRE_REQUIRE_PINNED_HERMES") == "1"');
  });
});
