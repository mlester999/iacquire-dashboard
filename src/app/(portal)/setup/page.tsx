import { ClipboardCheck } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getClientSetupSnapshot } from "@/server/setup/snapshots";
import { SetupCenter } from "@/components/setup/setup-center";
import { OnboardedBanner, type EmployeeProvisioningState } from "@/components/setup/onboarded-banner";
import { withSystem, withUser } from "@/server/db";
import { listAgents } from "@/server/workforce/service";
import { isSetupPaymentClearedFor } from "@/server/billing/clearance";
import { crmOwners } from "@/server/setup/native-evidence";
import { ButtonLink } from "@/components/ui/button";
import { Card, EmptyState } from "@/components/ui/primitives";
import { firstName } from "@/lib/utils";

export const metadata = { title: "Setup" };

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ onboarded?: string }> }) {
  const ctx = await requireOrgContext("setup.view");
  const { onboarded } = await searchParams;

  if (ctx.org.kind !== "client") {
    return (
      <Card className="mx-auto max-w-3xl">
        <EmptyState icon={<ClipboardCheck className="size-5" />} title="Setup applies to client workspaces" description="This is the agency workspace. Manage each client's setup from the Admin portal." />
      </Card>
    );
  }

  // The checklist starts once the company information has been submitted.
  if (!ctx.org.onboardingCompletedAt) {
    return (
      <Card className="mx-auto max-w-3xl">
        <EmptyState
          icon={<ClipboardCheck className="size-5" />}
          title="Let's start with your company information"
          description="Answer a few short questions about your business. Once you submit them, your setup checklist appears here and the iAcquire team gets to work."
          action={ctx.can("workspace.manage_profile") ? <ButtonLink href="/onboarding" variant="brand">Start company setup</ButtonLink> : undefined}
        />
      </Card>
    );
  }

  const snapshot = await getClientSetupSnapshot(ctx);
  if (!snapshot) {
    return (
      <Card className="mx-auto max-w-3xl">
        <EmptyState icon={<ClipboardCheck className="size-5" />} title="Your checklist isn't ready yet" description="The iAcquire team is preparing it. Refresh in a moment, or message the team from the help button." />
      </Card>
    );
  }
  // Who runs the CRM decides what the team does next: a Blueprint for iAcquire's own CRM (native or hybrid), the sub-account for GoHighLevel.
  // A trusted read of this workspace's own provider mode, only when the banner shows.
  const nativeCrm = onboarded === "1" ? (await withSystem((db) => crmOwners(db, ctx.org.orgId))).mode !== "ghl" : false;
  const [agents, provisioning] = onboarded === "1" ? await Promise.all([
    listAgents(ctx.user.id, ctx.org.orgId),
    withUser(ctx.user.id, async (db) => {
      const { rows } = await db.query<EmployeeProvisioningState>(
        `select distinct on (a.role_key) a.role_key as role, j.status, j.detail
         from agent_instances a left join agent_provisioning_jobs j on j.agent_instance_id = a.id and j.org_id = a.org_id
         where a.org_id = $1 order by a.role_key, j.created_at desc nulls last`,
        [ctx.org.orgId],
      );
      return rows;
    }),
  ]) : [[], []];
  const paymentCleared = onboarded === "1" ? await isSetupPaymentClearedFor(ctx.user.id, ctx.org.orgId) : undefined;
  return (
    <>
      {onboarded === "1" && <OnboardedBanner nativeCrm={nativeCrm} crmGuide={ctx.can("crm.view")} agents={agents} provisioning={provisioning} paymentCleared={paymentCleared} />}
      <SetupCenter key={ctx.org.orgId} initial={snapshot} firstName={firstName(ctx.user.fullName) ?? "there"} timeZone={ctx.org.timezone} />
    </>
  );
}
