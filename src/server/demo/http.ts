import "server-only";
import { sameSiteRequest } from "@/server/security/same-site";
import { LINK_SENT_COPY, PUBLIC_COPY } from "@/lib/demo/copy";
import { fieldWords, holdWord, MESSAGE_WORDS, START_REFUSALS, VERIFY_REFUSALS } from "@/lib/demo/outcomes";
import { confirmVerification, endSession, getRoom, recordCta, registerProspect, requestReturnLink, type DemoContext, type Refused } from "@/server/demo/public";
import { demoModelState, sendDemoMessage, type DemoModelDeps } from "@/server/demo/generator";
import { demoPublicDisabled } from "@/server/demo/switch";
import { DEMO_COOKIE, demoCookie, looksLikeDemoToken } from "@/server/demo/tokens";

// The public API of the demo, as Request in and Response out, so it can be tested with plain Request objects: /api/public/demo/[action]. It decides nothing; every rule is in the
// services it calls. What it adds is the web's part: the emergency stop before anything is read, the same-site check on every POST, a bound on the body, the session cookie, and
// answers a browser can use in two ways.
//
//   * A script (the room's chat) sends JSON and gets JSON.
//   * A plain form (every page works without scripts) is sent back to the page with ONE word in the address saying how it went (src/lib/demo/outcomes.ts). No name, address or
//     message is ever put in an address.
//
// No CORS: there is no Access-Control header, so no other site can read an answer. Every answer is no-store, noindex and carries no referrer.

export const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" } as const;
const MAX_BODY_BYTES = 16_384;
const MAX_FIELD_CHARS = 4_000;

export const DEMO_ACTIONS = ["start", "return-link", "verify", "message", "history", "cta", "leave"] as const;
export type DemoAction = (typeof DEMO_ACTIONS)[number];
const isAction = (a: string): a is DemoAction => (DEMO_ACTIONS as readonly string[]).includes(a);

/** The page each action belongs to and the word its outcome travels in. */
const PAGE: Record<DemoAction, { path: string; param: string }> = {
  start: { path: "/demo", param: "r" },
  "return-link": { path: "/demo", param: "r" },
  leave: { path: "/demo", param: "r" },
  verify: { path: "/demo/verify", param: "e" },
  message: { path: "/demo/room", param: "m" },
  cta: { path: "/demo/room", param: "c" },
  history: { path: "/demo/room", param: "m" },
};

const STATUS: Record<string, number> = {
  invalid: 400, no_session: 401, rate_limited: 429, unavailable: 503, not_available: 404, daily_cap: 503, blocked_domain: 422, email_failed: 503,
  link_invalid: 400, link_expired: 410, link_used: 410, closed: 409, blocked: 403, not_verified: 403, window_ended: 409, limit_reached: 409, ai_off: 409,
};

const clientIp = (req: Request): string | null => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** What the services need to know about the request. The session cookie is read only if it has the shape of one. */
export function contextOf(req: Request, now?: Date): DemoContext {
  const cookie = cookieValue(req, DEMO_COOKIE);
  return { ip: clientIp(req), userAgent: req.headers.get("user-agent"), sessionToken: looksLikeDemoToken(cookie) ? cookie : null, now };
}

/** A request from another site never gets in. See security/same-site.ts for why a no-referrer page posts with Origin: null. */
export const sameSite = sameSiteRequest;

function setCookieHeader(token: string, expires: Date): string {
  const c = demoCookie(token, expires);
  return `${c.name}=${c.value}; Path=${c.options.path}; HttpOnly; SameSite=Lax; Expires=${c.options.expires.toUTCString()}${c.options.secure ? "; Secure" : ""}`;
}
const clearCookieHeader = (secure: boolean): string => `${DEMO_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? "; Secure" : ""}`;

interface Body {
  data: Record<string, unknown>;
  /** The caller sent JSON (a script) and wants JSON back. */
  json: boolean;
}

/**
 * The body as text, read in pieces and abandoned the moment it passes the bound, so a body sent without a Content-Length (or with a false one) cannot make the server hold more than
 * MAX_BODY_BYTES. Null when it is too large.
 */
