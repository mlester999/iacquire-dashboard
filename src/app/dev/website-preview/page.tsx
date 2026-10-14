import { notFound } from "next/navigation";
import { Globe, History, Inbox, Palette } from "lucide-react";
import { env } from "@/server/env";
import { PageHero } from "@/components/ui/workspace";
import { DomainsView } from "@/components/website/portal/domains-view";
import { EnquiriesList } from "@/components/website/portal/enquiries-list";
import { HistoryView } from "@/components/website/portal/history-view";
import { NewWebsite } from "@/components/website/portal/new-website";
import { OverviewView } from "@/components/website/portal/overview-view";
import { WebsiteSubnav } from "@/components/website/portal/website-subnav";
import type { SiteDetails } from "@/lib/website/generate";
import type { DnsInstructions } from "@/server/websites/domains";
import type { SubmissionView } from "@/server/websites/forms";
import type { DomainView, PublicationView, VersionView, WebsiteSummary } from "@/server/websites/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Website pages preview" };

/*
 * Development only (404 in production). The real website pages drawn with clearly labelled sample data and no server behind them:
 * buttons that need the server show an error instead of doing anything. ?view=overview|domains|history|enquiries|new
 * and ?state=live|draft|unhealthy|submitted change what the sample shows.
 */

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const domain = (p: Partial<DomainView>): DomainView => ({
  id: crypto.randomUUID(), hostname: "x.test", kind: "custom", status: "pending_dns", verificationToken: "a1b2c3d4e5f60718293a4b5c6d7e8f90", verifiedAt: null, dnsCheckedAt: null, dnsDetail: null,
  routingOk: null, sslStatus: "unknown", sslDetail: null, liveOk: null, liveCheckedAt: null, isPrimary: false, acquisition: "existing", registrar: null, renewsAt: null, purchaseCostMicros: null, ...p,
});

const DETAILS: SiteDetails = {
  businessName: "Brightside Roofing", industry: "home_services", tagline: "Roof repairs and replacements across Austin",
  description: "We repair and replace roofs for homeowners in Austin.", services: [{ title: "Roof repair" }, { title: "Roof replacement" }, { title: "Storm damage" }],
  phone: "+15125550100", email: "hello@brightside.test", address: "100 Sample Street, Austin", hours: "Mon–Fri 8:00–17:00", areas: ["Austin", "Round Rock"], primary: "#c2410c", accent: "#0f766e",
  pages: ["home", "about", "services", "faq", "contact"], primaryAction: "call",
};

function sampleSite(state: string): WebsiteSummary {
  const live = state !== "draft";
  const platform = domain({ hostname: "brightside-roofing.sites.localhost", kind: "platform", status: "active", isPrimary: true, liveOk: live ? true : null, acquisition: "platform" });
  return {
    id: crypto.randomUUID(), name: "Brightside Roofing", kind: "website", templateKey: "forge.torque", subdomain: "brightside-roofing", platformHost: "brightside-roofing.sites.localhost",
    draftRevision: 7, draftUpdatedAt: ago(0.1),
    approval: { status: state === "submitted" ? "submitted" : "draft", note: null, decidedAt: null },
    published: live ? { publicationId: crypto.randomUUID(), number: 3, publishedAt: ago(2), health: state === "unhealthy" ? "unhealthy" : "healthy", healthDetail: state === "unhealthy" ? "The live check got an error page instead of your site." : null, healthCheckedAt: ago(0.01) } : null,
    hasUnpublishedChanges: live, domains: [platform, domain({ hostname: "brightsideroofing.example.com", status: "verified", routingOk: false, dnsDetail: "Ownership confirmed. It currently points to parking.example.net, not sites.iacquire.com." })],
  };
}

const SUBMISSIONS: SubmissionView[] = [
  { id: "s1", pageSlug: "contact", name: "Dana Whitfield", email: "dana@example.test", phone: "+15125550123", service: "Roof repair", message: "A branch came through our roof last night. Can someone take a look this week?", marketingOptIn: false, status: "processed", contactId: "c1", createdAt: ago(0.2), utm: {}, referrer: null },
  { id: "s2", pageSlug: "home", name: "Marcus Lee", email: "marcus@example.test", phone: null, service: null, message: "Looking for a quote on a full replacement.", marketingOptIn: true, status: "received", contactId: null, createdAt: ago(1), utm: {}, referrer: null },
  { id: "s3", pageSlug: "contact", name: "Cheap SEO Deals", email: "seo@example.test", phone: null, service: null, message: "Rank #1 on Google in a week!!!", marketingOptIn: false, status: "spam", contactId: null, createdAt: ago(3), utm: {}, referrer: null },
];

