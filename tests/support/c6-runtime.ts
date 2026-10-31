// Helpers for the pinned-runtime compatibility proof (C6): a real, pinned Hermes 0.21.5 plus the repository's catalog overlay, run in a disposable home, talking to the real business MCP
// handler served on loopback. Nothing here touches a live gateway or profile: the home, the profiles, the keys and the ports are all created for the run and removed afterwards.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

export interface PinnedRuntime {
  /** The Python of the pinned runtime's virtual environment. */
  python: string;
  /** The Hermes 0.21.5 source with the catalog overlay applied (PYTHONPATH). */
  source: string;
  /** Optional: the same source WITHOUT the overlay, used as a control. */
  baselineSource: string | null;
}

export function pinnedRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): PinnedRuntime | null {
  const python = env.IACQUIRE_C6_PYTHON?.trim();
  const source = env.IACQUIRE_C6_HERMES_SOURCE?.trim();
  if (!python || !source) return null;
  return { python, source, baselineSource: env.IACQUIRE_C6_BASELINE_SOURCE?.trim() || null };
}

/** A clean environment for the runtime: nothing from the developer's shell (no provider keys, no HERMES_* variables) reaches it. */
export function cleanRuntimeEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const keep = process.platform === "win32" ? ["SystemRoot", "SYSTEMROOT", "SystemDrive", "COMSPEC", "PATHEXT", "WINDIR"] : ["LANG", "LC_ALL"];
  const env: Record<string, string | undefined> = {};
  for (const name of keep) if (process.env[name] !== undefined) env[name] = process.env[name];
  env.PATH = process.platform === "win32" ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32` : "/usr/local/bin:/usr/bin:/bin";
  // A home directory of its own, so nothing is read from or written to the developer's or the runner's real one.
  if (process.platform !== "win32") {
    const fakeHome = path.join(tmpdir(), "iaq-c6-home");
    mkdirSync(fakeHome, { recursive: true });
    env.HOME = fakeHome;
  }
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.PYTHONUNBUFFERED = "1";
  env.NO_COLOR = "1";
  env.PYTHONIOENCODING = "utf-8";
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export interface Disposable {
  root: string;
  dispose(): void;
}

export function disposableRoot(prefix = "iaq-c6-"): Disposable {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) };
}

export interface ProfileSpec {
  name: string;
  /** The profile's own API_SERVER_KEY (what the portal would hold in its vault). */
  apiKey: string;
  /** The business MCP credential written to the profile's .env, or null for none. */
  credential: string | null;
  /** The mcp_servers entry, or null for a profile with no MCP entry. */
  mcpUrl: string | null;
  /** Toolsets for platform_toolsets.api_server. */
  toolsets: readonly string[];
}

const DISABLED_TOOLSETS = ["browser", "code_execution", "computer_use", "connections", "cronjob", "delegation", "file", "image_gen", "skills", "terminal", "catalog", "kanban"];

export function profileConfigYaml(spec: Pick<ProfileSpec, "mcpUrl" | "toolsets">): string {
  const lines = [
    "platform_toolsets:",
    "  api_server:",
    ...spec.toolsets.map((toolset) => `    - ${toolset}`),
    "agent:",
    "  disabled_toolsets:",
    ...DISABLED_TOOLSETS.map((toolset) => `    - ${toolset}`),
    "terminal:",
    "  backend: docker",
    "  docker_forward_env: []",
    "  container_persistent: false",
  ];
  if (spec.mcpUrl) {
    lines.push(
      "mcp_servers:",
      "  iacquire_business:",
      `    url: ${spec.mcpUrl}`,
      "    headers:",
      '      Authorization: "Bearer ${IACQUIRE_BUSINESS_MCP_TOKEN}"',
      "    tool_timeout: 12",
    );
  }
  return `${lines.join("\n")}\n`;
}

interface RunResult { status: number | null; stdout: string; stderr: string }

/** Runs the runtime's Python and waits for it WITHOUT blocking this process: the business MCP handler is served from this same process, so a blocking wait would starve it. */
function run(runtime: PinnedRuntime, args: string[], env: Record<string, string>, source = runtime.source, timeout = 120_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.python, args, { env: cleanRuntimeEnv({ PYTHONPATH: source, ...env }), cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-6000); });
    const timer = setTimeout(() => {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGKILL");
      reject(new Error(`The runtime command timed out after ${timeout} ms: ${redact(stderr).slice(-300)}`));
    }, timeout);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

/** Creates the disposable home with the given profiles, through the runtime's own CLI (so the layout is whatever this Hermes version expects). */
export async function createHome(runtime: PinnedRuntime, home: string, port: number, profiles: readonly ProfileSpec[]): Promise<void> {
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "config.yaml"), `gateway:\n  multiplex_profiles: true\n  api_server:\n    enabled: true\n    host: 127.0.0.1\n    port: ${port}\n    max_concurrent_runs: 1\n`, "utf8");
  for (const profile of profiles) {
    const created = await run(runtime, ["-m", "hermes_cli.main", "profile", "create", profile.name, "--no-alias", "--no-skills"], { HERMES_HOME: home });
    if (created.status !== 0) throw new Error(`Could not create the disposable profile ${profile.name} (exit ${created.status}): ${String(created.stderr).slice(-300)}`);
    const dir = path.join(home, "profiles", profile.name);
    writeFileSync(path.join(dir, "config.yaml"), profileConfigYaml(profile), "utf8");
    const env = ["API_SERVER_ENABLED=true", `API_SERVER_KEY=${profile.apiKey}`, ...(profile.credential ? [`IACQUIRE_BUSINESS_MCP_TOKEN=${profile.credential}`] : [])];
    writeFileSync(path.join(dir, ".env"), `${env.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

export interface GatewayHandle {
  port: number;
  base: string;
  stop(): Promise<void>;
  /** The last lines of the gateway's error log, with anything key-shaped removed. */
  logTail(): string;
}

/** Removes anything credential- or key-shaped from text that may be shown: the business credential, and long tokens that contain a digit (tool names have none). */
function redact(text: string): string {
  return text.replace(/iamcp1\.[A-Za-z0-9_.-]+/g, "<credential>").replace(/(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}/g, "<redacted>");
}

export async function startGateway(runtime: PinnedRuntime, home: string, port: number, rootKey: string, source = runtime.source): Promise<GatewayHandle> {
  const child: ChildProcess = spawn(
    runtime.python,
    ["-m", "hermes_cli.main", "gateway", "run"],
    {
      env: cleanRuntimeEnv({
        PYTHONPATH: source, HERMES_HOME: home, API_SERVER_ENABLED: "true", API_SERVER_HOST: "127.0.0.1", API_SERVER_PORT: String(port), API_SERVER_KEY: rootKey,
      }),
      cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-6000); });
  child.stdout?.on("data", () => undefined);
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The pinned gateway exited early (code ${child.exitCode}): ${redact(stderr).slice(-400)}`);
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error(`The pinned gateway did not become ready in time: ${redact(stderr).slice(-400)}`); }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return {
    port, base,
    logTail: () => redact(stderr),
    async stop() {
      if (child.exitCode === null) {
        if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else child.kill("SIGTERM");
      }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8_000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

export interface ProbeReport {
  ok: boolean;
  error?: string;
  hermes: { version: string | null; python: string; mcp_sdk: string | null };
  discovered: Array<{ name: string; toolset: string | null; arguments: string[] }>;
  warnings: string[];
  call?: { tool: string; registered: boolean; error: string | null; bytes: number; contains: Record<string, boolean>; excludes: Record<string, boolean>; keys: string[] | null };
}

export interface ProbeCall { tool: string; arguments?: Record<string, unknown>; contains?: string[]; excludes?: string[] }

/** Runs the in-runtime probe against one profile directory (as a single-profile Hermes home) and returns its report. A call spec goes through a file, so no shell quoting is involved. */
export async function runProbe(runtime: PinnedRuntime, probeScript: string, profileDir: string, call?: ProbeCall, source = runtime.source): Promise<ProbeReport> {
  const args = [probeScript, "discover"];
  let specFile: string | null = null;
  if (call) {
    specFile = path.join(tmpdir(), `iaq-probe-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(specFile, JSON.stringify({ tool: call.tool, arguments: call.arguments ?? {}, expect: { contains: call.contains ?? [], excludes: call.excludes ?? [] } }), "utf8");
    args.splice(1, 1, "call", specFile);
  }
  try {
    const result = await run(runtime, args, { HERMES_HOME: profileDir }, source, 150_000);
    const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
    try {
      return JSON.parse(line) as ProbeReport;
    } catch {
      throw new Error(`The probe printed no report (exit ${result.status}): ${redact(result.stderr).slice(-400)}`);
    }
  } finally {
    if (specFile) rmSync(specFile, { force: true });
  }
}

/** Bridges Node's HTTP server to a Web-standard request handler, exactly as the Next.js route does for the real endpoint. */
export function serveHandler(
  handler: (request: Request) => Promise<Response>,
): Promise<{ url: string; port: number; close(): Promise<void>; requests: Array<{ method: string; status: number; authorization: "none" | "present" }> }> {
  const requests: Array<{ method: string; status: number; authorization: "none" | "present" }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const origin = `http://${req.headers.host}`;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    const response = await handler(new Request(`${origin}${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : body }));
    requests.push({ method: req.method ?? "GET", status: response.status, authorization: req.headers.authorization ? "present" : "none" });
    const out = Buffer.from(await response.arrayBuffer());
    const outHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => { outHeaders[name] = value; });
    res.writeHead(response.status, outHeaders);
    res.end(out);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`, port, requests,
        close: () => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
      });
    });
  });
}