async function readBounded(req: Request): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function readBody(req: Request): Promise<Body | { status: 400 | 413 | 415 }> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  const wantsJson = type.startsWith("application/json") || (req.headers.get("accept") ?? "").toLowerCase().includes("application/json");
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return { status: 413 };
  // An action with no fields at all (leave, history) may have no body and no type.
  if (!type) return { data: {}, json: wantsJson };
  const isJson = type.startsWith("application/json");
  // A page's own forms are urlencoded; nothing here takes a file, so multipart is refused rather than parsed.
  if (!isJson && !type.startsWith("application/x-www-form-urlencoded")) return { status: 415 };
  try {
    const text = await readBounded(req);
    if (text === null) return { status: 413 };
    if (isJson) {
      const parsed: unknown = text ? JSON.parse(text) : {};
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { status: 400 };
      return { data: parsed as Record<string, unknown>, json: true };
    }
    const data: Record<string, unknown> = Object.create(null);
    for (const [k, v] of new URLSearchParams(text).entries()) if (!(k in data)) data[k] = v.slice(0, MAX_FIELD_CHARS);
    return { data, json: wantsJson };
  } catch {
    return { status: 400 };
  }
}

const truthy = (v: unknown): boolean => v === true || v === "true" || v === "on" || v === "1" || v === "yes";

