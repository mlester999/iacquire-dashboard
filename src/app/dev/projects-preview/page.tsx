import Link from "next/link";
import { notFound } from "next/navigation";
import { listCatalogForAdmin } from "@/server/catalog/service";
import { listPortfolioForAdmin } from "@/server/portfolio/service";
import type { SessionUser } from "@/server/auth/service";
import type { AgencyProjectDetail } from "@/server/projects/agency";
import type { ProjectDetail } from "@/server/projects/shared";
import type { MaintenanceOverview } from "@/server/maintenance/service";
import type { PortfolioCard, PortfolioDetail,AdminPortfolioRow } from "@/server/portfolio/service";
import founder from "../../../../content/founder-portfolio.json";
import { Marketplace } from "@/components/projects/marketplace";
import { RequestWizard } from "@/components/projects/request-wizard";
import { ProjectWorkspace } from "@/components/projects/project-workspace";
import { MaintenancePanel } from "@/components/projects/maintenance-panel";
import { PortfolioGallery, FounderNotice } from "@/components/portfolio/portfolio-views";
import { AdminProjectWorkspace } from "@/components/admin/admin-project-workspace";
import { ServiceCatalogAdmin } from "@/components/admin/service-catalog-admin";
import { PortfolioAdmin } from "@/components/admin/portfolio-admin";
import { MaintenanceAdmin } from "@/components/admin/maintenance-admin";
import { CaseStudy } from "@/components/portfolio/case-study";
import { portfolioTitle } from "@/lib/projects";
import { PreviewTheme } from "@/components/projects/preview-theme";

export const dynamic = "force-dynamic";

const VIEWS = ["marketplace", "wizard", "project", "maintenance", "gallery", "case-study", "admin-project", "admin-services", "admin-portfolio", "admin-maintenance"] as const;
type View = (typeof VIEWS)[number];

// Dev-only stand-in so the preview can read the catalog without a login. Never used outside this page.
const previewAdmin = { id: "00000000-0000-0000-0000-000000000000", platformRole: "agency_super_admin" } as unknown as SessionUser;

const now = Date.now();
const ago = (h: number) => new Date(now - h * 3600_000).toISOString();

