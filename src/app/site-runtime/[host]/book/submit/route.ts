import { headers } from "next/headers";
import { bookingErrorPage, handleSiteBooking } from "@/server/sites/booking";
import { normalizeHost } from "@/server/sites/runtime";
import { readBoundedFormData } from "@/server/security/bounded-body";

// The booking form on a customer's site posts here (/__iaq/book, rewritten by the proxy). POST, then redirect, so refreshing the
// confirmation never books again; the decisions themselves live in handleSiteBooking.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const html = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });

export async function POST(req: Request, { params }: { params: Promise<{ host: string }> }) {
  const host = normalizeHost(decodeURIComponent((await params).host));
  const h = await headers();
  if (!host || h.get("x-site-host") !== host) return html(404, bookingErrorPage("This site isn't available."));
  if (Number(req.headers.get("content-length") ?? 0) > 40_000) return html(413, bookingErrorPage("That was too much to send. Shorten your answers and try again."));
  let fields: Record<string, string> = {};
  try {
    const form = await readBoundedFormData(req, 40_000);
    if (!form) return html(413, bookingErrorPage("That was too much to send. Shorten your answers and try again."));
    fields = Object.fromEntries([...form].filter((entry): entry is [string, string] => typeof entry[1] === "string").slice(0, 40));
  } catch {
    return html(400, bookingErrorPage("That booking couldn't be read. Go back and try again."));
  }
  const result = await handleSiteBooking({
    host, origin: req.headers.get("origin"), secFetchSite: req.headers.get("sec-fetch-site"), forwardedFor: req.headers.get("x-forwarded-for"), fields,
  });
  if (result.kind === "redirect") return new Response(null, { status: 303, headers: { Location: result.to, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  return html(result.status, bookingErrorPage(result.message));
}
