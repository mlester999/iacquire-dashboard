import "server-only";
import { claimSetupEvidenceReconcile, finishSetupEvidenceReconcile } from "@/server/ops/jobs";
import { backfillSetupInstances } from "@/server/setup/core";
import { reconcileAllSetupInstances } from "@/server/setup/automation";

export interface SetupMaintenanceResult {
  /** False when another runner held the fleet-wide lease, so this caller did no database work. */
  ran: boolean;
  created: number;
  updated: number;
}

/**
 * The one implementation of Setup Center maintenance, shared by the server boot and the scheduled
 * `setupEvidence` job so both obey the same fleet-wide lease.
 *
 * It is safe to abandon at any point: both passes are idempotent and only read recorded evidence
 * (no provider is contacted), so a skipped or interrupted run is simply retried by the next boot or
 * tick. The lease is what stops a deployment that starts many serverless functions from running the
 * same walk once per function and consuming the connection pool the first user requests need.
 */
export async function runSetupMaintenance(): Promise<SetupMaintenanceResult> {
  if (!(await claimSetupEvidenceReconcile())) return { ran: false, created: 0, updated: 0 };
  try {
    const created = (await backfillSetupInstances()).length;
    const updated = await reconcileAllSetupInstances();
    await finishSetupEvidenceReconcile(true);
    return { ran: true, created, updated };
  } catch (error) {
    await finishSetupEvidenceReconcile(false, error);
    throw error;
  }
}
