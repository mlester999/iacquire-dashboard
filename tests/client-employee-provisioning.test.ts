import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { withSystem } from "@/server/db";
import { getProvisioningBundle, requestProvisioning, updateProvisioningJob } from "@/server/workforce/provisioning";
import { suggestedProfileName } from "@/server/workforce/service";
import { addMember, createOrg, createUser } from "./support/fixtures";
import { clearSetupPayment } from "./support/billing";

async function eligibleClient() {
  const org = await createOrg();
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  // Everything else a job needs; the setup payment condition has its own tests (tests/payment-gate.test.ts).
  await clearSetupPayment(org.id);
  await withSystem((db) => db.query("update organizations set onboarding_completed_at = now() where id = $1", [org.id]));
  return { org, owner };
}

describe("eligible client employee provisioning queue", () => {
  it("keeps long tenant slugs and role identities distinct, with an exact host SOUL digest", async () => {
    const common = "very-long-client-name-".repeat(4);
    const first = suggestedProfileName(`${common}alpha`, "lead_hunter");
    const second = suggestedProfileName(`${common}bravo`, "lead_hunter");
    const otherRole = suggestedProfileName(`${common}alpha`, "performance_analyst");
    expect(new Set([first, second, otherRole]).size).toBe(3);
    for (const name of [first, second, otherRole]) expect(name).toMatch(/^[a-z0-9][a-z0-9_-]{1,62}$/);
    const { org } = await eligibleClient();
    const agents = await withSystem((db) => db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = 'lead_hunter'", [org.id]));
    const bundle = await getProvisioningBundle(agents.rows[0].id);
    expect(bundle.soulSha256).toBe(createHash("sha256").update(bundle.soul, "utf8").digest("hex"));
    expect(bundle.steps[0].command).toContain("--no-alias --no-skills");
    expect(bundle.steps.some((step) => step.command?.startsWith("sha256sum "))).toBe(true);
  });

  it("creates one open job for each of six isolated employee records and deduplicates retries", async () => {
    const { org, owner } = await eligibleClient();
    const first = await withSystem((db) => requestProvisioning(db, org.id, owner.id));
    const second = await withSystem((db) => requestProvisioning(db, org.id, owner.id));
    expect(first).toBe(6);
    expect(second).toBe(0);
    const { rows } = await withSystem((db) => db.query<{ role_key: string; status: string; hermes_profile: string | null }>(
      "select a.role_key, a.status, a.hermes_profile from agent_instances a where a.org_id = $1 order by role_key", [org.id],
    ));
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.status !== "online" && row.hermes_profile === null)).toBe(true);
    const jobs = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from agent_provisioning_jobs where org_id = $1", [org.id]));
    expect(jobs.rows[0].n).toBe(6);
  });

  it("does not queue costly profiles for demos, unverified owners or unfinished onboarding", async () => {
    const demo = await eligibleClient();
    await withSystem((db) => db.query("update organizations set is_demo = true where id = $1", [demo.org.id]));
    expect(await withSystem((db) => requestProvisioning(db, demo.org.id, demo.owner.id))).toBe(0);
    const unverified = await eligibleClient();
    await withSystem((db) => db.query("update users set email_verified_at = null where id = $1", [unverified.owner.id]));
    expect(await withSystem((db) => requestProvisioning(db, unverified.org.id, unverified.owner.id))).toBe(0);
    const unfinished = await eligibleClient();
    await withSystem((db) => db.query("update organizations set onboarding_completed_at = null where id = $1", [unfinished.org.id]));
    expect(await withSystem((db) => requestProvisioning(db, unfinished.org.id, unfinished.owner.id))).toBe(0);
  });

  it("records bounded attempts and refuses wrong-tenant mutations", async () => {
    const { org, owner } = await eligibleClient();
    const other = await eligibleClient();
    const admin = await createUser({ platformRole: "agency_super_admin" });
    await withSystem((db) => requestProvisioning(db, org.id, owner.id));
    const { rows } = await withSystem((db) => db.query<{ id: string }>("select id from agent_provisioning_jobs where org_id = $1 order by id limit 1", [org.id]));
    const jobId = rows[0].id;
    await expect(updateProvisioningJob(owner.id, org.id, jobId, "in_progress")).rejects.toThrow(/agency workforce/i);
    await expect(updateProvisioningJob(admin.id, other.org.id, jobId, "in_progress")).rejects.toThrow(/not found/i);
    await updateProvisioningJob(admin.id, org.id, jobId, "in_progress");
    await expect(updateProvisioningJob(admin.id, org.id, jobId, "in_progress")).rejects.toThrow(/already in progress/i);
    await updateProvisioningJob(admin.id, org.id, jobId, "failed", "Host tool check did not pass.");
    await expect(updateProvisioningJob(admin.id, org.id, jobId, "in_progress")).rejects.toThrow(/retry time/i);
    const state = await withSystem((db) => db.query<{ status: string; attempt_count: number; next_retry_at: Date }>("select status, attempt_count, next_retry_at from agent_provisioning_jobs where id = $1", [jobId]));
    expect(state.rows[0]).toMatchObject({ status: "failed", attempt_count: 1 });
    expect(state.rows[0].next_retry_at).toBeTruthy();
    expect(await withSystem((db) => requestProvisioning(db, org.id, owner.id))).toBe(0);
  });
});
