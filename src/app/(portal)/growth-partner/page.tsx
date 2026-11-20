import { redirect } from "next/navigation";
import { GrowthPartnerMigrationPlanReview } from "@/components/growth-partner/migration-plan-review";
import { readOwnerMigrationPlan } from "@/server/admin/growth-partner-migration-plan";
import { GrowthPartnerControlCenter } from "@/components/growth-partner/control-center";
import { getGrowthPartnerControlState } from "@/server/ai-growth-partner/service";
import { listGrowthPartnerLegacyKnowledge, type GrowthPartnerLegacyKnowledgeReview } from "@/server/ai-growth-partner/legacy-knowledge";
import { getGrowthPartnerCapabilityAccess } from "@/server/ai-growth-partner/capability-access";
import { getGrowthPartnerAbilityControls } from "@/server/ai-growth-partner/ability-controls";
import { listGrowthPartnerMemories } from "@/server/ai-growth-partner/memory";
import { listGrowthPartnerGoalProgress } from "@/server/ai-growth-partner/goals";
import { requireOrgContext } from "@/server/tenancy/context";
import { getSubmittedBrainSource } from "@/server/onboarding/submitted-brain-source";
import { listAgents } from "@/server/workforce/service";
import { withUser } from "@/server/db";
import { getControlState } from "@/server/automation/controls";
import { outboundMessagingEnabled } from "@/server/messaging/transports/policy";
import { workBoardSummary } from "@/server/workforce/work-board";
import { getResearchSourceHealth, getResearchSourcePolicy, researchSourceApprovalCurrent, type StoredResearchSourcePolicy } from "@/server/leads/research-source-policy";
import type { ResearchSourcePoliciesView, ResearchSourcePolicyView } from "@/components/growth-partner/research-source-settings";

export const metadata = { title: "AI Growth Partner" };

