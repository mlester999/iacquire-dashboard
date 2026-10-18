import { headers } from "next/headers";
import { errorPage, handleEnquiry } from "@/server/sites/enquiry";
import { normalizeHost } from "@/server/sites/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const html = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });

export async function POST(req: Request, { params }: { params: Promise<{ host: string }> }) {
  const host = normalizeHost(decodeURIComponent((await params).host));
  const h = await headers();
  if (!host || h.get("x-site-host") !== host) return html(404, errorPage("This site isn't available."));
  // A native CRM form can ask more (up to 60 questions, paragraphs of up to 5,000 characters), so the cap is higher than the built-in
  // form needs; the built-in form still reads only its first 24 values, and every value is clipped where it is used.
  if (Number(req.headers.get("content-length") ?? 0) > 64_000) return html(413, errorPage("That message is too long."));
  let fields: Record<string, string> = {};
  let entries: Array<[string, string]> = [];
  try {
    const form = await req.formData();
    entries = [...form].filter((entry): entry is [string, string] => typeof entry[1] === "string").slice(0, 400);
    fields = Object.fromEntries(entries.slice(0, 24));
  } catch {
    return html(400, errorPage("That message couldn't be read."));
  }
  const result = await handleEnquiry({
    host, origin: req.headers.get("origin"), secFetchSite: req.headers.get("sec-fetch-site"), forwardedFor: req.headers.get("x-forwarded-for"), referer: req.headers.get("referer"), fields, entries,
  });
  // POST then redirect, so refreshing the confirmation page never sends the enquiry again.
  if (result.kind === "redirect") return new Response(null, { status: 303, headers: { Location: result.to, "Cache-Control": "no-store" } });
  return html(result.status, errorPage(result.message));
}
