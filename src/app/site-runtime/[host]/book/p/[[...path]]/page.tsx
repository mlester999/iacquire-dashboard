import type { Metadata } from "next";
import { headers } from "next/headers";
import { after } from "next/server";
import { notFound } from "next/navigation";
import { BookingPage } from "@/components/website/render/booking-pages";
import { siteBookingPage } from "@/server/sites/booking";
import { renderSiteShell, siteForRequest } from "@/server/sites/render";
import { recordUsage } from "@/server/sites/runtime";

// A site's own booking pages: /_book, /_book/<calendar> and /_book/<calendar>/<type> on a customer's host (the proxy rewrites them here).
// Server-rendered links and forms only, inside the site's header and footer.

export const dynamic = "force-dynamic";

type Params = Promise<{ host: string; path?: string[] }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const site = await siteForRequest((await params).host);
  const name = site?.content.business.name;
  // Times change by the minute, so these pages are never offered to search engines.
  return { title: { absolute: name ? `Book an appointment | ${name}` : "Book an appointment" }, robots: { index: false, follow: true } };
}

export default async function SiteBookingRoute({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { host: hostParam, path } = await params;
  const site = await siteForRequest(hostParam);
  if (!site) notFound();
  const host = decodeURIComponent(hostParam).toLowerCase();
  const raw = await searchParams;
  const query: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) {
    const one = Array.isArray(v) ? v[0] : v;
    if (typeof one === "string") query[k] = one.slice(0, 100);
  }
  const res = await siteBookingPage(site, host, { path: path ?? [], query, forwardedFor: (await headers()).get("x-forwarded-for") });
  if (res.kind === "not_found") notFound();
  after(() => recordUsage(host, 0));
  return renderSiteShell(site, host, res.title, <BookingPage view={res.view} />);
}
