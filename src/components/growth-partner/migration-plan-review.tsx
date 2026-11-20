"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { decideGrowthPartnerMigrationPlanAction } from "@/app/actions/ai-growth-partner-migration";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { MigrationPlanManifestView, PLAN_STATUS } from "@/components/growth-partner/migration-plan-manifest";
import type { readOwnerMigrationPlan } from "@/server/admin/growth-partner-migration-plan";

type OwnerReview = NonNullable<Awaited<ReturnType<typeof readOwnerMigrationPlan>>>;

export function GrowthPartnerMigrationPlanReview({ plan }: { plan: OwnerReview }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [confirmation, setConfirmation] = React.useState<"approved" | "declined" | "withdrawn" | null>(null);
  const open = plan.status === "pending_review" || plan.status === "approved";

  function decide(decision: "approved" | "declined" | "withdrawn") {
    startTransition(async () => {
      setError(null);
      const result = await decideGrowthPartnerMigrationPlanAction({ planId: plan.id, digest: plan.digest, decision });
      if (!result.ok) return setError(result.error);
      setConfirmation(decision);
      router.refresh();
    });
  }

  return (
    <Card aria-label="Growth Partner migration plan review">
      <CardHeader>
        <div>
          <CardTitle>Review your Growth Partner migration plan</CardTitle>
          <CardDescription>Your approval lets iAcquire apply this Business Brain version and prepare disabled schedule replacements. Your current runtime, schedules and messages keep their settings. A cutover requires a separate approval.</CardDescription>
        </div>
        <Badge tone={plan.status === "approved" ? "success" : "neutral"}>{PLAN_STATUS[plan.status]}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <MigrationPlanManifestView manifest={plan.manifest} />
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">Exact plan reference</summary>
          <p className="mt-1 break-all font-mono">{plan.digest}</p>
        </details>
        {plan.preparation && !plan.preparation.withdrawnAt && (
          <p role="status" className="text-sm text-muted">Business Brain version {plan.preparation.brainVersion} applied. Prepared {plan.preparation.replacementScheduleCount} disabled schedule replacements.</p>
        )}
        {open && !plan.currentEvidence && (
          <p role="status" className="text-sm text-warning-ink">
            The workspace has changed since this plan was staged. {plan.preparation ? "Withdraw this approval so iAcquire can prepare a new plan." : "Ask iAcquire for an updated plan before approving preparation."}
          </p>
        )}
        {error && <p role="alert" className="text-sm text-danger-ink">{error}</p>}
        {confirmation && <p role="status" className="text-sm text-muted">{PLAN_STATUS[confirmation]}.</p>}
        <div className="flex flex-wrap gap-2">
          {plan.status === "pending_review" && (
            <>
              <Button disabled={pending || Boolean(confirmation) || !plan.currentEvidence} onClick={() => decide("approved")}>Approve this preparation plan</Button>
              <Button variant="secondary" disabled={pending || Boolean(confirmation)} onClick={() => decide("declined")}>Decline plan</Button>
            </>
          )}
          {plan.status === "approved" && (
            <Button variant="secondary" disabled={pending || confirmation === "withdrawn"} onClick={() => decide("withdrawn")}>Withdraw approval</Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
