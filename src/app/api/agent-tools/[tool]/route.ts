import { handleAgentToolHttp, type ToolHttpRequest } from "@/server/crm/agent-tools/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * CRM tools for a client's own AI employees. Authenticated only by a short-lived per-run bearer token; the workspace and the employee
 * come from that token, never from the request. POST /api/agent-tools/<tool> calls a tool; GET /api/agent-tools/catalog lists the
 * tools the token may call. See docs/hermes-crm-tools.md.
 */
function meta(req: Request): ToolHttpRequest {
  const h = req.headers;
  return {
    method: req.method,
    authorization: h.get("authorization"),
    contentType: h.get("content-type"),
    contentLength: h.get("content-length"),
    idempotencyKey: h.get("idempotency-key"),
    // Behind the trusted reverse proxy the first X-Forwarded-For entry is the caller. Only its hash is logged.
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null,
    readBody: () => req.text(),
  };
}

async function handle(req: Request, { params }: { params: Promise<{ tool: string }> }) {
  const { tool } = await params;
  const res = await handleAgentToolHttp(meta(req), tool);
  return Response.json(res.body, { status: res.status, headers: res.headers });
}

export const POST = handle;
export const GET = handle;
