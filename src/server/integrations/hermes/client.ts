import "server-only";
import { validateIntegrationEndpoint } from "@/server/integrations/safety";

/**
 * Typed adapter for the Hermes Agent API server (gateway `api_server` platform).
 *
 * Only endpoints present in the Hermes source (gateway/platforms/api_server.py, api_server_runs.py)
 * are used:
 *   GET  /v1/capabilities            authenticated feature discovery
 *   GET  /v1/toolsets                toolsets enabled for the api_server platform
 *   POST /v1/runs                    start a run (Idempotency-Key supported)
 *   GET  /v1/runs/{id}               run status
 *   GET  /v1/runs/{id}/events        SSE lifecycle stream
 *   POST /v1/runs/{id}/stop          interrupt a run
 *   POST /v1/runs/{id}/approval      resolve a pending approval: { choice, request_id? }
 * With a multiplexed gateway every profile is served under /p/<profile>/ and must be called with
 * that profile's own API_SERVER_KEY. Keys never leave the server.
 */

export interface HermesConnection {
  baseUrl: string;
  profile: string | null;
  apiKey: string;
}

export type HermesErrorKind = "unreachable" | "auth_failed" | "not_found" | "rate_limited" | "bad_response" | "timeout" | "upstream";

export class HermesError extends Error {
  constructor(
    readonly kind: HermesErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface HermesCapabilities {
  contract: string | null;
  authenticated: boolean;
  model: string | null;
  features: Record<string, unknown>;
  supportsRuns: boolean;
  supportsEvents: boolean;
  supportsStop: boolean;
  supportsApproval: boolean;
}

export interface StartRunInput {
  input: string;
  instructions?: string;
  sessionId?: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  idempotencyKey: string;
  /** Stable long-term memory scope (X-Hermes-Session-Key). */
  memoryScope?: string;
}

export type HermesEvent =
  | { type: "delta"; text: string }
  | { type: "interim"; text: string }
  | { type: "tool_started"; tool: string; callId?: string }
  | { type: "tool_completed"; tool: string; callId?: string; durationMs?: number; error: boolean }
  | { type: "approval_request"; approvalId?: string; tool?: string; summary?: string }
  | { type: "completed"; output: string | null; usage: TokenUsage | null }
  | { type: "failed"; error: string; partialOutput?: string | null; usage: TokenUsage | null }
  | { type: "cancelled" }
  | { type: "interrupted"; error: string }
  | { type: "other"; name: string };

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

function endpoint(conn: HermesConnection, path: string): string {
  // Apply the same deployment-owned host policy to every legacy/chat adapter call too.
  const base = validateIntegrationEndpoint(conn.baseUrl);
  const prefix = conn.profile ? `/p/${encodeURIComponent(conn.profile)}` : "";
  return `${base}${prefix}${path}`;
}

function headers(conn: HermesConnection, extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${conn.apiKey}`, Accept: "application/json", ...extra };
}

async function request(conn: HermesConnection, path: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const { timeoutMs = 15000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(endpoint(conn, path), {
      ...rest,
      redirect: "error",
      signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new HermesError("timeout", "Hermes did not respond in time.");
    throw new HermesError("unreachable", "Hermes could not be reached.");
  }
  if (res.status === 401 || res.status === 403) throw new HermesError("auth_failed", "Hermes rejected the credential.", res.status);
  if (res.status === 404) throw new HermesError("not_found", "Hermes profile route was not found.", res.status);
  if (res.status === 429) throw new HermesError("rate_limited", "Hermes is at its concurrent-run limit.", res.status);
  if (res.status >= 500) throw new HermesError("upstream", `Hermes returned ${res.status}.`, res.status);
  return res;
}

export async function getCapabilities(conn: HermesConnection, timeoutMs = 8000): Promise<HermesCapabilities> {
  const res = await request(conn, "/v1/capabilities", { method: "GET", headers: headers(conn), timeoutMs });
  if (!res.ok) throw new HermesError("bad_response", `Unexpected capabilities status ${res.status}.`, res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new HermesError("bad_response", "Capabilities response was not JSON.");
  }
  const obj = (body ?? {}) as { object?:unknown; auth?:{required?:unknown;type?:unknown}; model?: unknown; features?: Record<string, unknown> };
  const features = obj.features && typeof obj.features === "object" ? obj.features : {};
  return {
    contract: typeof obj.object === "string" ? obj.object : null,
    authenticated: obj.auth?.required === true && obj.auth?.type === "bearer",
    model: typeof obj.model === "string" ? obj.model : null,
    features,
    supportsRuns: features.run_submission === true,
    supportsEvents: features.run_events_sse === true,
    supportsStop: features.run_stop === true,
    supportsApproval: features.run_approval_response === true,
  };
}

/** Official profile discovery surface; custom aliases cannot prove profile identity. */
export async function getProfileModels(conn:HermesConnection):Promise<string[]> {
  const res=await request(conn,"/v1/models",{method:"GET",headers:headers(conn),timeoutMs:8000});
  if(!res.ok) throw new HermesError("bad_response","The gateway could not verify its profile identity.");
  const json:unknown=await res.json().catch(()=>null);
  if(!json || typeof json!=="object" || !Array.isArray((json as {data?:unknown}).data)) throw new HermesError("bad_response","The gateway profile identity response is unsupported.");
  // Aliases are advertised alongside the primary model. An alias equal to the expected profile
  // cannot prove which profile actually served this route, so only primary Hermes identities count.
  return ((json as {data:unknown[]}).data).flatMap(row=>{
    if(!row || typeof row!=="object")return [];
    const model=row as Record<string,unknown>;
    return typeof model.id==="string" && model.owned_by==="hermes" && model.parent===null && model.root===model.id ? [model.id] : [];
  });
}

export interface HermesToolset {
  name: string;
  enabled: boolean;
  tools: string[];
}

/** GET /v1/toolsets — toolsets resolved for the api_server platform (read-only). */
export async function getToolsets(conn: HermesConnection, timeoutMs = 8000): Promise<HermesToolset[]> {
  const res = await request(conn, "/v1/toolsets", { method: "GET", headers: headers(conn), timeoutMs });
  if (!res.ok) throw new HermesError("bad_response", `Unexpected toolsets status ${res.status}.`, res.status);
  const body = (await res.json().catch(() => null)) as unknown;
  const list = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : null;
  if (!list?.length) throw new HermesError("bad_response", "Toolsets response did not contain a verifiable inventory.");
  return list.map((entry) => {
    if(!entry || typeof entry!=="object")throw new HermesError("bad_response","Toolset permissions could not be verified.");
    const t=entry as Record<string,unknown>;
    if(typeof t.name!=="string" || !t.name.trim() || typeof t.enabled!=="boolean" || !Array.isArray(t.tools) || t.tools.some(x=>typeof x!=="string" || !x.trim()))throw new HermesError("bad_response","Toolset permissions could not be verified.");
    if(t.enabled && !t.tools.length)throw new HermesError("bad_response","An enabled toolset did not report its concrete permissions.");
    return {name:t.name,enabled:t.enabled,tools:t.tools as string[]};
  });
}

/**
 * Tools a client-facing employee must never expose: host shell/file/code access, desktop and
 * browser automation, scheduling, delegation, self-installation and skill rewriting.
 */
const RESTRICTED_TOOL = /^(terminal|process|process_manage|execute_code|write_file|patch|read_file|search_files|computer_use|cronjob_manage|cronjob|manage_connections|manage_catalog|delegate_task|skill_manage|start_chat|setup_choose)$|^(browser_|kanban_|discord|feishu_)/;
const REVIEWED_CLIENT_TOOLS=new Set(["web_search","web_extract","memory","session_search","todo_list","clarify","vision_analyze","video_analyze","x_search","text_to_speech"]);

/** The public toolsets contract may omit default plugin/MCP tools; it cannot prove a complete
 * client permission boundary. Only our explicit loopback test environment supplies the complete
 * synthetic inventory implemented by tests/support/mock-hermes.ts. No remote claim or checkbox
 * bypasses this gate. A supported complete-inventory contract is still required for live use. */
export function hasVerifiedCompleteToolInventory(conn:HermesConnection):boolean {
  const url=new URL(conn.baseUrl);
  return process.env.NODE_ENV==="test" && process.env.SECRET_STORE==="test-memory" && url.protocol==="http:" && ["127.0.0.1","localhost","[::1]"].includes(url.hostname);
}

export function restrictedToolsIn(toolsets: HermesToolset[]): string[] {
  const found = new Set<string>();
  for (const ts of toolsets) {
    if (!ts.enabled) continue;
    for (const tool of ts.tools) if (RESTRICTED_TOOL.test(tool) || !REVIEWED_CLIENT_TOOLS.has(tool)) found.add(tool);
  }
  return [...found].sort();
}

export async function startRun(conn: HermesConnection, input: StartRunInput): Promise<{ runId: string }> {
  if(!hasVerifiedCompleteToolInventory(conn))throw new HermesError("bad_response","Live employee runs are blocked until complete profile tool permissions can be verified.");
  const body: Record<string, unknown> = { input: input.input };
  if (input.instructions) body.instructions = input.instructions;
  if (input.sessionId) body.session_id = input.sessionId;
  if (input.conversationHistory?.length) body.conversation_history = input.conversationHistory;
  const extra: Record<string, string> = { "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey };
  if (input.memoryScope) extra["X-Hermes-Session-Key"] = input.memoryScope.slice(0, 256);
  const res = await request(conn, "/v1/runs", { method: "POST", headers: headers(conn, extra), body: JSON.stringify(body), timeoutMs: 20000 });
  if (res.status === 409) throw new HermesError("bad_response", "Hermes reported an idempotency conflict.", 409);
  if (!res.ok) throw new HermesError("bad_response", `Unexpected run status ${res.status}.`, res.status);
  const json = (await res.json().catch(() => null)) as { run_id?: unknown } | null;
  if (!json || typeof json.run_id !== "string" || !json.run_id) throw new HermesError("bad_response", "Hermes did not return a run id.");
  return { runId: json.run_id };
}

export async function stopRun(conn: HermesConnection, runId: string): Promise<void> {
  await request(conn, `/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST", headers: headers(conn), timeoutMs: 8000 });
}

/** Resolves one pending approval. Only "once" and "deny" are used: clients never grant standing approvals. */
export async function resolveRunApproval(conn: HermesConnection, runId: string, choice: "once" | "deny", requestId?: string): Promise<void> {
  const res = await request(conn, `/v1/runs/${encodeURIComponent(runId)}/approval`, {
    method: "POST",
    headers: headers(conn, { "Content-Type": "application/json" }),
    body: JSON.stringify(requestId ? { choice, request_id: requestId } : { choice }),
    timeoutMs: 8000,
  });
  if (!res.ok) throw new HermesError("bad_response", `Approval was not accepted (${res.status}).`, res.status);
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

interface RawSseEvent {
  event: string | null;
  data: string;
}

/** Minimal spec-compliant SSE reader: handles comments, multi-line data and CRLF. */
export async function* readSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<RawSseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | null = null;
  let data: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r\n|\n|\r/)) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + (buffer.startsWith("\r\n", idx) ? 2 : 1));
        if (line === "") {
          if (data.length) yield { event, data: data.join("\n") };
          event = null;
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value2 = colon === -1 ? "" : line.slice(colon + 1);
        if (value2.startsWith(" ")) value2 = value2.slice(1);
        if (field === "event") event = value2;
        else if (field === "data") data.push(value2);
      }
    }
    if (data.length) yield { event, data: data.join("\n") };
  } finally {
    reader.releaseLock();
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  return {
    inputTokens: num(u.input_tokens) ?? num(u.prompt_tokens),
    outputTokens: num(u.output_tokens) ?? num(u.completion_tokens),
    totalTokens: num(u.total_tokens),
  };
}

