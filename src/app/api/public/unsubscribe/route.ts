import { looksLikeUnsubscribeToken, performUnsubscribe, unsubscribePagePath, type UnsubscribeOutcome } from "@/server/messaging/unsubscribe";
import { readBoundedFormData, readBoundedText } from "@/server/security/bounded-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 8_192;
const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };

/** A relative redirect: the request's own host serves the page, whatever address the server sees internally. */
const seeOther = (location: string) => new Response(null, { status: 303, headers: { ...NO_STORE, Location: location } });

/**
 * The List-Unsubscribe URL of a marketing message (RFC 8058).
 *
 * GET is what a person gets by opening the link: it only redirects to the confirmation page and never unsubscribes anyone, because link
 * scanners and mail-app previews open links too. POST unsubscribes: a mail app's one-click request ("List-Unsubscribe=One-Click", no
 * cookies, no session) gets an empty 200; the confirmation page's own form is sent back to the page. The signed token in `t` is the only
 * authorization, and it only ever revokes marketing consent for its own contact and channel.
 */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("t");
  return seeOther(unsubscribePagePath(token ?? ""));
}

const ONE_CLICK_STATUS: Record<UnsubscribeOutcome, number> = { unsubscribed: 200, already: 200, not_found: 200, invalid: 400, expired: 410, rate_limited: 429 };

export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return new Response(null, { status: 413, headers: NO_STORE });
  const url = new URL(req.url);
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  let fields = new URLSearchParams();
  try {
    if (contentType.startsWith("multipart/form-data")) {
      const form = await readBoundedFormData(req, MAX_BODY_BYTES);
      if (!form) return new Response(null, { status: 413, headers: NO_STORE });
      for (const [k, v] of form.entries()) if (typeof v === "string") fields.append(k, v.slice(0, 200));
    } else {
      const text = await readBoundedText(req, MAX_BODY_BYTES);
      if (text === null) return new Response(null, { status: 413, headers: NO_STORE });
      fields = new URLSearchParams(text);
    }
  } catch {
    fields = new URLSearchParams();
  }
  const token = url.searchParams.get("t") ?? fields.get("t");
  const fromPage = fields.get("via") === "page";
  const method = fromPage ? "page" : "one_click";

  let outcome: UnsubscribeOutcome;
  try {
    outcome = (await performUnsubscribe(token, { method })).outcome;
  } catch (err) {
    console.error("[iacquire] unsubscribe failed", { type: err instanceof Error ? err.name : "unknown" });
    if (fromPage && looksLikeUnsubscribeToken(token)) return seeOther(`${unsubscribePagePath(token)}?r=error`);
    return new Response(null, { status: 500, headers: NO_STORE });
  }

  if (fromPage) return seeOther(`${unsubscribePagePath(token ?? "")}?r=${outcome}`);
  // RFC 8058 / Resend's guidance: answer a one-click POST with an empty 200; the person never sees this response.
  return new Response(null, { status: ONE_CLICK_STATUS[outcome], headers: outcome === "rate_limited" ? { ...NO_STORE, "Retry-After": "3600" } : NO_STORE });
}
