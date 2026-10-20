// Local test double for the Hermes Agent API server. It implements the documented endpoints the
// portal uses so the adapter, streaming and persistence can be tested end to end without a live
// Hermes instance. Every reply is labelled as coming from a test double.
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

export interface MockInventoryTool {
  name: string;
  toolset?: string;
  source?: "configurable" | "recently_shipped" | "default_injected" | "mcp" | "unresolved";
  sourceServer?: string | null;
  addedBelowExplicitConfig?: boolean;
  available?: boolean;
  /** Drop the `parameters` schema, which every real gateway row carries. */
  omitParameters?: boolean;
}

export interface MockInventory {
  /** Defaults to the six reviewed tools. Use [] to prove an empty catalog is refused. */
  tools?: MockInventoryTool[];
  enabledToolsets?: string[];
  explicitConfigPresent?: boolean;
  /** False makes GET /v1/tools return 404, like Hermes 0.21.5. */
  advertised?: boolean;
  /** Return this status instead of a catalog (e.g. 503 for an unavailable inventory service). */
  status?: number;
  /** Whether the gateway certifies the catalog as complete. Defaults to true. */
  complete?: boolean;
  incompleteReason?: string;
  /** Echo X-Hermes-Inventory-Challenge as `challenge` (default true, like the patched gateway). */
  echoChallenge?: boolean;
  /** The `contract` the gateway reports. Defaults to the patched gateway's value; null omits the field. */
  contract?: string | null;
  /** Wrap each row as `{ type: "function", function: {...}, provenance }` instead of the flat live shape. */
  functionWrapped?: boolean;
  /** Return this challenge instead of the request's, to prove replay binding fails closed. */
  challengeOverride?: string;
  generatedAt?: string;
  expiresAt?: string;
  /** Delay catalog replies so tests can change database state during an acknowledgement workflow. */
  delayMs?: number;
  /** Return these tools from the second read onward, proving a changing inventory is detected. */
  changeAfterFirstRead?: MockInventoryTool[];
}

export interface MockProfile {
  key: string;
  /** Tools to report from /v1/toolsets. */
  tools?: string[];
  /** Complete runtime tool catalog controls for GET /v1/tools. */
  inventory?: MockInventory;
  /** Advertise no SSE stream; the run is completed through GET /v1/runs/{id} polling. */
  polling?: boolean;
  /** Override behaviour for a given input. */
  respond?: (input: string) => MockScript;
}

export type MockStep =
  | { delta: string }
  | { tool: string; ms?: number }
  | { approval: string }
  | { wait: number }
  | { fail: string }
  | { cancelOnly: true };

export interface MockScript {
  steps: MockStep[];
  output?: string;
}

