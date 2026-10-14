import { headers } from "next/headers";
import { normalizeHost, resolveSite } from "@/server/sites/runtime";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ host: string }> }) {
  const host = normalizeHost(decodeURIComponent((await params).host));
  const site = host && (await headers()).get("x-site-host") === host ? await resolveSite(host) : null;
  if (!site || !host) return new Response("Not found", { status: 404 });
  // Only the main address asks to be indexed; the others point search engines to it.
  const indexable = !site.content.seo.noindex && host === site.canonicalHost;
  const body = indexable ? `User-agent: *\nAllow: /\n\nSitemap: https://${host}/sitemap.xml\n` : "User-agent: *\nDisallow: /\n";
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
