import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emptyBusinessBrain } from "@/lib/ai-growth-partner";
import { decideMigrationPlan, prepareApprovedMigrationPlan, previewMigrationPlan, readOwnerMigrationPlan, stageMigrationPlan } from "@/server/admin/growth-partner-migration-plan";
import { prepareGrowthPartnerMigrationCandidate } from "@/server/admin/growth-partner-migration";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { resolveActorAgent } from "@/server/workforce/partner-runtime";
import { agentId, addMember, createUser, ctxFor } from "./support/fixtures";
import { createLegacySixRoleTenant } from "./support/growth-partner-tenant";

const DOWN_PLAN = readFileSync("supabase/rollbacks/0142_growth_partner_migration_plans.down.sql", "utf8");
const DOWN_PREPARATION = readFileSync("supabase/rollbacks/0144_growth_partner_migration_preparations.down.sql", "utf8");
class RehearsalEnd extends Error {}

async function rollback(db: Queryable, sql: string) {
  const [lock, afterLock] = sql.split(/^do \$\$/m);
  const [guard, drop] = afterLock.split("end $$;");
  await db.query(lock);
  await db.query(`do $$${guard}end $$;`);
  await db.query(drop);
}

async function fixture() {
  const { org, ownerCtx } = await createLegacySixRoleTenant({ name: "Migration plan synthetic workspace" });
  const operator = await createUser({ platformRole: "agency_super_admin" });
  const candidate = await prepareGrowthPartnerMigrationCandidate(org.id, operator.id);
  const leadHunter = await agentId(org.id, "lead_hunter");
  const brain = emptyBusinessBrain();
  brain.sections.businessIdentity.companyName = { value: "PRIVATE_BRAIN_FACT", state: "client_confirmed", provenance: [], updatedAt: null, clientOverride: false };
  const rows = await withSystem(async (db) => {
    const brainVersion = (await db.query<{ id: string }>(
      `insert into ai_growth_partner_versions (org_id, partner_id, version, source, business_brain)
       values ($1, $2, 1, 'migration', $3::jsonb) returning id`,
      [org.id, candidate.id, JSON.stringify(brain)],
    )).rows[0];
    const schedule = (await db.query<{ id: string }>(
      `insert into ai_work_schedules (org_id, agent_instance_id, capability, enabled, next_run_at, payload, recurrence_rule)
       values ($1, $2, 'lead_generation_review', true, now() + interval '1 day', '{"prompt":"PRIVATE_SCHEDULE_ASSIGNMENT"}',
         '{"kind":"weekly","localTime":"08:30","weekdays":["mon","wed"]}') returning id`,
      [org.id, leadHunter],
    )).rows[0];
    await db.query(
      `insert into ai_work_schedules (org_id, agent_instance_id, capability, enabled, next_run_at)
       values ($1, $2, 'lead_research', true, now() + interval '1 day')`, [org.id, leadHunter],
    );
    await db.query(
      `insert into company_knowledge (org_id, section, content, version) values ($1, 'brand_voice', 'PRIVATE_COMPANY_FACT', 3)`,
      [org.id],
    );
    const source = (await db.query<{ id: string }>(
      `insert into ai_growth_partner_legacy_knowledge (org_id, partner_id, source_type, source_record_id,
           source_version, source_role_key, title, content, status, reviewed_by, reviewed_at)
       values ($1, $2, 'employee_note', gen_random_uuid(), '1', 'lead_hunter', 'PRIVATE_TITLE',
           'PRIVATE_SOURCE_CONTENT', 'approved', $3, now()) returning id`,
      [org.id, candidate.id, ownerCtx.user.id],
    )).rows[0];
    return { brainId: brainVersion.id, scheduleId: schedule.id, sourceId: source.id };
  });
  return { org, ownerCtx, operator, candidate, leadHunter, ...rows };
}

async function ready(fixt: Awaited<ReturnType<typeof fixture>>) {
  const { proposal } = await previewMigrationPlan(fixt.org.id, fixt.operator.id);
  if (proposal.status !== "ready") throw new Error(JSON.stringify(proposal.blockers));
  return proposal;
}

