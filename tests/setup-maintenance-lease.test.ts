import { beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { JOBS } from "@/server/ops/tick";
import { SETUP_EVIDENCE_LEASE, claimSetupEvidenceReconcile, finishSetupEvidenceReconcile } from "@/server/ops/jobs";
import { runSetupMaintenance } from "@/server/setup/startup";
import { createOrg } from "./support/fixtures";

const resetLease = () => withSystem((db) => db.query("delete from worker_job_runs where job_name = $1", [SETUP_EVIDENCE_LEASE]));
const ageLease = (set: string) =>
  withSystem((db) => db.query(`update worker_job_runs set ${set} where job_name = $1`, [SETUP_EVIDENCE_LEASE]));
const checklists = (orgId: string) =>
  withSystem((db) => db.query("select 1 from client_setup_instances where org_id = $1", [orgId])).then((r) => r.rows.length);
const setupEvidenceJob = () => JOBS.find((job) => job.name === "setupEvidence")!;

/**
 * Setup-checklist backfill and evidence reconciliation are expensive (about two transactions per
 * unfinished workspace) and idempotent. Every serverless function boots its own instrumentation, so
 * the lease is what stops a deployment from running the same walk once per cold function while user
 * requests are waiting for a pooled connection.
 */
describe("setup maintenance runs once per fleet, not once per server instance", () => {
  beforeEach(resetLease);

  it("lets exactly one runner claim the walk", async () => {
    expect(await claimSetupEvidenceReconcile()).toBe(true);
    expect(await claimSetupEvidenceReconcile()).toBe(false);
    await finishSetupEvidenceReconcile(true);
  });

  it("counts the fifteen-minute interval from the last success", async () => {
    expect(await claimSetupEvidenceReconcile()).toBe(true);
    await finishSetupEvidenceReconcile(true);
    expect(await claimSetupEvidenceReconcile()).toBe(false);
    await ageLease("last_success_at = now() - interval '16 minutes', last_finished_at = now() - interval '16 minutes'");
    expect(await claimSetupEvidenceReconcile()).toBe(true);
    await finishSetupEvidenceReconcile(true);
  });

  it("does not retry a failed run until the overlap window has passed", async () => {
    expect(await claimSetupEvidenceReconcile()).toBe(true);
    await finishSetupEvidenceReconcile(false, new Error("connection terminated unexpectedly"));
    expect(await claimSetupEvidenceReconcile()).toBe(false);
    await ageLease("last_finished_at = now() - interval '31 seconds'");
    expect(await claimSetupEvidenceReconcile()).toBe(true);
    const row = (
      await withSystem((db) => db.query<{ consecutive_failures: number; last_error: string | null }>(
        "select consecutive_failures, last_error from worker_job_runs where job_name = $1",
        [SETUP_EVIDENCE_LEASE],
      ))
    ).rows[0];
    expect(row.consecutive_failures).toBe(1);
    expect(row.last_error).toMatch(/^Error: connection terminated unexpectedly$/);
    await finishSetupEvidenceReconcile(true);
  });

  it("reclaims a runner that crashed without releasing the lease", async () => {
    expect(await claimSetupEvidenceReconcile()).toBe(true);
    // Five minutes of no heartbeat is a dead runner, exactly like the scheduler tick lease.
    await ageLease("last_started_at = now() - interval '5 minutes 1 second'");
    expect(await claimSetupEvidenceReconcile()).toBe(true);
    await finishSetupEvidenceReconcile(true);
  });

  it("replaces the per-instance boot walk instead of removing it", async () => {
    const org = await createOrg({ name: "Lease Co" });
    const first = await runSetupMaintenance();
    expect(first.ran).toBe(true);
    expect(first.created).toBeGreaterThanOrEqual(1);
    expect(await checklists(org.id)).toBe(1);

    // A second instance booting during the same deployment finds the checklist and is told to stand down.
    const second = await runSetupMaintenance();
    expect(second).toEqual({ ran: false, created: 0, updated: 0 });
  });

  it("makes the scheduled job obey the same lease as the boot path", async () => {
    const first = await createOrg({ name: "Scheduled Lease Co" });
    expect(await setupEvidenceJob().run()).toBeGreaterThanOrEqual(1);
    expect(await checklists(first.id)).toBe(1);

    // A workspace that appears while the lease is held waits for the next window instead of being
    // reconciled by every overlapping tick.
    const second = await createOrg({ name: "Second Scheduled Lease Co" });
    expect(await setupEvidenceJob().run()).toBe(0);
    expect(await checklists(second.id)).toBe(0);

    // Once the window has passed the job runs again, and the walk stays idempotent.
    await ageLease("last_success_at = now() - interval '16 minutes', last_finished_at = now() - interval '16 minutes'");
    expect(await setupEvidenceJob().run()).toBeGreaterThanOrEqual(1);
    expect(await checklists(second.id)).toBe(1);
    expect(await checklists(first.id)).toBe(1);
  });

  it("retries an interrupted boot walk on the next instance while the scheduler is disabled", async () => {
    const org = await createOrg({ name: "Interrupted Walk Co" });
    // A boot that the platform freezes mid-walk claims the lease and never releases it.
    expect(await claimSetupEvidenceReconcile()).toBe(true);
    expect(await checklists(org.id)).toBe(0);

    // The scheduler is off in production, so the retry path is the next cold instance. It is refused
    // while the previous runner is inside the crash window and costs nothing when it is refused.
    expect(await runSetupMaintenance()).toEqual({ ran: false, created: 0, updated: 0 });
    expect(await checklists(org.id)).toBe(0);

    // After five minutes the abandoned lease is reclaimed and the walk completes on that boot.
    await ageLease("last_started_at = now() - interval '5 minutes 1 second'");
    const retried = await runSetupMaintenance();
    expect(retried.ran).toBe(true);
    expect(retried.created).toBeGreaterThanOrEqual(1);
    expect(await checklists(org.id)).toBe(1);
  });
});
