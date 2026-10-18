import { ClipboardCheck } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getClientSetupSnapshot } from "@/server/setup/snapshots";
import { SetupCenter } from "@/components/setup/setup-center";
import { OnboardedBanner } from "@/components/setup/onboarded-banner";
import { withSystem } from "@/server/db";
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
  return (
    <>
      {onboarded === "1" && <OnboardedBanner nativeCrm={nativeCrm} crmGuide={ctx.can("crm.view")} />}
      <SetupCenter key={ctx.org.orgId} initial={snapshot} firstName={firstName(ctx.user.fullName) ?? "there"} timeZone={ctx.org.timezone} />
    </>
  );
}
