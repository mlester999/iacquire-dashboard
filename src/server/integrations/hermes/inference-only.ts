import "server-only";
import crypto from "node:crypto";
import { AGENCY_HERMES_PROFILE_IDS, type AgentRoleKey } from "@/lib/agents";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { validateIntegrationEndpoint } from "@/server/integrations/safety";
import type { HermesConnection } from "@/server/integrations/hermes/client";

const MAX_OUTPUT_TOKENS = 128;
const MAX_INPUT_TOKENS = 8_192;
const MAX_PROMPT_BYTES = 24_576;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_WORKER_BODY_BYTES = 48 * 1024;
const WORKER_PATH_PREFIX = "/internal/inference/v1";

export interface InferenceOnlyResult {
  requestId: string;
  provider: "deepseek";
  model: string;
  content: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  toolSchemas: 0;
  toolCalls: 0;
}

export interface InferenceOnlyRequest {
  requestId?: string;
  actorId: string;
  role: AgentRoleKey;
  instructions: string;
  input: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  signal?: AbortSignal;
}

export interface PromptAuditResult {
  requestId: string;
  role: AgentRoleKey;
  profile: string;
  hermesVersion: "0.22.5";
  appInstructionBytes: number;
  soulBytes: number;
  providerOnlyMessageBytes: number;
  chatMessageBytes: number;
  syntheticProviderRequests: 2;
  promptLimitBytes: 24_576;
}

