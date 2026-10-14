import { ClipboardCheck } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getClientSetupSnapshot } from "@/server/setup/snapshots";
import { SetupCenter } from "@/components/setup/setup-center";
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
  return (
    <>
      {onboarded === "1" && (
        <div role="status" className="mx-auto mb-4 max-w-6xl rounded-2xl border border-success/30 bg-success-soft/60 p-4 text-[14px] leading-relaxed text-success-ink">
          <strong className="font-semibold">Your company setup is approved.</strong> Your six AI employees have configurations ready. The iAcquire team now links your CRM and verifies each connection. Nothing contacts your customers until you switch it on.
        </div>
      )}
      <SetupCenter key={ctx.org.orgId} initial={snapshot} firstName={firstName(ctx.user.fullName) ?? "there"} timeZone={ctx.org.timezone} />
    </>
  );
}
