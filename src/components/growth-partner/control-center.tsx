import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Brain,
  CalendarClock,
  CalendarDays,
  CircleCheck,
  CircleHelp,
  ClipboardList,
  Gauge,
  HeartHandshake,
  MessageSquareText,
  PauseCircle,
  Plug,
  ShieldCheck,
  Settings2,
  Sparkles,
  Target,
  Users,
  Workflow,
} from "lucide-react";
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, SectionHeading } from "@/components/ui/primitives";
import { Button, ButtonLink } from "@/components/ui/button";
import { SETUP_REQUIRED_LABEL } from "@/lib/agents";
import {
  GROWTH_PARTNER_CAPABILITY_GROUPS,
  type GrowthPartnerCapabilityAccess,
  type GrowthPartnerCapabilityAccessStatus,
  type GrowthPartnerCapabilityDomainKey,
} from "@/lib/ai-growth-partner-capability-access";
import { BrainFactEditor } from "@/components/growth-partner/brain-fact-editor";
import { BusinessBrainDraftReview } from "@/components/growth-partner/brain-draft-review";
import { GrowthPartnerMemoryPanel } from "@/components/growth-partner/memory-panel";
import { GrowthPartnerGoalsPanel } from "@/components/growth-partner/goals-panel";
import { GrowthPartnerLegacyKnowledgeReview } from "@/components/growth-partner/legacy-knowledge-review";
import { ResearchSourceSettings, type ResearchSourcePoliciesView } from "@/components/growth-partner/research-source-settings";
import { WorkforceSafetyControls } from "@/components/workforce/safety-controls";
import {
  BUSINESS_BRAIN_SECTIONS,
  type BusinessBrain,
  type BusinessBrainFact,
} from "@/lib/ai-growth-partner";
import type { GrowthPartnerControlState } from "@/server/ai-growth-partner/service";
import type { GrowthPartnerMemory } from "@/lib/ai-growth-partner-memory";
import type { GrowthPartnerGoalProgress } from "@/lib/ai-growth-partner-goals";
import type { GrowthPartnerLegacyKnowledgeReview as GrowthPartnerLegacyKnowledgeReviewData } from "@/server/ai-growth-partner/legacy-knowledge";
import { prepareGrowthPartnerFromSubmittedOnboardingAction } from "@/app/actions/ai-growth-partner";

const sectionTitles: Record<(typeof BUSINESS_BRAIN_SECTIONS)[number], string> = {
  businessIdentity: "Business identity",
  productsServicesOffers: "Products, services & offers",
  idealCustomers: "Ideal customers",
  acquisitionStrategy: "Customer acquisition",
  salesKnowledge: "Sales knowledge",
  brandCommunication: "Brand communication",
  businessOperations: "Business operations",
  policies: "Policies",
  employeeGoals: "Goals and priorities",
  productOperations: "iAcquireOS tools",
  employeeBehavior: "Working style",
};

const capabilityAreaPresentation: Record<GrowthPartnerCapabilityDomainKey, { description: string; icon: typeof Target }> = {
  lead_discovery: { description: "Find relevant prospects and check fit against approved criteria.", icon: Target },
  sales: { description: "Review the pipeline and prepare follow-up drafts for a person's review.", icon: HeartHandshake },
  scheduling: { description: "Review appointments and coordinate booking details against calendar rules.", icon: CalendarClock },
  crm: { description: "Review authorized contact and company records for quality issues.", icon: ClipboardList },
  operations: { description: "Review blocked work, receivables and reputation tasks.", icon: Workflow },
  analytics: { description: "Explain progress using recorded activity and outcomes.", icon: Activity },
};

const capabilityAreas = GROWTH_PARTNER_CAPABILITY_GROUPS.map((group) => ({
  ...group,
  ...capabilityAreaPresentation[group.key],
}));

const capabilityStatusInfo: Record<GrowthPartnerCapabilityAccessStatus, { label: string; tone: "neutral" | "success" | "warning" }> = {
  available: { label: "Ready to request", tone: "success" },
  permission_required: { label: "Your access needed", tone: "warning" },
  disabled: { label: "Turned off", tone: "warning" },
  actions_unverified: { label: "Access check needed", tone: "neutral" },
  runtime_unverified: { label: "Runtime check needed", tone: "neutral" },
  not_configured: { label: "Not set up", tone: "neutral" },
};

