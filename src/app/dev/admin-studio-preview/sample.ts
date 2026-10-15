// Sample data for reviewing the agency's Website Studio screens without signing in. Every name below is invented, and none of it comes from a
// database: this exists only so the real screens can be looked at in a browser.
import type { DomainsOverview } from "@/components/website/admin/domains-view";
import type { ReviewQueues } from "@/components/website/admin/reviews-view";
import type { ManagedWebsite, StudioOverview } from "@/server/websites/admin";
import type { TemplateView } from "@/server/websites/templates";
import type { PatternView } from "@/server/websites/components";
import type { CommentView, ReviewSummary } from "@/server/websites/review";
import type { Preflight, PublicationView, WebsiteSummary } from "@/server/websites/service";
import { FAMILIES, sampleSite, templateKey } from "@/lib/website/templates";
import { INDUSTRY_FILTERS } from "@/lib/website/gallery";
import { contentFacets } from "@/lib/website/gallery-facets";

// A fixed moment, not the clock: the server and the browser both build this data, and they must agree on every timestamp.
const NOW = Date.parse("2026-10-15T08:00:00.000Z");
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const base = (over: Partial<ManagedWebsite> & Pick<ManagedWebsite, "orgName" | "name" | "templateKey" | "templateName" | "lifecycle">, n: number): ManagedWebsite => ({
  websiteId: id(n), orgId: id(100 + n), approval: "draft", approvalNote: null, draftUpdatedAt: ago(3), published: null, domain: null, warnings: [], openComments: 0, enquiries30d: 0, archived: false, lockedBy: null, ...over,
});

export const SAMPLE_SITES: ManagedWebsite[] = [
  base({ orgName: "Brightside Realty (sample)", name: "Brightside Realty", templateKey: "meridian.estate", templateName: "Meridian · Estate", lifecycle: "published", approval: "approved", draftUpdatedAt: ago(30), published: { number: 4, publishedAt: ago(28), health: "healthy", healthDetail: null }, domain: { hostname: "brightside.sites.example", kind: "platform", status: "active", sslStatus: "ready", liveOk: true, detail: null }, enquiries30d: 18 }, 1),
  base({ orgName: "Sunrise Dental (sample)", name: "Sunrise Dental", templateKey: "care.haven", templateName: "Care · Haven", lifecycle: "ready_for_review", approval: "submitted", approvalNote: "Please check the opening hours before this goes live.", draftUpdatedAt: ago(2), openComments: 2, domain: { hostname: "sunrisedental.sites.example", kind: "platform", status: "active", sslStatus: "ready", liveOk: null, detail: null } }, 2),
  base({ orgName: "Northwind Plumbing (sample)", name: "Northwind Plumbing", templateKey: "local.crew", templateName: "Local · Crew", lifecycle: "changes_requested", approval: "changes_requested", approvalNote: "Swap the hero photo for one of our vans.", draftUpdatedAt: ago(20), warnings: ["Changes were requested by the owner."] }, 3),
  base({ orgName: "Harbor Legal (sample)", name: "Harbor Legal", templateKey: "corp.atlas", templateName: "Corporate · Atlas", lifecycle: "approved", approval: "approved", draftUpdatedAt: ago(9), domain: { hostname: "harborlegal.example", kind: "custom", status: "pending_dns", sslStatus: "pending", liveOk: null, detail: "The CNAME record has not been found yet." }, warnings: ["harborlegal.example: DNS not verified"] }, 4),
  base({ orgName: "Maple Street Bakery (sample)", name: "Maple Street Bakery", templateKey: "luxe.maison", templateName: "Luxe · Maison", lifecycle: "publication_failed", draftUpdatedAt: ago(50), warnings: ["The last publication failed. Nothing is live."] }, 5),
  base({ orgName: "Orbit Analytics (sample)", name: "Orbit Analytics", templateKey: "tech.nova", templateName: "Tech · Nova", lifecycle: "published", approval: "approved", draftUpdatedAt: ago(70), published: { number: 2, publishedAt: ago(70), health: "unhealthy", healthDetail: "The site returned an error." }, domain: { hostname: "orbit.example", kind: "custom", status: "active", sslStatus: "ready", liveOk: false, detail: null }, warnings: ["Live site is not answering its health check."], lockedBy: "Dana (agency)" }, 6),
  base({ orgName: "Quiet Pines Retreat (sample)", name: "Quiet Pines Retreat", templateKey: "host.terrace", templateName: "Hospitality · Terrace", lifecycle: "draft", draftUpdatedAt: ago(5) }, 7),
  base({ orgName: "Old Mill Studio (sample)", name: "Old Mill Studio", templateKey: "minimal.quiet", templateName: "Minimal · Quiet", lifecycle: "archived", archived: true, draftUpdatedAt: ago(400) }, 8),
];