const snapshot = (orgId: string) => withSystem(async (db) => ({
  profiles: (await db.query("select * from agent_instances where org_id = $1 order by id", [orgId])).rows,
  schedules: (await db.query("select * from ai_work_schedules where org_id = $1 order by id", [orgId])).rows,
  partner: (await db.query("select * from ai_growth_partners where org_id = $1", [orgId])).rows,
  versions: (await db.query("select * from ai_growth_partner_versions where org_id = $1 order by version", [orgId])).rows,
  history: (await db.query("select * from chat_conversations where org_id = $1 order by id", [orgId])).rows,
  queue: (await db.query("select * from ai_work_jobs where org_id = $1 order by id", [orgId])).rows,
  provisioning: (await db.query("select * from agent_provisioning_jobs where org_id = $1 order by id", [orgId])).rows,
}));

describe("Growth Partner migration preparation plan", () => {
  it("allows newest-first empty schema rollback and protects stored receipts", async () => {
    await expect(withSystem((db) => rollback(db, DOWN_PLAN))).rejects
      .toThrow(/cannot drop table ai_growth_partner_migration_plans because other objects depend on it/i);
    await expect(withSystem(async (db) => {
      await rollback(db, DOWN_PREPARATION);
      await rollback(db, DOWN_PLAN);
      expect((await db.query("select to_regclass('public.ai_growth_partner_migration_plans') as name")).rows).toEqual([{ name: null }]);
      throw new RehearsalEnd();
    })).rejects.toBeInstanceOf(RehearsalEnd);
    const f = await fixture();
    const preview = await ready(f);
    await stageMigrationPlan(f.org.id, f.operator.id, preview.digest);
    await expect(withSystem(async (db) => {
      await rollback(db, DOWN_PREPARATION);
      await rollback(db, DOWN_PLAN);
    })).rejects.toThrow(/Rollback refused: Growth Partner migration review history exists/);
    expect(await readOwnerMigrationPlan(f.ownerCtx)).toMatchObject({ digest: preview.digest, status: "pending_review" });
  });

  it("stages and approves the exact inert plan once, with scoped owner access and no customer content", async () => {
    const f = await fixture();
    const other = await createLegacySixRoleTenant({ name: "Outside migration owner" });
    const manager = await createUser();
    await addMember(f.org.id, manager.id, "admin");
    const before = await snapshot(f.org.id);
    const preview = await ready(f);
    expect(preview.manifest).toMatchObject({
      businessBrain: { id: f.brainId, version: 1, active: false },
      companyKnowledge: [{ section: "brand_voice", version: 3 }],
      reviewedSources: [{ id: f.sourceId, previousRole: "lead_hunter" }],
    });
    expect(preview.manifest.retainedProfiles).toHaveLength(6);
    expect(preview.manifest.schedules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: f.scheduleId, disposition: "propose_disabled_replacement", timezone: "UTC", targetCapability: "lead_generation_review" }),
      expect.objectContaining({ disposition: "retain_legacy", targetCapability: null }),
    ]));
    expect(JSON.stringify(preview)).not.toContain("PRIVATE_");

    await expect(stageMigrationPlan(f.org.id, f.ownerCtx.user.id, preview.digest)).rejects.toMatchObject({ code: "forbidden" });
    const [first, retry] = await Promise.all([
      stageMigrationPlan(f.org.id, f.operator.id, preview.digest),
      stageMigrationPlan(f.org.id, f.operator.id, preview.digest),
    ]);
    expect(retry).toEqual(first);
    expect(await readOwnerMigrationPlan(other.ownerCtx)).toBeNull();
    await expect(readOwnerMigrationPlan(ctxFor(manager, f.org, "admin"))).rejects.toMatchObject({ code: "forbidden" });
    await expect(decideMigrationPlan(other.ownerCtx, { planId: first.id, digest: first.digest, decision: "approved" })).rejects.toMatchObject({ code: "not_found" });
    await expect(withUser(f.ownerCtx.user.id, (db) => db.query("select * from ai_growth_partner_migration_plans"))).rejects.toThrow(/permission denied/i);
    await expect(decideMigrationPlan(f.ownerCtx, { planId: first.id, digest: "0".repeat(64), decision: "approved" })).rejects.toMatchObject({ code: "conflict" });

    const approved = await decideMigrationPlan(f.ownerCtx, { planId: first.id, digest: first.digest, decision: "approved" });
    expect(approved).toMatchObject({ id: first.id, status: "approved", digest: first.digest });
    expect(await decideMigrationPlan(f.ownerCtx, { planId: first.id, digest: first.digest, decision: "approved" })).toEqual(approved);
    expect(await snapshot(f.org.id)).toEqual(before);
    const receipts = await withSystem((db) => db.query(
      "select action, actor_user_id, metadata->>'planDigest' as digest from audit_logs where org_id = $1 and target_id = $2 order by id",
      [f.org.id, first.id],
    ));
    expect(receipts.rows).toEqual([
      { action: "ai_growth_partner.migration_plan_staged", actor_user_id: f.operator.id, digest: first.digest },
      { action: "ai_growth_partner.migration_plan_approved", actor_user_id: f.ownerCtx.user.id, digest: first.digest },
    ]);
  });

  it("rejects stale decisions, preserves approved receipts when replaced, and lets an owner withdraw a plan", async () => {
    const f = await fixture();
    const first = await stageMigrationPlan(f.org.id, f.operator.id, (await ready(f)).digest);
    await decideMigrationPlan(f.ownerCtx, { planId: first.id, digest: first.digest, decision: "approved" });

    // A private assignment edit leaves visible schedule metadata the same and invalidates the digest.
    await withSystem((db) => db.query("update ai_work_schedules set payload = $2::jsonb where id = $1", [f.scheduleId, JSON.stringify({ prompt: "PRIVATE_CHANGED_ASSIGNMENT" })]));
    expect(await readOwnerMigrationPlan(f.ownerCtx)).toMatchObject({ id: first.id, status: "approved", currentEvidence: false });
    await expect(stageMigrationPlan(f.org.id, f.operator.id, first.digest)).rejects.toMatchObject({ code: "conflict" });
    await expect(decideMigrationPlan(f.ownerCtx, { planId: first.id, digest: first.digest, decision: "approved" })).rejects.toMatchObject({ code: "conflict" });
    const revised = await ready(f);
    expect(revised.manifest).toEqual(first.manifest);
    expect(revised.digest).not.toBe(first.digest);
    const replacement = await stageMigrationPlan(f.org.id, f.operator.id, revised.digest);
    await expect(decideMigrationPlan(f.ownerCtx, { planId: first.id, digest: first.digest, decision: "approved" })).rejects.toMatchObject({ code: "conflict" });

    expect(await decideMigrationPlan(f.ownerCtx, { planId: replacement.id, digest: replacement.digest, decision: "approved" })).toMatchObject({ status: "approved" });
    expect(await decideMigrationPlan(f.ownerCtx, { planId: replacement.id, digest: replacement.digest, decision: "withdrawn" })).toMatchObject({ status: "withdrawn" });
    const { rows } = await withSystem((db) => db.query(
      "select id, status, owner_decision_digest, superseded_by from ai_growth_partner_migration_plans where org_id = $1",
      [f.org.id],
    ));
    expect(rows).toEqual(expect.arrayContaining([
      { id: first.id, status: "superseded", owner_decision_digest: first.digest, superseded_by: replacement.id },
      { id: replacement.id, status: "withdrawn", owner_decision_digest: replacement.digest, superseded_by: null },
    ]));
    expect((await readOwnerMigrationPlan(f.ownerCtx))?.id).toBe(replacement.id);
    const nextReview = await stageMigrationPlan(f.org.id, f.operator.id, revised.digest);
    expect(nextReview.id).not.toBe(replacement.id);
    expect(await decideMigrationPlan(f.ownerCtx, { planId: nextReview.id, digest: nextReview.digest, decision: "declined" })).toMatchObject({ status: "declined" });
    await expect(decideMigrationPlan(f.ownerCtx, { planId: nextReview.id, digest: nextReview.digest, decision: "approved" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("blocks duplicate, overdue and in-flight mappings, and rechecks owner membership", async () => {
    const f = await fixture();
    const preview = await ready(f);
    const legacy = await agentId(f.org.id, "crm_manager");
    await withSystem(async (db) => {
      await db.query("update ai_work_schedules set timezone = 'Invalid/Zone' where id = $1", [f.scheduleId]);
      await db.query(
        `insert into ai_work_schedules (org_id, agent_instance_id, capability, enabled, next_run_at)
         values ($1, $2, 'lead_generation_review', true, now() - interval '1 day')`, [f.org.id, legacy],
      );
      await db.query(
        `insert into ai_work_jobs (org_id, agent_instance_id, capability, title, idempotency_key, status)
         values ($1, $2, 'lead_generation_review', 'Fictional running job', gen_random_uuid()::text, 'running')`, [f.org.id, legacy],
      );
    });
    await expect(previewMigrationPlan(f.org.id, f.operator.id)).resolves.toMatchObject({
      proposal: { status: "blocked", blockers: expect.arrayContaining([expect.stringContaining("same Growth Partner capability"), expect.stringContaining("already due"), expect.stringContaining("invalid time zone"), expect.stringContaining("open work")]) },
      current: null,
    });
    await expect(stageMigrationPlan(f.org.id, f.operator.id, preview.digest)).rejects.toMatchObject({ code: "conflict" });
    await withSystem((db) => db.query("update organization_memberships set role = 'admin' where org_id = $1 and user_id = $2", [f.org.id, f.ownerCtx.user.id]));
    await expect(readOwnerMigrationPlan(f.ownerCtx)).rejects.toMatchObject({ code: "forbidden" });
  });
});


describe("Owner-approved Growth Partner preparation", () => {
  it("activates the exact Brain once and materializes inert, tenant-isolated schedule and runtime candidates", async () => {
    const f = await fixture();
    const other = await fixture();
    await withSystem((db) => db.query(
      `update ai_work_schedules set business_hours = '{"mon":[["08:00","17:00"]]}', timezone = 'Pacific/Auckland'
        where id = $1`, [f.scheduleId],
    ));
    const before = await snapshot(f.org.id);
    const otherBefore = await snapshot(other.org.id);
    const beforeActor = await withSystem((db) => resolveActorAgent(db, f.org.id, "sales_assistant"));
    expect(beforeActor).toMatchObject({ roleKey: "sales_assistant", viaPartner: false });
    const plan = await stageMigrationPlan(f.org.id, f.operator.id, (await ready(f)).digest);
    const input = { planId: plan.id, digest: plan.digest };
    await expect(prepareApprovedMigrationPlan(f.org.id, f.operator.id, input)).rejects.toMatchObject({ code: "conflict" });
    await decideMigrationPlan(f.ownerCtx, { ...input, decision: "approved" });
    await expect(prepareApprovedMigrationPlan(other.org.id, f.operator.id, input)).rejects.toMatchObject({ code: "not_found" });
    await expect(prepareApprovedMigrationPlan(f.org.id, f.ownerCtx.user.id, input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(prepareApprovedMigrationPlan(f.org.id, f.operator.id, { ...input, digest: "0".repeat(64) })).rejects.toMatchObject({ code: "conflict" });

    const [prepared, retry] = await Promise.all([
      prepareApprovedMigrationPlan(f.org.id, f.operator.id, input),
      prepareApprovedMigrationPlan(f.org.id, f.operator.id, input),
    ]);
    expect(retry).toEqual(prepared);
    expect(prepared).toMatchObject({ brainVersion: 1, replacementScheduleCount: 1, withdrawnAt: null });
    expect(await readOwnerMigrationPlan(f.ownerCtx)).toMatchObject({ currentEvidence: true, preparation: prepared });
    const result = await withSystem(async (db) => ({
      applications: (await db.query(
        "select candidate_runtime_id, replacement_schedules from ai_growth_partner_migration_preparations where org_id = $1 and plan_id = $2",
        [f.org.id, plan.id],
      )).rows,
      audit: (await db.query(
        `select actor_user_id from audit_logs where org_id = $1 and target_id = $2
          and action = 'ai_growth_partner.business_brain_activated'`,
        [f.org.id, f.brainId],
      )).rows,
      actor: await resolveActorAgent(db, f.org.id, "sales_assistant"),
    }));
    expect(result.applications).toEqual([{
      candidate_runtime_id: prepared.candidateRuntimeId,
      replacement_schedules: [{
        candidateScheduleId: expect.any(String), legacyScheduleId: f.scheduleId, capability: "lead_generation_review",
        cadence: "weekly", intervalMinutes: 1440, timezone: "Pacific/Auckland", enabled: false,
        recurrence: { kind: "weekly", localTime: "08:30", weekdays: ["mon", "wed"] },
        businessHours: { mon: [["08:00", "17:00"]] },
        nextRunAt: plan.manifest.schedules.find((schedule) => schedule.id === f.scheduleId)?.nextRunAt,
      }],
    }]);
    expect(result.audit).toEqual([{ actor_user_id: f.ownerCtx.user.id }]);
    expect(result.actor).toEqual(beforeActor);
    const { partner, ...unchanged } = await snapshot(f.org.id);
    const { partner: _previousPartner, ...expectedUnchanged } = before;
    expect(unchanged).toEqual(expectedUnchanged);
    expect(partner).toMatchObject([{ id: f.candidate.id, current_version: 1, runtime_agent_instance_id: null, status: "migration_required" }]);
    expect(await snapshot(other.org.id)).toEqual(otherBefore);
    await expect(withUser(f.ownerCtx.user.id, (db) => db.query("select * from ai_growth_partner_migration_preparations"))).rejects.toThrow(/permission denied/i);
    await expect(withSystem((db) => rollback(db, DOWN_PREPARATION))).rejects.toThrow(/Rollback refused: Growth Partner migration preparation history exists/);

    expect(await decideMigrationPlan(f.ownerCtx, { ...input, decision: "withdrawn" })).toMatchObject({ status: "withdrawn" });
    expect(await readOwnerMigrationPlan(f.ownerCtx)).toMatchObject({ currentEvidence: false, preparation: { ...prepared, withdrawnAt: expect.any(String) } });
    expect((await snapshot(f.org.id)).partner).toMatchObject([{ current_version: null, status: "migration_required", runtime_agent_instance_id: null }]);
    await expect(prepareApprovedMigrationPlan(f.org.id, f.operator.id, input)).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses preparation after source drift or loss of the approving owner", async () => {
    const f = await fixture();
    const plan = await stageMigrationPlan(f.org.id, f.operator.id, (await ready(f)).digest);
    const input = { planId: plan.id, digest: plan.digest };
    await decideMigrationPlan(f.ownerCtx, { ...input, decision: "approved" });
    await withSystem((db) => db.query("update ai_work_schedules set timezone = 'Pacific/Auckland' where id = $1", [f.scheduleId]));
    await expect(prepareApprovedMigrationPlan(f.org.id, f.operator.id, input)).rejects.toThrow(/workspace changed/);
    await withSystem(async (db) => {
      await db.query("update ai_work_schedules set timezone = 'UTC' where id = $1", [f.scheduleId]);
      await db.query("update organization_memberships set role = 'admin' where org_id = $1 and user_id = $2", [f.org.id, f.ownerCtx.user.id]);
    });
    await expect(prepareApprovedMigrationPlan(f.org.id, f.operator.id, input)).rejects.toThrow(/no longer an active workspace owner/);
    expect((await snapshot(f.org.id)).partner).toMatchObject([{ current_version: null, runtime_agent_instance_id: null }]);
  });

  it("keeps a newer Brain choice when an owner withdraws a stale preparation", async () => {
    const f = await fixture();
    const plan = await stageMigrationPlan(f.org.id, f.operator.id, (await ready(f)).digest);
    const input = { planId: plan.id, digest: plan.digest };
    await decideMigrationPlan(f.ownerCtx, { ...input, decision: "approved" });
    await prepareApprovedMigrationPlan(f.org.id, f.operator.id, input);
    await withSystem(async (db) => {
      await db.query(
        `insert into ai_growth_partner_versions (org_id, partner_id, version, source, business_brain)
         values ($1, $2, 2, 'client_edit', $3::jsonb)`, [f.org.id, f.candidate.id, JSON.stringify(emptyBusinessBrain())],
      );
      await db.query("update ai_growth_partners set current_version = 2 where org_id = $1", [f.org.id]);
    });
    expect(await readOwnerMigrationPlan(f.ownerCtx)).toMatchObject({ currentEvidence: false });
    await expect(prepareApprovedMigrationPlan(f.org.id, f.operator.id, input)).rejects.toMatchObject({ code: "conflict" });
    await expect(stageMigrationPlan(f.org.id, f.operator.id, (await ready(f)).digest)).rejects.toThrow(/must withdraw/);
    await decideMigrationPlan(f.ownerCtx, { ...input, decision: "withdrawn" });
    expect((await snapshot(f.org.id)).partner).toMatchObject([{ current_version: 2, runtime_agent_instance_id: null }]);
  });
});
