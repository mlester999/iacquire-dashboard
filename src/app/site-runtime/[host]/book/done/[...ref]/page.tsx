import type { Metadata } from "next";
import { after } from "next/server";
import { notFound } from "next/navigation";
import { BookingPage } from "@/components/website/render/booking-pages";
import { siteBookedPage } from "@/server/sites/booking";
import { renderSiteShell, siteForRequest } from "@/server/sites/render";
import { recordUsage } from "@/server/sites/runtime";

// The page a visitor lands on after booking on a customer's site (/_booked/...). Its address can carry the customer's manage link, so it
// is never indexed and never sends its address on to another site.

export const dynamic = "force-dynamic";

type Params = Promise<{ host: string; ref: string[] }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const site = await siteForRequest((await params).host);
  const name = site?.content.business.name;
  return { title: { absolute: name ? `Your booking | ${name}` : "Your booking" }, robots: { index: false, follow: false }, referrer: "no-referrer" };
}

export default async function SiteBookedRoute({ params }: { params: Params }) {
  const { host: hostParam, ref } = await params;
  const site = await siteForRequest(hostParam);
  if (!site) notFound();
  const host = decodeURIComponent(hostParam).toLowerCase();
  const res = await siteBookedPage(site, host, ref ?? []);
  if (res.kind === "not_found") notFound();
  after(() => recordUsage(host, 0));
  return renderSiteShell(site, host, res.title, <BookingPage view={res.view} />);
}