const sampleProject: ProjectDetail = {
  request: {
    id: "11111111-1111-1111-1111-111111111111",
    ref: "PRJ-1042",
    orgId: "22222222-2222-2222-2222-222222222222",
    title: "AI voice receptionist for incoming calls",
    summary: "We miss calls after hours.",
    toolsUsed: ["GoHighLevel", "Google Calendar"],
    preferredDeadline: null,
    budgetRange: "$1,000–$2,500",
    status: "awaiting_approval",
    statusBeforeHold: null,
    serviceId: null,
    serviceName: "AI Voice Receptionist",
    serviceSlug: "ai-voice-receptionist",
    isAssigned: true,
    cancelReason: null,
    submittedAt: ago(96),
    lastActivityAt: ago(2),
    closedAt: null,
  },
  requirements: [
    { key: "build", label: "What would you like us to build?", answer: "An AI that answers incoming customer phone calls and books appointments." },
    { key: "problem", label: "What business problem are you trying to solve?", answer: "We miss calls after hours and lose booked appointments." },
    { key: "current_process", label: "How does your current process work?", answer: "Calls go to voicemail and someone returns them the next day." },
    { key: "desired_outcome", label: "What would you like the new system to do?", answer: "Answer calls, check availability and book appointments on our calendar." },
  ],
  quotes: [
    {
      id: "q1", version: 1, status: "sent", projectName: "AI voice receptionist", scope: "Configure and deploy a voice receptionist that answers inbound calls, checks live availability, and books or reschedules appointments on your calendar, with call summaries logged and a path to a human.",
      deliverables: ["Voice agent configured to your services", "Google Calendar availability and booking", "Call summaries logged", "Documentation and handover"], includedIntegrations: ["Google Calendar", "GoHighLevel"], exclusions: ["Telephony and AI usage costs", "Work outside this scope"],
      timelineText: "3–4 weeks after kickoff", estimatedWeeksMin: 3, estimatedWeeksMax: 4, oneTimeCents: 120000, ongoingMonthlyCents: null, ongoingDescription: null,
      revisionTerms: "Two rounds of revisions are included.", paymentTerms: "50% to begin, 50% on delivery. Invoiced separately.", warrantyTerms: "30 days of post-launch fixes.", currency: "USD", validUntil: "2099-01-01", contentHash: "x", sentAt: ago(20), firstViewedAt: ago(10), createdAt: ago(30), decision: null,
    },
  ],
  delivery: null,
  milestones: [
    { id: "m1", title: "Discovery", description: "Understand call flows and services.", sortOrder: 10, status: "completed", dueOn: null, requiresClientApproval: false, clientApprovedAt: null, clientNote: null, completedAt: ago(70) },
    { id: "m2", title: "Knowledge setup", description: "Load your services, hours and FAQs.", sortOrder: 20, status: "completed", dueOn: null, requiresClientApproval: true, clientApprovedAt: ago(48), clientNote: null, completedAt: ago(48) },
    { id: "m3", title: "Voice agent development", description: "Build and tune the voice agent.", sortOrder: 30, status: "awaiting_approval", dueOn: "2026-11-10", requiresClientApproval: true, clientApprovedAt: null, clientNote: null, completedAt: null },
    { id: "m4", title: "Calendar integration", description: null, sortOrder: 40, status: "pending", dueOn: null, requiresClientApproval: false, clientApprovedAt: null, clientNote: null, completedAt: null },
    { id: "m5", title: "Testing and launch", description: null, sortOrder: 50, status: "pending", dueOn: null, requiresClientApproval: true, clientApprovedAt: null, clientNote: null, completedAt: null },
  ],
  updates: [
    { id: "u1", kind: "system", body: "Quote v1 sent for your review.", visibility: "client", authorName: null, createdAt: ago(20) },
    { id: "u2", kind: "progress", body: "Kick-off call completed. We have your service list and opening hours.", visibility: "client", authorName: null, createdAt: ago(60) },
    { id: "u3", kind: "system", body: "Request submitted. The iAcquire team will review it and reply here.", visibility: "client", authorName: null, createdAt: ago(96) },
  ],
  files: [{ id: "f1", filename: "current-call-script.pdf", mimeType: "application/pdf", sizeBytes: 182_000, kind: "requirement", visibility: "client", description: null, uploadedByKind: "client", createdAt: ago(90) }],
  messages: [
    { id: "ms1", authorKind: "agency", authorName: null, kind: "info_request", body: "Which calendar do you use for bookings, and do you want the agent to transfer calls to a person?", internal: false, createdAt: ago(80) },
    { id: "ms2", authorKind: "client", authorName: "Jordan", kind: "info_response", body: "Google Calendar, and yes: transfer to the front desk if the caller asks for a person.", internal: false, createdAt: ago(75) },
  ],
  tickets: [],
  changes: [],
  amendments: [],
  prerequisites: [],
};

const sampleAdmin: AgencyProjectDetail = {
  ...sampleProject,
  orgName: "Sample Dental Group",
  createdByName: "Jordan Owner",
  internalNotes: "Client is price sensitive. Keep scope tight.",
  assignedTo: { id: "a1", name: "Sam Staff" },
  assignable: [{ id: "a1", name: "Sam Staff" }, { id: "a2", name: "Avery Admin" }],
  tasks: [{ id: "t1", kind: "respond_to_client", title: "Reply to Sample Dental Group on PRJ-1042", dueAt: ago(-24), createdAt: ago(1) }],
  suggestedServices: [{ id: "s1", slug: "ai-voice-receptionist", name: "AI Voice Receptionist" }],
  quoteInternalNotes: { q1: "Margin is fine." },
  messages: [...sampleProject.messages, { id: "ms3", authorKind: "agency", authorName: "Sam Staff", kind: "message", body: "Internal: quote at the low end of the published range.", internal: true, createdAt: ago(40) }],
  request: { ...sampleProject.request, status: "under_review" },
  quotes: [{ ...sampleProject.quotes[0], status: "draft", sentAt: null, firstViewedAt: null }],
};

