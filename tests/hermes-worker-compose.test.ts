import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Regression for the A1 install: `tmpfs: [/tmp:rw,noexec,nosuid,nodev,size=32m]` is a YAML flow
// list, so the commas split it into five items and `docker compose up` refused to create any
// container ("invalid mount path: 'nodev' mount path must be absolute"). CI only validated the
// file, never started the services, so it passed. The options must stay inside one quoted string.

const root = resolve(__dirname, "..");
const compose = readFileSync(join(root, "services/hermes-inference-worker/compose.internal.yaml"), "utf8");
const workflow = readFileSync(join(root, ".github/workflows/hermes-inference-worker.yml"), "utf8");

describe("worker Compose tmpfs", () => {
  const tmpfsLines = compose.split("\n").filter((line) => /^\s*tmpfs:/.test(line));

  it("declares exactly two tmpfs mounts: the worker base and the proxy", () => {
    expect(tmpfsLines).toHaveLength(2);
  });

  it.each(tmpfsLines)("keeps the options in one quoted string: %s", (line) => {
    expect(line.trim()).toMatch(/^tmpfs: \["\/tmp:rw,noexec,nosuid,nodev,size=\d+m"\]$/);
  });

  it("has no unquoted comma inside a tmpfs flow list", () => {
    for (const line of tmpfsLines) expect(line).not.toMatch(/\[[^"\]]*,/);
  });

  it("is checked in CI against the rendered Compose configuration, not just parsed", () => {
    expect(workflow).toContain('assert service.get("tmpfs") == ["/tmp:rw,noexec,nosuid,nodev,size=32m"]');
    expect(workflow).toContain('assert services[proxy_name].get("tmpfs") == ["/tmp:rw,noexec,nosuid,nodev,size=8m"]');
  });
});