export const SAMPLE_OVERVIEW: StudioOverview = {
  total: 8, published: 2, drafts: 5, pendingApprovals: 1, changesRequested: 1, approvedWaiting: 1, domainsNeedingAttention: 1, failedPublications: 1, unhealthy: 1, archived: 1,
  usage30d: { requests: 18420, bytes: 0, enquiries: 18 }, clientsWithoutSite: 2,
  activity: [
    { at: ago(1), action: "website.submitted", label: "Sent for approval", actor: "Sam Rivera", orgName: "Sunrise Dental (sample)", orgId: id(102) },
    { at: ago(8), action: "website.agency_edit", label: "Edited by the agency", actor: "Dana (agency)", orgName: "Orbit Analytics (sample)", orgId: id(106) },
    { at: ago(26), action: "website.published", label: "Website published", actor: "Alex Kim", orgName: "Brightside Realty (sample)", orgId: id(101) },
    { at: ago(30), action: "website.changes_requested", label: "Changes requested", actor: "Priya N.", orgName: "Northwind Plumbing (sample)", orgId: id(103) },
    { at: ago(52), action: "website.template_created", label: "Template created", actor: "Dana (agency)", orgName: null, orgId: null },
  ],
};

export const SAMPLE_QUEUES: ReviewQueues = {
  waiting: SAMPLE_SITES.filter((s) => s.lifecycle === "ready_for_review"),
  approved: SAMPLE_SITES.filter((s) => s.lifecycle === "approved"),
  changes: SAMPLE_SITES.filter((s) => s.lifecycle === "changes_requested"),
  failed: SAMPLE_SITES.filter((s) => s.lifecycle === "publication_failed" || s.published?.health === "unhealthy"),
  comments: SAMPLE_SITES.filter((s) => s.openComments > 0),
};

const dom = (n: number, over: Partial<DomainsOverview["domains"][number]> & Pick<DomainsOverview["domains"][number], "hostname" | "orgName" | "kind" | "status" | "sslStatus">): DomainsOverview["domains"][number] => ({
  id: id(200 + n), websiteId: id(n), orgId: id(100 + n), liveOk: null, routingOk: null, isPrimary: true, dnsDetail: null, sslDetail: null, checkedAt: ago(2), renewsAt: null, acquisition: "existing", needsAttention: false, why: null, ...over,
});
export const SAMPLE_DOMAINS: DomainsOverview = {
  baseDomain: "sites.example",
  domains: [
    dom(1, { hostname: "brightside.sites.example", orgName: "Brightside Realty (sample)", kind: "platform", status: "active", sslStatus: "ready", liveOk: true }),
    dom(4, { hostname: "harborlegal.example", orgName: "Harbor Legal (sample)", kind: "custom", status: "pending_dns", sslStatus: "pending", needsAttention: true, why: "The CNAME record has not been found yet.", checkedAt: ago(0.5) }),
    dom(6, { hostname: "orbit.example", orgName: "Orbit Analytics (sample)", kind: "custom", status: "active", sslStatus: "ready", liveOk: false, needsAttention: true, why: "The live site is not answering.", renewsAt: new Date(NOW + 90 * 86_400_000).toISOString() }),
  ],
  usage: [{ orgId: id(101), orgName: "Brightside Realty (sample)", requests: 12980, bytes: 0, enquiries: 14 }, { orgId: id(106), orgName: "Orbit Analytics (sample)", requests: 5440, bytes: 0, enquiries: 4 }],
};

