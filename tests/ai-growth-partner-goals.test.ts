import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { ensureGrowthPartnerIdentity } from "@/server/ai-growth-partner/service";
import { growthPartnerGoalPromptContext, listGrowthPartnerGoalProgress, saveGrowthPartnerGoal, setGrowthPartnerGoalEnabled } from "@/server/ai-growth-partner/goals";
import { ensureGrowthPartnerRuntime } from "@/server/workforce/service";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

let org: Awaited<ReturnType<typeof createOrg>>;
let otherOrg: Awaited<ReturnType<typeof createOrg>>;
let owner: Awaited<ReturnType<typeof createUser>>;
let member: Awaited<ReturnType<typeof createUser>>;
let otherOwner: Awaited<ReturnType<typeof createUser>>;
let runtimeId: string;
let ownerCtx: ReturnType<typeof ctxFor>;
let memberCtx: ReturnType<typeof ctxFor>;
let otherCtx: ReturnType<typeof ctxFor>;

beforeAll(async () => {
  org = await createOrg({ name: "Growth Goal Tenant" });
  otherOrg = await createOrg({ name: "Growth Goal Other Tenant" });
  owner = await createUser();
  member = await createUser();
  otherOwner = await createUser();
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, member.id, "member");
  await addMember(otherOrg.id, otherOwner.id, "owner");
  ownerCtx = ctxFor(owner, org, "owner");
  memberCtx = ctxFor(member, org, "member");
  otherCtx = ctxFor(otherOwner, otherOrg, "owner");
  runtimeId = await withSystem((db) => ensureGrowthPartnerRuntime(org.id, db));
  await ensureGrowthPartnerIdentity(ownerCtx);
  await ensureGrowthPartnerIdentity(otherCtx);
});

describe("AI Growth Partner measured goals", () => {
  it("persists bounded owner targets with optimistic revisions, audit and member authorization", async () => {
    const created = await saveGrowthPartnerGoal(ownerCtx, {
      metric: "leads_created", cadence: "weekly", targetValue: 5, baseRevision: null,
    });
    expect(created).toMatchObject({ id: expect.any(String), revision: 1 });

    await expect(saveGrowthPartnerGoal(ownerCtx, {
      metric: "leads_created", cadence: "weekly", targetValue: 6, baseRevision: null,
    })).rejects.toMatchObject({ code: "conflict" });
    await expect(saveGrowthPartnerGoal(ownerCtx, {
      metric: "leads_created", cadence: "weekly", targetValue: 0, baseRevision: 1,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(saveGrowthPartnerGoal(ownerCtx, {
      metric: "leads_created", cadence: "weekly", targetValue: 100_001, baseRevision: 1,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(saveGrowthPartnerGoal(ownerCtx, {
      metric: "unknown_metric", cadence: "weekly", targetValue: 5, baseRevision: null,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(saveGrowthPartnerGoal(memberCtx, {
      metric: "leads_created", cadence: "weekly", targetValue: 6, baseRevision: 1,
    })).rejects.toMatchObject({ code: "forbidden" });

    const updated = await saveGrowthPartnerGoal(ownerCtx, {
      metric: "leads_created", cadence: "weekly", targetValue: 6, baseRevision: 1,
    });
    expect(updated).toMatchObject({ id: created.id, revision: 2 });
    await expect(saveGrowthPartnerGoal(ownerCtx, {
      metric: "leads_created", cadence: "weekly", targetValue: 7, baseRevision: 1,
    })).rejects.toMatchObject({ code: "conflict" });

    const paused = await setGrowthPartnerGoalEnabled(ownerCtx, { goalId: created.id, enabled: false, baseRevision: 2 });
    expect(paused).toMatchObject({ id: created.id, enabled: false, revision: 3 });
    expect((await listGrowthPartnerGoalProgress(ownerCtx))[0]).toMatchObject({ enabled: false, actualValue: null });
    const resumed = await setGrowthPartnerGoalEnabled(ownerCtx, { goalId: created.id, enabled: true, baseRevision: 3 });
    expect(resumed).toMatchObject({ enabled: true, revision: 4 });
    const prompt = await withSystem((db) => growthPartnerGoalPromptContext(db, org.id, runtimeId));
    expect(prompt).toContain("Leads created: 6 per week");
    expect(prompt).toContain("not promises or guaranteed outcomes");
    expect(await withSystem((db) => growthPartnerGoalPromptContext(db, otherOrg.id, runtimeId))).toBe("");

    const audits = await withSystem((db) => db.query<{ action: string; metadata: Record<string, unknown> }>(
      "select action, metadata from audit_logs where org_id = $1 and target_id = $2 and action like 'ai_growth_partner.goal_%' order by created_at",
      [org.id, created.id],
    ));
    expect(audits.rows.map((row) => row.action)).toEqual([
      "ai_growth_partner.goal_created",
      "ai_growth_partner.goal_updated",
      "ai_growth_partner.goal_paused",
      "ai_growth_partner.goal_enabled",
    ]);
    expect(audits.rows[0].metadata).toMatchObject({ metric: "leads_created", cadence: "weekly", targetValue: 5, revision: 1 });
  });

  it("counts only the tenant's recorded activity and withholds progress without record permission", async () => {
    await withSystem(async (db) => {
      await db.query("insert into leads (org_id, business_name, review_status, created_at) values ($1, 'Measured A', 'pending', now()), ($1, 'Measured B', 'pending', now())", [org.id]);
      await db.query("insert into leads (org_id, business_name, review_status, created_at) values ($1, 'Other tenant', 'pending', now())", [otherOrg.id]);
    });
    const visible = await listGrowthPartnerGoalProgress(ownerCtx);
    const weekly = visible.find((goal) => goal.metric === "leads_created" && goal.cadence === "weekly");
    expect(weekly).toMatchObject({ targetValue: 6, actualValue: 2, percentComplete: 33, remainingValue: 4, enabled: true, canViewProgress: true });

    const restrictedCtx = {
      ...ownerCtx,
      can: (permission: Parameters<typeof ownerCtx.can>[0]) => permission === "leads.view" ? false : ownerCtx.can(permission),
    };
    const restricted = await listGrowthPartnerGoalProgress(restrictedCtx);
    expect(restricted.find((goal) => goal.id === weekly?.id)).toMatchObject({ actualValue: null, percentComplete: null, canViewProgress: false });
    expect(await listGrowthPartnerGoalProgress(otherCtx)).toEqual([]);
    const directCrossTenantRead = await withUser(otherOwner.id, (db) => db.query(
      "select id from ai_growth_partner_goals where org_id = $1",
      [org.id],
    ));
    expect(directCrossTenantRead.rows).toEqual([]);
  });
});