export function normalizeEvent(raw: RawSseEvent): HermesEvent | null {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw.data);
    if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const name = raw.event ?? str(payload.event) ?? str(payload.type) ?? "";
  switch (name) {
    case "message.delta":
    case "assistant.delta": {
      const text = str(payload.delta) ?? str(payload.text) ?? str(payload.content) ?? "";
      return text ? { type: "delta", text } : null;
    }
    case "message.interim":
    case "assistant.commentary":
      if (payload.already_streamed === true) return null;
      return { type: "interim", text: str(payload.text) ?? "" };
    case "tool.started":
    case "tool.start":
      return { type: "tool_started", tool: str(payload.tool) ?? str(payload.name) ?? "tool", callId: str(payload.tool_call_id) ?? str(payload.call_id) };
    case "tool.completed":
    case "tool.complete":
    case "tool.failed": {
      const duration = num(payload.duration);
      return {
        type: "tool_completed",
        tool: str(payload.tool) ?? str(payload.name) ?? "tool",
        callId: str(payload.tool_call_id) ?? str(payload.call_id),
        durationMs: duration === null ? undefined : Math.round(duration * 1000),
        error: name === "tool.failed" || payload.error === true,
      };
    }
    case "approval.request":
      // The raw command is redacted by Hermes and deliberately not surfaced here.
      return {
        type: "approval_request",
        approvalId: str(payload.request_id) ?? str(payload.id),
        tool: str(payload.tool) ?? str(payload.pattern_key),
        summary: str(payload.description) ?? str(payload.summary),
      };
    case "run.completed":
      return { type: "completed", output: str(payload.output) ?? null, usage: parseUsage(payload.usage) };
    case "run.failed":
      return { type: "failed", error: str(payload.error) ?? "The run failed.", partialOutput: str(payload.output) ?? null, usage: parseUsage(payload.usage) };
    case "run.cancelled":
      return { type: "cancelled" };
    case "run.interrupted":
      return { type: "interrupted", error: str(payload.error) ?? "The run was interrupted." };
    default:
      return name ? { type: "other", name } : null;
  }
}

