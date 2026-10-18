import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { queuePreparation, executePreparation, getPreparationJobs, queueOnboardingPreparations, retirePreparation } from "@/server/setup/jobs";
import { ensureInstanceStandalone, getSetupRevision } from "@/server/setup/core";
import { getAgencySetupSnapshot } from "@/server/setup/snapshots";
import { activateSetup, markReadyForReview, setServices, updateTaskStatus } from "@/server/setup/agency";
import { runChecks } from "@/server/setup/automation";
import { createOrg, createUser, agencyUser, addMember } from "./support/fixtures";

async function fixture(onboarded = true) {
  const org = await createOrg();
  const user = await createUser({ platformRole: "agency_super_admin" });
  const admin = agencyUser(user, "agency_super_admin");
  await ensureInstanceStandalone(org.id);
  if (onboarded) await withSystem(async (db) => {
    await db.query("update organizations set onboarding_completed_at = now() where id = $1", [org.id]);
    await db.query("insert into onboarding_responses (org_id, completed_at) values ($1, now())", [org.id]);
  });
  return { org, admin };
}
describe("resumable preparation (local database; external services unavailable)", () => {
  it("deduplicates onboarding jobs and repeated requests, preserving six configuration drafts", async () => {
    const { org, admin } = await fixture();
    await withSystem((db) => queueOnboardingPreparations(db, org.id, admin.id));
    await withSystem((db) => queueOnboardingPreparations(db, org.id, admin.id));
    // A new client's CRM is iAcquire's own (native), so there is no GoHighLevel sub-account to map: three onboarding jobs, not four.
    const nativeJobs = (await getPreparationJobs(admin, org.id)).jobs;
    expect(nativeJobs.map((j) => j.operation).sort()).toEqual(["manual_hermes_profiles", "prepare_ai_configuration", "prepare_automation_configuration"]);
    // A GoHighLevel client still gets the manual mapping job, once.
    const ghl = await fixture();
    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [ghl.org.id]));
    await withSystem((db) => queueOnboardingPreparations(db, ghl.org.id, ghl.admin.id));
    await withSystem((db) => queueOnboardingPreparations(db, ghl.org.id, ghl.admin.id));
    expect((await getPreparationJobs(ghl.admin, ghl.org.id)).jobs.map((j) => j.operation).sort()).toEqual(["manual_ghl_mapping", "manual_hermes_profiles", "prepare_ai_configuration", "prepare_automation_configuration"]);
    const input = { operation: "prepare_ai_configuration" as const, idempotencyKey: "test:same:configuration" };
    const id = await queuePreparation(admin, org.id, input);
    expect(await queuePreparation(admin, org.id, input)).toBe(id);
    expect(await executePreparation(admin, org.id, id)).toMatchObject({ status: "succeeded" });
    expect(await executePreparation(admin, org.id, id)).toMatchObject({ repeated: true });
    const drafts = await withSystem((db) => db.query<{ status: string }>("select status from agent_config_versions where org_id = $1", [org.id]));
    expect(drafts.rows).toHaveLength(6);
    expect(drafts.rows.every((r) => r.status === "draft")).toBe(true);
    const result = await getPreparationJobs(admin, org.id);
    expect(result.attempts.filter((a) => a.job_id === id)).toMatchObject([{ attempt_number: 1, status: "succeeded" }]);
  });
  it("rejects unassigned staff, stale role claims, client calls and cross-tenant job identifiers", async () => {
    const { org, admin } = await fixture();
    const other = await fixture();
    const staff = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
    await expect(queuePreparation(staff, org.id, { operation: "manual_ghl_mapping", idempotencyKey: "test:forbidden" })).rejects.toThrow();
    const client = await createUser();
    const forged = agencyUser(client, "agency_super_admin");
    await expect(getPreparationJobs(forged, org.id)).rejects.toThrow(/Agency access/);
    const id = await queuePreparation(admin, org.id, { operation: "manual_ghl_mapping", idempotencyKey: "test:ownership" });
    await expect(executePreparation(other.admin, other.org.id, id)).rejects.toThrow(/not found/);
    await withSystem((db) => db.query("update users set status = 'disabled' where id = $1", [admin.id]));
    await expect(executePreparation(admin, org.id, id)).rejects.toThrow(/Agency access/);
  });
  it("records failures, applies retry backoff, and resumes after onboarding without duplicate drafts", async () => {
    const { org, admin } = await fixture(false);
    const id = await queuePreparation(admin, org.id, { operation: "prepare_ai_configuration", idempotencyKey: "test:retry:config" });
    expect(await executePreparation(admin, org.id, id)).toMatchObject({ status: "failed" });
    await expect(executePreparation(admin, org.id, id)).rejects.toThrow(/retry time/);
    await withSystem(async (db) => {
      await db.query("update organizations set onboarding_completed_at = now() where id = $1", [org.id]);
      await db.query("update provisioning_jobs set next_retry_at = now() - interval '1 second' where id = $1", [id]);
    });
    expect(await executePreparation(admin, org.id, id)).toMatchObject({ status: "succeeded" });
    const { jobs, attempts } = await getPreparationJobs(admin, org.id);
    expect(jobs[0]).toMatchObject({ status: "succeeded", attempt_count: 2, last_error: null });
    expect(attempts.filter((a) => a.job_id === id).map((a) => a.status).sort()).toEqual(["failed", "succeeded"]);
  });
  it("recovers an expired lease while refusing a concurrent live worker", async () => {
    const { org, admin } = await fixture();
    const id = await queuePreparation(admin, org.id, { operation: "prepare_automation_configuration", idempotencyKey: "test:lease:automation" });
    await withSystem(async (db) => {
      await db.query("update provisioning_jobs set status = 'running', attempt_count = 1, lease_token = gen_random_uuid(), lease_expires_at = now() + interval '5 minutes' where id = $1", [id]);
      await db.query("insert into provisioning_job_attempts (org_id, job_id, attempt_number, status) values ($1, $2, 1, 'running')", [org.id, id]);
    });
    await expect(executePreparation(admin, org.id, id)).rejects.toThrow(/already running/);
    await withSystem((db) => db.query("update provisioning_jobs set lease_expires_at = now() - interval '1 second' where id = $1", [id]));
    await executePreparation(admin, org.id, id);
    const result = await getPreparationJobs(admin, org.id);
    expect(result.attempts.map((a) => a.status).sort()).toEqual(["interrupted", "succeeded"]);
    expect(result.jobs[0].prepared_configuration).toMatchObject({ outreachEnabled: false, workflowActivation: false, crmWritePermissions: [] });
  });
  it("preserves unsupported remote operations as actionable agency tasks", async () => {
    const { org, admin } = await fixture();
    for (const operation of ["manual_ghl_mapping", "manual_hermes_profiles"] as const) {
      const id = await queuePreparation(admin, org.id, { operation, idempotencyKey: `test:manual:${operation}` });
      expect(await executePreparation(admin, org.id, id)).toMatchObject({ status: "awaiting_admin" });
    }
    const jobs = (await getPreparationJobs(admin, org.id)).jobs;
    expect(jobs.every((j) => Boolean(j.last_error))).toBe(true);
    expect(jobs.find((j) => j.operation === "manual_hermes_profiles")!.prepared_configuration).toMatchObject({ remoteCreationSupported: false });
    const profiles = await withSystem((db) => db.query("select 1 from agent_instances where org_id = $1 and hermes_profile is not null", [org.id]));
    expect(profiles.rows).toHaveLength(0);
  });
  it("persists an expired final lease as failed with interrupted history even when no retry remains", async () => {
    const { org, admin } = await fixture();
    const id = await queuePreparation(admin, org.id, { operation: "prepare_automation_configuration", idempotencyKey: "test:exhausted:lease" });
    await withSystem(async (db) => {
      await db.query("update provisioning_jobs set status='running', attempt_count=3, lease_token=gen_random_uuid(), lease_expires_at=now()-interval '1 second' where id=$1", [id]);
      await db.query("insert into provisioning_job_attempts (org_id,job_id,attempt_number,status) values ($1,$2,3,'running')", [org.id,id]);
    });
    const revision = (await getSetupRevision(org.id))!;
    await expect(executePreparation(admin, org.id, id)).rejects.toThrow(/Retry limit/);
    const result = await getPreparationJobs(admin, org.id);
    expect(result.jobs.find((j) => j.id === id)).toMatchObject({ status:"failed",attempt_count:3,lease_expires_at:null });
    expect(result.attempts.find((a) => a.job_id === id)).toMatchObject({ status:"interrupted" });
    expect((await getSetupRevision(org.id))!).toBeGreaterThan(revision);
    expect((await getAgencySetupSnapshot(admin,org.id)).readiness.blockers.some((b) => b.code === "job_needs_attention")).toBe(true);
  });
  it("retires explicitly with preserved failures, scoped successful supersession and unchanged required checks", async () => {
    const { org, admin } = await fixture(false);
    const id = await queuePreparation(admin, org.id, { operation:"prepare_automation_configuration",idempotencyKey:"test:retire:failed" });
    await executePreparation(admin,org.id,id);
    const checksBefore = await withSystem((db) => db.query("select check_key,status from client_setup_checks where org_id=$1 order by check_key",[org.id]));
    await expect(retirePreparation(admin,org.id,id,{reason:"short"})).rejects.toThrow();
    const other = await fixture();
    const otherId = await queuePreparation(other.admin,other.org.id,{operation:"prepare_automation_configuration",idempotencyKey:"test:retire:other"});
    await executePreparation(other.admin,other.org.id,otherId);
    await expect(retirePreparation(admin,org.id,id,{reason:"Replacing failed configuration preparation.",supersededBy:otherId})).rejects.toThrow(/same client/);
    await withSystem((db) => db.query("update organizations set onboarding_completed_at=now() where id=$1",[org.id]));
    const replacement = await queuePreparation(admin,org.id,{operation:"prepare_automation_configuration",idempotencyKey:"test:retire:replacement"});
    await executePreparation(admin,org.id,replacement);
    const wrongOperation = await queuePreparation(admin,org.id,{operation:"prepare_ai_configuration",idempotencyKey:"test:retire:wrongoperation"});
    await executePreparation(admin,org.id,wrongOperation);
    await expect(retirePreparation(admin,org.id,id,{reason:"Replacing failed configuration preparation.",supersededBy:wrongOperation})).rejects.toThrow(/same client/);
    expect(await retirePreparation(admin,org.id,id,{reason:"Superseded by the reviewed configuration preparation.",supersededBy:replacement})).toMatchObject({repeated:false});
    expect(await retirePreparation(admin,org.id,id,{reason:"Same retirement submitted again.",supersededBy:replacement})).toMatchObject({repeated:true});
    expect(await executePreparation(admin,org.id,id)).toMatchObject({repeated:true});
    const result = await getPreparationJobs(admin,org.id);
    expect(result.jobs.find((j) => j.id===id)).toMatchObject({status:"cancelled",attempt_count:1});
    expect(result.attempts.find((a) => a.job_id===id)).toMatchObject({status:"failed"});
    expect(result.retirements.filter((r) => r.target_id===id)).toMatchObject([{metadata:{reason:"Superseded by the reviewed configuration preparation.",supersededBy:replacement}}]);
    const checksAfter = await withSystem((db) => db.query("select check_key,status from client_setup_checks where org_id=$1 order by check_key",[org.id]));
    expect(checksAfter.rows).toEqual(checksBefore.rows);
    expect((await getAgencySetupSnapshot(admin,org.id)).readiness.canActivate).toBe(false);
  });
  it("refuses retirement by unauthorized staff and during a live worker lease", async () => {
    const {org,admin}=await fixture();
    const id=await queuePreparation(admin,org.id,{operation:"manual_ghl_mapping",idempotencyKey:"test:retire:live"});
    const staff=agencyUser(await createUser({platformRole:"agency_staff"}),"agency_staff");
    await expect(retirePreparation(staff,org.id,id,{reason:"Cancelling unused manual mapping."})).rejects.toThrow();
    await withSystem(async db=>{
      await db.query("update provisioning_jobs set status='running',attempt_count=1,lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes' where id=$1",[id]);
      await db.query("insert into provisioning_job_attempts (org_id,job_id,attempt_number,status) values ($1,$2,1,'running')",[org.id,id]);
    });
    await expect(retirePreparation(admin,org.id,id,{reason:"Cancelling unused manual mapping."})).rejects.toThrow(/live worker/);
    await withSystem(db=>db.query("update provisioning_jobs set lease_expires_at=now()-interval '1 second' where id=$1",[id]));
    await retirePreparation(admin,org.id,id,{reason:"Expired operation no longer belongs to the package."});
    const result=await getPreparationJobs(admin,org.id);
    expect(result.attempts[0].status).toBe("interrupted");
    expect(result.jobs[0].status).toBe("cancelled");
  });
  it("fails unavailable verification visibly and isolates internal job details under RLS", async () => {
    const { org, admin } = await fixture();
    const id = await queuePreparation(admin, org.id, { operation: "verify_integrations", idempotencyKey: "test:verify:unavailable" });
    expect(await executePreparation(admin, org.id, id)).toMatchObject({ status: "failed" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    expect((await withUser(owner.id, (db) => db.query("select * from provisioning_jobs"))).rows).toHaveLength(0);
    await expect(withUser(owner.id, (db) => db.query("update provisioning_jobs set status = 'succeeded' where id = $1", [id]))).rejects.toThrow(/permission denied/);
  });
});