export function signInferenceOnlyRequest(secret: string, timestamp: string, body: string): string {
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${digest}`).digest("hex");
}

export function parseInferenceOnlyResponse(value: unknown, expectedRequestId: string): InferenceOnlyResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("upstream_error", "The restricted AI worker returned an unsupported response.");
  const row = value as Record<string, unknown>;
  const usage = row.usage;
  if (
    row.ok !== true
    || row.requestId !== expectedRequestId
    || row.provider !== "deepseek"
    || row.toolSchemas !== 0
    || row.toolCalls !== 0
    || typeof row.model !== "string"
    || !/^[A-Za-z0-9_.:/-]{1,120}$/.test(row.model)
    || typeof row.content !== "string"
    || !row.content.trim()
    || row.content.length > 4_096
    || !usage
    || typeof usage !== "object"
    || Array.isArray(usage)
  ) {
    throw new AppError("upstream_error", "The restricted AI worker failed its response and tool-policy checks.");
  }
  const counts = usage as Record<string, unknown>;
  if (
    Object.keys(counts).sort().join(",") !== "inputTokens,outputTokens,totalTokens"
    || !Number.isInteger(counts.inputTokens)
    || !Number.isInteger(counts.outputTokens)
    || !Number.isInteger(counts.totalTokens)
    || (counts.inputTokens as number) < 0
    || (counts.inputTokens as number) > MAX_INPUT_TOKENS
    || (counts.outputTokens as number) < 0
    || (counts.outputTokens as number) > MAX_OUTPUT_TOKENS
    || counts.totalTokens !== (counts.inputTokens as number) + (counts.outputTokens as number)
  ) {
    throw new AppError("upstream_error", "The restricted AI worker returned invalid token usage.");
  }
  return {
    requestId: expectedRequestId,
    provider: "deepseek",
    model: row.model,
    content: row.content,
    usage: {
      inputTokens: counts.inputTokens as number,
      outputTokens: counts.outputTokens as number,
      totalTokens: counts.totalTokens as number,
    },
    toolSchemas: 0,
    toolCalls: 0,
  };
}

export function parsePromptAuditResponse(
  value: unknown,
  input: { requestId: string; role: AgentRoleKey; appInstructionBytes: number },
): PromptAuditResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("upstream_error", "The no-call prompt audit returned an unsupported response.");
  const row = value as Record<string, unknown>;
  const counts = [row.soulBytes, row.providerOnlyMessageBytes, row.chatMessageBytes];
  if (
    row.ok !== true
    || row.requestId !== input.requestId
    || row.mode !== "prompt_audit"
    || row.role !== input.role
    || row.profile !== AGENCY_HERMES_PROFILE_IDS[input.role]
    || row.hermesVersion !== "0.22.5"
    || row.toolSchemas !== 0
    || row.toolCalls !== 0
    || row.syntheticProviderRequests !== 2
    || counts.some((count) => !Number.isInteger(count) || (count as number) < 0 || (count as number) > MAX_WORKER_BODY_BYTES)
  ) {
    throw new AppError("upstream_error", "The no-call prompt audit failed its identity or measurement checks.");
  }
  return {
    requestId: input.requestId,
    role: input.role,
    profile: AGENCY_HERMES_PROFILE_IDS[input.role],
    hermesVersion: "0.22.5",
    appInstructionBytes: input.appInstructionBytes,
    soulBytes: counts[0] as number,
    providerOnlyMessageBytes: counts[1] as number,
    chatMessageBytes: counts[2] as number,
    syntheticProviderRequests: 2,
    promptLimitBytes: MAX_PROMPT_BYTES,
  };
}

/** Sends approved app instructions to the pinned worker's synthetic local provider and returns only byte counts. */
export async function requestPromptAudit(
  conn: HermesConnection,
  input: { actorId: string; role: AgentRoleKey; instructions: string; providerInput: string; chatInput: string },
): Promise<PromptAuditResult> {
  const config = env();
  if (!config.HERMES_PROMPT_AUDIT_ENABLED || !config.HERMES_INFERENCE_WORKER_URL || !config.HERMES_INFERENCE_WORKER_SECRET) {
    throw new AppError("integration_unavailable", "The no-call prompt audit is not enabled.");
  }
  if (
    conn.orgKind !== "agency"
    || conn.roleKey !== input.role
    || conn.profile !== AGENCY_HERMES_PROFILE_IDS[input.role]
    || !conn.accessClientId
    || !conn.accessClientSecret
  ) {
    throw new AppError("forbidden", "The prompt audit is available only for its verified internal employee profile.");
  }
  let gatewayHost: string;
  try {
    gatewayHost = new URL(conn.baseUrl).host.toLowerCase();
  } catch {
    throw new AppError("integration_unavailable", "The approved worker address is unavailable.");
  }
  const workerBase = validateIntegrationEndpoint(config.HERMES_INFERENCE_WORKER_URL, [gatewayHost]);
  const parsedEndpoint = new URL(workerBase);
  if (parsedEndpoint.host.toLowerCase() !== gatewayHost || parsedEndpoint.pathname !== WORKER_PATH_PREFIX) {
    throw new AppError("invalid_input", "The prompt audit must use the approved worker host and fixed route prefix.");
  }
  const endpoint = new URL(`${WORKER_PATH_PREFIX}/${input.role}/infer`, parsedEndpoint.origin).toString();
  const requestId = crypto.randomUUID();
  const payload = {
    requestId,
    actorId: input.actorId,
    role: input.role,
    instructions: input.instructions,
    input: input.providerInput,
    chatInput: input.chatInput,
    history: [],
    mode: "prompt_audit",
  };
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > MAX_WORKER_BODY_BYTES) throw new AppError("invalid_input", "The no-call prompt audit context is too large to measure safely.");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signInferenceOnlyRequest(config.HERMES_INFERENCE_WORKER_SECRET, timestamp, body);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Iacquire-Timestamp": timestamp,
        "X-Iacquire-Signature": signature,
        "CF-Access-Client-Id": conn.accessClientId,
        "CF-Access-Client-Secret": conn.accessClientSecret,
      },
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(36_000),
    });
  } catch {
    throw new AppError("upstream_error", "The no-call prompt audit worker could not be reached or timed out.");
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_RESPONSE_BYTES) throw new AppError("upstream_error", "The no-call prompt audit returned an oversized response.");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new AppError("upstream_error", "The no-call prompt audit returned an oversized response.");
  if (!response.ok) throw new AppError("upstream_error", "The no-call prompt audit could not complete its identity checks.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AppError("upstream_error", "The no-call prompt audit returned invalid data.");
  }
  const appInstructionBytes = Buffer.byteLength(input.instructions, "utf8");
  const audit = parsePromptAuditResponse(value, { requestId, role: input.role, appInstructionBytes });
  return audit;
}

export async function requestInferenceOnly(
  conn: HermesConnection,
  input: InferenceOnlyRequest,
): Promise<InferenceOnlyResult> {
  const config = env();
  if (!config.HERMES_INFERENCE_WORKER_ENABLED || !config.HERMES_INFERENCE_WORKER_URL || !config.HERMES_INFERENCE_WORKER_SECRET) {
    throw new AppError("integration_unavailable", "Restricted Hermes inference is not enabled.");
  }
  if (
    conn.orgKind !== "agency"
    || conn.roleKey !== input.role
    || conn.profile !== AGENCY_HERMES_PROFILE_IDS[input.role]
    || !conn.accessClientId
    || !conn.accessClientSecret
  ) {
    throw new AppError("forbidden", "The restricted worker is available only for its verified internal employee profile.");
  }
  let gatewayHost: string;
  try {
    gatewayHost = new URL(conn.baseUrl).host.toLowerCase();
  } catch {
    throw new AppError("integration_unavailable", "The approved Hermes gateway address is unavailable.");
  }
  const workerBase = validateIntegrationEndpoint(config.HERMES_INFERENCE_WORKER_URL, [gatewayHost]);
  const parsedEndpoint = new URL(workerBase);
  if (parsedEndpoint.host.toLowerCase() !== gatewayHost || parsedEndpoint.pathname !== WORKER_PATH_PREFIX) {
    throw new AppError("invalid_input", "The restricted worker must use the approved Hermes hostname and fixed inference route prefix.");
  }
  const endpoint = new URL(`${WORKER_PATH_PREFIX}/${input.role}/infer`, parsedEndpoint.origin).toString();

  const requestId = input.requestId ?? crypto.randomUUID();
  const payload = {
    requestId,
    actorId: input.actorId,
    role: input.role,
    instructions: input.instructions,
    input: input.input,
    history: input.history ?? [],
  };
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > 48 * 1024) throw new AppError("invalid_input", "The restricted inference context is too large.");
  const contextBytes = Buffer.byteLength(`${input.instructions}${input.input}${(input.history ?? []).map((row) => row.content).join("")}`, "utf8");
  if (contextBytes > MAX_PROMPT_BYTES) throw new AppError("invalid_input", "The restricted inference context exceeds its request budget.");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signInferenceOnlyRequest(config.HERMES_INFERENCE_WORKER_SECRET, timestamp, body);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Iacquire-Timestamp": timestamp,
        "X-Iacquire-Signature": signature,
        "CF-Access-Client-Id": conn.accessClientId,
        "CF-Access-Client-Secret": conn.accessClientSecret,
      },
      body,
      cache: "no-store",
      redirect: "error",
      signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(36_000)]) : AbortSignal.timeout(36_000),
    });
  } catch {
    throw new AppError("upstream_error", "The restricted Hermes inference worker could not be reached or timed out.");
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_RESPONSE_BYTES) throw new AppError("upstream_error", "The restricted Hermes inference worker returned an oversized response.");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new AppError("upstream_error", "The restricted Hermes inference worker returned an oversized response.");
  if (!response.ok) throw new AppError("upstream_error", "The restricted Hermes inference worker could not complete the request.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AppError("upstream_error", "The restricted Hermes inference worker returned invalid JSON.");
  }
  return parseInferenceOnlyResponse(value, requestId);
}