export async function* streamRunEvents(conn: HermesConnection, runId: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
  let res: Response;
  try {
    res = await fetch(endpoint(conn, `/v1/runs/${encodeURIComponent(runId)}/events`), {
      method: "GET",
      headers: headers(conn, { Accept: "text/event-stream" }),
      signal,
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new HermesError("unreachable", "Lost connection to Hermes while starting the event stream.");
  }
  if (res.status === 401 || res.status === 403) throw new HermesError("auth_failed", "Hermes rejected the credential.", res.status);
  if (res.status === 404) throw new HermesError("not_found", "The run is no longer available.", 404);
  if (!res.ok || !res.body) throw new HermesError("bad_response", `Unexpected event stream status ${res.status}.`, res.status);
  for await (const raw of readSse(res.body)) {
    const ev = normalizeEvent(raw);
    if (ev) yield ev;
  }
}

/** Maps real tool events to short, safe status text. Unknown tools get a neutral label. */
export function toolActivityLabel(tool: string): string {
  const t = tool.toLowerCase();
  if (/calendar|appointment|availability|slot|booking/.test(t)) return "Checking your calendar…";
  if (/lead|prospect/.test(t)) return "Reviewing your leads…";
  if (/crm|contact|opportunit|pipeline|highlevel|ghl/.test(t)) return "Looking up CRM information…";
  if (/search|browse|web|fetch|crawl/.test(t)) return "Searching approved sources…";
  if (/memory|recall/.test(t)) return "Checking what I know about your business…";
  if (/analy|report|metric|chart/.test(t)) return "Crunching your numbers…";
  if (/file|document|knowledge|read/.test(t)) return "Reading your knowledge base…";
  if (/delegate|subagent/.test(t)) return "Coordinating with a teammate…";
  return "Working on a step…";
}