const sampleMaintenance: MaintenanceOverview = {
  eligible: true,
  eligibilityNote: null,
  plan: {
    id: "p", slug: "managed-maintenance", kind: "maintenance_plan", categoryId: "c", categoryCode: "managed_maintenance", categoryName: "Managed Maintenance", name: "Fully Managed Maintenance",
    tagline: "Optional hands-on upkeep for your iAcquire system: monitoring, troubleshooting, reasonable configuration adjustments and AI optimization.", description: "", problemSolved: "", accomplishes: [],
    deliverables: ["Monitoring of your connected integrations and AI employee health, with alerts to our team", "Troubleshooting when an integration, workflow or AI employee stops working as configured", "Reasonable configuration adjustments, such as updating AI knowledge or instructions", "AI optimization reviews based on how your AI employees are performing", "Smaller improvements within your monthly request allowance"],
    exclusions: ["New automations, AI agents, websites, funnels or software: quoted separately, even with an active plan", "Third-party platform subscriptions and usage or API costs", "Unlimited requests, unlimited AI usage, free future development or lifetime maintenance"],
    optionalUpgrades: [], platforms: [], useCases: [], tags: [], keywords: [], deliveryMinDays: null, deliveryMaxDays: null, availability: "available", featured: false, requiresQuote: false, visible: true, sortOrder: 900,
    monthlyRequestAllowance: 4, coreOverlapNote: null, sourceNote: null, price: { type: "monthly", minCents: 29900, maxCents: null, currency: "USD", note: "Optional monthly plan. Billing starts only after you accept the plan and your system is activated." }, portfolio: [],
  },
  subscription: { id: "s", status: "active", monthlyPriceCents: 29900, currency: "USD", monthlyRequestAllowance: 4, termsVersion: "2026-10", acceptedAt: ago(500), activatedAt: ago(480), billingStartOn: "2026-10-01", renewalOn: "2026-11-01", cancelRequestedAt: null },
  allowance: { total: 4, used: 2, remaining: 2, month: "2026-10" },
  requests: [
    { id: "r1", ref: "MNT-1003", kind: "managed_change", title: "Update FAQ answers for the assistant", description: "Refresh answers.", status: "in_progress", ticketId: null, countsAgainstAllowance: true, resolutionNote: null, createdAt: ago(30), closedAt: null },
    { id: "r2", ref: "MNT-1002", kind: "core_defect", title: "Calendar sync stopped on Tuesday", description: "Booking failed.", status: "completed", ticketId: null, countsAgainstAllowance: false, resolutionNote: "Reconnected the calendar and verified bookings.", createdAt: ago(200), closedAt: ago(190) },
  ],
};

const sampleSubscriptions = [
  { id: "s1", status: "requested" as const, monthlyPriceCents: 29900, currency: "USD", monthlyRequestAllowance: 4, termsVersion: "2026-10", acceptedAt: ago(30), activatedAt: null, billingStartOn: null, renewalOn: null, cancelRequestedAt: null, orgId: "o1", orgName: "Sample Dental Group", used: 0, requestNote: "Interested in monitoring.", cancelNote: null, eligible: true },
  { id: "s2", status: "active" as const, monthlyPriceCents: 29900, currency: "USD", monthlyRequestAllowance: 4, termsVersion: "2026-10", acceptedAt: ago(900), activatedAt: ago(880), billingStartOn: "2026-10-01", renewalOn: "2026-11-01", cancelRequestedAt: null, orgId: "o2", orgName: "Sample Roofing Co", used: 3, requestNote: null, cancelNote: null, eligible: true },
];
const sampleMaintenanceRequests = [
  { id: "r1", ref: "MNT-1003", kind: "managed_change" as const, title: "Update FAQ answers for the assistant", description: "Please refresh the FAQ answers.", status: "open", countsAgainstAllowance: true, orgId: "o2", orgName: "Sample Roofing Co", ticketId: null, createdAt: ago(10), internalNotes: null },
  { id: "r2", ref: "MNT-1002", kind: "core_defect" as const, title: "Calendar sync stopped", description: "Bookings fail since Tuesday.", status: "in_progress", countsAgainstAllowance: false, orgId: "o1", orgName: "Sample Dental Group", ticketId: null, createdAt: ago(40), internalNotes: null },
];

function founderCards(): PortfolioCard[] {
  return founder.projects.map((p, i) => ({
    id: `p${i}`, slug: p.slug, title: portfolioTitle({ title: p.title, anonymizedTitle: p.anonymizedTitle, clientNamePublic: p.clientNamePublic }), summary: p.summary,
    status: p.status as PortfolioCard["status"], statusLabel: p.statusLabel, technologies: p.technologies, categories: p.categories, featured: p.featured, attribution: founder.attribution, coverAssetId: null, services: [],
  }));
}