const workspaceControlItems = [
  { key: "work", label: "Work Board", description: "Review tasks, schedules and execution history.", href: "/work", permission: "agents.use", icon: ClipboardList },
  { key: "schedules", label: "Schedules & calendar", description: "Manage recurring work and its schedule.", href: "/work/calendar", permission: "agents.use", icon: CalendarDays },
  { key: "preferences", label: "Partner preferences", description: "Set the workspace's AI behavior and conversation preferences.", href: "/settings/ai", permission: "agents.configure", icon: Settings2 },
  { key: "knowledge", label: "Business knowledge", description: "Review approved company knowledge used by the Partner.", href: "/knowledge", permission: "knowledge.view", icon: BookOpen },
  { key: "integrations", label: "Integrations", description: "Check connected tools and their status.", href: "/settings/integrations", permission: "integrations.view", icon: Plug },
  { key: "crm", label: "CRM", description: "Open contacts, opportunities and acquisition records.", href: "/crm", permission: "crm.view", icon: ClipboardList },
  { key: "appointments", label: "Appointments", description: "Review bookings and appointment settings.", href: "/appointments", permission: "appointments.view", icon: CalendarClock },
  { key: "messaging", label: "Messaging", description: "Review customer messaging channels and AI reply settings.", href: "/settings/messaging", permission: "inbox.view", icon: MessageSquareText },
  { key: "approvals", label: "Approvals", description: "Review work waiting for a decision.", href: "/approvals", permission: "approvals.view", icon: ShieldCheck },
  { key: "access", label: "Team & access", description: "Review workspace members and their access.", href: "/settings/team", permission: "team.view", icon: Users },
  { key: "activity", label: "Activity", description: "Inspect recorded Partner actions and AI runs.", href: "/activity", permission: "activity.view", icon: Activity },
  { key: "usage", label: "Usage & health", description: "Check AI usage and workspace limits.", href: "/settings/usage", permission: "usage.view", icon: Gauge },
] as const;

const stateLabels: Record<GrowthPartnerControlState["status"], { label: string; tone: "neutral" | "success" | "warning" }> = {
  setup_required: { label: SETUP_REQUIRED_LABEL, tone: "warning" },
  provisioning: { label: "Provisioning", tone: "neutral" },
  configured: { label: "Configured", tone: "success" },
  paused: { label: "Paused", tone: "warning" },
  migration_required: { label: "Migration required", tone: "warning" },
};

const factStateLabels: Record<BusinessBrainFact["state"], string> = {
  verified: "Verified",
  client_confirmed: "Client confirmed",
  draft_suggestion: "Draft suggestion",
  unknown: "Not provided",
  historical: "Historical record",
  superseded: "Superseded",
};

const factStateTones: Record<BusinessBrainFact["state"], "neutral" | "success" | "warning" | "violet"> = {
  verified: "success",
  client_confirmed: "success",
  draft_suggestion: "warning",
  unknown: "neutral",
  historical: "violet",
  superseded: "neutral",
};

const provenanceLabels: Record<BusinessBrainFact["provenance"][number]["source"], string> = {
  onboarding: "Submitted setup",
  client_confirmed: "Client confirmed",
  company_knowledge: "Company knowledge",
  knowledge_document: "Knowledge document",
  website: "Website research",
  integration: "Connected tool",
  crm: "CRM record",
  calendar: "Calendar record",
  client_edit: "Client edit",
  draft_suggestion: "Draft suggestion",
  historical_record: "Historical record",
};

function countFacts(brain: BusinessBrain) {
  const counts = { confirmed: 0, suggestions: 0, historical: 0, unknown: 0, superseded: 0 };
  for (const sectionName of BUSINESS_BRAIN_SECTIONS) {
    for (const fact of Object.values(brain.sections[sectionName])) {
      if (fact.state === "verified" || fact.state === "client_confirmed") counts.confirmed += 1;
      else if (fact.state === "draft_suggestion") counts.suggestions += 1;
      else if (fact.state === "historical") counts.historical += 1;
      else if (fact.state === "superseded") counts.superseded += 1;
      else counts.unknown += 1;
    }
  }
  return counts;
}

