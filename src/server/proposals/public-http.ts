import "server-only";
import { env } from "@/server/env";
import { sameSiteRequest } from "@/server/security/same-site";
import { SESSION_MAX_HOURS, type PublicState } from "@/lib/proposals/share";
import { decideOnProposal, loadPublicPdf, recordProposalView, requestEmailCode, verifyEmailCode, type PublicContext } from "@/server/proposals/public";
import { looksLikeProposalToken, sessionCookieName } from "@/server/proposals/link-token";

// The thin HTTP layer of the customer's proposal page: reads the request, calls the service in public.ts, answers. Kept apart from the route files so it can be tested with plain
// Request objects. Nothing here decides anything. Every answer carries no-store, no-referrer and noindex: the address in the bar is the customer's credential.

export const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" } as const;
const MAX_BODY_BYTES = 16_384;

const clientIp = (req: Request): string | null => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** What the service needs to know about the request. The session cookie is the one that belongs to THIS token. */
export function contextOf(req: Request, token: string, now?: Date): PublicContext {
  return { ip: clientIp(req), userAgent: req.headers.get("user-agent"), sessionToken: looksLikeProposalToken(token) ? cookieValue(req, sessionCookieName(token)) : null, now };
}

/** A form posted from another site is refused before anything is read. A same-site form on this no-referrer page arrives with Origin: null; see security/same-site.ts. */
export const sameSite = sameSiteRequest;

/** The customer's page for a token, with the outcome of what they just did in the query. The token is only ever put back in the address when it is the right shape. */
export const pagePath = (token: string, query?: Record<string, string>): string =>
  `/proposal/${looksLikeProposalToken(token) ? token : "invalid"}${query ? `?${new URLSearchParams(query).toString()}` : ""}`;

const seeOther = (location: string, extra: Record<string, string> = {}) => new Response(null, { status: 303, headers: { ...NO_STORE, ...extra, Location: location } });
const plain = (status: number, text: string, extra: Record<string, string> = {}) => new Response(text, { status, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8", ...extra } });

async function formFields(req: Request): Promise<URLSearchParams | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  try {
    if (type.startsWith("multipart/form-data")) {
      const out = new URLSearchParams();
      for (const [k, v] of (await req.formData()).entries()) if (typeof v === "string") out.append(k, v.slice(0, 4000));
      return out;
    }
    const text = await req.text();
    return text.length > MAX_BODY_BYTES ? null : new URLSearchParams(text);
  } catch {
    return new URLSearchParams();
  }
}

const sessionCookie = (token: string, value: string): string =>
  `${sessionCookieName(token)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_HOURS * 3600}${env().NODE_ENV === "production" ? "; Secure" : ""}`;

const STATE_STATUS: Partial<Record<PublicState, number>> = { rate_limited: 429, disabled: 503 };

/** The page's beacon: the page stayed open and was used. No body, no redirect. */
export async function handleView(req: Request, token: string): Promise<Response> {
  if (!sameSite(req)) return plain(403, "Not allowed.");
  const r = await recordProposalView(token, contextOf(req, token));
  return new Response(null, { status: r === "rate_limited" ? 429 : r === "unavailable" ? 404 : 204, headers: NO_STORE });
}

export async function handleCode(req: Request, token: string): Promise<Response> {
  if (!sameSite(req)) return plain(403, "Not allowed.");
  const r = await requestEmailCode(token, contextOf(req, token));
  return seeOther(pagePath(token, { c: r.outcome }));
}

export async function handleVerify(req: Request, token: string): Promise<Response> {
  if (!sameSite(req)) return plain(403, "Not allowed.");
  const fields = await formFields(req);
  if (!fields) return plain(413, "Too large.");
  const r = await verifyEmailCode(token, fields.get("code"), contextOf(req, token));
  const query = { c: r.outcome, ...(r.attemptsLeft !== undefined && r.outcome === "wrong" ? { left: String(r.attemptsLeft) } : {}) };
  return seeOther(pagePath(token, query), r.outcome === "verified" && r.sessionToken ? { "Set-Cookie": sessionCookie(token, r.sessionToken) } : {});
}

export async function handleDecide(req: Request, token: string): Promise<Response> {
  if (!sameSite(req)) return plain(403, "Not allowed.");
  const fields = await formFields(req);
  if (!fields) return plain(413, "Too large.");
  const r = await decideOnProposal(token, { decision: fields.get("decision"), note: fields.get("note"), acknowledged: fields.get("ack"), contentHash: fields.get("h") }, contextOf(req, token));
  return seeOther(pagePath(token, { r: r.outcome }));
}

/** The PDF as a download: never shown inside the page (frames and objects are blocked by policy), never cached, never sniffed. */
export async function handlePdf(req: Request, token: string): Promise<Response> {
  const r = await loadPublicPdf(token, contextOf(req, token));
  if (!r.ok) return plain(STATE_STATUS[r.state] ?? 404, r.state === "rate_limited" ? "Too many requests. Try again in a few minutes." : r.state === "disabled" ? "Temporarily unavailable." : "Not found.", r.state === "rate_limited" ? { "Retry-After": "300" } : {});
  return new Response(new Uint8Array(r.bytes), {
    status: 200,
    headers: {
      ...NO_STORE,
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${r.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "Content-Length": String(r.bytes.length),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

/** Opening a form endpoint's address goes back to the page: nothing is recorded by a GET. */
export const backToPage = (token: string): Response => seeOther(pagePath(token));
