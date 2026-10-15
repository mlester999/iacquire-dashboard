import type { Metadata } from "next";
import { after } from "next/server";
import { notFound } from "next/navigation";
import { findPage, pagePath, type ImageSrc, type SiteContent } from "@/lib/website/doc";
import { recordUsage, siteAssets } from "@/server/sites/runtime";
import { hrefForPage, renderSitePage, siteForRequest, thanksPage } from "@/server/sites/render";

export const dynamic = "force-dynamic";

type Params = Promise<{ host: string; path?: string[] }>;

const slugOf = (path: string[] | undefined) => (!path || path.length === 0 ? "home" : path.length === 1 ? path[0] : null);

/** JSON that is safe to place inside a script element: the characters that could close it are escaped. */
const safeJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

function structuredData(content: SiteContent, url: string) {
  const b = content.business;
  return {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: b.name,
    url,
    ...(b.tagline ? { description: b.tagline } : {}),
    ...(b.phone ? { telephone: b.phone } : {}),
    ...(b.email ? { email: b.email } : {}),
    ...(b.address ? { address: b.address.replace(/\n/g, ", ") } : {}),
  };
}

const assetIdOf = (src: ImageSrc) => (src && src.kind === "asset" ? src.id.toLowerCase() : null);

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { host, path } = await params;
  const site = await siteForRequest(host);
  const slug = slugOf(path);
  const content = site?.content;
  const page = content && slug ? (slug === "thanks" ? thanksPage(content).page : findPage(content, slug)) : null;
  if (!site || !content || !page) return { title: { absolute: "Page not found" }, robots: { index: false, follow: false } };

  const decoded = decodeURIComponent(host).toLowerCase();
  const canonicalHost = site.canonicalHost;
  const canonical = `https://${canonicalHost}${pagePath(page.slug)}`;
  // Only the main address is indexed, so the same site on its included address and a custom domain doesn't compete with itself.
  const indexable = !content.seo.noindex && !page.noindex && decoded === canonicalHost && page.kind !== "thanks";
  const title = page.slug === "home" ? content.seo.title || content.business.name : page.seoTitle || `${page.title} | ${content.business.name}`;
  const description = page.seoDescription || content.seo.description || undefined;
  const assets = await siteAssets(decoded, site.publicationId);
  const ogId = assetIdOf(page.ogImage) ?? assetIdOf(content.seo.ogImage);
  const og = ogId ? assets.get(ogId) : undefined;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical },
    robots: indexable ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: { title, description, url: canonical, siteName: content.business.name, type: "website", ...(og ? { images: [{ url: `https://${canonicalHost}/_a/${og.sha256}` }] } : {}) },
    icons: { icon: [{ url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23" + content.design.colors.primary.slice(1) + "'/%3E%3C/svg%3E" }] },
  };
}

export default async function SiteRuntimePage({ params }: { params: Params }) {
  const { host: hostParam, path } = await params;
  const site = await siteForRequest(hostParam);
  const slug = slugOf(path);
  if (!site || !slug) notFound();
  const host = decodeURIComponent(hostParam).toLowerCase();
  const tree = await renderSitePage(site, host, slug);
  if (!tree) notFound();
  // Requests are counted exactly; response sizes are measured at the CDN, not guessed here.
  after(() => recordUsage(host, 0));
  const url = `https://${site.canonicalHost}${hrefForPage(slug) === "/" ? "" : hrefForPage(slug)}`;
  return (
    <>
      {tree}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJson(structuredData(site.content, url)) }} />
    </>
  );
}
