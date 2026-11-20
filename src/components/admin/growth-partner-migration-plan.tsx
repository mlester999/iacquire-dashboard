"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { MigrationPlanManifestView, PLAN_STATUS } from "@/components/growth-partner/migration-plan-manifest";
import { applyApprovedGrowthPartnerMigrationPlanAction, previewGrowthPartnerMigrationPlanAction, stageGrowthPartnerMigrationPlanAction } from "@/app/(admin)/admin/migration-actions";
import type { MigrationPlanInspection, MigrationPlanPreview } from "@/server/admin/growth-partner-migration-plan";

export function GrowthPartnerMigrationPlanStage({ orgId }: { orgId: string }) {
  const [pending, startTransition] = React.useTransition();
  const [preview, setPreview] = React.useState<MigrationPlanPreview | null>(null);
  const [current, setCurrent] = React.useState<MigrationPlanInspection | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const active = current?.status === "pending_review" || current?.status === "approved";
  const prepared = Boolean(current?.preparation && !current.preparation.withdrawnAt);
  const alreadyStaged = active && preview?.status === "ready" && preview.digest === current?.digest;

  function refresh() {
    startTransition(async () => {
      setError(null);
      setPreview(null);
      const result = await previewGrowthPartnerMigrationPlanAction(orgId);
      if (!result.ok) return setError(result.error);
      setCurrent(result.data.current);
      setPreview(result.data.proposal);
    });
  }

  function stage(digest: string) {
    startTransition(async () => {
      setError(null);
      const result = await stageGrowthPartnerMigrationPlanAction(orgId, digest);
      if (!result.ok) {
        setPreview(null);
        return setError(result.error);
      }
      setCurrent({ ...result.data, currentEvidence: true, preparation: null });
    });
  }

  function prepare(plan: MigrationPlanInspection) {
    startTransition(async () => {
      setError(null);
      const result = await applyApprovedGrowthPartnerMigrationPlanAction(orgId, plan.id, plan.digest);
      if (!result.ok) return setError(result.error);
      setCurrent({ ...plan, preparation: result.data });
    });
  }

  return (
    <section aria-labelledby="migration-plan-stage" className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="migration-plan-stage" className="text-sm font-semibold text-ink">Plan for workspace owner review</h3>
        {current && <Badge tone={current.status === "approved" ? "success" : "neutral"}>{PLAN_STATUS[current.status]}</Badge>}
      </div>
      <p className="text-sm text-muted">The plan records a Business Brain version, reviewed knowledge references and proposed schedule mappings. Staging sends the plan to the workspace’s Growth Partner page for owner review. Approved preparation applies the reviewed Brain and saves disabled replacements for a future cutover.</p>
      <Button variant="secondary" disabled={pending} onClick={refresh}>Preview migration plan</Button>
      {error && <p role="alert" className="text-sm text-danger-ink">{error}</p>}
      {current?.status === "approved" && current.currentEvidence && !prepared && (
        <Button disabled={pending} onClick={() => prepare(current)}>Apply approved preparation</Button>
      )}
      {prepared && current?.preparation && (
        <p role="status" className="text-sm text-muted">
          Business Brain version {current.preparation.brainVersion} applied. Prepared {current.preparation.replacementScheduleCount} disabled schedule replacements.
          {current.currentEvidence ? " Runtime and schedule cutover still require approval." : " Workspace data changed. Ask the owner to withdraw this preparation before staging a replacement."}
        </p>
      )}
      {!prepared && preview?.status === "blocked" && (
        <ul className="list-disc space-y-1 pl-4 text-sm text-warning-ink">
          {preview.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
        </ul>
      )}
      {!prepared && preview?.status === "ready" && (
        <div className="space-y-3">
          <MigrationPlanManifestView manifest={preview.manifest} />
          {alreadyStaged ? <p role="status" className="text-sm text-muted">This exact plan is already staged.</p> : (
            <>
              {active && <p className="text-sm text-warning-ink">Replacing the staged plan archives its previous decision and asks the owner to review the new version.</p>}
              <Button variant="secondary" disabled={pending} onClick={() => stage(preview.digest)}>
                {active ? "Replace plan for owner review" : "Stage plan for owner review"}
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
