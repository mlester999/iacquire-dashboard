import "server-only";
import * as React from "react";
import { headers } from "next/headers";
import { SiteRenderer } from "@/components/website/render/site-renderer";
import type { ResolvedAsset } from "@/components/website/render/ctx";
import { createBuilder } from "@/lib/website/build";
import { findPage, pagePath, type SiteContent, type SitePage } from "@/lib/website/doc";
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

/**
 * The page shown after an enquiry. If the owner built their own thank-you page it is used as it is; otherwise the site's own header and
 * footer surround the owner's chosen message.
 */
export function thanksPage(content: SiteContent): { content: SiteContent; page: SitePage } {
  const own = content.pages.find((p) => p.kind === "thanks");
  if (own) return { content, page: own };
  const b = createBuilder("th");
  const section = b.section({ id: "thanks-1", name: "Thank you", layout: { pt: "3xl", pb: "3xl", width: "narrow", minH: "60", valign: "center" } }, [
    b.col(12, [
      b.h1("Thank you", { style: { align: "center", size: "5xl" } }),
      b.lede(content.form.successMessage, { style: { align: "center", w: "m" } }),
      b.group([b.btn("Back to the home page", "/", { variant: "primary", size: "l" })], { justify: "center", style: { mt: "s" } }),
    ], { gap: "m", align: "center" }),
  ]);
  const page: SitePage = { id: "pg-thanks", slug: "thanks", title: "Thank you", kind: "thanks", navLabel: "", showInNav: false, seoTitle: "", seoDescription: "", ogImage: null, noindex: true, items: [section] };
  return { content: { ...content, pages: [...content.pages, page] }, page };
}

export async function renderSitePage(site: LiveSite, host: string, slug: string): Promise<React.ReactElement | null> {
  let content = site.content;
  let page = findPage(content, slug);
  if (slug === "thanks") {
    const t = thanksPage(content);
    content = t.content;
    page = t.page;
  }
  if (!page) return null;
  const assets = await siteAssets(host, site.publicationId);
  return React.createElement(SiteRenderer, {
    content, pageSlug: page.slug, resolveAsset: assetResolver(assets), mode: "published", formAction: "/__iaq/form",
    formToken: issueFormToken(host), hrefFor: hrefForPage, publicationId: site.publicationId,
  });
}

export { pagePath };