export default async function GrowthPartnerPage() {
  const ctx = await requireOrgContext();
  if (ctx.org.kind !== "client") {
    redirect(ctx.user.platformRole === "agency_super_admin" ? "/admin/employees" : ctx.user.platformRole === "agency_staff" ? "/admin/employees/clients" : "/no-workspace");
  }

  if (!ctx.can("agents.use")) {
    return (
      <main className="mx-auto flex min-h-[55dvh] w-full max-w-3xl items-center px-4 py-10 sm:px-6">
        <section className="w-full rounded-2xl border border-line bg-surface p-6 shadow-soft sm:p-8" aria-labelledby="growth-partner-access-title">
          <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">Workspace access</p>
          <h1 id="growth-partner-access-title" className="mt-2 text-[22px] font-semibold tracking-tight text-ink">AI Growth Partner access needed</h1>
          <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-muted">Your current workspace role does not include access to the AI Growth Partner. Ask a workspace owner or admin to review your permissions.</p>
        </section>
      </main>
    );
  }

  const state = await getGrowthPartnerControlState(ctx);
  const unavailable = {
    previousProfiles: false,
    submittedOnboarding: false,
    memories: false,
    capabilityAccess: false,
    abilityControls: false,
    goals: false,
    workSummary: false,
    researchSourcePolicies: false,
    legacyKnowledgeReview: false,
    controls: false,
  };
  const canConfigure = ctx.can("agents.configure");
  const [legacyAgents, memories, capabilityAccess, abilityControls, goals] = await Promise.all([
    listAgents(ctx.user.id, ctx.org.orgId).catch(() => { unavailable.previousProfiles = true; return []; }),
    listGrowthPartnerMemories(ctx).catch(() => { unavailable.memories = true; return []; }),
    getGrowthPartnerCapabilityAccess(ctx, {
      partnerExists: state !== null,
      runtimeAgentId: state?.runtimeAgentInstanceId ?? null,
      runtimeReady: state?.status === "configured",
    }).catch(() => { unavailable.capabilityAccess = true; return []; }),
    canConfigure
      ? getGrowthPartnerAbilityControls(ctx).catch(() => { unavailable.abilityControls = true; return null; })
      : null,
    listGrowthPartnerGoalProgress(ctx).catch(() => { unavailable.goals = true; return []; }),
  ]);
  const canConfigureResearch = ctx.can("leads.research");
  const researchSourceWorkspaceId = canConfigureResearch && ctx.org.kind === "client" && !ctx.org.isDemo ? ctx.org.orgId : undefined;
  const submittedSource = canConfigure
    ? await getSubmittedBrainSource(ctx).catch(() => { unavailable.submittedOnboarding = true; return null; })
    : null;
  const [controls, researchSourcePolicies, legacyKnowledgeReview, workSummary] = await Promise.all([
    withUser(ctx.user.id, (db) => getControlState(db, ctx.org.orgId)).catch(() => { unavailable.controls = true; return null; }),
    canConfigureResearch
      ? withUser(ctx.user.id, async (db): Promise<ResearchSourcePoliciesView> => {
          const openstreetmap = await getResearchSourcePolicy(db, ctx.org.orgId, "openstreetmap");
          const companyWebsite = await getResearchSourcePolicy(db, ctx.org.orgId, "company_website");
          const directory = researchSourceWorkspaceId ? await getResearchSourcePolicy(db, ctx.org.orgId, "fsa_directory") : null;
          const view = async (policy: StoredResearchSourcePolicy | null): Promise<ResearchSourcePolicyView | null> => policy ? ({
            enabled: policy.enabled,
            providerFeeUsdPerRequest: policy.providerFeeUsdPerRequest,
            perJobRequestCap: policy.perJobRequestCap,
            perDayRequestCap: policy.perDayRequestCap,
            perJobSpendCapUsd: policy.perJobSpendCapUsd,
            perDaySpendCapUsd: policy.perDaySpendCapUsd,
            sourceConfig: { ...policy.sourceConfig } as Record<string, unknown>,
            health: policy.enabled ? await getResearchSourceHealth(db, policy).catch(() => null) : null,
            approvalCurrent: researchSourceApprovalCurrent(policy),
          }) : null;
          const osmView = await view(openstreetmap);
          const websiteView = await view(companyWebsite);
          return {
            openstreetmap: osmView,
            company_website: websiteView,
            fsa_directory: await view(directory),
          };
        }).catch(() => { unavailable.researchSourcePolicies = true; return { openstreetmap: null, company_website: null }; })
      : Promise.resolve({ openstreetmap: null, company_website: null }),
    canConfigure && ctx.can("knowledge.view") && state
      ? listGrowthPartnerLegacyKnowledge(ctx).catch(() => { unavailable.legacyKnowledgeReview = true; return { candidates: [], imports: [] } satisfies GrowthPartnerLegacyKnowledgeReview; })
      : Promise.resolve({ candidates: [], imports: [] } satisfies GrowthPartnerLegacyKnowledgeReview),
    workBoardSummary(ctx).catch(() => { unavailable.workSummary = true; return { active: 0, waiting: 0, needsAttention: 0, completedToday: 0 }; }),
  ]);

  const migrationReview = state?.status === "migration_required" && ctx.role === "owner" && ctx.can("approvals.decide_high")
    ? await readOwnerMigrationPlan(ctx)
      .then((plan) => plan ? <GrowthPartnerMigrationPlanReview key={plan.id} plan={plan} /> : null)
      .catch(() => <p role="alert" className="rounded-xl border border-line p-4 text-sm text-muted">The migration plan could not be loaded. Refresh this page to try again.</p>)
    : null;
  return (
    <GrowthPartnerControlCenter
      state={state}
      capabilityAccess={capabilityAccess}
      abilityControls={abilityControls}
      memories={memories}
      goals={goals}
      workSummary={workSummary}
      canManageMemory={canConfigure}
      canManageGoals={canConfigure}
      canConfigure={canConfigure}
      canConfigureResearch={canConfigureResearch}
      researchSourcePolicies={researchSourcePolicies}
      researchSourceWorkspaceId={researchSourceWorkspaceId}
      legacyKnowledgeReview={legacyKnowledgeReview}
      migrationReview={migrationReview}
      canOpenSetup={ctx.can("setup.view")}
      controlPermissions={{
        "agents.use": ctx.can("agents.use"),
        "agents.configure": canConfigure,
        "knowledge.view": ctx.can("knowledge.view"),
        "integrations.view": ctx.can("integrations.view"),
        "crm.view": ctx.can("crm.view"),
        "appointments.view": ctx.can("appointments.view"),
        "inbox.view": ctx.can("inbox.view"),
        "approvals.view": ctx.can("approvals.view"),
        "team.view": ctx.can("team.view"),
        "activity.view": ctx.can("activity.view"),
        "analytics.view": ctx.can("analytics.view"),
        "usage.view": ctx.can("usage.view"),
      }}
      legacyProfilesPresent={legacyAgents.some((agent) => agent.enabled)}
      hasSubmittedOnboarding={Boolean(submittedSource)}
      submittedAnswerCount={submittedSource?.answerCount ?? 0}
      unavailable={unavailable}
      timezone={ctx.org.timezone}
      safetyControls={{
        outboundMessagingEnabled: outboundMessagingEnabled(),
        messagingPaused: controls?.pauses.messaging.active ?? false,
        outboundPaused: controls?.pauses.outbound.active ?? false,
        agencyPaused: controls?.pauses.agency.active ?? false,
        canPause: ctx.can("automation.pause"),
      }}
    />
  );
}
