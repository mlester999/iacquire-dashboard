import { redirect } from "next/navigation";
import { GrowthPartnerControlCenter } from "@/components/growth-partner/control-center";
import { getGrowthPartnerControlState } from "@/server/ai-growth-partner/service";
import { requireOrgContext } from "@/server/tenancy/context";
import { getSubmittedBrainSource } from "@/server/onboarding/submitted-brain-source";
import { listAgents } from "@/server/workforce/service";
import { withUser } from "@/server/db";
import { getControlState } from "@/server/automation/controls";

export const metadata = { title: "AI Growth Partner" };

export default async function GrowthPartnerPage() {
  const ctx = await requireOrgContext();
  if (ctx.org.kind !== "client") {
    redirect(ctx.user.platformRole === "agency_super_admin" ? "/admin/employees" : ctx.user.platformRole === "agency_staff" ? "/admin/employees/clients" : "/no-workspace");
  }

  const [state, legacyAgents] = await Promise.all([
    getGrowthPartnerControlState(ctx),
    listAgents(ctx.user.id, ctx.org.orgId),
  ]);
  const canConfigure = ctx.can("agents.configure");
  const submittedSource = canConfigure ? await getSubmittedBrainSource(ctx) : null;
  const controls = await withUser(ctx.user.id, (db) => getControlState(db, ctx.org.orgId));

  return (
    <GrowthPartnerControlCenter
      state={state}
      canConfigure={canConfigure}
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
