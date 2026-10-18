import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { agencyUser, addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import type { AqiViewer } from "@/server/aqi/access";
import { aqiCostMicros, createAqiConversation, estimateAqiTokens, reserveAqiSpend, saveAqiBudget, saveAqiModelPrice, DEFAULT_AQI_CONFIG } from "@/server/aqi/service";

function viewerFor(user: ReturnType<typeof ctxFor>): AqiViewer {
  return { user: user.user, org: { orgId: user.org.orgId, name: user.org.name, kind: user.org.kind, role: user.org.role }, permissions: user.permissions, can: user.can, agencyRole: null };
}

describe("AQi cost controls", () => {
  it("calculates token estimates and configured model cost", () => {
    expect(estimateAqiTokens("12345678")).toBe(2);
    expect(aqiCostMicros({ model: "x", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, enabled: true }, 1000, 100)).toBe(1200);
  });

  it("reserves budget atomically and rejects an exhausted budget", async () => {
    const org = await createOrg({ name: "AQi Budget Audit" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const viewer = viewerFor(ctxFor(owner, org, "owner"));
    const admin = await createUser({ platformRole: "agency_super_admin" });
    const session = agencyUser(admin, "agency_super_admin");
    const model = `audit-budget-${Date.now()}`;
    try {
      await saveAqiModelPrice(session, { model, inputUsdPerMillion: 1, outputUsdPerMillion: 2, enabled: true });
      await saveAqiBudget(session, { orgId: org.id, enabled: true, monthlyOrgUsd: 0.0015, monthlyUserUsd: 0.0015 });
      const conversation = await createAqiConversation(viewer, "/workforce");
      const config = { ...DEFAULT_AQI_CONFIG, model, maxTokens: 100 };
      const first = await reserveAqiSpend(viewer, config, 1000, 100, conversation.id, null, "/workforce");
      expect(first.id).toBeTruthy();
      expect(first.estimatedCostMicros).toBe(1200);
      await expect(reserveAqiSpend(viewer, config, 1000, 100, conversation.id, null, "/workforce")).rejects.toThrow(/budget/i);
    } finally {
      await withSystem(async (db) => {
        await db.query("delete from aqi_usage_events where org_id = $1", [org.id]);
        await db.query("delete from aqi_conversations where org_id = $1", [org.id]);
        await db.query("delete from aqi_budgets where org_id = $1", [org.id]);
        await db.query("delete from aqi_model_prices where model = $1", [model]);
      });
    }
  });

  it("serializes two simultaneous turns against the same budget", async () => {
    const org = await createOrg({ name: "AQi Budget Race" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const viewer = viewerFor(ctxFor(owner, org, "owner"));
    const admin = await createUser({ platformRole: "agency_super_admin" });
    const session = agencyUser(admin, "agency_super_admin");
    const model = `audit-race-${Date.now()}`;
    try {
      await saveAqiModelPrice(session, { model, inputUsdPerMillion: 1, outputUsdPerMillion: 2, enabled: true });
      await saveAqiBudget(session, { orgId: org.id, enabled: true, monthlyOrgUsd: 0.0015, monthlyUserUsd: 0.0015 });
      const conversation = await createAqiConversation(viewer, "/workforce");
      const config = { ...DEFAULT_AQI_CONFIG, model, maxTokens: 100 };
      const results = await Promise.allSettled([
        reserveAqiSpend(viewer, config, 1000, 100, conversation.id, null, "/workforce"),
        reserveAqiSpend(viewer, config, 1000, 100, conversation.id, null, "/workforce"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    } finally {
      await withSystem(async (db) => {
        await db.query("delete from aqi_usage_events where org_id = $1", [org.id]);
        await db.query("delete from aqi_conversations where org_id = $1", [org.id]);
        await db.query("delete from aqi_budgets where org_id = $1", [org.id]);
        await db.query("delete from aqi_model_prices where model = $1", [model]);
      });
    }
  });

  it("refuses a budgeted call when the model has no configured price", async () => {
    const org = await createOrg({ name: "AQi Missing Price Audit" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const viewer = viewerFor(ctxFor(owner, org, "owner"));
    const admin = await createUser({ platformRole: "agency_super_admin" });
    const session = agencyUser(admin, "agency_super_admin");
    try {
      await saveAqiBudget(session, { orgId: org.id, enabled: true, monthlyOrgUsd: 1, monthlyUserUsd: 1 });
      const conversation = await createAqiConversation(viewer, "/workforce");
      const config = { ...DEFAULT_AQI_CONFIG, model: `missing-${Date.now()}`, maxTokens: 100 };
      await expect(reserveAqiSpend(viewer, config, 100, 10, conversation.id, null, "/workforce")).rejects.toThrow(/pricing/i);
    } finally {
      await withSystem(async (db) => {
        await db.query("delete from aqi_conversations where org_id = $1", [org.id]);
        await db.query("delete from aqi_budgets where org_id = $1", [org.id]);
      });
    }
  });
});