/** A spread of the built-in designs plus a couple of the agency's own, in the states the library shows. */
export const SAMPLE_TEMPLATES: TemplateView[] = (() => {
  const keys = ["meridian.estate", "luxe.maison", "tech.nova", "care.haven", "bold.riot", "minimal.quiet", "host.terrace", "agency.thesis", "local.corner", "corp.charter", "luxe.noir", "meridian.skyline"];
  const list: TemplateView[] = keys.map((key, i) => {
    const [fam, v] = key.split(".");
    const f = FAMILIES.find((x) => x.id === fam)!;
    const variation = f.variations.find((x) => templateKey(f.id, x.id) === key)!;
    const content = sampleSite(key);
    return {
      ...contentFacets(content), id: null, key, kind: "builtin", name: variation.name, description: variation.description, familyId: f.id, familyName: f.name, industries: INDUSTRY_FILTERS.filter((industry) => industry.families.includes(f.id)).map((industry) => industry.id), tags: variation.tags, status: i === 9 ? "hidden" : "published", featured: i < 6, version: content.origin.version,
      basedOn: null, mode: content.design.mode, updatedAt: null, publishedAt: null, updatedByName: null, hasPreviewImage: false, unpublishedChanges: false, sitesUsing: [4, 2, 1, 3, 0, 1, 0, 2, 5, 1, 0, 1][i],
    } satisfies TemplateView;
    void v;
  });
  list.push(
    { id: id(301), key: "custom.harbor", kind: "custom", name: "Harbor Lights", description: "A calm coastal template made for the agency's hospitality clients.", familyId: "custom", familyName: "Agency originals", industries: ["hospitality"], tags: ["coastal"], status: "in_review", featured: false, version: 0, basedOn: "host.terrace", mode: "light", updatedAt: ago(4), publishedAt: null, updatedByName: "Dana (agency)", hasPreviewImage: false, unpublishedChanges: true, sitesUsing: 0 },
    { id: id(302), key: "custom.studio-grid", kind: "custom", name: "Studio Grid", description: "A portfolio-first layout for designers and photographers.", familyId: "custom", familyName: "Agency originals", industries: ["creative"], tags: ["portfolio"], status: "draft", featured: false, version: 0, basedOn: null, mode: "dark", updatedAt: ago(30), publishedAt: null, updatedByName: "Dana (agency)", hasPreviewImage: false, unpublishedChanges: true, sitesUsing: 0 },
  );
  return list;
})();

export const SAMPLE_SUMMARY: WebsiteSummary = {
  id: id(2), name: "Sunrise Dental", kind: "website", templateKey: "care.haven", subdomain: "sunrisedental", platformHost: "sunrisedental.sites.example", draftRevision: 14, draftUpdatedAt: ago(2),
  approval: { status: "submitted", note: "Please check the opening hours before this goes live.", decidedAt: null }, published: null, hasUnpublishedChanges: true,
  domains: [{ id: id(202), hostname: "sunrisedental.sites.example", kind: "platform", status: "active", verificationToken: "sample", verifiedAt: ago(100), dnsCheckedAt: ago(2), dnsDetail: null, routingOk: true, sslStatus: "ready", sslDetail: null, liveOk: null, liveCheckedAt: null, isPrimary: true, acquisition: "platform", registrar: null, renewsAt: null, purchaseCostMicros: null }],
};
export const SAMPLE_REVIEW: ReviewSummary = { hasLive: false, liveNumber: null, approval: "submitted", approvalNote: "Please check the opening hours before this goes live.", diff: null };
export const SAMPLE_COMMENTS: CommentView[] = [
  { id: id(401), pageSlug: "home", nodeId: null, body: "The Saturday hours look different from our sign. Can you check?", authorName: "Sam Rivera", authorKind: "client", createdAt: ago(3), resolvedAt: null, resolvedByName: null },
  { id: id(402), pageSlug: "services", nodeId: null, body: "Love the new services layout.", authorName: "Dana (agency)", authorKind: "agency", createdAt: ago(20), resolvedAt: ago(19), resolvedByName: "Sam Rivera" },
];
export const SAMPLE_PUBLICATIONS: PublicationView[] = [];
export const SAMPLE_PREFLIGHT: Preflight = {
  blockers: [{ code: "placeholder", message: "\"[Your answer]\" looks like placeholder text. Replace it with your own words.", where: "Home › FAQ" }],
  warnings: [{ code: "missing_alt", message: "One image has no description for screen readers.", where: "Home › Hero" }], needsAcknowledgement: [], canPublishNow: false,
};

export const SAMPLE_PATTERNS: PatternView[] = [
  { id: id(501), name: "Studio hero with trust row", status: "published", createdByName: "Dana (agency)", updatedAt: ago(40) },
  { id: id(502), name: "Three-step process", status: "draft", createdByName: "Sam (agency)", updatedAt: ago(6) },
  { id: id(503), name: "Old pricing table", status: "archived", createdByName: "Dana (agency)", updatedAt: ago(900) },
];
