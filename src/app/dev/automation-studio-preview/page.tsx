import { notFound } from "next/navigation";
import { env } from "@/server/env";
import { PreviewTheme } from "@/components/projects/preview-theme";
import { UpgradePage, type UpgradeProps } from "@/components/automation-studio/upgrade-page";
import { STUDIO_PLAN_MONTHLY_USD, STUDIO_SETUP_FEE_USD, entitlementFor, type PlanStatus } from "@/lib/automation-studio/plan";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automation Studio upgrade preview" };

const STATES: Record<string, PlanStatus | null> = { none: null, pending: "requested", expired: "expired", cancelled: "cancelled", declined: "declined" };

/** The Automation Studio upgrade page with sample props, for design QA without signing in. Development only. */
export default async function AutomationStudioPreview({ searchParams }: { searchParams: Promise<{ state?: string; owner?: string; saved?: string }> }) {
  if (env().NODE_ENV === "production") notFound();
  const q = await searchParams;
  const key = q.state && q.state in STATES ? q.state : "none";
  const status = STATES[key];
  const ent = entitlementFor(status ? { id: "sample", status, graceEndsAt: null } : null);
  const owner = q.owner !== "0";
  const props: UpgradeProps = {
    state: ent.state,
    reason: ent.reason,
    monthlyUsd: STUDIO_PLAN_MONTHLY_USD,
    setupFeeUsd: STUDIO_SETUP_FEE_USD,
    canRequest: owner,
    requestNote: owner ? null : "Only the owner of your workspace can request the plan. Ask them to open the Maintenance page.",
    saved: q.saved === "1" ? [{ id: "00000000-0000-4000-8000-000000000001", name: "Welcome new leads" }, { id: "00000000-0000-4000-8000-000000000002", name: "Review request after a job" }] : [],
  };
  return (
    <div className="min-h-dvh bg-bg">
      <div className="mx-auto w-full max-w-[1600px] px-4 pb-28 pt-6 sm:px-6 lg:pl-[calc(272px+2rem)] lg:pr-8">
        <div role="note" className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-line-strong bg-surface-2 px-4 py-2.5 text-[12.5px] text-muted">
          <PreviewTheme />
          <span>Design preview with <strong>sample props</strong>; the left gutter stands in for the sidebar. States:</span>
          {Object.keys(STATES).map((s) => <a key={s} href={`?state=${s}`} className="font-medium text-primary underline">{s}</a>)}
          <a href={`?state=${key}&owner=0`} className="font-medium text-primary underline">not owner</a>
          <a href={`?state=expired&saved=1`} className="font-medium text-primary underline">expired + saved</a>
        </div>
        <UpgradePage {...props} />
      </div>
    </div>
  );
}