function humanizeKey(key: string) {
  return key
    .replaceAll("_", " ")
    .replaceAll(".", " · ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not provided yet";
  if (Array.isArray(value)) return value.map((item) => displayValue(item)).filter(Boolean).join(", ") || "Not provided yet";
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${humanizeKey(key)}: ${displayValue(item)}`)
      .join(" · ");
  }
  return String(value);
}

function formatDate(value: Date | string | null, timeZone: string) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date);
  }
}

function BrainSnapshot({
  brain,
  title,
  version,
  active,
  timezone,
  canEdit = false,
}: {
  brain: BusinessBrain;
  title: string;
  version: number | null;
  active: boolean;
  timezone: string;
  canEdit?: boolean;
}) {
  const counts = countFacts(brain);
  const generatedAt = formatDate(brain.generatedAt, timezone);
  return (
    <Card className="overflow-hidden border border-line bg-surface shadow-soft">
      <CardHeader className="flex-wrap items-center">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-soft text-violet-ink"><Brain className="size-5" aria-hidden /></div>
          <div className="min-w-0">
            <CardTitle>{title}{version ? ` · v${version}` : ""}</CardTitle>
            <p className="mt-1 text-[13px] text-muted">
              {counts.confirmed} confirmed · {counts.suggestions} suggestions · {counts.historical} historical · {counts.unknown} not provided
            </p>
          </div>
        </div>
        <Badge tone={active ? "success" : "warning"}>{active ? "Active snapshot" : "Draft snapshot"}</Badge>
      </CardHeader>
      <CardContent className="pt-4">
        <p className="mb-4 text-[13px] leading-relaxed text-muted">
          {active
            ? "This is the Business Brain version currently marked active."
            : "This version is saved for review and does not control live behavior."}
          {generatedAt ? ` Generated ${generatedAt}.` : " The generation date is unavailable."}
        </p>
        <div className="space-y-2">
          {BUSINESS_BRAIN_SECTIONS.map((sectionName) => {
            const facts = Object.entries(brain.sections[sectionName]);
            const confirmedCount = facts.filter(([, fact]) => fact.state === "verified" || fact.state === "client_confirmed").length;
            const suggestionCount = facts.filter(([, fact]) => fact.state === "draft_suggestion").length;
            return (
              <details key={sectionName} className="group rounded-xl border border-line bg-surface-2/55">
                <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-3.5 py-2.5 focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium text-ink">{sectionTitles[sectionName]}</span>
                    <span className="mt-0.5 block text-[12px] text-muted">{confirmedCount} confirmed · {suggestionCount} to review · {facts.length - confirmedCount - suggestionCount} other</span>
                  </span>
                  <ArrowUpRight className="size-4 shrink-0 rotate-45 text-muted transition-transform group-open:rotate-90" aria-hidden />
                </summary>
                {facts.length > 0 ? (
                  <dl className="space-y-2 border-t border-line px-3.5 py-3">
                    {facts.map(([key, fact]) => {
                      const source = fact.provenance[0];
                      const updatedAt = formatDate(fact.updatedAt, timezone);
                      return (
                        <div key={key} className="grid gap-2 rounded-lg bg-surface px-3 py-2.5 sm:grid-cols-[minmax(135px,0.32fr)_minmax(0,1fr)]">
                          <dt className="text-[13px] font-medium text-ink-2">{humanizeKey(key)}</dt>
                          <dd className="min-w-0">
                            <p className="break-words text-[13px] leading-relaxed text-ink">{displayValue(fact.value)}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <Badge tone={factStateTones[fact.state]}>{factStateLabels[fact.state]}</Badge>
                              {source && <span className="text-[12px] text-muted">From {provenanceLabels[source.source]}</span>}
                              {updatedAt && <time className="text-[12px] text-faint" dateTime={fact.updatedAt ?? undefined}>{updatedAt}</time>}
                            </div>
                            {canEdit && version !== null && <BrainFactEditor section={sectionName} factKey={key} fact={fact} baseVersion={version} />}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                ) : <p className="border-t border-line px-3.5 py-3 text-[13px] text-muted">No facts in this section yet.</p>}
              </details>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function MetricCard({
  icon,
  label,
  value,
  detail,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  tone?: "neutral" | "success" | "warning";
}) {
  return (
    <Card className="h-full border border-line bg-surface shadow-soft">
      <CardContent className="flex h-full gap-3 p-4 sm:p-5">
        <div className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${tone === "success" ? "bg-success-soft text-success-ink" : tone === "warning" ? "bg-warning-soft text-warning-ink" : "bg-surface-2 text-muted"}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-muted">{label}</p>
          <p className="mt-1 text-[15px] font-semibold text-ink">{value}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">{detail}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function GrowthPartnerControlCenter({
  state,
  capabilityAccess,
  memories,
  goals,
  canManageMemory,
  canManageGoals,
  canConfigure,
  canConfigureResearch,
  researchSourcePolicies,
  legacyKnowledgeReview,
  canOpenSetup,
  controlPermissions,
  legacyProfilesPresent,
  hasSubmittedOnboarding,
  submittedAnswerCount,
  timezone,
  safetyControls,
}: {
  state: GrowthPartnerControlState | null;
  capabilityAccess: GrowthPartnerCapabilityAccess[];
  memories: GrowthPartnerMemory[];
  goals: GrowthPartnerGoalProgress[];
  canManageMemory: boolean;
  canManageGoals: boolean;
  canConfigure: boolean;
  canConfigureResearch: boolean;
  researchSourcePolicies: ResearchSourcePoliciesView;
  legacyKnowledgeReview: GrowthPartnerLegacyKnowledgeReviewData;
  canOpenSetup: boolean;
  controlPermissions: Record<string, boolean>;
  legacyProfilesPresent: boolean;
  hasSubmittedOnboarding: boolean;
  submittedAnswerCount: number;
  timezone: string;
  safetyControls: { messagingPaused: boolean; outboundPaused: boolean; agencyPaused: boolean; canPause: boolean };
}) {
  const stateInfo = state
    ? stateLabels[state.status]
    : legacyProfilesPresent
      ? { label: "Migration required", tone: "warning" as const }
      : { label: "Not set up", tone: "neutral" as const };
  const activeBrain = state?.currentBusinessBrain ?? null;
  const draftBrain = state?.draftBusinessBrain ?? null;
  const hasAnyBrain = Boolean(activeBrain || draftBrain);
  const runtimeLinked = Boolean(state?.runtimeAgentInstanceId);
  const lastUpdated = formatDate(state?.updatedAt ?? null, timezone);
  const canPrepareBrain = canConfigure && hasSubmittedOnboarding && !hasAnyBrain;
  const latestVersion = state?.draftVersion ?? state?.currentVersion ?? null;
  const capabilityAccessByKey = new Map(capabilityAccess.map((item) => [item.key, item]));

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-7 pb-10">
      <WorkforceSafetyControls {...safetyControls} />
      {legacyProfilesPresent && (
        <div role="status" className="rounded-xl border border-warning/25 bg-warning-soft/60 px-4 py-3 text-[13px] leading-relaxed text-warning-ink">
          This workspace still has enabled profiles from its previous setup. Their settings, schedules and history remain in place while a Growth Partner migration is reviewed.
        </div>
      )}
      <section data-aqi-target="growth-partner.header" className="relative overflow-hidden rounded-[28px] border border-primary/15 bg-[radial-gradient(ellipse_at_top_right,rgba(103,88,229,0.16),transparent_44%),linear-gradient(135deg,var(--surface),var(--surface-2))] px-5 py-6 shadow-soft sm:px-8 sm:py-8">
        <div className="absolute -right-12 -top-16 size-52 rounded-full border border-primary/10" aria-hidden />
        <div className="absolute -right-2 -top-6 size-32 rounded-full border border-primary/10" aria-hidden />
        <div className="relative flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-3xl">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge tone="violet"><Sparkles className="size-3.5" aria-hidden /> AI Growth Partner</Badge>
              <Badge tone={stateInfo.tone}>{stateInfo.label}</Badge>
            </div>
            <h1 className="text-[30px] font-semibold tracking-[-0.045em] text-ink sm:text-[38px]">AI Growth Partner</h1>
            <p className="mt-2 max-w-2xl text-[14px] leading-[1.75] text-muted sm:text-[15px]">
              One partner for your customer acquisition work, shaped by your submitted business information and the tools your workspace authorizes.
            </p>
            <p className="mt-4 text-[13px] font-medium text-ink-2">One AI Growth Partner · six connected capabilities · one Business Brain</p>
          </div>
          <div className="relative flex size-[74px] shrink-0 items-center justify-center self-start rounded-[22px] border border-primary/15 bg-surface/80 text-primary shadow-card sm:self-auto">
            <Sparkles className="size-8" aria-hidden />
            <span className="absolute -bottom-2 -right-2 flex size-8 items-center justify-center rounded-xl border border-line bg-surface text-violet-ink shadow-soft"><Brain className="size-4" aria-hidden /></span>
          </div>
        </div>
      </section>

      <section aria-label="Partner status" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={<CircleCheck className="size-5" aria-hidden />}
          label="Partner identity"
          value={state ? "Created" : "Not created"}
          detail={state ? `This workspace has one logical ${state.name} identity.` : "No Growth Partner identity is saved for this workspace yet."}
          tone={state ? "success" : "neutral"}
        />
        <MetricCard
          icon={<Brain className="size-5" aria-hidden />}
          label="Business Brain"
          value={activeBrain ? `Active · v${state?.currentVersion ?? "?"}` : draftBrain ? `Draft · v${state?.draftVersion ?? "?"}` : "Not prepared"}
          detail={activeBrain ? "A version is marked active." : draftBrain ? "A saved draft is available to inspect." : "Submitted business information has not been assembled here yet."}
          tone={activeBrain ? "success" : draftBrain ? "warning" : "neutral"}
        />
        <MetricCard
          icon={<ShieldCheck className="size-5" aria-hidden />}
          label="Runtime profile"
          value={runtimeLinked ? "Profile linked" : state?.status === "provisioning" ? "Provisioning" : "Not provisioned"}
          detail={runtimeLinked ? "A profile is attached; runtime health still needs its own verification." : "No runtime profile is attached to this identity."}
          tone={runtimeLinked ? "success" : state?.status === "provisioning" ? "warning" : "neutral"}
        />
        <MetricCard
          icon={<MessageSquareText className="size-5" aria-hidden />}
          label="Permanent conversation"
          value={state?.conversationId ? "Connected" : "Not connected"}
          detail={state?.conversationId ? "One permanent thread is available to workspace members with AI access." : "The shared thread stays unavailable until a dedicated runtime and history checks are complete."}
          tone={state?.conversationId ? "success" : "warning"}
        />
      </section>

      <section aria-label="Growth Partner workspace controls">
        <SectionHeading
          title="Workspace controls"
          description="Manage the tools, schedules, access and activity connected to your AI Growth Partner."
        />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {workspaceControlItems.filter((item) => controlPermissions[item.permission]).map(({ key, label, description, href, icon: Icon }) => (
            <Card key={key} className="border border-line bg-surface shadow-soft transition-colors hover:border-primary/25">
              <CardContent className="flex h-full flex-col items-start gap-3 p-4 sm:p-5">
                <div className="flex size-10 items-center justify-center rounded-xl bg-violet-soft text-violet-ink"><Icon className="size-5" aria-hidden /></div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-[14px] font-semibold text-ink">{label}</h3>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p>
                </div>
                <ButtonLink href={href} variant="secondary" size="sm">
                  Open {label} <ArrowUpRight className="size-4" aria-hidden />
                </ButtonLink>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <GrowthPartnerMemoryPanel memories={memories} canManage={canManageMemory} hasPartner={Boolean(state)} timezone={timezone} />

      <GrowthPartnerGoalsPanel goals={goals} canManage={canManageGoals} hasPartner={Boolean(state)} />

      {canConfigureResearch && <ResearchSourceSettings policies={researchSourcePolicies} />}

      {state?.status === "paused" && (
        <div role="status" className="flex gap-3 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-warning-ink">
          <PauseCircle className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p className="text-[14px] leading-relaxed">This AI Growth Partner is paused. Its status is shown here; this page does not change the pause setting.</p>
        </div>
      )}

      <section data-aqi-target="growth-partner.brain">
        <SectionHeading
          title="One partner, six capabilities"
          description="These capabilities belong to one Growth Partner identity. Readiness combines your access, the Partner's saved Allowed actions and its runtime check; connected services, limits and approvals are checked again when work starts."
        />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {capabilityAreas.map(({ key, title, description, icon: Icon, capabilityKeys }) => {
            const items = capabilityKeys.map((capabilityKey) => capabilityAccessByKey.get(capabilityKey)).filter((item): item is GrowthPartnerCapabilityAccess => Boolean(item));
            const availableCount = items.filter((item) => item.status === "available").length;
            const hasAccessBlock = items.some((item) => item.status === "permission_required" || item.status === "disabled");
            const summary = items.length > 0 && availableCount === items.length
              ? { label: "Ready to request", tone: "success" as const }
              : availableCount > 0
                ? { label: `${availableCount} of ${items.length} available`, tone: "warning" as const }
                : hasAccessBlock
                  ? { label: "Access needed", tone: "warning" as const }
                  : { label: "Setup needs review", tone: "neutral" as const };
            return (
              <Card key={key} data-capability-domain={key} className="border border-line bg-surface shadow-soft transition-colors hover:border-primary/25">
                <CardHeader className="items-start">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-soft text-violet-ink"><Icon className="size-5" aria-hidden /></div>
                  <div className="min-w-0 flex-1">
                    <CardTitle>{title}</CardTitle>
                    <p className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p>
                  </div>
                  <Badge tone={summary.tone}>{summary.label}</Badge>
                </CardHeader>
                <CardContent className="space-y-2">
                  {items.map((item) => {
                    const status = capabilityStatusInfo[item.status];
                    return (
                      <div key={item.key} className="rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-[13px] font-medium text-ink">{item.label}</p>
                          <Badge tone={status.tone}>{status.label}</Badge>
                        </div>
                        <p className="mt-1 text-[12px] leading-relaxed text-muted">{item.detail}</p>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <section>
        <SectionHeading
          title="Business Brain"
          description="Structured business knowledge with its source and review status. Unknown details stay marked as unknown."
          action={state && lastUpdated ? <span className="text-[12px] text-faint">Workspace record updated {lastUpdated}</span> : undefined}
        />
        <div className="space-y-4">
          {draftBrain && <BrainSnapshot brain={draftBrain} title="Draft Business Brain" version={state?.draftVersion ?? null} active={false} timezone={timezone} canEdit={canConfigure} />}
          {draftBrain && canConfigure && state?.draftVersion !== null && state?.draftVersion !== undefined && (
            <div className="flex flex-col gap-3 rounded-xl border border-primary/15 bg-primary-soft/30 p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-2xl text-[13px] leading-relaxed text-ink-2">Review the confirmed facts above, then apply the latest version when you are ready for the Partner to use them.</p>
              <BusinessBrainDraftReview version={state.draftVersion} currentVersion={state.currentVersion} />
            </div>
          )}
          {activeBrain && <BrainSnapshot brain={activeBrain} title="Active Business Brain" version={state?.currentVersion ?? null} active timezone={timezone} canEdit={canConfigure && !draftBrain} />}
          {!hasAnyBrain && (
            <Card className="border border-line bg-surface shadow-soft">
              <CardContent className="p-3 sm:p-5">
                <EmptyState
                  icon={<CircleHelp className="size-5" aria-hidden />}
                  title="The Business Brain is not prepared yet"
                  description={hasSubmittedOnboarding
                    ? `We found ${submittedAnswerCount} saved answers from your last submitted setup. An owner or admin can prepare a draft from those answers for review.`
                    : "Your AI Growth Partner will use the business information already collected in setup. There is no separate training questionnaire."}
                  action={canPrepareBrain ? (
                    <form action={prepareGrowthPartnerFromSubmittedOnboardingAction}>
                      <Button type="submit" variant="primary" size="md">
                        <Sparkles className="size-4" aria-hidden />
                        Prepare draft from saved setup
                      </Button>
                    </form>
                  ) : !hasSubmittedOnboarding && canOpenSetup ? (
                    <ButtonLink href="/setup" variant="secondary" size="md">
                      Review business setup <ArrowUpRight className="size-4" aria-hidden />
                    </ButtonLink>
                  ) : null}
                />
              </CardContent>
            </Card>
          )}
          {draftBrain && <p className="flex items-start gap-2 rounded-xl border border-violet/15 bg-violet-soft/50 px-4 py-3 text-[13px] leading-relaxed text-violet-ink"><CircleHelp className="mt-0.5 size-4 shrink-0" aria-hidden />This saved draft is separate from the active version. It does not change the live partner configuration.</p>}
          {state && state.versions.length > 0 && (
            <Card className="border border-line bg-surface shadow-soft">
              <CardHeader>
                <div>
                  <CardTitle>Business Brain history</CardTitle>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted">Saved versions stay available as an audit trail. Editing always creates another version.</p>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {state.versions.map((item) => (
                  <div key={item.version} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-2/45 px-3 py-2.5">
                    <span className="text-[13px] font-semibold text-ink">Version {item.version}</span>
                    <Badge tone={item.active ? "success" : item.version === latestVersion ? "warning" : "neutral"}>
                      {item.active ? "Active" : item.version === latestVersion ? "Latest draft" : "Saved"}
                    </Badge>
                    <span className="text-[12px] text-muted">{humanizeKey(item.source)}</span>
                    <time className="ml-auto text-[12px] text-faint" dateTime={item.createdAt.toISOString()}>{formatDate(item.createdAt, timezone)}</time>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </section>

      {state && canConfigure && controlPermissions["knowledge.view"] && (
        <section aria-label="Retained profile knowledge review">
          <GrowthPartnerLegacyKnowledgeReview data={legacyKnowledgeReview} />
        </section>
      )}

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
        <Card className="border border-line bg-surface shadow-soft">
          <CardHeader>
            <div>
              <CardTitle>One lasting conversation</CardTitle>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">A single shared place for requests, decisions, approvals and progress updates.</p>
            </div>
            <Badge tone={state?.conversationId ? "success" : "warning"}>{state?.conversationId ? "Connected" : "Not connected"}</Badge>
          </CardHeader>
          <CardContent>
            {state?.conversationId ? (
              <div className="space-y-3">
                <div className="flex gap-3 rounded-xl border border-success/20 bg-success-soft/40 p-4">
                  <MessageSquareText className="mt-0.5 size-5 shrink-0 text-success-ink" aria-hidden />
                  <p className="text-[13px] leading-relaxed text-ink-2">This is the single shared Growth Partner thread. Members with AI access see the same history; conversations from previous role profiles remain in their original records.</p>
                </div>
                {state.conversationLastMessageAt && <p className="text-[12px] text-faint">Latest message {formatDate(state.conversationLastMessageAt, timezone)}</p>}
                <ButtonLink href="/growth-partner/conversation" variant="secondary" size="sm">
                  <MessageSquareText className="size-4" aria-hidden /> View conversation history <ArrowUpRight className="size-4" aria-hidden />
                </ButtonLink>
              </div>
            ) : (
              <div className="flex gap-3 rounded-xl border border-line bg-surface-2/60 p-4">
                <MessageSquareText className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
                <p className="text-[13px] leading-relaxed text-muted">
                  This workspace does not yet have a registered permanent conversation for the AI Growth Partner. Conversations from previous role profiles remain in their original history while a dedicated unified runtime is prepared.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border border-line bg-surface shadow-soft">
          <CardHeader>
            <div>
              <CardTitle>Access and setup</CardTitle>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">Partner access follows your workspace permissions.</p>
            </div>
            <ShieldCheck className="size-5 text-muted" aria-hidden />
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2.5 text-[13px] leading-relaxed text-muted">
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-success-ink" aria-hidden />
              <span>Existing permissions and approval rules remain in force for every capability.</span>
            </div>
            <div className="flex gap-2.5 text-[13px] leading-relaxed text-muted">
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-success-ink" aria-hidden />
              <span>Business Brain snapshots are versioned and retain their source information.</span>
            </div>
            {state?.status === "migration_required" && <div className="rounded-xl border border-warning/30 bg-warning-soft px-3 py-2.5 text-[13px] text-warning-ink">An administrator needs to review this workspace’s existing profiles before setup continues.</div>}
            {state && lastUpdated && <p className="border-t border-line pt-3 text-[12px] text-faint">Partner record last updated {lastUpdated}</p>}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
