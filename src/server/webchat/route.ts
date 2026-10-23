import "server-only";
import { handleWebChat, type ChatResponse, type ChatSurface } from "@/server/webchat/http";
import { UNAVAILABLE_MESSAGE, webchatPublicDisabled } from "@/server/webchat/switch";

// The Request/Response edge of the website chat: reads the body (bounded), the bearer token and the visitor's address, calls the adapter, and writes
// the answer with the headers a public JSON endpoint needs. Used by the external-site route and by the Website Studio site route.

const MAX_BODY = 16_000;
const ACTIONS = new Set(["config", "session", "messages", "send", "lead", "handoff"]);

const baseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" } as const;

function cors(res: ChatResponse): Record<string, string> {
  if (!res.corsOrigin) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": res.corsOrigin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "600",
  };
}

function toResponse(res: ChatResponse): Response {
  const headers: Record<string, string> = { ...baseHeaders, ...cors(res) };
  if (res.retryAfterSeconds) headers["Retry-After"] = String(res.retryAfterSeconds);
  if (res.status === 204 || res.body === null) return new Response(null, { status: res.status, headers });
  return Response.json(res.body, { status: res.status, headers });
}

const notFound = () => Response.json({ ok: false, error: { code: "unknown_action", message: "Not found." } }, { status: 404, headers: baseHeaders });

/** The visitor's address as the platform forwarded it. Used only through a keyed hash. */
function addressOf(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip") || null;
}

/**
 * What every request gets while WEBCHAT_PUBLIC_DISABLED is on. It is the same for everyone and says nothing about any workspace, so it may be read from any
 * website (the widget has to be able to read "unavailable" and leave the page alone instead of failing noisily): no credentials are ever sent to this API.
 */
function unavailable(method: string): Response {
  const open = { ...baseHeaders, "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Max-Age": "60" };
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: open });
  return Response.json({ ok: false, error: { code: "unavailable", message: UNAVAILABLE_MESSAGE } }, { status: 503, headers: { ...open, "Retry-After": "300" } });
}

export async function chatRoute(req: Request, surface: ChatSurface, action: string): Promise<Response> {
  if (!ACTIONS.has(action)) return notFound();
  const method = req.method.toUpperCase();
  if (!["GET", "POST", "OPTIONS"].includes(method)) return Response.json({ ok: false, error: { code: "method", message: "Not allowed." } }, { status: 405, headers: { ...baseHeaders, Allow: "GET, POST, OPTIONS" } });
  // The emergency switch is checked before the body is read or the database is touched.
  if (webchatPublicDisabled()) return unavailable(method);

  let body: unknown = {};
  if (method === "POST") {
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return Response.json({ ok: false, error: { code: "invalid", message: "That is too long." } }, { status: 413, headers: baseHeaders });
    try {
      const text = await req.text();
      if (text.length > MAX_BODY) return Response.json({ ok: false, error: { code: "invalid", message: "That is too long." } }, { status: 413, headers: baseHeaders });
      body = text ? JSON.parse(text) : {};
    } catch {
      return Response.json({ ok: false, error: { code: "invalid", message: "That could not be read." } }, { status: 400, headers: baseHeaders });
    }
  }
  const auth = req.headers.get("authorization");
  const token = auth && /^Bearer\s+[A-Za-z0-9_-]{43}$/.test(auth) ? auth.slice(7).trim() : null;
  const res = await handleWebChat({ action, method, surface, token, address: addressOf(req), query: new URL(req.url).searchParams, body });
  return toResponse(res);
}
