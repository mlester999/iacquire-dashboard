import { describe, expect, it } from "vitest";
import { AI_GROWTH_PARTNER_ROLE_KEY } from "@/lib/agents";
import { getGrowthPartnerAbilityControls, requestGrowthPartnerAbilityRestoration, restrictGrowthPartnerAbilities } from "@/server/ai-growth-partner/ability-controls";
import { withSystem } from "@/server/db";
import { outboundMessagingEnabled } from "@/server/messaging/transports/policy";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { defaultSettings } from "@/server/workforce/compiler";
import { requestProvisioning } from "@/server/workforce/provisioning";
import { createConfigVersion, decideHeldVersion, ensureGrowthPartnerRuntime } from "@/server/workforce/service";
import { runWorkJob } from "@/server/workforce/work-runner";
import { clearSetupPayment, provisioningJobs, setupStatus } from "./support/billing";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

async function setup(cleared = true) {
  const org = await createOrg();
  const owner = await createUser();
  const admin = await createUser();
  const member = await createUser();
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, admin.id, "admin");
  await addMember(org.id, member.id, "member");
  if (cleared) await clearSetupPayment(org.id);

  const settings = {
    ...defaultSettings(AI_GROWTH_PARTNER_ROLE_KEY),
    tone: "professional" as const,
    disabledTools: ["crm.contacts.create", "appointments.request_change"],
  };
  const { agentId, versionId } = await withSystem(async (db) => {
    const agentId = await ensureGrowthPartnerRuntime(org.id, db);
    const version = await createConfigVersion(db, {
      orgId: org.id, agentId, settings, source: "onboarding", userId: owner.id, apply: true,
    });
    if (cleared) await db.query("update agent_instances set status = 'online' where org_id = $1 and id = $2", [org.id, agentId]);
    return { agentId, versionId: version.versionId };
  });
  return {
    org, admin, settings, agentId, versionId,
    ownerCtx: ctxFor(owner, org, "owner"),
    adminCtx: ctxFor(admin, org, "admin"),
    memberCtx: ctxFor(member, org, "member"),
  };
}

async function versionRows(fixture: Awaited<ReturnType<typeof setup>>) {
  return withSystem(async (db) => (await db.query<{
    version: number; id: string; status: string; settings: unknown; change_request: string | null;
  }>(
    `select version, id, status, settings, change_request from agent_config_versions
     where org_id = $1 and agent_instance_id = $2 order by version`,
    [fixture.org.id, fixture.agentId],
  )).rows);
}

