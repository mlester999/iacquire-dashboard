import { redirect } from "next/navigation";
import { GrowthPartnerControlCenter } from "@/components/growth-partner/control-center";
import { getGrowthPartnerControlState } from "@/server/ai-growth-partner/service";
import { getGrowthPartnerCapabilityAccess } from "@/server/ai-growth-partner/capability-access";
import { listGrowthPartnerMemories } from "@/server/ai-growth-partner/memory";
import { listGrowthPartnerGoalProgress } from "@/server/ai-growth-partner/goals";
import { requireOrgContext } from "@/server/tenancy/context";
import { getSubmittedBrainSource } from "@/server/onboarding/submitted-brain-source";
import { listAgents } from "@/server/workforce/service";
import { withUser } from "@/server/db";
import { getControlState } from "@/server/automation/controls";
import { getResearchSourcePolicy, type StoredResearchSourcePolicy } from "@/server/leads/research-source-policy";
import type { ResearchSourcePoliciesView, ResearchSourcePolicyView } from "@/components/growth-partner/research-source-settings";

export const metadata = { title: "AI Growth Partner" };

export default async function GrowthPartnerPage() {
  const ctx = await requireOrgContext();
  if (ctx.org.kind !== "client") {
    redirect(ctx.user.platformRole === "agency_super_admin" ? "/admin/employees" : ctx.user.platformRole === "agency_staff" ? "/admin/employees/clients" : "/no-workspace");
  }

  const state = await getGrowthPartnerControlState(ctx);
  const [legacyAgents, memories, capabilityAccess, goals] = await Promise.all([
    listAgents(ctx.user.id, ctx.org.orgId),
    listGrowthPartnerMemories(ctx),
    getGrowthPartnerCapabilityAccess(ctx, {
      partnerExists: state !== null,
      runtimeAgentId: state?.runtimeAgentInstanceId ?? null,
      runtimeReady: state?.status === "configured",
    }),
    listGrowthPartnerGoalProgress(ctx),
  ]);
  const canConfigure = ctx.can("agents.configure");
  const canConfigureResearch = ctx.can("leads.research");
  const submittedSource = canConfigure ? await getSubmittedBrainSource(ctx) : null;
  const [controls, researchSourcePolicies] = await Promise.all([
    withUser(ctx.user.id, (db) => getControlState(db, ctx.org.orgId)),
    canConfigureResearch
      ? withUser(ctx.user.id, async (db): Promise<ResearchSourcePoliciesView> => {
          const openstreetmap = await getResearchSourcePolicy(db, ctx.org.orgId, "openstreetmap");
          const companyWebsite = await getResearchSourcePolicy(db, ctx.org.orgId, "company_website");
          const view = (policy: StoredResearchSourcePolicy | null): ResearchSourcePolicyView | null => policy ? ({
            enabled: policy.enabled,
            providerFeeUsdPerRequest: policy.providerFeeUsdPerRequest,
            perJobRequestCap: policy.perJobRequestCap,
            perDayRequestCap: policy.perDayRequestCap,
            perJobSpendCapUsd: policy.perJobSpendCapUsd,
            perDaySpendCapUsd: policy.perDaySpendCapUsd,
            sourceConfig: { ...policy.sourceConfig } as Record<string, unknown>,
          }) : null;
          return {
            openstreetmap: view(openstreetmap),
            company_website: view(companyWebsite),
          };
        })
      : Promise.resolve({ openstreetmap: null, company_website: null }),
  ]);

  return (
    <GrowthPartnerControlCenter
      state={state}
      capabilityAccess={capabilityAccess}
      memories={memories}
      goals={goals}
      canManageMemory={canConfigure}
      canManageGoals={canConfigure}
      canConfigure={canConfigure}
      canConfigureResearch={canConfigureResearch}
      researchSourcePolicies={researchSourcePolicies}
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
        "usage.view": ctx.can("usage.view"),
      }}
      legacyProfilesPresent={legacyAgents.some((agent) => agent.enabled)}
      hasSubmittedOnboarding={Boolean(submittedSource)}
      submittedAnswerCount={submittedSource?.answerCount ?? 0}
      timezone={ctx.org.timezone}
      safetyControls={{
        messagingPaused: controls.pauses.messaging.active,
        outboundPaused: controls.pauses.outbound.active,
        agencyPaused: controls.pauses.agency.active,
        canPause: ctx.can("automation.pause"),
      }}
    />
  );
}