const jsonRes = (status: number, body: unknown, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
const seeOther = (location: string, extra: Record<string, string> = {}) => new Response(null, { status: 303, headers: { ...NO_STORE, ...extra, Location: location } });
const plain = (status: number, text: string, extra: Record<string, string> = {}) => new Response(text, { status, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8", ...extra } });

/** A refusal as the caller can use it: JSON with a code and a sentence, or the page with the word. */
function refusal(action: DemoAction, json: boolean, r: { reason: string; message: string; retryAfterSeconds?: number; fields?: Record<string, string | undefined> }): Response {
  const status = STATUS[r.reason] ?? 400;
  const retry: Record<string, string> = r.retryAfterSeconds ? { "Retry-After": String(r.retryAfterSeconds) } : {};
  if (json) return jsonRes(status, { ok: false, error: { code: r.reason, message: r.message }, ...(r.fields ? { fields: r.fields } : {}) }, retry);
  // A browser with no session (or an ended one) is sent to the request page, which says what to do. Decided before the words below, which do not include it.
  if (r.reason === "no_session" && action !== "start") return seeOther("/demo?r=no_session", retry);
  let word = r.reason;
  // A word a page does not know would be shown as nothing; the page says "unavailable" for those.
  if (action === "start" || action === "return-link") {
    if (!(START_REFUSALS as readonly string[]).includes(word)) word = "unavailable";
  } else if (action === "verify") {
    if (!(VERIFY_REFUSALS as readonly string[]).includes(word)) word = "link_invalid";
  } else if (!MESSAGE_WORDS.includes(word)) word = "unavailable";
  const page = PAGE[action];
  const fields = r.fields ? fieldWords(Object.keys(r.fields)) : "";
  return seeOther(`${page.path}?${page.param}=${encodeURIComponent(word)}${fields ? `&f=${fields}` : ""}`, retry);
}

const fromRefused = (r: Refused) => ({ reason: r.reason, message: r.message, retryAfterSeconds: r.retryAfterSeconds, fields: r.fields });

export interface DemoHttpDeps {
  model?: DemoModelDeps;
  now?: Date;
}

/** Everything /api/public/demo/<action> does. */
export async function handleDemo(req: Request, action: string, deps: DemoHttpDeps = {}): Promise<Response> {
  if (!isAction(action)) return jsonRes(404, { ok: false, error: { code: "unknown_action", message: "Not found." } });
  const method = req.method.toUpperCase();
  const want = action === "history" ? "GET" : "POST";
  if (method !== want) return plain(405, "Not allowed.", { Allow: want });

  const jsonish = (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json") || (req.headers.get("accept") ?? "").toLowerCase().includes("application/json");
  // The emergency stop answers before the body is read or the database is touched.
  if (demoPublicDisabled()) {
    return jsonish || action === "history"
      ? jsonRes(503, { ok: false, error: { code: "unavailable", message: PUBLIC_COPY.unavailable } }, { "Retry-After": "300" })
      : seeOther(`${PAGE[action].path}?${PAGE[action].param}=unavailable`, { "Retry-After": "300" });
  }
  if (method === "POST" && !sameSite(req)) return plain(403, "Not allowed.");

  let body: Body = { data: {}, json: jsonish };
  if (method === "POST") {
    const read = await readBody(req);
    if ("status" in read) return plain(read.status, read.status === 413 ? "Too large." : read.status === 415 ? "Unsupported." : "Could not be read.");
    body = read;
  }
  const { data, json } = body;
  const ctx = { ...contextOf(req, deps.now) };
  const modelCheck = async () => (await demoModelState(deps.model)).ready;

  switch (action) {
    case "start": {
      const r = await registerProspect(
        { name: data.name, email: data.email, business: data.business, industry: data.industry, consent: truthy(data.consent), marketingOptIn: truthy(data.marketingOptIn), utm: data, trap: data.company_website },
        ctx,
      );
      if (!r.ok) return refusal(action, json, fromRefused(r));
      return json ? jsonRes(200, { ok: true, message: LINK_SENT_COPY }) : seeOther("/demo?r=sent");
    }

    case "return-link": {
      const r = await requestReturnLink(data.email, ctx);
      if (!r.ok) return refusal(action, json, fromRefused(r));
      return json ? jsonRes(200, { ok: true, message: LINK_SENT_COPY }) : seeOther("/demo?r=sent");
    }

    case "verify": {
      const r = await confirmVerification(data.token, ctx);
      if (!r.ok) return refusal(action, json, fromRefused(r));
      const cookie = { "Set-Cookie": setCookieHeader(r.sessionToken, r.expiresAt) };
      return json ? jsonRes(200, { ok: true, redirect: "/demo/room", firstTime: r.firstTime }, cookie) : seeOther("/demo/room", cookie);
    }

    case "message": {
      const out = await sendDemoMessage({ text: data.text, clientMessageId: data.clientMessageId, employeeRole: data.employeeRole }, ctx, deps.model);
      if (!out.ok) return refusal(action, json, { reason: out.reason, message: out.message, retryAfterSeconds: out.retryAfterSeconds });
      if (!json) return seeOther(out.kind === "held" ? `/demo/room?m=${holdWord(out.why)}#chat` : "/demo/room#chat");
      // The browser gets the room as it is now, so what it shows (the conversation, the messages left, whether it can send) comes from the record and not from a guess.
      const room = await getRoom({ ...ctx, modelReady: modelCheck });
      return jsonRes(200, {
        ok: true,
        kind: out.kind,
        ...(out.kind === "held" ? { why: out.why, message: out.message } : {}),
        room: room.ok ? room.room : null,
      });
    }

    case "history": {
      const room = await getRoom({ ...ctx, modelReady: modelCheck });
      if (!room.ok) return refusal(action, true, fromRefused(room));
      return jsonRes(200, { ok: true, room: room.room });
    }

    case "cta": {
      const kind = data.kind === "consultation" || data.kind === "buy" ? data.kind : null;
      if (!kind) return refusal(action, json, { reason: "invalid", message: PUBLIC_COPY.invalid });
      const r = await recordCta(kind, ctx);
      if (!r.ok) return refusal(action, json, fromRefused(r));
      return json ? jsonRes(200, { ok: true, consultationUrl: r.consultationUrl, alreadyRecorded: r.alreadyRecorded }) : seeOther(`/demo/room?c=${kind}#actions`);
    }

    case "leave": {
      await endSession(ctx);
      const clear = { "Set-Cookie": clearCookieHeader(demoCookie("", new Date(0)).options.secure) };
      return json ? jsonRes(200, { ok: true }, clear) : seeOther("/demo?r=left", clear);
    }
  }
}
