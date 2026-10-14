// Shared, client-safe definitions for the service catalog, custom projects, quotes and maintenance.
// Prices and service copy live in the database; nothing here is a price.

export const MARKETPLACE_FILTERS = [
  { id: "all", label: "All Services" },
  { id: "ai-automation", label: "AI Automations" },
  { id: "ai-agents", label: "AI Agents" },
  { id: "crm-integrations", label: "CRM & Integrations" },
  { id: "websites-funnels", label: "Websites & Funnels" },
  { id: "custom-development", label: "Custom Development" },
  { id: "shopify", label: "Shopify" },
] as const;
export type MarketplaceFilterId = (typeof MARKETPLACE_FILTERS)[number]["id"];

export type ServiceAvailability = "available" | "coming_soon" | "unavailable";
export type ServiceKind = "ready_system" | "custom_build" | "maintenance_plan";
export type PriceType = "range" | "starting_at" | "monthly" | "custom_quote";

export interface ServicePrice {
  type: PriceType;
  minCents: number | null;
  maxCents: number | null;
  currency: string;
  note: string | null;
}

export interface ServiceView {
  id: string;
  slug: string;
  kind: ServiceKind;
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  name: string;
  tagline: string;
  description: string;
  problemSolved: string;
  accomplishes: string[];
  deliverables: string[];
  exclusions: string[];
  optionalUpgrades: string[];
  platforms: string[];
  useCases: string[];
  tags: string[];
  keywords: string[];
  deliveryMinDays: number | null;
  deliveryMaxDays: number | null;
  availability: ServiceAvailability;
  featured: boolean;
  requiresQuote: boolean;
  visible: boolean;
  sortOrder: number;
  monthlyRequestAllowance: number | null;
  coreOverlapNote: string | null;
  sourceNote: string | null;
  price: ServicePrice | null;
  portfolio: Array<{ slug: string; title: string; status: PortfolioStatus }>;
}

const usd = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(cents / 100);

export function formatMoney(cents: number | null | undefined, currency = "USD") {
  return cents === null || cents === undefined ? "—" : usd(cents, currency);
}

/** "$499–$999", "From $1,500", "$299/month" or "Custom quote". Quoted prices are never presented as fixed totals. */
export function formatPrice(price: ServicePrice | null): string {
  if (!price) return "Custom quote";
  const min = price.minCents === null ? null : usd(price.minCents, price.currency);
  const max = price.maxCents === null ? null : usd(price.maxCents, price.currency);
  switch (price.type) {
    case "range":
      return `${min}–${max}`;
    case "starting_at":
      return `From ${min}`;
    case "monthly":
      return `${min}/month`;
    default:
      return "Custom quote";
  }
}

export function priceCaption(service: Pick<ServiceView, "kind" | "requiresQuote" | "price">): string {
  if (service.kind === "maintenance_plan") return "Optional · billed monthly once accepted and active";
  if (service.kind === "custom_build") return "Starting price · final price quoted after discovery";
  if (service.price?.type === "range") return "Typical range · confirmed in writing before work starts";
  return service.requiresQuote ? "Quoted after review" : "Published price";
}