describe("persisted portal activation review", () => {
  it("records verified agency approval and rejects edits to review history", async () => {
    const { org, admin } = await fixture();
    await setServices(admin, org.id, []);
    await runChecks(org.id, { actorUserId: admin.id, live: false, force: true });
    await markReadyForReview(admin, org.id);
    await activateSetup(admin, org.id, { note: "Onboarding-only package reviewed; no external activation authorized." });
    const review = await withSystem((db) => db.query<{ id: string; decision: string; external_activation_authorized: boolean }>("select id, decision, external_activation_authorized from activation_reviews where org_id = $1", [org.id]));
    expect(review.rows).toMatchObject([{ decision: "approved", external_activation_authorized: false }]);
    await expect(withSystem((db) => db.query("update activation_reviews set note = 'changed' where id = $1", [review.rows[0].id]))).rejects.toThrow(/append-only/);
  });
  it("persists a denied review when a failed preparation job blocks otherwise verified readiness", async () => {
    const { org, admin } = await fixture();
    await setServices(admin, org.id, []);
    await runChecks(org.id, { actorUserId: admin.id, live: false, force: true });
    await markReadyForReview(admin, org.id);
    const id = await queuePreparation(admin, org.id, { operation: "verify_integrations", idempotencyKey: "test:activation:block" });
    await withSystem((db) => db.query("update provisioning_jobs set status = 'failed', last_error = 'Provider unavailable' where id = $1", [id]));
    expect((await getAgencySetupSnapshot(admin,org.id)).canActivate).toBe(false);
    await expect(activateSetup(admin, org.id)).rejects.toThrow(/jobs still need attention/);
    const review = await withSystem((db) => db.query("select decision from activation_reviews where org_id = $1", [org.id]));
    expect(review.rows).toMatchObject([{ decision: "blocked" }]);
    await withSystem((db) => db.query("update provisioning_jobs set status = 'cancelled' where id = $1", [id]));
    // A new setup task invalidates final review through the existing mutation service.
    const task = await withSystem((db) => db.query<{ id: string }>("select id from client_setup_tasks where org_id = $1 and template_key = 'company_info'", [org.id]));
    await updateTaskStatus(admin, org.id, task.rows[0].id, { status: "in_progress", reason: "Company information changed" });
    await expect(activateSetup(admin, org.id)).rejects.toThrow(/final review/);
  });
});