export default async function ProjectsPreview({ searchParams }: { searchParams: Promise<{ view?: string;sample?:string;empty?:string }> }) {
  if (process.env.NODE_ENV !== "development") notFound();
  const { view: raw,sample,empty } = await searchParams;
  const view: View = (VIEWS as readonly string[]).includes(raw ?? "") ? (raw as View) : "marketplace";
  const catalog = await listCatalogForAdmin(previewAdmin);
  const services = catalog.services.filter((s) => s.kind !== "maintenance_plan" && s.visible);
  const portfolioAdmin = view === "admin-portfolio" ? await listPortfolioForAdmin(previewAdmin) : { projects: [], services: [] };
  const samplePortfolio:AdminPortfolioRow[]=sample==="1"?founder.projects.map((p,i)=>({id:`preview-${i}`,slug:p.slug,title:p.title,anonymizedTitle:p.anonymizedTitle,clientNamePublic:p.clientNamePublic,summary:p.summary,problem:p.problem,solution:p.solution,publishedOutcome:p.publishedOutcome,sections:p.sections,limitations:p.limitations,privacyNote:p.privacyNote,technologies:p.technologies,categories:p.categories,status:p.status as AdminPortfolioRow["status"],statusLabel:p.statusLabel,liveDemoUrl:null,attribution:founder.attribution,sourceUrl:null,sourceImportedAt:null,featured:p.featured,reviewState:"pending_review",disclosureConfirmed:false,visible:false,sortOrder:i,serviceSlugs:p.services,assets:[]})):[];
  const fp = founder.projects[0];
  const founderDetail: PortfolioDetail | null =
    view === "case-study"
      ? {
          id: "p0", slug: fp.slug, title: fp.title, summary: fp.summary, status: fp.status as PortfolioDetail["status"], statusLabel: fp.statusLabel, technologies: fp.technologies, categories: fp.categories,
          featured: fp.featured, attribution: founder.attribution, coverAssetId: null, services: fp.services.map((slug) => ({ slug, name: slug })), problem: fp.problem, solution: fp.solution,
          publishedOutcome: fp.publishedOutcome, sections: fp.sections, limitations: fp.limitations, privacyNote: fp.privacyNote, liveDemoUrl: null, assets: [],
        }
      : null;
  return (
    <main className="app-backdrop min-h-dvh p-4 sm:p-8">
      <div className="mx-auto max-w-[1200px] space-y-6">
        <p className="rounded-xl bg-warning-soft p-3 text-xs text-warning-ink">
          Development UI preview · Sample data only. Actions are disabled here because there is no signed-in session. Views:{" "}
          {VIEWS.map((v) => (
            <Link key={v} href={`/dev/projects-preview?view=${v}`} className={`mr-2 underline ${v === view ? "font-bold" : ""}`}>
              {v}
            </Link>
          ))}
        </p>
        <PreviewTheme/>
        {view === "marketplace" && <Marketplace services={services} canRequest maintenancePrice="$299/month" />}
        {view === "wizard" && <RequestWizard services={services} connected={["ghl"]} initialServiceSlug="ai-voice-receptionist" reference={null} />}
        {view === "project" && <ProjectWorkspace project={sampleProject} timeZone="UTC" canRequest canApproveQuote canOpenSupport justSubmitted={false} />}
        {view === "maintenance" && <MaintenancePanel overview={empty==="1"?{...sampleMaintenance,subscription:null,allowance:null,requests:[]}:sampleMaintenance} timeZone="UTC" canManagePlan canRequest />}
        {view === "gallery" && (
          <div className="space-y-6">
            <h2 className="text-[26px] font-semibold tracking-[-0.02em]">Selected Work from Our Founder</h2>
            <FounderNotice />
            <PortfolioGallery projects={founderCards()} />
          </div>
        )}
        {view === "case-study" && founderDetail && <CaseStudy project={founderDetail} services={services.filter((s) => founderDetail.services.some((x) => x.slug === s.slug))} canRequest />}
        {view === "admin-project" && <AdminProjectWorkspace project={sampleAdmin} currentUserId="a1" />}
        {view === "admin-services" && <ServiceCatalogAdmin services={catalog.services} categories={catalog.categories} portfolio={catalog.portfolio} />}
        {view === "admin-portfolio" && <PortfolioAdmin projects={sample==="1"?samplePortfolio:portfolioAdmin.projects} services={portfolioAdmin.services} />}
        {view === "admin-maintenance" && <MaintenanceAdmin subscriptions={empty==="1"?[]:sampleSubscriptions} requests={empty==="1"?[]:sampleMaintenanceRequests} />}
      </div>
    </main>
  );
}

export type { PortfolioDetail };
