import type { Metadata } from "next";
import { SiteFrame } from "@/components/website/frame/site-frame";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Website preview", robots: { index: false, follow: false } };

/** A client's draft inside an iframe: for the client's own team, and for agency staff assigned to that client. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  return <SiteFrame q={await searchParams} base="/frame/site" />;
}
