import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Reads .github/workflows/hermes-inference-worker.yml as text. The guard keeps the workflow reachable from this branch and from pull
// requests to master (GP-QA-11) without loosening any of its safety properties.
const workflow = readFileSync(join(process.cwd(), ".github/workflows/hermes-inference-worker.yml"), "utf8").replace(/\r\n/g, "\n");
const lines = workflow.split("\n");
const BRANCH = "claude/ai-growth-partner-completion";
const CANDIDATE = "codex/growth-partner-release-candidate";

function codeLines() {
  return lines.filter((line) => !line.trimStart().startsWith("#"));
}

/** The lines nested under a top-level key (2-space indent children), up to the next top-level key. */
function topLevelBlock(key: string) {
  const start = lines.findIndex((line) => line === `${key}:`);
  expect(start, `top-level key ${key}`).toBeGreaterThanOrEqual(0);
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.length > 0 && !line.startsWith(" ")) break;
    block.push(line);
  }
  return block;
}

function jobBlock(job: string) {
  const jobs = topLevelBlock("jobs");
  const start = jobs.findIndex((line) => line === `  ${job}:`);
  expect(start, `job ${job}`).toBeGreaterThanOrEqual(0);
  const block: string[] = [];
  for (const line of jobs.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

describe("CI workflow triggers (hermes-inference-worker.yml)", () => {
  it("runs on a push to this branch, next to the existing branches and the isolated release candidate", () => {
    const push = topLevelBlock("on").join("\n");
    const branches = push.slice(push.indexOf("branches:"), push.indexOf("paths:"));
    for (const name of ["codex/internal-iacquire-activation", "codex/ai-growth-partner", "integration/hermes-bridge-final", BRANCH, CANDIDATE]) {
      expect(branches).toContain(`      - ${name}\n`);
    }
  });

  it("keeps the release branch isolated from Vercel while running synthetic Hermes", () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8"));
    expect(vercel.git.deploymentEnabled).toEqual({ [CANDIDATE]: false });
    const hermes = readFileSync(join(process.cwd(), ".github/workflows/hermes-client-acceptance.yml"), "utf8");
    expect(hermes).toContain(`      - ${CANDIDATE}`);
    expect(hermes).toContain(`github.ref_name == '${CANDIDATE}'`);
    expect(hermes).toContain(`"$GITHUB_REF_NAME" == ${CANDIDATE}`);
    expect(hermes).toContain("      - .github/hermes-acceptance.trigger");
  });

  it("keeps the paths filter on push", () => {
    const on = topLevelBlock("on").join("\n");
    const pushBlock = on.slice(on.indexOf("  push:"), on.indexOf("  pull_request:"));
    expect(pushBlock).toContain("    paths:");
    expect(pushBlock).toContain("      - src/**");
    expect(pushBlock).toContain("      - tests/**");
    expect(pushBlock).toContain("      - .github/workflows/hermes-inference-worker.yml");
  });

  it("has a pull_request trigger for master with no paths filter, and never pull_request_target", () => {
    const on = topLevelBlock("on").join("\n");
    expect(on).toContain("  pull_request:\n    branches:\n      - master\n");
    const pr = on.slice(on.indexOf("  pull_request:"), on.indexOf("  workflow_dispatch:"));
    expect(pr).not.toContain("paths");
    expect(pr).not.toContain("paths-ignore");
    expect(workflow).not.toContain("pull_request_target");
  });

  it("lets all three jobs run for a pull request and for this branch", () => {
    for (const job of ["app-checks", "client-runtime-ops-tests", "worker-build-and-smoke"]) {
      const condition = jobBlock(job)
        .split("\n")
        .find((line) => line.startsWith("    if: "));
      expect(condition, job).toBeDefined();
      expect(condition).toContain("github.event_name == 'pull_request' || contains(fromJSON(");
      expect(condition).toContain(`"${BRANCH}"`);
      expect(condition).toContain("github.ref_name");
      // Evaluate the allowlist the way Actions does: a pull request has ref_name "N/merge", a push has the branch name.
      const list = JSON.parse(/fromJSON\('(\[.*?\])'\)/.exec(condition!)![1]) as string[];
      expect(list).toEqual([
        "codex/internal-iacquire-activation",
        "codex/ai-growth-partner",
        "integration/hermes-bridge-final",
        BRANCH,
        CANDIDATE,
      ]);
      expect(list).not.toContain("123/merge");
    }
  });

  it("keeps the ancestor-SHA check for pushes only and gives pull requests a whitespace check against the base", () => {
    for (const job of ["app-checks", "worker-build-and-smoke"]) {
      const block = jobBlock(job);
      const step = block.slice(block.indexOf("      - name: Verify the candidate contains the approved changes"));
      expect(step.split("\n").slice(0, 3).join("\n"), job).toContain("if: github.event_name != 'pull_request'");
      expect(step, job).toContain("git merge-base --is-ancestor");
    }
    const prStep = jobBlock("app-checks");
    const variant = prStep.slice(prStep.indexOf("Check the pull request for whitespace errors against its base"));
    const head = variant.slice(0, variant.indexOf("      - name: Verify the candidate"));
    expect(head).toContain("if: github.event_name == 'pull_request'");
    expect(head).toContain("PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}");
    expect(head).toContain('git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --check "$PR_BASE_SHA" HEAD');
  });

  it("never interpolates a GitHub expression inside a run script", () => {
    let inRun = false;
    let runIndent = 0;
    for (const line of lines) {
      const indent = line.length - line.trimStart().length;
      if (inRun && line.trim() !== "" && indent <= runIndent) inRun = false;
      if (inRun) expect(line, line).not.toContain("${{");
      if (/^\s*run:\s*\|/.test(line)) {
        inRun = true;
        runIndent = indent;
      }
    }
    expect(workflow).not.toMatch(/run:\s*[^|\s].*\$\{\{/);
  });

  it("has contents: read as its only permission, at the top level and in no job", () => {
    expect(topLevelBlock("permissions").filter((line) => line.trim() !== "")).toEqual(["  contents: read"]);
    expect(codeLines().filter((line) => /^\s*permissions:/.test(line))).toHaveLength(1);
    expect(jobBlock("app-checks")).not.toContain("permissions:");
    expect(jobBlock("client-runtime-ops-tests")).not.toContain("permissions:");
    expect(jobBlock("worker-build-and-smoke")).not.toContain("permissions:");
  });

  it("pins every action to a 40-character commit SHA and never reads a repository secret", () => {
    const uses = codeLines().filter((line) => /^\s*-?\s*uses:/.test(line));
    expect(uses.length).toBe(6); // four checkouts and two setup-node steps
    for (const line of uses) {
      expect(line, line).toMatch(/uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40}(\s+#.*)?$/);
    }
    expect(codeLines().join("\n")).not.toMatch(/secrets\./);
    expect(workflow).not.toMatch(/\$\{\{\s*secrets\b/);
  });

  it("keeps checkout without persisted credentials, the digest-pinned images and the network-none runs", () => {
    const code = codeLines().join("\n");
    expect(code.match(/persist-credentials: false/g)?.length).toBe(4);
    const nodeImages = code.match(/node:24-bookworm-slim(@sha256:[0-9a-f]{64})?/g) ?? [];
    expect(nodeImages.length).toBeGreaterThan(0);
    for (const image of nodeImages) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(code).toContain("--network none");
    expect(code).toContain("concurrency:");
    expect(code).toContain("cancel-in-progress: true");
  });
});
