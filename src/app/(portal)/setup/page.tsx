import { cookies } from "next/headers";
import { ClipboardCheck } from "lucide-react";
import { requireOrgContext, type OrgContext } from "@/server/tenancy/context";
import { getClientSetupSnapshot } from "@/server/setup/snapshots";
import { SetupCenter } from "@/components/setup/setup-center";
import { OnboardedBanner, type EmployeeProvisioningState } from "@/components/setup/onboarded-banner";
import { SetupPaymentLine } from "@/components/setup/setup-payment-line";
import { LaunchReadinessPanel } from "@/components/setup/launch-readiness-panel";
import { getLaunchReadiness } from "@/server/setup/launch-readiness";
import { withSystem, withUser } from "@/server/db";
import { listAgents } from "@/server/workforce/service";
import { getGrowthPartnerControlState } from "@/server/ai-growth-partner/service";
import { isSetupPaymentClearedFor } from "@/server/billing/clearance";
import { crmOwners } from "@/server/setup/native-evidence";
import { latestOnboardingNotes } from "@/server/onboarding/service";
import { loadAnswerRows, toStored } from "@/server/onboarding/answers";
import { CALENDAR_NOTICE_COOKIE, calendarNoticeFor } from "@/server/calendars/connections";
import { computeProgress, planScope } from "@/lib/onboarding/engine";
import { AGENT_ROLE_KEYS, isAgentRoleKey } from "@/lib/agents";
import { ButtonLink } from "@/components/ui/button";
import { Card, EmptyState } from "@/components/ui/primitives";
import { firstName } from "@/lib/utils";

export const metadata = { title: "Setup" };

/**
 * How far a half-finished questionnaire got, from the answers the person gave themselves (what the workspace already knew is not counted: they have not answered it). Null when
 * they have not answered anything or the read failed, so the page falls back to the plain start.
 */
async function savedAnswerCounts(ctx: OrgContext): Promise<{ answered: number; total: number } | null> {
  return withUser(ctx.user.id, async (db) => {
    const rows = (await loadAnswerRows(db, ctx.org.orgId)).filter((r) => r.source !== "prefill");
    if (!rows.length) return null;
    const { rows: roles } = await db.query<{ role_key: string }>("select role_key from agent_instances where org_id = $1 and enabled", [ctx.org.orgId]);
    const progress = computeProgress(toStored(rows), planScope(roles.map((r) => r.role_key).filter(isAgentRoleKey)));
    return progress.done > 0 ? { answered: progress.done, total: progress.total } : null;
  });
}

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
    const canEdit = ctx.can("workspace.manage_profile");
    // Someone who has answered part of the questionnaire is told so, and picks up where they stopped; the read never blocks the page.
    const saved = canEdit ? await savedAnswerCounts(ctx).catch(() => null) : null;
    return (
      <Card className="mx-auto max-w-3xl">
        <EmptyState
          icon={<ClipboardCheck className="size-5" />}
          title={saved ? "Continue where you left off" : "Let's start with your company information"}
          description={saved
            ? `${saved.answered} of ${saved.total} questions are saved. Pick up exactly where you stopped. Once you submit them, your setup checklist appears here and the iAcquire team gets to work.`
            : "Answer a few short questions about your business. Once you submit them, your setup checklist appears here and the iAcquire team gets to work."}
          action={canEdit ? <ButtonLink href="/onboarding" variant="brand">{saved ? "Continue company setup" : "Start company setup"}</ButtonLink> : undefined}
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
  const [agents, provisioning, growthPartner] = onboarded === "1" ? await Promise.all([
    listAgents(ctx.user.id, ctx.org.orgId),
    withUser(ctx.user.id, async (db) => {
      const { rows } = await db.query<EmployeeProvisioningState>(
        `select distinct on (a.role_key) a.role_key as role, j.status, j.detail
         from agent_instances a left join agent_provisioning_jobs j on j.agent_instance_id = a.id and j.org_id = a.org_id
         where a.org_id = $1 and a.role_key = any($2::text[]) order by a.role_key, j.created_at desc nulls last`,
        [ctx.org.orgId, AGENT_ROLE_KEYS],
      );
      return rows;
    }),
    getGrowthPartnerControlState(ctx).catch(() => null),
  ]) : [[], [], null];
  // The database's yes or no (app.setup_payment_cleared), asked as this member. A sample workspace has no setup fee, so it says nothing about one.
  const paymentCleared = ctx.org.isDemo ? undefined : await isSetupPaymentClearedFor(ctx.user.id, ctx.org.orgId);
  // The one honest launch state, from the workspace's own records. If it cannot be read the panel says so and offers to try again; nothing is claimed, and the checklist below still works.
  const { launch, launchFailed } = await getLaunchReadiness(ctx).then(
    (readiness) => ({ launch: readiness, launchFailed: false }),
    (error: unknown) => {
      // The kind of failure only: no record, name or answer goes into a log line.
      console.warn(`Launch readiness could not be read for the Setup page (${error instanceof Error ? error.name : "unknown error"}).`);
      return { launch: null, launchFailed: true };
    },
  );
  // What the submission just kept, held or skipped, shown once the person lands here after submitting. A failed read shows nothing.
  const outcomeNotes = onboarded === "1" ? await latestOnboardingNotes(ctx).catch(() => []) : [];
  // A Google or Microsoft sign-in that started from this page comes back here with one short message in a cookie that names this page. The panel shows it once and clears the cookie; a message left for a CRM page is not shown here.
  const calendarNotice = calendarNoticeFor((await cookies()).get(CALENDAR_NOTICE_COOKIE)?.value, "setup");
  return (
    <>
      {onboarded === "1" && <OnboardedBanner nativeCrm={nativeCrm} crmGuide={ctx.can("crm.view")} agents={agents} provisioning={provisioning} paymentCleared={paymentCleared} readiness={launch} growthPartner={growthPartner} />}
      {outcomeNotes.length > 0 && (
        <section aria-label="What your submission changed" data-testid="outcome-notes" className="mx-auto mb-6 max-w-6xl rounded-[26px] border border-line bg-surface p-5 shadow-sm sm:p-7">
          <h2 className="text-[15px] font-semibold text-ink">What your submission changed</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] leading-snug text-muted">
            {outcomeNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      )}
      <SetupPaymentLine cleared={paymentCleared} billingHref={ctx.can("billing.view") ? "/settings/billing" : null} />
      {(launch || launchFailed) && <LaunchReadinessPanel readiness={launch} calendarNotice={calendarNotice ? { ok: calendarNotice.kind === "success", text: calendarNotice.message } : null} />}
      <SetupCenter key={ctx.org.orgId} initial={snapshot} firstName={firstName(ctx.user.fullName) ?? "there"} timeZone={ctx.org.timezone} />
    </>
  );
}
