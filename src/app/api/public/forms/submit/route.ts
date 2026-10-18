import { collectFields } from "@/lib/crm/forms/logic";
import { handleHostedSubmit, requestMetaFrom } from "@/server/crm/forms/public";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY = 64_000;
const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** What a browser without script sees when something needs fixing: the reason, and the way back to the answers it still holds. */
const errorPage = (message: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Not sent yet</title></head>` +
  `<body style="font-family:ui-sans-serif,system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f9fb;color:#101828;padding:1.5rem"><main style="max-width:28rem;text-align:center">` +
  `<h1 style="font-size:1.4rem;margin:0 0 .75rem">Your answers weren't sent yet</h1><p style="margin:0 0 1.25rem;color:#475467">${esc(message)}</p>` +
  `<p style="margin:0;color:#475467;font-size:.9rem">Use your browser's back button to return to the form: your answers are still there.</p></main></body></html>`;

/**
 * A hosted form page's submission. The page posts here as an ordinary form (no script needed) and gets a redirect to its thank-you
 * page; with script it asks for JSON and shows the result in place. The decisions live in handleHostedSubmit.
 */
export async function POST(req: Request) {
  const wantsJson = /application\/json/i.test(req.headers.get("accept") ?? "");
  const reply = (status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
    wantsJson
      ? Response.json(body, { status, headers: { ...NO_STORE, ...extra } })
      : new Response(errorPage(String(body.message ?? "Something went wrong.")), { status, headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE, ...extra } });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return reply(413, { ok: false, code: "invalid", message: "That's more than this form can take. Please shorten your answers." });
  let entries: Array<[string, string]>;
  try {
    const form = await req.formData();
    entries = [...form].filter((e): e is [string, string] => typeof e[1] === "string");
  } catch {
    return reply(400, { ok: false, code: "invalid", message: "Your answers couldn't be read. Reload the page and try again." });
  }
  const res = await handleHostedSubmit(requestMetaFrom(req), collectFields(entries));
  if (res.ok) {
    if (wantsJson) return Response.json({ ok: true, message: res.message, redirect: res.redirect }, { status: res.status, headers: NO_STORE });
    // Post, then redirect, so refreshing the thank-you page never sends the answers again.
    return new Response(null, { status: 303, headers: { Location: `/f/${encodeURIComponent(res.org)}/${encodeURIComponent(res.key)}/sent`, ...NO_STORE } });
  }
  return reply(res.status, { ok: false, code: res.code, message: res.message, errors: res.errors ?? {} }, res.retryAfter ? { "Retry-After": String(res.retryAfter) } : {});
}