const VERSIONS: VersionView[] = [
  { id: "v3", version: 3, templateKey: "forge.torque", source: "publish", note: "Added storm damage page", createdAt: ago(2), createdByName: "Sam Rivera", isLive: true },
  { id: "v2", version: 2, templateKey: "forge.torque", source: "editor", note: null, createdAt: ago(5), createdByName: "Sam Rivera", isLive: false },
  { id: "v1", version: 1, templateKey: "forge.torque", source: "generated", note: "First draft written from your business details", createdAt: ago(9), createdByName: null, isLive: false },
];
const PUBLICATIONS: PublicationView[] = [
  { id: "p3", number: 3, templateKey: "forge.torque", status: "live", health: "healthy", healthDetail: null, note: "Added storm damage page", rolledBackTo: null, publishedAt: ago(2), publishedByName: "Sam Rivera" },
  { id: "p2", number: 2, templateKey: "forge.torque", status: "superseded", health: "healthy", healthDetail: null, note: null, rolledBackTo: null, publishedAt: ago(6), publishedByName: "Sam Rivera" },
  { id: "p1", number: 1, templateKey: "forge.torque", status: "failed", health: "unhealthy", healthDetail: "The first publish couldn't be served.", note: null, rolledBackTo: null, publishedAt: ago(9), publishedByName: "Sam Rivera" },
];

export default async function WebsitePreview({ searchParams }: { searchParams: Promise<{ view?: string; state?: string; role?: string }> }) {
  if (env().NODE_ENV === "production") notFound();
  const { view = "overview", state = "live", role = "owner" } = await searchParams;
  const owner = role !== "editor";
  const site = sampleSite(state);
  const dns: Record<string, DnsInstructions> = Object.fromEntries(
    site.domains.filter((d) => d.kind === "custom").map((d) => [d.id, {
      verifyRecord: { type: "TXT" as const, name: `_iacquire-verify.${d.hostname}`, value: `iacquire-site-verification=${d.verificationToken}` },
      routing: { type: "CNAME" as const, name: d.hostname, value: "sites.iacquire.com", note: "Add this CNAME record." }, notes: [],
    }]),
  );
  const purchase = domain({ hostname: "brightsideroofs.example", acquisition: "purchase_requested", purchaseCostMicros: 14_980_000 });

  return (
    <div className="app-backdrop grain min-h-dvh">
      <div role="region" aria-label="Preview notice" className="sticky top-0 z-40 border-b border-warning/30 bg-warning-soft px-4 py-2 text-center text-[12.5px] font-medium text-warning-ink">
        Design preview. Sample data for Brightside Roofing; nothing here is real and buttons that need a server will report an error. Try ?view=overview|domains|history|enquiries|new, ?state=live|draft|unhealthy|submitted, ?role=editor
      </div>
      <main id="main" className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
        <WebsiteSubnav hasSite canEdit />
        {view === "overview" && (
          <OverviewView
            site={site}
            pf={{ blockers: state === "draft" ? [{ code: "contact_missing", message: "Add a phone number or an email address so visitors can reach you.", where: "Business details" }] : [], warnings: [], needsAcknowledgement: state === "draft" ? [] : [{ code: "claim_licensed", message: "“Licensed and insured” is a claim customers rely on.", where: "Home › Hero" }], canPublishNow: state !== "draft" }}
            enquiries={SUBMISSIONS.slice(0, 3)} timeZone="America/Chicago" perms={{ canEdit: true, canPublish: owner, canApprove: owner }}
          />
        )}
        {view === "domains" && (
          <div className="space-y-6">
            <PageHero eyebrow="Website" title="Your website address" icon={<Globe className="size-4" />} tone="neutral" description="Your site works on its included address straight away. If you want your own name, connect a domain you own, or ask us to get one for you. We never buy a domain without your approval." />
            <DomainsView
              platformHost={site.platformHost} subdomain={site.subdomain} baseDomain="sites.localhost" domains={[...site.domains, purchase]} instructions={{ ...dns, [purchase.id]: dns[site.domains[1].id] }}
              canManage canApprove={owner} hasPublished
            />
          </div>
        )}
        {view === "history" && (
          <div className="space-y-6">
            <PageHero eyebrow="Website" title="History and rollback" icon={<History className="size-4" />} tone="neutral" description="Every draft you've saved and every version you've published is kept. Nothing you do here can lose your work." />
            <HistoryView versions={VERSIONS} publications={PUBLICATIONS} assets={[]} draftRevision={7} canEdit canPublish={owner} timeZone="America/Chicago" />
          </div>
        )}
        {view === "enquiries" && (
          <div className="space-y-6">
            <PageHero eyebrow="Website" title="Enquiries from your website" icon={<Inbox className="size-4" />} tone="neutral" description="Everyone who filled in your form. Each one becomes a contact automatically, with their consent recorded exactly as they gave it. We never message anyone from here." />
            <EnquiriesList items={state === "empty" ? [] : SUBMISSIONS} canEdit />
          </div>
        )}
        {view === "new" && (
          <div className="space-y-6">
            <PageHero eyebrow="Website" title="Pick a look. We'll write the first draft." icon={<Palette className="size-4" />} tone="neutral" description="Every style below is shown with your own business name, colours and services. Pick the one that feels right; you can change it later without losing a word. Nothing goes live until you publish." />
            <NewWebsite details={DETAILS} industry={DETAILS.industry} />
          </div>
        )}
      </main>
    </div>
  );
}
