import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const compose = readFileSync(join(root, "services/hermes-inference-worker/compose.internal.yaml"), "utf8");
const workflow = readFileSync(join(root, ".github/workflows/hermes-inference-worker.yml"), "utf8");
const runtimeCheck = readFileSync(
  join(root, "services/hermes-inference-worker/test_compose_tmpfs_runtime.py"),
  "utf8",
);

describe("worker Compose tmpfs", () => {
  const tmpfsLines = compose.split("\n").filter((line) => /^\s*tmpfs:/.test(line));

  it("declares exactly two tmpfs definitions: the worker base and the proxy", () => {
    expect(tmpfsLines).toHaveLength(2);
  });

  it.each(tmpfsLines)("keeps the options in one quoted string: %s", (line) => {
    expect(line.trim()).toMatch(/^tmpfs: \["\/tmp:rw,noexec,nosuid,nodev,size=\d+m"\]$/);
  });

  it("has no unquoted comma inside a tmpfs flow list", () => {
    for (const line of tmpfsLines) expect(line).not.toMatch(/\[[^"\]]*,/);
  });

  it("checks the exact rendered tmpfs settings for workers and the proxy", () => {
    expect(workflow).toContain('assert service.get("tmpfs") == ["/tmp:rw,noexec,nosuid,nodev,size=32m"]');
    expect(workflow).toContain('assert proxy.get("tmpfs") == ["/tmp:rw,noexec,nosuid,nodev,size=8m"]');
  });

  it("runs all seven services in disposable no-network containers and checks the kernel mount table", () => {
    expect(workflow).toContain("test_compose_tmpfs_runtime.py");
    expect(workflow).toContain("v5.5.1");
    expect(workflow).toContain("db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576");
    expect(runtimeCheck).toContain("/proc/self/mountinfo");
    expect(runtimeCheck).toMatch(/"--network",\s*"none"/);
    expect(runtimeCheck).toContain("EXPECTED_MOUNTS");
  });
});