/** Delivery windows are stored in days; longer windows read better in weeks. */
export function formatDelivery(min: number | null, max: number | null): string | null {
  if (!min && !max) return null;
  const lo = min ?? max!;
  const hi = max ?? min!;
  if (lo >= 14 && lo % 7 === 0 && hi % 7 === 0) return lo === hi ? `${lo / 7} weeks` : `${lo / 7}–${hi / 7} weeks`;
  return lo === hi ? `${lo} days` : `${lo}–${hi} days`;
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

export type PortfolioStatus = "built" | "in_development" | "built_locally" | "planned";
export const PORTFOLIO_STATUS_LABEL: Record<PortfolioStatus, string> = {
  built: "Built",
  in_development: "In development",
  built_locally: "Built locally",
  planned: "Planned",
};
export const FOUNDER_ATTRIBUTION = "Selected Work from Our Founder";

/** The core offer, kept distinct from every optional add-on, custom project and the optional maintenance plan. */
export const CORE_OFFER = {
  name: "iAcquire AI-Powered Client Acquisition System",
  setupCents: 149900,
  currency: "USD",
  summary: "One-time setup. Once your agreed system is configured, verified and activated, you use it through your iAcquire portal. Everything else on this page is optional.",
} as const;

// ---------------------------------------------------------------------------
// Project requests
// ---------------------------------------------------------------------------

export const PROJECT_STATUSES = [
  "submitted",
  "under_review",
  "discovery_needed",
  "quote_preparing",
  "quote_sent",
  "awaiting_approval",
  "approved",
  "in_development",
  "testing",
  "ready_for_review",
  "completed",
  "on_hold",
  "cancelled",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  submitted: "Request Submitted",
  under_review: "Under Review",
  discovery_needed: "Discovery Needed",
  quote_preparing: "Quote Preparing",
  quote_sent: "Quote Sent",
  awaiting_approval: "Awaiting Approval",
  approved: "Approved",
  in_development: "In Development",
  testing: "Testing",
  ready_for_review: "Ready for Review",
  completed: "Completed",
  on_hold: "On Hold",
  cancelled: "Cancelled",
};

export const PROJECT_STATUS_TONE: Record<ProjectStatus, "primary" | "violet" | "warning" | "success" | "neutral" | "danger"> = {
  submitted: "primary",
  under_review: "primary",
  discovery_needed: "warning",
  quote_preparing: "violet",
  quote_sent: "warning",
  awaiting_approval: "warning",
  approved: "success",
  in_development: "violet",
  testing: "violet",
  ready_for_review: "warning",
  completed: "success",
  on_hold: "neutral",
  cancelled: "danger",
};

/** Statuses where the project is still moving, in the order clients see them. */
export const PROJECT_FLOW: ProjectStatus[] = [
  "submitted",
  "under_review",
  "quote_preparing",
  "quote_sent",
  "approved",
  "in_development",
  "testing",
  "ready_for_review",
  "completed",
];

/** Which statuses staff may move to from each status. Clients cannot change status directly. */
export const STATUS_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  submitted: ["under_review", "discovery_needed", "quote_preparing", "on_hold", "cancelled"],
  under_review: ["discovery_needed", "quote_preparing", "on_hold", "cancelled"],
  discovery_needed: ["under_review", "quote_preparing", "on_hold", "cancelled"],
  quote_preparing: ["discovery_needed", "on_hold", "cancelled"],
  // quote_sent / awaiting_approval are entered by sending a quote; the client or staff move them on.
  quote_sent: ["awaiting_approval", "quote_preparing", "on_hold", "cancelled"],
  awaiting_approval: ["quote_preparing", "on_hold", "cancelled"],
  approved: ["in_development", "on_hold", "cancelled"],
  in_development: ["testing", "on_hold", "cancelled"],
  testing: ["in_development", "ready_for_review", "on_hold", "cancelled"],
  ready_for_review: ["in_development", "completed", "on_hold"],
  completed: [],
  on_hold: [],
  cancelled: [],
};

export const MILESTONE_STATUSES = ["pending", "in_progress", "awaiting_approval", "completed", "blocked"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];
export const MILESTONE_LABEL: Record<MilestoneStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  awaiting_approval: "Awaiting your approval",
  completed: "Completed",
  blocked: "Blocked",
};

export const BUDGET_BANDS = [
  "Under $1,000",
  "$1,000–$2,500",
  "$2,500–$5,000",
  "$5,000–$10,000",
  "Over $10,000",
  "Not sure yet",
] as const;

/** The seven discovery questions beyond the title. Budget, deadline and files are optional. */
export const REQUEST_QUESTIONS = [
  { key: "problem", label: "What business problem are you trying to solve?", required: true },
  { key: "current_process", label: "How does your current process work?", required: true },
  { key: "desired_outcome", label: "What would you like the new system to do?", required: true },
] as const;

export const QUOTE_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  sent: "Awaiting your decision",
  accepted: "Accepted",
  changes_requested: "Changes requested",
  declined: "Declined",
  superseded: "Replaced by a newer version",
  withdrawn: "Withdrawn",
};

export const QUOTE_ACKNOWLEDGEMENT =
  "I confirm I have reviewed this quote. Accepting records my decision against my account and the time it was made. It is not an electronic signature, and no payment is taken. iAcquire will confirm the written agreement and payment terms separately.";

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export const MAINTENANCE_TERMS_VERSION = "2026-10";
export const MAINTENANCE_LANES = [
  {
    id: "core_defect",
    title: "Core defect corrections",
    body: "A confirmed defect in your original iAcquire setup is corrected under your service agreement. No charge, and it never uses your maintenance allowance.",
  },
  {
    id: "basic_support",
    title: "Basic customer support",
    body: "Questions and help using your system are available to every client through Support, with or without a maintenance plan.",
  },
  {
    id: "managed",
    title: "Managed maintenance",
    body: "Optional. Monitoring, troubleshooting, reasonable configuration changes and AI optimization, within a defined monthly request allowance.",
  },
  {
    id: "new_project",
    title: "New custom projects",
    body: "New automations, AI agents, websites and software are scoped and quoted separately, even if you have a maintenance plan.",
  },
] as const;
export type MaintenanceStatus = "requested" | "active" | "cancel_requested" | "cancelled" | "declined";
export const MAINTENANCE_STATUS_LABEL: Record<MaintenanceStatus | "not_enrolled", string> = {
  not_enrolled: "Not enrolled",
  requested: "Awaiting activation",
  active: "Active",
  cancel_requested: "Cancellation requested",
  cancelled: "Cancelled",
  declined: "Declined",
};

