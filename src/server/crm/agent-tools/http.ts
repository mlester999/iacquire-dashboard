import "server-only";
import { AppError } from "@/server/errors";
import { sha256 } from "@/server/security/crypto";
import { callAgentTool, describeAgentTools, type AgentToolCatalogReply, type AgentToolReply } from "@/server/crm/agent-tools/service";

/**
 * The HTTP surface of the CRM tools (src/app/api/agent-tools/[tool]/route.ts): bearer authentication, JSON in and out, and nothing
 * the request says about which workspace it is for. See docs/hermes-crm-tools.md.
 */

export const MAX_TOOL_BODY = 16_000;
export const CATALOG_PATH = "catalog";

export interface ToolHttpRequest {
  method: string;
  authorization: string | null;
  contentType: string | null;
  contentLength: string | null;
  idempotencyKey: string | null;
  ip: string | null;
  readBody: () => Promise<string>;
}

export interface ToolHttpResponse {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

const BASE_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

function bearer(header: string | null): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m ? m[1] : null;
}

function toResponse(r: AgentToolReply | AgentToolCatalogReply): ToolHttpResponse {
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (!r.ok) {
    if (r.httpStatus === 401) headers["WWW-Authenticate"] = 'Bearer realm="iacquire-crm-tools"';
    if (r.retryAfterSeconds) headers["Retry-After"] = String(r.retryAfterSeconds);
    return { status: r.httpStatus, headers, body: { ok: false, code: r.code, error: r.error, ...(r.issues ? { issues: r.issues } : {}) } };
  }
  if ("tools" in r) return { status: 200, headers, body: { ok: true, agent: r.agent, scopes: r.scopes, tools: r.tools } };
  return {
    status: r.httpStatus,
    headers,
    body: { ok: true, tool: r.tool, status: r.status, result: r.result, ...(r.approvalId ? { approvalId: r.approvalId } : {}), ...(r.detail ? { detail: r.detail } : {}) },
  };
}

export async function handleAgentToolHttp(req: ToolHttpRequest, tool: string): Promise<ToolHttpResponse> {
  const token = bearer(req.authorization);
  const ipHash = req.ip ? sha256(`agent-tools:${req.ip}`).slice(0, 32) : null;
  if (req.method === "GET") {
    if (tool !== CATALOG_PATH) return { status: 405, headers: { ...BASE_HEADERS, Allow: "POST" }, body: { ok: false, code: "method_not_allowed", error: "Call a tool with POST." } };
    return toResponse(await describeAgentTools(token, { ipHash }));
  }
  if (req.method !== "POST") return { status: 405, headers: { ...BASE_HEADERS, Allow: "GET, POST" }, body: { ok: false, code: "method_not_allowed", error: "Use POST." } };
  const reply = await callAgentTool({
    token,
    tool,
    callId: req.idempotencyKey,
    ipHash,
    // Read only once the caller is authenticated and within its rate limit.
    readArgs: async () => {
      if (Number(req.contentLength ?? 0) > MAX_TOOL_BODY) throw new AppError("invalid_input", "The arguments are too large.");
      const text = await req.readBody();
      if (text.length > MAX_TOOL_BODY) throw new AppError("invalid_input", "The arguments are too large.");
      if (!text.trim()) return {};
      if (!/^application\/json\b/i.test(req.contentType ?? "")) throw new AppError("invalid_input", "Send the arguments as JSON (Content-Type: application/json).");
      try {
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("invalid_input", "The arguments must be a JSON object.");
        return value;
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError("invalid_input", "The arguments couldn't be read as JSON.");
      }
    },
  });
  return toResponse(reply);
}
