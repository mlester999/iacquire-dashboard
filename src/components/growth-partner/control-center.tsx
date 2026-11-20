import type { ComponentProps, ReactNode } from "react";
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
import { PageHero } from "@/components/ui/workspace";

import { SETUP_REQUIRED_LABEL } from "@/lib/agents";
import { isRuntimeOnline } from "@/lib/employee-runtime";
import {
  GROWTH_PARTNER_CAPABILITY_GROUPS,
  type GrowthPartnerCapabilityAccess,
  type GrowthPartnerCapabilityAccessStatus,
  type GrowthPartnerCapabilityDomainKey,
} from "@/lib/ai-growth-partner-capability-access";
import { BrainFactEditor } from "@/components/growth-partner/brain-fact-editor";
import { GrowthPartnerAbilityEditor } from "@/components/growth-partner/ability-editor";
import { BusinessBrainDraftReview } from "@/components/growth-partner/brain-draft-review";
import { GrowthPartnerMemoryPanel } from "@/components/growth-partner/memory-panel";
import { GrowthPartnerGoalsPanel } from "@/components/growth-partner/goals-panel";
import { GrowthPartnerLegacyKnowledgeReview } from "@/components/growth-partner/legacy-knowledge-review";
import { GrowthPartnerSectionUnavailable } from "@/components/growth-partner/section-unavailable";
import { ResearchSourceSettings, type ResearchSourcePoliciesView } from "@/components/growth-partner/research-source-settings";
import { WorkforceSafetyControls } from "@/components/workforce/safety-controls";
import {
  BUSINESS_BRAIN_SECTION_TITLES,
  BUSINESS_BRAIN_SECTIONS,
  type BusinessBrain,
  type BusinessBrainFact,
} from "@/lib/ai-growth-partner";
import type { GrowthPartnerControlState } from "@/server/ai-growth-partner/service";
import type { GrowthPartnerAbilityControls } from "@/server/ai-growth-partner/ability-controls";
import type { WorkBoardSummary } from "@/server/workforce/work-board";
import type { GrowthPartnerMemory } from "@/lib/ai-growth-partner-memory";
import type { GrowthPartnerGoalProgress } from "@/lib/ai-growth-partner-goals";
import type { GrowthPartnerLegacyKnowledgeReview as GrowthPartnerLegacyKnowledgeReviewData } from "@/server/ai-growth-partner/legacy-knowledge";
import { prepareGrowthPartnerFromSubmittedOnboardingAction } from "@/app/actions/ai-growth-partner";

const sectionTitles = BUSINESS_BRAIN_SECTION_TITLES;

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
  runtime_unverified: { label: "Connection check needed", tone: "neutral" },
  not_configured: { label: "Not set up", tone: "neutral" },
};

const workspaceControlItems = [
  { key: "work", label: "AI Work Board", description: "Review tasks, schedules and execution history.", href: "/work", permission: "agents.use", icon: ClipboardList },
  { key: "schedules", label: "Schedules & Calendar", description: "Manage recurring work and its schedule.", href: "/work/calendar", permission: "agents.use", icon: CalendarDays },
  { key: "preferences", label: "Growth Partner Settings", description: "Set the workspace's AI behavior and conversation preferences.", href: "/settings/ai", permission: "agents.configure", icon: Settings2 },
  { key: "knowledge", label: "Knowledge Center", description: "Review approved company knowledge used by the Partner.", href: "/knowledge", permission: "knowledge.view", icon: BookOpen },
  { key: "integrations", label: "Integrations", description: "Check connected tools and their status.", href: "/settings/integrations", permission: "integrations.view", icon: Plug },
  { key: "crm", label: "CRM", description: "Open contacts, opportunities and acquisition records.", href: "/crm", permission: "crm.view", icon: ClipboardList },
  { key: "appointments", label: "Appointments", description: "Review bookings and appointment settings.", href: "/appointments", permission: "appointments.view", icon: CalendarClock },
  { key: "messaging", label: "Messaging", description: "Review customer messaging channels and AI reply settings.", href: "/settings/messaging", permission: "inbox.view", icon: MessageSquareText },
  { key: "approvals", label: "Approvals", description: "Review work waiting for a decision.", href: "/approvals", permission: "approvals.view", icon: ShieldCheck },
  { key: "access", label: "Team & access", description: "Review workspace members and their access.", href: "/settings/team", permission: "team.view", icon: Users },
  { key: "reports", label: "Performance Reporting", description: "See acquisition, pipeline and appointment outcomes.", href: "/analytics", permission: "analytics.view", icon: Gauge },
  { key: "activity", label: "Activity", description: "Review recorded work by your AI Growth Partner.", href: "/activity", permission: "activity.view", icon: Activity },
  { key: "usage", label: "Usage & health", description: "Check AI usage and workspace limits.", href: "/settings/usage", permission: "usage.view", icon: Gauge },
] as const;