// ---------------------------------------------------------------------------
// Smart suggestions
// ---------------------------------------------------------------------------

export interface ServiceSuggestion {
  service: ServiceView;
  score: number;
  /** Plain-language reasons shown to the client. Never a promise of price or fit. */
  reasons: string[];
}

const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9+&.\s-]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Suggests published services from what the client typed and the tools they named. Matching is
 * keyword-based and deliberately conservative: it surfaces a published price range for context only.
 * Whether a project fits that range is decided by the iAcquire team after review.
 */
export function suggestServices(text: string, tools: string[], services: ServiceView[], connected: string[] = []): ServiceSuggestion[] {
  const haystack = ` ${norm(text)} `;
  if (haystack.trim().length < 8) return [];
  const toolSet = new Set(tools.map(norm).filter(Boolean));
  const out: ServiceSuggestion[] = [];
  for (const service of services) {
    if (service.kind === "maintenance_plan" || !service.visible || service.availability === "unavailable") continue;
    let score = 0;
    const reasons: string[] = [];
    const hits: string[] = [];
    for (const keyword of service.keywords) {
      const k = norm(keyword);
      // Whole-word match, or a prefix match for longer keywords so "automate" finds "automation".
      if (k && (haystack.includes(` ${k} `) || (k.length > 4 && haystack.includes(` ${k}`)))) {
        score += k.includes(" ") ? 3 : 2;
        hits.push(keyword);
      }
    }
    if (hits.length) reasons.push(`Mentions ${[...new Set(hits)].slice(0, 3).join(", ")}`);
    const platformHits = service.platforms.filter((p) => toolSet.has(norm(p)) || haystack.includes(` ${norm(p)} `));
    if (platformHits.length) {
      score += platformHits.length;
      reasons.push(`Works with ${platformHits.slice(0, 3).join(", ")}`);
    }
    if (service.platforms.some((p) => connected.includes(norm(p).replace(/\s+/g, "")) || (norm(p) === "gohighlevel" && connected.includes("ghl")))) {
      score += 1;
      reasons.push("Fits an integration already connected to your workspace");
    }
    if (score >= 2) out.push({ service, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

/** A confirmed-public title, otherwise a neutral label. Never leaks a client name that has not been cleared. */
export function portfolioTitle(p: { title: string; anonymizedTitle: string | null; clientNamePublic: boolean }) {
  return p.clientNamePublic ? p.title : (p.anonymizedTitle ?? "Client project");
}

// ---------------------------------------------------------------------------
// Case-study sections as editable plain text
// ---------------------------------------------------------------------------

export interface CaseSection {
  heading: string;
  body?: string;
  items?: string[];
}

/** "## Heading", free text for the paragraph, "- item" lines for bullets. */
export function sectionsToText(sections: CaseSection[]): string {
  return sections
    .map((s) => [`## ${s.heading}`, s.body ?? "", ...(s.items ?? []).map((i) => `- ${i}`)].filter((l, i) => i === 0 || l !== "").join("\n"))
    .join("\n\n");
}

export function textToSections(text: string): CaseSection[] {
  const out: CaseSection[] = [];
  let cur: { heading: string; body: string[]; items: string[] } | null = null;
  const flush = () => {
    if (cur && cur.heading) out.push({ heading: cur.heading, ...(cur.body.length ? { body: cur.body.join("\n").trim() } : {}), ...(cur.items.length ? { items: cur.items } : {}) });
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("## ")) {
      flush();
      cur = { heading: line.slice(3).trim(), body: [], items: [] };
    } else if (cur && line.trim().startsWith("- ")) cur.items.push(line.trim().slice(2).trim());
    else if (cur && line.trim()) cur.body.push(line.trim());
  }
  flush();
  return out;
}
