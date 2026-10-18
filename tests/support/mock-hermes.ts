// Local test double for the Hermes Agent API server. It implements the documented endpoints the
// portal uses so the adapter, streaming and persistence can be tested end to end without a live
// Hermes instance. Every reply is labelled as coming from a test double.
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

export interface MockProfile {
  key: string;
  /** Tools to report from /v1/toolsets. */
  tools?: string[];
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
  close(): Promise<void>;
}

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
    const p = profile ? profiles[profile] : undefined;
    const auth = req.headers.authorization ?? "";
    if (!p) return send(404, { error: "unknown profile" });
    if (auth !== `Bearer ${p.key}`) return send(401, { error: "unauthorized" });
    if (req.method === "GET" && pathname === "/v1/models") return send(200,{object:"list",data:[{id:profile,object:"model",owned_by:"hermes",root:profile,parent:null}]});

    if (req.method === "GET" && pathname === "/v1/capabilities") {
      return send(200, {
        object: "hermes.api_server.capabilities",
        platform: "hermes-agent",
        model: profile,
        auth: { type: "bearer", required: true },
        features: { chat_completions: true, responses_api: true, run_submission: true, run_status: true, run_events_sse: !p.polling, run_stop: true, run_approval_response: true, approval_events: true },
      });
    }
    if (req.method === "GET" && pathname === "/v1/toolsets") {
      return send(200, { object: "list", platform: "api_server", data: [{ name: "core", label: "Core", enabled: true, configured: true, tools: p.tools ?? ["web_search", "memory", "clarify"] }] });
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
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
