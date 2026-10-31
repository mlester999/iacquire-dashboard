import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The A1 preflight is only worth running on the VPS and in Cloudflare if it can be trusted to
// change nothing, to print no secret, and to describe the same worker the Compose file builds.

const root = resolve(__dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const vpsScript = read("scripts/hermes-a1-preflight.sh");
const cloudflareScript = read("scripts/hermes-a1-cloudflare-readonly.mjs");
const compose = read("services/hermes-inference-worker/compose.internal.yaml");
const runner = read("services/hermes-inference-worker/inference_runner.py");
const dockerfile = read("services/hermes-inference-worker/Dockerfile");
const deployment = read("services/hermes-inference-worker/DEPLOYMENT.md");

const codeLines = (source: string) => source.split("\n").filter((line) => !/^\s*#/.test(line));
// Quoted text and arithmetic can contain > and <; only real shell syntax counts as a redirect.
const shellSyntaxOnly = (line: string) => line
  .replace(/\$\(\(.*\)\)/g, "0")
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  .replace(/'[^']*'/g, "''");

const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
const workDirs: string[] = [];

// The fake docker below is a script the preflight has to execute. CI mounts /tmp noexec, so the script
// goes in the first scratch directory where a script can actually run: the system temp directory,
// else the workspace's node_modules/.cache (ignored by git).
function executableScratchDir(): string | null {
  for (const base of [tmpdir(), join(root, "node_modules", ".cache")]) {
    let dir: string | null = null;
    try {
      mkdirSync(base, { recursive: true });
      dir = mkdtempSync(join(base, "a1-preflight-bin-"));
      const probe = join(dir, "probe");
      writeFileSync(probe, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      // Run it through bash, the way the preflight does, so a noexec mount fails here and Windows still works.
      if (spawnSync("bash", ["-c", '"$1"', "probe", probe.replace(/\\/g, "/")]).status === 0) return dir;
    } catch {
      // try the next location
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  return null;
}
afterAll(() => { for (const dir of workDirs) rmSync(dir, { recursive: true, force: true }); });

describe("VPS preflight script is read-only", () => {
  const MUTATING: Array<[string, RegExp, ((line: string) => string)?]> = [
    ["a Docker command that creates, changes or removes something", /\b(?:docker|D) (?:run|pull|create|rm|rmi|stop|start|restart|kill|pause|unpause|build|push|login|logout|cp|commit|tag|load|save|update|rename|prune)\b/],
    ["a Docker network, volume or compose change", /\b(?:docker|D) (?:network|volume|system|image|container|compose) (?:create|connect|disconnect|rm|prune|up|down|run|build|pull|start|stop|restart)\b/],
    ["a file or permission change", /(?:^|[\s;|&(])(?:rm|mv|cp|chmod|chown|chgrp|mkdir|rmdir|touch|ln|tee|truncate|dd|install|useradd|usermod|userdel)\s/],
    ["a service, firewall or package change", /(?:^|[\s;|&(])(?:systemctl\s+(?:start|stop|restart|enable|disable|reload|mask|daemon-reload)|ufw\s+(?:allow|deny|enable|disable|delete|reset|limit)|iptables|nft|apt(?:-get)?\s+(?:install|remove|upgrade)|yum|dnf|pip3?\s+install|npm\s+install|reboot|shutdown|kill|pkill)\b/],
    ["an in-place edit", /\bsed\s+(?:-[a-zA-Z]*i|--in-place)/],
    ["a request that sends data", /\bcurl\b[^|\n]*(?:\s-X\s|\s-d\s|--data|--upload|-F\s|--form)/],
    ["a redirect into a file", /(?:^|[^<>&0-9-])>>?\s*(?!&|\/dev\/null)\S/, shellSyntaxOnly],
  ];

  it.each(MUTATING)("contains no %s", (_label, pattern, view) => {
    const offenders = codeLines(vpsScript).filter((line) => pattern.test(view ? view(line) : line));
    expect(offenders).toEqual([]);
  });

  it("allows exactly one docker exec, gated behind PREFLIGHT_ALLOW_EXEC and limited to --version", () => {
    const execs = codeLines(vpsScript).filter((line) => /\bdocker exec\b/.test(line));
    expect(execs).toHaveLength(1);
    expect(execs[0]).toContain("cloudflared --version");
    expect(vpsScript).toMatch(/if \[ "\$ALLOW_EXEC" = "1" \]; then\s*\n\s*info "cloudflared version \(docker exec/);
  });

  it("never inspects environment, command or arguments in a way that can print them", () => {
    const printed = codeLines(vpsScript).filter((line) => /\.Config\.(?:Env|Cmd|Entrypoint)|\.Args/.test(line));
    expect(printed).toHaveLength(1);
    expect(printed[0]).toMatch(/\| grep -Eq /);
  });

  it("reads its settings from the environment and runs the body with stdin closed", () => {
    expect(vpsScript).toMatch(/^main "\$@" <\/dev\/null$/m);
    expect(vpsScript).toContain("exec 2>&1");
  });

  it("maps the six roles to the same profile directories as the Compose file and the runner", () => {
    const script = [...vpsScript.matchAll(/^\s+"([a-z_]+) (iacquire-[a-z-]+)"$/gm)].map((m) => [m[1], m[2]]);
    const composeDirs = [...compose.matchAll(/IACQUIRE_WORKER_PROFILE_BASE[^}]*\}\/(iacquire-[a-z-]+)/g)].map((m) => m[1]);
    const runnerMap = [...runner.matchAll(/^\s+"([a-z_]+)": "(iacquire-[a-z-]+)",$/gm)].map((m) => [m[1], m[2]]);
    expect(script).toHaveLength(6);
    expect(script).toEqual(runnerMap);
    expect(script.map(([, dir]) => dir).sort()).toEqual([...composeDirs].sort());
  });

  it("uses the same model allow-list, base image pin and worker UID as the worker", () => {
    const models = runner.match(/ALLOWED_MODELS = \{([^}]*)\}/)?.[1].match(/"([^"]+)"/g)?.map((m) => m.replace(/"/g, "")) ?? [];
    expect(vpsScript).toContain(`ALLOWED_MODELS="${models.join(" ")}"`);
    const pin = dockerfile.match(/HERMES_BASE_IMAGE=(docker\.io\/nousresearch\/hermes-agent@sha256:[0-9a-f]{64})/)?.[1];
    expect(pin).toBeTruthy();
    expect(vpsScript).toContain(`BASE_IMAGE="${pin}"`);
    expect(compose).toContain('user: "10000:10000"');
    expect(vpsScript).toContain("WORKER_UID=10000");
    expect(vpsScript).toContain("WORKER_GID=10000");
  });

  it("keeps the new HMAC secret out of the Hermes data directory and the build context", () => {
    expect(vpsScript).toMatch(/"\$DATA"\/\*\) fail/);
    expect(vpsScript).toMatch(/"\$COMPOSE_ROOT"\/\*\) fail/);
    expect(vpsScript).toContain("/etc/iacquire-hermes-inference/inference_hmac");
  });

  it.skipIf(!hasBash)("passes bash -n and prints no secret from a profile tree, a .env or the tunnel container", () => {
    expect(spawnSync("bash", ["-n", join(root, "scripts/hermes-a1-preflight.sh")]).status).toBe(0);

    const dir = mkdtempSync(join(tmpdir(), "a1-preflight-"));
    workDirs.push(dir);
    const profiles = join(dir, "data", "profiles");
    for (const dirName of ["iacquire-operations-manager", "iacquire-lead-hunter", "iacquire-appointment-setter", "iacquire-sales-assistant", "iacquire-crm-manager", "iacquire-analyst"]) {
      const p = join(profiles, dirName);
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "SOUL.md"), "You are a test employee.\n");
      writeFileSync(join(p, "config.yaml"), "model:\n  default: deepseek-flash\n  provider: deepseek\n  api_key: sk-CANARYCONFIGKEY0001\n");
      writeFileSync(join(p, ".env"), "DEEPSEEK_API_KEY=sk-LEAKCANARY1234567890abcdef\nOTHER=topsecretvalue99\nDEEPSEEK_BASE_URL=https://user:LEAKCANARYPASS@api.deepseek.com/v1?token=LEAKCANARYURL\n");
    }
    writeFileSync(join(dir, "data", ".env"), "DEEPSEEK_API_KEY=sk-LEAKCANARYSHARED000000\n");
    const bin = executableScratchDir();
    if (!bin) throw new Error("no scratch directory allows running scripts, so the fake docker cannot run");
    workDirs.push(bin);
    writeFileSync(join(bin, "docker"), [
      "#!/usr/bin/env bash",
      'cmd=$1; shift',
      'case "$cmd" in',
      '  version) echo 27.3.1 ;;',
      '  compose) echo 2.29.7 ;;',
      '  info) case "$*" in *DockerRootDir*) echo /var/lib/docker ;; *SecurityOptions*) echo "[name=seccomp]" ;; *Warnings*) ;; *) echo overlay2 ;; esac ;;',
      '  ps) echo "iacquire-hermes-tunnel   cloudflare/cloudflared:2026.10.1   Up 3 days" ;;',
      '  network) echo "bridge   bridge   internal=false" ;;',
      '  image) exit 1 ;;',
      '  system) echo "TYPE TOTAL" ;;',
      '  inspect) name=${*: -1}; [ "$name" = "iacquire-hermes-tunnel" ] || exit 1; [ "$1" = "-f" ] || exit 0',
      '    case "$2" in *.Config.Env*) echo \'["TUNNEL_TOKEN=eyJLEAKTOKENabcdefghijkl"] ["tunnel","run"] [] []\' ;; "{{.State.Status}}") echo running ;; *) echo ok ;; esac ;;',
      '  *) exit 1 ;;',
      'esac',
      "",
    ].join("\n"), { mode: 0o755 });

    const posix = (p: string) => p.replace(/\\/g, "/");
    const result = spawnSync("bash", [join(root, "scripts/hermes-a1-preflight.sh")], {
      encoding: "utf8",
      env: { ...process.env, HERMES_DATA_DIR: posix(join(dir, "data")), PREFLIGHT_OFFLINE: "1", PATH: `${posix(bin)}:${process.env.PATH}` },
      timeout: 60_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("== Summary ==");
    expect(output).not.toMatch(/LEAKCANARY|CANARYCONFIGKEY|topsecretvalue|LEAKTOKEN|TUNNEL_TOKEN|eyJ/);
    expect(output).toContain("DEEPSEEK_API_KEY is present with 12 or more characters (value not shown)");
    expect(output).toContain("connector is token-managed");
    expect(output).toMatch(/sha256 config\.yaml = [0-9a-f]{64}/);
  }, 90_000);
});