const stateLabels: Record<GrowthPartnerControlState["status"], { label: string; tone: "neutral" | "success" | "warning" }> = {
  setup_required: { label: SETUP_REQUIRED_LABEL, tone: "warning" },
  provisioning: { label: "Setting up", tone: "neutral" },
  configured: { label: "Configured", tone: "success" },
  paused: { label: "Paused", tone: "warning" },
  migration_required: { label: "Review previous profiles", tone: "warning" },
};

function growthPartnerStateInfo(state: GrowthPartnerControlState | null, legacyProfilesPresent: boolean) {
  if (!state) {
    return legacyProfilesPresent
      ? { label: "Review previous profiles", tone: "warning" as const }
      : { label: "Not set up", tone: "neutral" as const };
  }
  if (state.status !== "configured") return stateLabels[state.status];
  if (state.behaviorProfile?.runtimeSyncStatus === "pending") return { label: "Sync pending", tone: "warning" as const };
  if (state.behaviorProfile?.runtimeSyncStatus === "not_configured") return { label: "Runtime setup needed", tone: "warning" as const };
  if (!state.behaviorProfile) return { label: "Configuration check needed", tone: "neutral" as const };
  return stateLabels.configured;
}

function runtimeConnectionInfo(state: GrowthPartnerControlState | null): { label: string; detail: string; tone: "neutral" | "success" | "warning" } {
  if (!state) return { label: "Not set up", detail: "Your AI Growth Partner has not been connected yet.", tone: "neutral" };
  if (state.status === "migration_required") {
    return { label: "Review migration", detail: "Previous profiles are preserved while the unified Partner migration is reviewed.", tone: "warning" };
  }
  if (state.status === "paused" || state.runtimeEnabled === false || state.runtimeStatus === "disabled") {
    return { label: "Paused", detail: "The AI Growth Partner is paused and cannot start new work.", tone: "warning" };
  }
  if (state.runtimeAgentInstanceId && (state.runtimeStatus === "error" || state.runtimeStatus === "offline" || state.runtimeHealthOk === false)) {
    return { label: "Needs attention", detail: "The runtime is unavailable or failed its latest health check.", tone: "warning" };
  }
  if (state.status === "provisioning" || state.runtimeStatus === "provisioning") {
    return { label: "Setting up", detail: "The runtime is being prepared and has not passed its health check yet.", tone: "warning" };
  }
  if (!state.runtimeAgentInstanceId || state.runtimeEnabled !== true) {
    return { label: "Not connected", detail: "Your AI Growth Partner needs a verified runtime connection before it can work.", tone: "neutral" };
  }
  if (isRuntimeOnline(state.runtimeStatus)) {
    return state.runtimeHealthOk === true
      ? { label: "Online", detail: "The runtime passed its latest health check.", tone: "success" }
      : { label: "Connection not checked yet", detail: "The linked runtime has no recorded health check.", tone: "neutral" };
  }
  return { label: "Health check needed", detail: "A runtime profile is linked, but it has not passed the current health check.", tone: "neutral" };
}

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
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  return (
    <Card role="group" aria-label={label} className="h-full border border-line bg-surface shadow-soft">
      <CardContent className="flex h-full gap-3 p-4 sm:p-5">
        <div className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${tone === "success" ? "bg-success-soft text-success-ink" : tone === "warning" ? "bg-warning-soft text-warning-ink" : tone === "danger" ? "bg-danger-soft text-danger-ink" : "bg-surface-2 text-muted"}`}>
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
  abilityControls,
  memories,
  goals,
  workSummary,
  canManageMemory,
  canManageGoals,
  canConfigure,
  canConfigureResearch,
  researchSourcePolicies,
  researchSourceWorkspaceId,
  legacyKnowledgeReview,
  migrationReview,
  canOpenSetup,
  controlPermissions,
  legacyProfilesPresent,
  hasSubmittedOnboarding,
  submittedAnswerCount,
  timezone,
  safetyControls,
  unavailable = {},
}: {
  state: GrowthPartnerControlState | null;
  capabilityAccess: GrowthPartnerCapabilityAccess[];
  abilityControls?: GrowthPartnerAbilityControls | null;
  memories: GrowthPartnerMemory[];
  goals: GrowthPartnerGoalProgress[];
  workSummary: WorkBoardSummary;
  canManageMemory: boolean;
  canManageGoals: boolean;
  canConfigure: boolean;
  canConfigureResearch: boolean;
  researchSourcePolicies: ResearchSourcePoliciesView;
  researchSourceWorkspaceId?: string;
  legacyKnowledgeReview: GrowthPartnerLegacyKnowledgeReviewData;
  migrationReview?: ReactNode;
  canOpenSetup: boolean;
  controlPermissions: Record<string, boolean>;
  legacyProfilesPresent: boolean;
  hasSubmittedOnboarding: boolean;
  submittedAnswerCount: number;
  timezone: string;
  safetyControls: ComponentProps<typeof WorkforceSafetyControls>;
  unavailable?: {
    previousProfiles?: boolean;
    submittedOnboarding?: boolean;
    memories?: boolean;
    capabilityAccess?: boolean;
    abilityControls?: boolean;
    goals?: boolean;
    workSummary?: boolean;
    researchSourcePolicies?: boolean;
    legacyKnowledgeReview?: boolean;
    controls?: boolean;
  };
}) {
  const stateInfo = growthPartnerStateInfo(state, legacyProfilesPresent);
  const activeBrain = state?.currentBusinessBrain ?? null;
  const draftBrain = state?.draftBusinessBrain ?? null;
  const hasAnyBrain = Boolean(activeBrain || draftBrain);
  const lastUpdated = formatDate(state?.updatedAt ?? null, timezone);
  const canPrepareBrain = canConfigure && hasSubmittedOnboarding && !hasAnyBrain;
  const latestVersion = state?.draftVersion ?? state?.currentVersion ?? null;
  const capabilityAccessByKey = new Map(capabilityAccess.map((item) => [item.key, item]));
  const runtimeConnection = runtimeConnectionInfo(state);
  const visibleWorkspaceControlItems = workspaceControlItems.filter((item) => controlPermissions[item.permission]);
  const workspaceItems = visibleWorkspaceControlItems.filter((item) => item.key !== "approvals" && item.key !== "activity");
  const activityItems = visibleWorkspaceControlItems.filter((item) => item.key === "approvals" || item.key === "activity");
  const renderWorkspaceControl = ({ key, label, description, href, icon: Icon }: (typeof workspaceControlItems)[number]) => (
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
  );

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-7 pb-10">
      <PageHero
        target="growth-partner.header"
        tone="dark"
        eyebrow="Control Center"
        title="AI Growth Partner"
        description="See what your partner knows, what it can do, and which work needs your decision."
        icon={<Sparkles className="size-4" />}
        action={<>
          {state?.conversationId ? (
            <ButtonLink href="/growth-partner/conversation" variant="brand" size="md">
              <MessageSquareText className="size-4" aria-hidden /> Open conversation
            </ButtonLink>
          ) : canOpenSetup ? (
            <ButtonLink href="/setup" variant="brand" size="md">Open Setup Center <ArrowUpRight className="size-4" aria-hidden /></ButtonLink>
          ) : null}
          <ButtonLink href="#business-brain" variant="secondary" size="md">Review Business Brain</ButtonLink>
        </>}
        aside={<div className="flex items-center gap-3 rounded-2xl border border-white/15 bg-white/5 px-4 py-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-white/15 text-white">
            <Activity className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-[12px] text-slate-300">Workspace readiness</p>
            <p className="mt-0.5 text-[14px] font-semibold text-white">{stateInfo.label}</p>
          </div>
        </div>}
      />

      {unavailable.controls
        ? <GrowthPartnerSectionUnavailable title="Safety controls" />
        : <WorkforceSafetyControls {...safetyControls} />}
      {migrationReview}
      {unavailable.previousProfiles && <GrowthPartnerSectionUnavailable title="Previous role profile status" />}
      {legacyProfilesPresent && (
        <div role="status" className="rounded-xl border border-warning/25 bg-warning-soft/60 px-4 py-3 text-[13px] leading-relaxed text-warning-ink">
          This workspace still has enabled profiles from its previous setup. Their settings, schedules and history remain in place while a Growth Partner migration is reviewed.
        </div>
      )}
      <section aria-label="Partner status" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={<CircleCheck className="size-5" aria-hidden />}
          label="Partner"
          value={state ? "Created" : "Not created"}
          detail={state ? "This workspace has one Growth Partner identity." : "The workspace needs its Growth Partner identity."}
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
          label="Partner connection"
          value={runtimeConnection.label}
          detail={runtimeConnection.detail}
          tone={runtimeConnection.tone}
        />
        <MetricCard
          icon={<MessageSquareText className="size-5" aria-hidden />}
          label="Permanent Conversation"
          value={state?.conversationId ? "Connected" : "Not connected"}
          detail={state?.conversationId ? "One shared history is available to workspace members with AI access." : "Your shared conversation will be ready when setup and connection checks are complete."}
          tone={state?.conversationId ? "success" : "warning"}
        />
      </section>

      <section aria-label="Work Board status">
        <SectionHeading
          title="AI Work Board"
          description="See what is running, waiting, or finished in your workspace."
          action={<ButtonLink href="/work" variant="secondary" size="sm">Open AI Work Board <ArrowUpRight className="size-4" aria-hidden /></ButtonLink>}
        />
        {unavailable.workSummary
          ? <GrowthPartnerSectionUnavailable title="AI Work Board" />
          : <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard label="Running now" value={String(workSummary.active)} detail="Jobs with an active worker lease." icon={<Activity className="size-5" />} tone="success" />
              <MetricCard label="Waiting for approval" value={String(workSummary.waiting)} detail="A person must decide." icon={<ShieldCheck className="size-5" />} tone="warning" />
              <MetricCard label="Needs attention" value={String(workSummary.needsAttention)} detail="Includes approvals, failures, blocked work and interrupted runs." icon={<ClipboardList className="size-5" />} tone="warning" />
              <MetricCard label="Completed today" value={String(workSummary.completedToday)} detail="In this workspace's time zone." icon={<CircleCheck className="size-5" />} tone="success" />
            </div>}
      </section>

      <section aria-label="Growth Partner workspace controls">
        <SectionHeading
          title="Workspace controls"
          description="Manage the tools, schedules, access and activity connected to your AI Growth Partner."
        />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{workspaceItems.map(renderWorkspaceControl)}</div>
        {activityItems.length > 0 && (
          <div className="mt-6 space-y-3">
            <SectionHeading title="Activity and Approvals" description="Review decisions waiting for you and work recorded by the AI Growth Partner." />
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{activityItems.map(renderWorkspaceControl)}</div>
          </div>
        )}
      </section>

      <section aria-label="Partner personality and behavior">
        <SectionHeading
          title="Partner personality & behavior"
          description="Set the voice, communication style and behavior your Growth Partner uses across its capabilities."
          action={controlPermissions["agents.configure"] ? (
            <ButtonLink href="/settings/ai" variant="secondary" size="sm">
              Edit AI preferences <ArrowUpRight className="size-4" aria-hidden />
            </ButtonLink>
          ) : undefined}
        />
        {state?.behaviorProfile ? (
          <Card className="border border-line bg-surface shadow-soft">
            <CardHeader className="items-center">
              <div className="min-w-0 flex-1">
                <CardTitle>Shared conversation profile</CardTitle>
                <p className="mt-1 text-[12px] leading-relaxed text-muted">Saved configuration version {state.behaviorProfile.configVersion}</p>
              </div>
              <Badge tone={state.behaviorProfile.runtimeSyncStatus === "synced" ? "success" : state.behaviorProfile.runtimeSyncStatus === "pending" ? "warning" : "neutral"}>
                {state.behaviorProfile.runtimeSyncStatus === "synced" ? "Profile synced" : state.behaviorProfile.runtimeSyncStatus === "pending" ? "Profile sync pending" : "Runtime not configured"}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid gap-3 sm:grid-cols-3">
                {[
                  ["Tone", state.behaviorProfile.tone],
                  ["Reply length", state.behaviorProfile.replyLength],
                  ["Language", state.behaviorProfile.language],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border border-line bg-surface-2/40 px-3 py-2.5">
                    <dt className="text-[12px] font-medium text-muted">{label}</dt>
                    <dd className="mt-1 text-[14px] font-semibold capitalize text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="grid gap-3 md:grid-cols-2">
                {[
                  ["Personality", state.behaviorProfile.personality],
                  ["Communication style", state.behaviorProfile.communicationStyle],
                  ["Response behavior", state.behaviorProfile.responseBehavior],
                  ["Proactive work", state.behaviorProfile.proactiveResponsibilities],
                  ["Reporting", state.behaviorProfile.reportingBehavior],
                ].filter(([, value]) => Boolean(value)).map(([label, value]) => (
                  <div key={label} className="rounded-xl border border-line bg-surface-2/40 px-3 py-2.5">
                    <p className="text-[12px] font-medium text-muted">{label}</p>
                    <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">{value}</p>
                  </div>
                ))}
              </div>
              {state.behaviorProfile.runtimeSyncStatus === "pending" && (
                <p className="text-[12px] leading-relaxed text-warning-ink">The approved profile is saved. Check the connection status to see when the AI Growth Partner has received this version.</p>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card className="border border-line bg-surface shadow-soft">
            <CardContent className="p-4 text-[13px] leading-relaxed text-muted">The Growth Partner does not have an approved behavior profile yet. Complete Partner setup to save its shared voice and response behavior.</CardContent>
          </Card>
        )}
      </section>

      <section aria-label="Memory and Knowledge">
        <SectionHeading
          title="Memory and Knowledge"
          description="Review the notes your AI Growth Partner remembers. Open the Knowledge Center to manage company documents and reference text."
          action={<ButtonLink href="/knowledge" variant="secondary" size="sm">Open Knowledge Center <ArrowUpRight className="size-4" aria-hidden /></ButtonLink>}
        />
        {unavailable.memories
          ? <GrowthPartnerSectionUnavailable title="Memory" />
          : <GrowthPartnerMemoryPanel memories={memories} canManage={canManageMemory} hasPartner={Boolean(state)} timezone={timezone} />}
      </section>

      <section aria-label="Goals">
        {unavailable.goals
          ? <GrowthPartnerSectionUnavailable title="Goals" />
          : <GrowthPartnerGoalsPanel goals={goals} canManage={canManageGoals} hasPartner={Boolean(state)} />}
      </section>

      {canConfigureResearch && (unavailable.researchSourcePolicies
        ? <GrowthPartnerSectionUnavailable title="Research source settings" />
        : <ResearchSourceSettings policies={researchSourcePolicies} timeZone={timezone} workspaceId={researchSourceWorkspaceId} />)}

      {state?.status === "paused" && (
        <div role="status" className="flex gap-3 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-warning-ink">
          <PauseCircle className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p className="text-[14px] leading-relaxed">This AI Growth Partner is paused. Safety controls above show whether workspace messaging is also paused.</p>
        </div>
      )}

      <section id="capability-access" className="scroll-mt-24">
        <SectionHeading
          title="Capability Access"
          description="These capabilities belong to one AI Growth Partner. We show your access, the tools it is allowed to use and whether its connection has been checked. Service limits and approval rules are checked again before work starts."
        />
        {canConfigure && (unavailable.abilityControls
          ? <GrowthPartnerSectionUnavailable title="Restricted capabilities" />
          : abilityControls && <GrowthPartnerAbilityEditor controls={abilityControls} />)}
        {unavailable.capabilityAccess ? <GrowthPartnerSectionUnavailable title="Capability access" /> : <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
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
              <Card key={key} data-capability-domain={key} className="min-w-0 border border-line bg-surface shadow-soft transition-colors hover:border-primary/25">
                <CardHeader className="flex-col items-start gap-2">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-soft text-violet-ink"><Icon className="size-5" aria-hidden /></div>
                    <div className="min-w-0">
                      <CardTitle>{title}</CardTitle>
                      <p className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p>
                    </div>
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
        </div>}
      </section>

      <section id="business-brain" className="scroll-mt-24" data-aqi-target="growth-partner.brain">
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
          {!hasAnyBrain && unavailable.submittedOnboarding && <GrowthPartnerSectionUnavailable title="Submitted setup answers" />}
          {!hasAnyBrain && !unavailable.submittedOnboarding && (
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
          {unavailable.legacyKnowledgeReview
            ? <GrowthPartnerSectionUnavailable title="Previous profile knowledge review" />
            : <GrowthPartnerLegacyKnowledgeReview data={legacyKnowledgeReview} />}
        </section>
      )}

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
        <Card className="border border-line bg-surface shadow-soft">
          <CardHeader>
            <div>
              <CardTitle>Permanent Conversation</CardTitle>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">A single shared place for requests, decisions, approvals and progress updates.</p>
            </div>
            <Badge tone={state?.conversationId ? "success" : "warning"}>{state?.conversationId ? "Connected" : "Not connected"}</Badge>
          </CardHeader>
          <CardContent>
            {state?.conversationId ? (
              <div className="space-y-3">
                <div className="flex gap-3 rounded-xl border border-success/20 bg-success-soft/40 p-4">
                  <MessageSquareText className="mt-0.5 size-5 shrink-0 text-success-ink" aria-hidden />
                  <p className="text-[13px] leading-relaxed text-ink-2">Members with AI access share this conversation and its full history.</p>
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
                  Your AI Growth Partner’s shared conversation is not ready yet. It will open when setup and connection checks are complete. Histories from previous role profiles remain saved.
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