interface Run {
  id: string;
  profile: string;
  script: MockScript;
  status: "running" | "completed" | "failed" | "cancelled";
  stopped: boolean;
  approvalResolved: "once" | "deny" | null;
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

export interface MockHermes {
  url: string;
  runs: Map<string, Run>;
  requests: Array<{ method: string; path: string; profile: string | null }>;
  /** Replace a profile's complete-inventory behaviour between assertions. */
  setInventory(profile: string, inventory: MockInventory | null): void;
  close(): Promise<void>;
}

const SAFE_TOOLSETS = ["memory", "session_search", "todo", "vision", "web"];
const SAFE_INVENTORY_TOOLS: MockInventoryTool[] = [
  { name: "memory", toolset: "memory" },
  { name: "session_search", toolset: "session_search" },
  { name: "todo_list", toolset: "todo" },
  { name: "vision_analyze", toolset: "vision" },
  { name: "web_search", toolset: "web" },
  { name: "web_extract", toolset: "web" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function defaultScript(input: string): MockScript {
  if (/research request/i.test(input)) {
    const output =
      '```json\n{"leads":[{"business_name":"Sample Co (test double)","website":"https://example.com","industry":"Dental","location":"Austin, TX","evidence":[{"url":"https://example.com/booking","observed_at":"2026-10-01T00:00:00Z","summary":"Online booking page lists limited hours"}],"buying_signals":["Hiring a receptionist"],"qualification_summary":"Fits the stated profile (test double data).","score":{"service_fit":40,"problem_evidence":20,"buying_intent":10,"market_fit":12,"source_quality":8}}]}\n```';
    return { steps: [{ tool: "web_search" }, { delta: output }], output };
  }
  const text = `**Local test double** — this is not a live AI response.\n\nYou said: "${input.slice(0, 200)}"`;
  return { steps: [{ tool: "memory", ms: 30 }, ...text.match(/.{1,12}/gs)!.map((d) => ({ delta: d }))], output: text };
}

export async function startMockHermes(profiles: Record<string, MockProfile>): Promise<MockHermes> {
  const runs = new Map<string, Run>();
  const requests: MockHermes["requests"] = [];
  const state = new Map<string, MockProfile>(Object.entries(profiles).map(([name, profile]) => [name, { ...profile }]));
  const inventoryReads = new Map<string, number>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let pathname = url.pathname;
    let profile: string | null = null;
    const m = pathname.match(/^\/p\/([^/]+)(\/.*)$/);
    if (m) {
      profile = decodeURIComponent(m[1]);
      pathname = m[2];
    }
    requests.push({ method: req.method ?? "GET", path: pathname, profile });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (pathname === "/health") return send(200, { status: "ok" });
    const p = profile ? state.get(profile) : undefined;
    const auth = req.headers.authorization ?? "";
    if (!p) return send(404, { error: "unknown profile" });
    if (auth !== `Bearer ${p.key}`) return send(401, { error: "unauthorized" });
    if (req.method === "GET" && pathname === "/v1/models") return send(200,{object:"list",data:[{id:profile,object:"model",owned_by:"hermes",root:profile,parent:null}]});

    if (req.method === "GET" && pathname === "/v1/capabilities") {
      const inventoryAdvertised = p.inventory?.advertised !== false;
      return send(200, {
        object: "hermes.api_server.capabilities",
        platform: "hermes-agent",
        model: profile,
        auth: { type: "bearer", required: true },
        features: { chat_completions: true, responses_api: true, run_submission: true, run_status: true, run_events_sse: !p.polling, run_stop: true, run_approval_response: true, approval_events: true },
        endpoints: {
          toolsets: { method: "GET", path: "/v1/toolsets" },
          ...(inventoryAdvertised ? { tools: { method: "GET", path: "/v1/tools" } } : {}),
        },
      });
    }
    if (req.method === "GET" && pathname === "/v1/toolsets") {
      const sets = [
        { name: "web", label: "Web", enabled: true, configured: true, tools: ["web_search", "web_extract"] },
        { name: "memory", label: "Memory", enabled: true, configured: true, tools: ["memory"] },
        { name: "session_search", label: "Session search", enabled: true, configured: true, tools: ["session_search"] },
        { name: "todo", label: "Planning", enabled: true, configured: true, tools: ["todo_list"] },
        { name: "vision", label: "Vision", enabled: true, configured: true, tools: ["vision_analyze"] },
        ...(p.tools?.length ? [{ name: "core", label: "Core", enabled: true, configured: true, tools: p.tools }] : []),
      ];
      return send(200, { object: "list", platform: "api_server", data: sets });
    }
    if (req.method === "GET" && pathname === "/v1/tools") {
      const inventory = p.inventory ?? {};
      if (inventory.advertised === false) return send(404, { error: { message: "Unknown or unconfigured profile", type: "not_found" } });
      if (inventory.status) return send(inventory.status, { error: { message: "The complete tool inventory is unavailable.", type: "server_error" } });
      if (inventory.delayMs) await sleep(inventory.delayMs);
      const read = (inventoryReads.get(profile!) ?? 0) + 1;
      inventoryReads.set(profile!, read);
      const tools: MockInventoryTool[] = read > 1 && inventory.changeAfterFirstRead ? inventory.changeAfterFirstRead : inventory.tools ?? SAFE_INVENTORY_TOOLS;
      const challengeHeader = req.headers["x-hermes-inventory-challenge"];
      const challenge = Array.isArray(challengeHeader) ? challengeHeader[0] : challengeHeader;
      // Rows mirror the patched Hermes 0.21.5 gateway: the tool schema is flattened next to `provenance`, and
      // `available` appears on MCP rows only.
      const row = (tool: MockInventoryTool) => {
        const schema = {
          name: tool.name,
          description: `Reviewed ${tool.name} tool (test double).`,
          ...(tool.omitParameters ? {} : { parameters: { type: "object", properties: {} } }),
        };
        return {
          ...(inventory.functionWrapped ? { type: "function", function: schema } : schema),
          provenance: {
            source: tool.source ?? "configurable",
            toolset: tool.toolset ?? null,
            requested_toolsets: tool.toolset ? [tool.toolset] : [],
            source_server: tool.sourceServer ?? null,
            added_below_explicit_config: tool.addedBelowExplicitConfig ?? false,
          },
          ...(tool.available !== undefined ? { available: tool.available } : {}),
        };
      };
      return send(200, {
        object: "list",
        platform: "api_server",
        ...(inventory.contract === null ? {} : { contract: inventory.contract ?? "hermes.api_server.tool_catalog.v1" }),
        complete: inventory.complete ?? true,
        incomplete_reason: inventory.incompleteReason ?? null,
        explicit_config_present: inventory.explicitConfigPresent ?? true,
        enabled_toolsets: inventory.enabledToolsets ?? SAFE_TOOLSETS,
        data: tools.map(row),
        ...(inventory.echoChallenge !== false && challenge ? { challenge: inventory.challengeOverride ?? challenge } : {}),
        ...(inventory.generatedAt ? { generated_at: inventory.generatedAt } : {}),
        ...(inventory.expiresAt ? { expires_at: inventory.expiresAt } : {}),
      });
    }
    if (req.method === "POST" && pathname === "/v1/runs") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      const input = String(body.input ?? "");
      const id = `run_${crypto.randomBytes(6).toString("hex")}`;
      runs.set(id, { id, profile: profile!, script: (p.respond ?? defaultScript)(input), status: "running", stopped: false, approvalResolved: null, body, headers: req.headers });
      return send(202, { run_id: id, status: "started" });
    }
    const runMatch = pathname.match(/^\/v1\/runs\/([^/]+)(\/events|\/stop|\/approval)?$/);
    if (runMatch) {
      const run = runs.get(runMatch[1]);
      if (!run || run.profile !== profile) return send(404, { error: "not found" });
      const action = runMatch[2];
      if (!action && req.method === "GET") {
        // A polling-only profile completes the script when its status is read. Used to prove the non-streaming
        // fallback without inventing a second event contract.
        if (p.polling) {
          if (run.stopped) {
            run.status = "cancelled";
            return send(200, { object: "hermes.run", run_id: run.id, status: "cancelled" });
          }
          let text = "";
          let failure: string | null = null;
          for (const step of run.script.steps) {
            if ("delta" in step) text += step.delta;
            if ("fail" in step) failure = step.fail;
          }
          if (failure) {
            run.status = "failed";
            return send(200, { object: "hermes.run", run_id: run.id, status: "failed", error: failure });
          }
          run.status = "completed";
          return send(200, {
            object: "hermes.run",
            run_id: run.id,
            status: "completed",
            output: run.script.output ?? text,
            usage: { input_tokens: 42, output_tokens: 17, total_tokens: 59 },
          });
        }
        return send(200, { object: "hermes.run", run_id: run.id, status: run.status });
      }
      if (action === "/stop" && req.method === "POST") {
        run.stopped = true;
        return send(200, { status: "stopping" });
      }
      if (action === "/approval" && req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        // Mirrors Hermes: { choice, request_id? }; anything else is rejected with 400.
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { choice?: unknown; request_id?: unknown };
        if (body.choice !== "once" && body.choice !== "deny") return send(400, { error: { code: "invalid_approval_choice" } });
        if (body.request_id !== undefined && body.request_id !== "appr_1") return send(409, { error: { code: "approval_not_pending" } });
        run.approvalResolved = body.choice;
        return send(200, { object: "hermes.run.approval_response", run_id: run.id, choice: body.choice });
      }
      if (action === "/events" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const emit = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        res.write(": keepalive\n\n");
        let text = "";
        for (const step of run.script.steps) {
          if (run.stopped) break;
          if ("delta" in step) {
            text += step.delta;
            emit("message.delta", { run_id: run.id, delta: step.delta });
            await sleep(2);
          } else if ("tool" in step) {
            emit("tool.started", { tool: step.tool, preview: "…" });
            await sleep(step.ms ?? 5);
            emit("tool.completed", { tool: step.tool, duration: (step.ms ?? 5) / 1000, error: false, preview: "ok" });
          } else if ("approval" in step) {
            emit("approval.request", { event: "approval.request", run_id: run.id, request_id: "appr_1", pattern_key: step.approval, description: `Run ${step.approval}`, command: "[redacted]", choices: ["once", "deny"] });
            for (let i = 0; i < 400 && !run.approvalResolved && !run.stopped; i++) await sleep(10);
          } else if ("wait" in step) {
            for (let i = 0; i < step.wait / 10 && !run.stopped; i++) await sleep(10);
          } else if ("fail" in step) {
            run.status = "failed";
            emit("run.failed", { run_id: run.id, error: step.fail, completed: false });
            return res.end();
          } else if ("cancelOnly" in step) {
            for (let i = 0; i < 500 && !run.stopped; i++) await sleep(10);
          }
        }
        if (run.stopped) {
          run.status = "cancelled";
          emit("run.cancelled", { run_id: run.id, interrupted: true, completed: false });
        } else {
          run.status = "completed";
          emit("run.completed", { run_id: run.id, completed: true, output: run.script.output ?? text, usage: { input_tokens: 42, output_tokens: 17, total_tokens: 59 } });
        }
        return res.end();
      }
    }
    return send(404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    runs,
    requests,
    setInventory(profile: string, inventory: MockInventory | null) {
      const existing = state.get(profile);
      if (!existing) throw new Error(`unknown mock profile: ${profile}`);
      state.set(profile, { ...existing, inventory: inventory ?? undefined });
      inventoryReads.delete(profile);
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