describe("Cloudflare inspector is read-only and matches the deployment notes", () => {
  it("issues only GET requests, to api.cloudflare.com, through a single fetch", () => {
    const code = codeLines(cloudflareScript).filter((line) => !/^\s*\/\//.test(line)).join("\n");
    expect(code.match(/\bfetch\(/g)).toHaveLength(1);
    expect(code).toContain('method: "GET"');
    expect(code).not.toMatch(/method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i);
    expect(code).not.toMatch(/\bbody:/);
    expect(code).toContain('const API = "https://api.cloudflare.com/client/v4"');
  });

  it("never prints the token", () => {
    const logging = cloudflareScript.split("\n").filter((line) => /console\.(?:log|error)|say\(/.test(line));
    expect(logging.filter((line) => /\btoken\b(?!s|Id|Names|sById|\.)/.test(line) && /\$\{token\}|, token\)|\+ token/.test(line))).toEqual([]);
    expect(cloudflareScript).not.toMatch(/console\.\w+\([^)]*process\.env\.CF_API_TOKEN/);
  });

  it("plans exactly the six rules in DEPLOYMENT.md", () => {
    const rows = [...deployment.matchAll(/^\| `(\^\/internal\/inference\/v1\/([a-z_]+)\/infer\$)` \| `([^`]+)` \|$/gm)].map((m) => ({ role: m[2], path: m[1], service: m[3] }));
    expect(rows).toHaveLength(6);
    const loaded = spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(`file:///${join(root, "scripts/hermes-a1-cloudflare-readonly.mjs").replace(/\\/g, "/")}`)}).then((m) => console.log(JSON.stringify(m.PLANNED_ROUTES)))`], { encoding: "utf8" });
    expect(loaded.status).toBe(0);
    expect(JSON.parse(loaded.stdout)).toEqual(rows);
  });

  it("passes its own offline self-test", () => {
    const run = spawnSync(process.execPath, [join(root, "scripts/hermes-a1-cloudflare-readonly.mjs"), "--self-test"], { encoding: "utf8" });
    expect(run.stdout).toContain("self-test passed");
    expect(run.status).toBe(0);
  });

  it("refuses to run without its three settings instead of calling anything", () => {
    const env = { ...process.env };
    delete env.CF_API_TOKEN; delete env.CF_ACCOUNT_ID; delete env.HERMES_HOST;
    const run = spawnSync(process.execPath, [join(root, "scripts/hermes-a1-cloudflare-readonly.mjs")], { encoding: "utf8", env });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Set CF_API_TOKEN, CF_ACCOUNT_ID and HERMES_HOST");
  });
});
