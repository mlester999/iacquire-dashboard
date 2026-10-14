import { headers } from "next/headers";
import { pagePath } from "@/lib/website/schema";
import { normalizeHost, resolveSite } from "@/server/sites/runtime";

export const dynamic = "force-dynamic";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function GET(_req: Request, { params }: { params: Promise<{ host: string }> }) {
  const host = normalizeHost(decodeURIComponent((await params).host));
  const site = host && (await headers()).get("x-site-host") === host ? await resolveSite(host) : null;
  if (!site || !host || site.content.seo.noindex || host !== site.canonicalHost) return new Response("Not found", { status: 404 });
  const lastmod = site.publishedAt.slice(0, 10);
  const urls = site.content.pages.map((p) => `  <url><loc>${esc(`https://${host}${pagePath(p.slug)}`)}</loc><lastmod>${lastmod}</lastmod></url>`).join("\n");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}