describe("Growth Partner ability restrictions", () => {
  it("applies and audits an admin's restriction, then blocks new and already-queued work", async () => {
    const fixture = await setup();
    const outboundBefore = outboundMessagingEnabled();
    const { ownerCtx, adminCtx, org, agentId, versionId } = fixture;
    const dispatchInput = {
      agentRole: AI_GROWTH_PARTNER_ROLE_KEY,
      capability: "performance_snapshot",
      title: "Review acquisition results",
      deferKick: true,
    } as const;
    const job = await dispatchCapabilityJob(ownerCtx, { ...dispatchInput, idempotencyKey: "before-ability-restriction" });
    const controls = await getGrowthPartnerAbilityControls(adminCtx);
    expect(controls).toMatchObject({ state: "ready", version: 1, versionId });
    expect(controls).toMatchObject({ abilities: expect.arrayContaining([
      { key: "analytics.read", restricted: false },
      { key: "crm.contacts.create", restricted: true },
    ]) });

    expect(await restrictGrowthPartnerAbilities(adminCtx, { expectedVersionId: versionId, restrict: ["analytics.read"] }))
      .toEqual({ status: "applied", version: 2 });

    const versions = await versionRows(fixture);
    expect(versions.map(({ version, status }) => [version, status])).toEqual([[1, "superseded"], [2, "applied"]]);
    expect(versions[1].settings).toEqual({ ...fixture.settings, disabledTools: [...fixture.settings.disabledTools, "analytics.read"] });
    expect(versions[1].change_request).toBe("Restrict Growth Partner actions: analytics.read");
    const appliedId = versions[1].id;
    expect(appliedId).not.toBe(versionId);
    await expect(getGrowthPartnerAbilityControls(ownerCtx)).resolves.toMatchObject({
      state: "ready", versionId: appliedId, version: 2,
      abilities: expect.arrayContaining([{ key: "analytics.read", restricted: true }]),
    });
    await expect(restrictGrowthPartnerAbilities(ownerCtx, { expectedVersionId: appliedId, restrict: ["analytics.read"] }))
      .resolves.toEqual({ status: "unchanged", version: 2 });

    await expect(dispatchCapabilityJob(ownerCtx, { ...dispatchInput, idempotencyKey: "after-ability-restriction" }))
      .rejects.toMatchObject({ code: "forbidden", message: expect.stringMatching(/switched off in Allowed actions/) });
    await runWorkJob(job.jobId);
    await withSystem(async (db) => {
      const runtime = await db.query("select active_config_version_id from agent_instances where id = $1 and org_id = $2", [agentId, org.id]);
      expect(runtime.rows).toEqual([{ active_config_version_id: appliedId }]);
      const work = await db.query(
        "select id, status, failure_code from ai_work_jobs where org_id = $1 and agent_instance_id = $2", [org.id, agentId],
      );
      expect(work.rows).toEqual([{ id: job.jobId, status: "blocked", failure_code: "ability_switched_off" }]);
      const audit = await db.query(
        `select actor_user_id, result, metadata from audit_logs
         where org_id = $1 and agent_instance_id = $2 and action = 'agent.config_version_created' and target_id = $3`,
        [org.id, agentId, appliedId],
      );
      expect(audit.rows).toEqual([{
        actor_user_id: fixture.admin.id,
        result: "success",
        metadata: expect.objectContaining({ source: "client_edit", status: "applied", actorRole: "admin", version: 2 }),
      }]);
      const denials = await db.query(
        "select result, metadata from audit_logs where org_id = $1 and agent_instance_id = $2 and action = 'agent.action_denied'",
        [org.id, agentId],
      );
      expect(denials.rows).toEqual(expect.arrayContaining([{
        result: "denied",
        metadata: expect.objectContaining({ actionId: "capability:performance_snapshot", reason: "ability_switched_off: analytics.read" }),
      }]));
    });
    expect(outboundMessagingEnabled()).toBe(outboundBefore);
  });

  it("applies restrictions before payment while provisioning and spending remain gated", async () => {
    const fixture = await setup(false);
    const { org, ownerCtx, versionId } = fixture;
    await withSystem((db) => db.query("update organizations set onboarding_completed_at = now() where id = $1", [org.id]));
    const account = await setupStatus(org.id);
    expect(account.setup_payment_status).toBe("not_invoiced");

    await expect(getGrowthPartnerAbilityControls(ownerCtx)).resolves.toMatchObject({ state: "ready", versionId, version: 1 });
    await expect(restrictGrowthPartnerAbilities(ownerCtx, { expectedVersionId: versionId, restrict: ["analytics.read"] }))
      .resolves.toEqual({ status: "applied", version: 2 });
    await expect(getGrowthPartnerAbilityControls(ownerCtx)).resolves.toMatchObject({
      state: "ready", version: 2,
      abilities: expect.arrayContaining([{ key: "analytics.read", restricted: true }]),
    });

    expect(await setupStatus(org.id)).toEqual(account);
    expect(await provisioningJobs(org.id)).toBe(0);
    expect(await withSystem((db) => requestProvisioning(db, org.id, ownerCtx.user.id))).toBe(0);
    expect(await provisioningJobs(org.id)).toBe(0);
    const { rows } = await withSystem((db) => db.query(
      `select (select count(*)::int from usage_events where org_id = $1) as usage,
              (select count(*)::int from provider_fees where org_id = $1) as fees,
              (select count(*)::int from maintenance_subscriptions where org_id = $1) as subscriptions`,
      [org.id],
    ));
    expect(rows).toEqual([{ usage: 0, fees: 0, subscriptions: 0 }]);
  });

  it("refuses members, cross-tenant versions and inputs that would widen access", async () => {
    const fixture = await setup();
    const other = await setup();
    const before = await versionRows(fixture);
    const input = { expectedVersionId: fixture.versionId, restrict: ["analytics.read"] };
    await expect(getGrowthPartnerAbilityControls(fixture.memberCtx)).rejects.toMatchObject({ code: "forbidden" });
    await expect(restrictGrowthPartnerAbilities(fixture.memberCtx, input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(restrictGrowthPartnerAbilities(other.ownerCtx, input)).rejects.toMatchObject({ code: "conflict" });
    await expect(restrictGrowthPartnerAbilities(other.ownerCtx, {
      expectedVersionId: other.versionId, restrict: ["analytics.read"], enabledTools: ["crm.contacts.create"],
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(restrictGrowthPartnerAbilities(other.ownerCtx, {
      expectedVersionId: other.versionId, restrict: ["messages.send"],
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await versionRows(fixture)).toEqual(before);
    expect(await versionRows(other)).toHaveLength(1);
  });


  it("holds restoration for an independent agency decision and preserves other restrictions", async () => {
    const fixture = await setup();
    const { org, ownerCtx, adminCtx } = fixture;
    const reviewer = await createUser({ platformRole: "agency_super_admin" });
    await restrictGrowthPartnerAbilities(ownerCtx, { expectedVersionId: fixture.versionId, restrict: ["analytics.read"] });
    const active = (await versionRows(fixture))[1];
    const payload = { expectedVersionId: active.id, restore: ["analytics.read"] };
    await expect(requestGrowthPartnerAbilityRestoration(fixture.memberCtx, payload))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(requestGrowthPartnerAbilityRestoration(ownerCtx, { ...payload, restore: ["messages.send"] }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(requestGrowthPartnerAbilityRestoration(ownerCtx, { ...payload, expectedVersionId: fixture.versionId }))
      .rejects.toMatchObject({ code: "conflict" });

    await expect(requestGrowthPartnerAbilityRestoration(adminCtx, payload)).resolves.toEqual({ status: "review_pending", version: 3 });
    const pending = (await versionRows(fixture))[2];
    expect(pending).toMatchObject({
      status: "pending_agency_review",
      settings: fixture.settings,
      change_request: "Restore Growth Partner actions: analytics.read",
    });
    await expect(requestGrowthPartnerAbilityRestoration(ownerCtx, payload)).rejects.toMatchObject({ code: "conflict" });
    await expect(getGrowthPartnerAbilityControls(ownerCtx)).resolves.toMatchObject({
      state: "review_pending", versionId: active.id,
      abilities: expect.arrayContaining([{ key: "analytics.read", restricted: true }]),
    });
    const dispatch = {
      agentRole: AI_GROWTH_PARTNER_ROLE_KEY, capability: "performance_snapshot", title: "Review acquisition results",
      idempotencyKey: "reviewed-restoration", deferKick: true,
    } as const;
    await expect(dispatchCapabilityJob(ownerCtx, dispatch)).rejects.toMatchObject({ code: "forbidden" });

    await withSystem((db) => decideHeldVersion(db, { orgId: org.id, versionId: pending.id, approve: false, agencyUserId: reviewer.id }));
    await expect(dispatchCapabilityJob(ownerCtx, dispatch)).rejects.toMatchObject({ code: "forbidden" });
    await expect(requestGrowthPartnerAbilityRestoration(ownerCtx, payload)).resolves.toEqual({ status: "review_pending", version: 4 });
    const approved = (await versionRows(fixture))[3];
    await withSystem((db) => decideHeldVersion(db, { orgId: org.id, versionId: approved.id, approve: true, agencyUserId: reviewer.id }));
    await expect(getGrowthPartnerAbilityControls(ownerCtx)).resolves.toMatchObject({
      state: "ready", versionId: approved.id,
      abilities: expect.arrayContaining([{ key: "analytics.read", restricted: false }, { key: "crm.contacts.create", restricted: true }]),
    });
    await expect(dispatchCapabilityJob(ownerCtx, dispatch)).resolves.toMatchObject({ jobId: expect.any(String) });
    await expect(requestGrowthPartnerAbilityRestoration(ownerCtx, { ...payload, expectedVersionId: approved.id }))
      .resolves.toEqual({ status: "unchanged", version: 4 });

    const evidence = await withSystem(async (db) => {
      const flags = (await db.query("select risk_flags from agent_config_versions where id = $1 and org_id = $2", [approved.id, org.id])).rows;
      const audit = (await db.query(
        "select actor_user_id, action from audit_logs where org_id = $1 and target_id = $2 order by created_at",
        [org.id, approved.id],
      )).rows;
      const notices = (await db.query(
        "select title, link from notifications where org_id = $1 and user_id = $2 and dedupe_key = $3",
        [org.id, ownerCtx.user.id, `config-decision:${approved.id}`],
      )).rows;
      return { flags, audit, notices };
    });
    expect(evidence.flags).toEqual([{ risk_flags: ["tool_reenabled"] }]);
    expect(evidence.audit).toEqual(expect.arrayContaining([
      { actor_user_id: ownerCtx.user.id, action: "agent.config_version_created" },
      { actor_user_id: reviewer.id, action: "agent.config_review_approved" },
    ]));
    expect(evidence.notices).toEqual([{ title: "AI Growth Partner configuration v4 approved and applied", link: "/growth-partner" }]);
  });

  it("keeps a newer draft intact and refuses a stale applied version", async () => {
    const fixture = await setup();
    const input = { expectedVersionId: fixture.versionId, restrict: ["analytics.read"] };
    const draft = await withSystem((db) => createConfigVersion(db, {
      orgId: fixture.org.id, agentId: fixture.agentId, settings: { ...fixture.settings, tone: "friendly" },
      source: "agency", userId: null, apply: false,
    }));
    const before = await versionRows(fixture);
    expect(draft.status).toBe("draft");
    await expect(getGrowthPartnerAbilityControls(fixture.ownerCtx)).resolves.toMatchObject({ state: "review_pending" });
    await expect(restrictGrowthPartnerAbilities(fixture.ownerCtx, input))
      .rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/configuration change is open/) });
    expect(await versionRows(fixture)).toEqual(before);

    await withSystem((db) => db.query(
      "update agent_config_versions set status = 'rejected' where id = $1 and org_id = $2",
      [draft.versionId, fixture.org.id],
    ));
    const updated = await restrictGrowthPartnerAbilities(fixture.ownerCtx, input);
    expect(updated).toEqual({ version: 3, status: "applied" });
    await expect(restrictGrowthPartnerAbilities(fixture.ownerCtx, { ...input, restrict: ["tasks.read"] }))
      .rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/applied configuration changed/) });
    expect(await versionRows(fixture)).toHaveLength(3);
  });
});
