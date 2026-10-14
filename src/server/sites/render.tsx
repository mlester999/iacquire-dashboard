import "server-only";
import * as React from "react";
import { headers } from "next/headers";
import { SiteRenderer } from "@/components/website/site-renderer";
import type { ResolvedAsset } from "@/components/website/parts";
import { newSection, pagePath, findPage, type SiteContent, type SitePage } from "@/lib/website/schema";
import { issueFormToken } from "@/server/sites/form-token";
import { normalizeHost, resolveSite, siteAssets, type LiveSite, type SiteAsset } from "@/server/sites/runtime";

/** The site this request is for, but only if the proxy really routed here for that host. Direct calls to internal routes get nothing. */
export async function siteForRequest(hostParam: string): Promise<LiveSite | null> {
  const host = normalizeHost(decodeURIComponent(hostParam));
  if (!host) return null;
  const claimed = (await headers()).get("x-site-host");
  if (claimed !== host) return null;
  return resolveSite(host);
}

export const hrefForPage = (slug: string) => (slug === "home" ? "/" : `/${slug}`);

export function assetResolver(map: Map<string, SiteAsset>): (id: string | null | undefined) => ResolvedAsset | null {
  return (id) => {
    if (!id) return null;
    const a = map.get(id.toLowerCase());
    return a ? { src: `/_a/${a.sha256}`, width: a.width, height: a.height, alt: a.alt } : null;
  };
}

/** The thank-you page after an enquiry: the site's own header and footer around the owner's chosen message. */
function withThanks(content: SiteContent): { content: SiteContent; page: SitePage } {
  const section = newSection("richText", "thanks-1");
  (section.data as { heading: string; body: string }).heading = "Thank you";
  (section.data as { heading: string; body: string }).body = content.form.successMessage;
  const page: SitePage = { slug: "thanks", title: "Thank you", navLabel: "Thank you", showInNav: false, seoTitle: "", seoDescription: "", sections: [section] };
  return { content: { ...content, pages: [...content.pages, page] }, page };
}

export async function renderSitePage(site: LiveSite, host: string, slug: string): Promise<React.ReactElement | null> {
  let content = site.content;
  if (slug === "thanks") content = withThanks(content).content;
  const page = findPage(content, slug);
  if (!page) return null;
  const assets = await siteAssets(host, site.publicationId);
  return React.createElement(SiteRenderer, {
    content, templateKey: site.templateKey, pageSlug: page.slug, resolveAsset: assetResolver(assets), mode: "published", formAction: "/__iaq/form",
    formToken: issueFormToken(host), hrefFor: hrefForPage, publicationId: site.publicationId,
  });
}

export { pagePath };
