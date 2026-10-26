import { notFound } from "next/navigation";
import { env } from "@/server/env";
import { PreviewTheme } from "@/components/projects/preview-theme";
import { StudioNav } from "@/components/website/admin/studio-nav";
import { OverviewView } from "@/components/website/admin/overview-view";
import { ReviewsView } from "@/components/website/admin/reviews-view";
import { DomainsView } from "@/components/website/admin/domains-view";
import Client from "./client";
import { SAMPLE_DOMAINS, SAMPLE_OVERVIEW, SAMPLE_QUEUES } from "./sample";

export const dynamic = "force-dynamic";
export const metadata = { title: "Website Studio design preview" };

const VIEWS = ["overview", "websites", "workspace", "library", "reviews", "domains"] as const;
type View = (typeof VIEWS)[number];

/**
 * Development only (404 in production): the agency's Website Studio screens with invented sample data and no sign-in, so they can be reviewed
 * in a browser. Nothing here is read from or written to a database. Actions on these screens (publish, archive, duplicate) call real server
 * actions that need a signed-in agency user, so they are expected to be refused here.
 */
export default async function AdminStudioPreview({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  if (env().NODE_ENV === "production") notFound();
  const { view: raw } = await searchParams;
  const view: View = (VIEWS as readonly string[]).includes(raw ?? "") ? (raw as View) : "overview";
  return (
    <main className="mx-auto max-w-[1500px] space-y-5 p-4 sm:p-8">
      <PreviewTheme />
      <p className="text-[12px] font-semibold uppercase tracking-[.14em] text-muted">Design preview · invented sample data · {VIEWS.map((v) => <a key={v} href={`?view=${v}`} className={v === view ? "ml-3 text-ink underline" : "ml-3 hover:text-ink"}>{v}</a>)}</p>
      <StudioNav />
      {view === "overview" && <OverviewView o={SAMPLE_OVERVIEW} superAdmin />}
      {view === "reviews" && <ReviewsView q={SAMPLE_QUEUES} />}
      {view === "domains" && <DomainsView o={SAMPLE_DOMAINS} timeZone="UTC" baseDomain="sites.example" cnameTarget="cname.sites.example" />}
      {(view === "websites" || view === "workspace" || view === "library") && <Client view={view} />}
    </main>
  );
}

