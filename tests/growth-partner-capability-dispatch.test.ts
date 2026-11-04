// The unified role reuses the reviewed Work Board dispatcher. All checks are synthetic and local;
// no Hermes profile or provider call is involved.
import { describe, expect, it } from "vitest";
import { AI_GROWTH_PARTNER_ROLE_KEY } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { jobAbilityRefusal } from "@/server/workforce/abilities";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { runWorkJob } from "@/server/workforce/work-runner";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

async function setup() {
  const org = await createOrg({ name: "Unified Partner Dispatch" });
  const owner = await createUser();
  const member = await createUser();
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, member.id, "member");
  const agentId = await withSystem(async (db) => {
    const agent = await db.query<{ id: string }>(
      `insert into agent_instances (org_id, role_key, display_name, status, mode)
       values ($1, 'growth_partner', 'AI Growth Partner', 'online', 'autonomous') returning id`,
      [org.id],
    );
    const version = await db.query<{ id: string }>(
      `insert into agent_config_versions
         (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status, applied_at)
       values ($1, $2, 1, '{"disabledTools":[]}'::jsonb, 'Growth Partner test config', '# test', 'test', 'onboarding', 'applied', now())
       returning id`,
      [org.id, agent.rows[0].id],
    );
    await db.query("update agent_instances set active_config_version_id = $2 where id = $1", [agent.rows[0].id, version.rows[0].id]);
    return agent.rows[0].id;
  });
  return {
    org,
    agentId,
    owner,
    member,
    ownerContext: ctxFor(owner, org, "owner"),
    memberContext: ctxFor(member, org, "member"),
  };
}

async function disableAbilities(orgId: string, agentId: string, disabledTools: string[]) {
  await withSystem(async (db) => {
    const next = await db.query<{ id: string }>(
      `insert into agent_config_versions
         (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status, applied_at)
       values ($1, $2, (select coalesce(max(version), 0) + 1 from agent_config_versions where agent_instance_id = $2), $3::jsonb,
               'Updated Growth Partner test config', '# test', 'test', 'client_edit', 'applied', now()) returning id`,
      [orgId, agentId, JSON.stringify({ disabledTools })],
    );
    await db.query("update agent_instances set active_config_version_id = $2 where id = $1", [agentId, next.rows[0].id]);
  });
}

describe("Growth Partner capability dispatch", () => {
  it("queues a real reviewed Work Board job under its one runtime row", async () => {
    const state = await setup();
    const result = await dispatchCapabilityJob(state.ownerContext, {
      agentRole: AI_GROWTH_PARTNER_ROLE_KEY,
      capability: "performance_snapshot",
      title: "Review acquisition results",
      idempotencyKey: "growth-partner-performance-snapshot",
      deferKick: true,
    });
    expect(result.agentId).toBe(state.agentId);
    const job = (await withSystem((db) => db.query<{ agent_instance_id: string; capability: string; status: string }>(
      "select agent_instance_id, capability, status from ai_work_jobs where id = $1 and org_id = $2",
      [result.jobId, state.org.id],
    ))).rows[0];
    expect(job).toEqual({ agent_instance_id: state.agentId, capability: "performance_snapshot", status: "queued" });
    expect(await withSystem((db) => jobAbilityRefusal(db, { orgId: state.org.id, agentId: state.agentId, capability: "performance_snapshot" }))).toBeNull();
  });

  it("rechecks the partner's Allowed actions when a queued job starts", async () => {
    const state = await setup();
    const queued = await dispatchCapabilityJob(state.ownerContext, {
      agentRole: AI_GROWTH_PARTNER_ROLE_KEY,
      capability: "performance_snapshot",
      title: "Review acquisition results",
      idempotencyKey: "growth-partner-off-switch",
      deferKick: true,
    });
    await disableAbilities(state.org.id, state.agentId, ["analytics.read"]);
    await runWorkJob(queued.jobId);
    const result = (await withSystem((db) => db.query<{ status: string; failure_code: string | null; failure_message: string | null }>(
      "select status, failure_code, failure_message from ai_work_jobs where id = $1 and org_id = $2",
      [queued.jobId, state.org.id],
    ))).rows[0];
    expect(result.status).toBe("blocked");
    expect(result.failure_code).toBe("ability_switched_off");
    expect(result.failure_message).toMatch(/AI Growth Partner.*Allowed actions/);
  });

  it("does not let the unified role widen the signed-in person's own permissions", async () => {
    const state = await setup();
    const before = Number((await withSystem((db) => db.query<{ count: number }>(
      "select count(*)::int as count from ai_work_jobs where org_id = $1",
      [state.org.id],
    ))).rows[0].count);
    await expect(dispatchCapabilityJob(state.memberContext, {
      agentRole: AI_GROWTH_PARTNER_ROLE_KEY,
      capability: "lead_research",
      title: "Research a prospect list",
      deferKick: true,
    })).rejects.toMatchObject({ code: "forbidden" });
    const after = Number((await withSystem((db) => db.query<{ count: number }>(
      "select count(*)::int as count from ai_work_jobs where org_id = $1",
      [state.org.id],
    ))).rows[0].count);
    expect(after).toBe(before);
  });
});
