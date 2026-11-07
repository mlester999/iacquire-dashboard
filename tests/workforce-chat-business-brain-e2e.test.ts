import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyBusinessBrain } from "@/lib/ai-growth-partner";
import { defaultSettings } from "@/server/workforce/compiler";
import { getGrowthPartnerControlState } from "@/server/ai-growth-partner/service";
import { buildRunInstructions, connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { sendChatMessage } from "@/server/chat/service";
import { withSystem } from "@/server/db";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import { getMessagingSettings, updateMessagingSettings } from "@/server/messaging/inbox";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const KEY = "b".repeat(40);
const PROFILE = "c-business-brain-chat-e2e";

let mock: MockHermes;
let org: Awaited<ReturnType<typeof createOrg>>;
let owner: Awaited<ReturnType<typeof createUser>>;
let member: Awaited<ReturnType<typeof createUser>>;
let admin: Awaited<ReturnType<typeof createUser>>;
let growthPartnerAgentId: string;
let growthPartnerConversationId: string;

async function resetAgentMessageRateLimit(userId: string) {
  await withSystem((db) => db.query("delete from rate_limit_buckets where bucket_key = $1", [`${RATE_LIMITS.agentMessageByUser.name}:${userId}`]));
}

beforeAll(async () => {
  mock = await startMockHermes({ [PROFILE]: { key: KEY } });
  org = await createOrg({ name: "Growth Partner Business Brain Chat E2E" });
  owner = await createUser({ name: "Business Brain Owner" });
  member = await createUser({ name: "Business Brain Member" });
  admin = await createUser({ platformRole: "agency_super_admin", name: "Business Brain Runtime Admin" });
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, member.id, "member");

  growthPartnerAgentId = await withSystem(async (db) => (await db.query<{ id: string }>(
    "insert into agent_instances (org_id, role_key, display_name) values ($1, 'growth_partner', 'AI Growth Partner') returning id",
    [org.id],
  )).rows[0].id);
  await withSystem((db) => createConfigVersion(db, {
    orgId: org.id,
    agentId: growthPartnerAgentId,
    settings: defaultSettings("growth_partner"),
    source: "onboarding",
    userId: owner.id,
    apply: true,
  }));
  await connectHermesProfile({ agentId: growthPartnerAgentId, baseUrl: mock.url, profile: PROFILE, apiKey: KEY, agencyUserId: admin.id });

  const partnerId = await withSystem(async (db) => {
    const partner = (await db.query<{ id: string }>(
      "insert into ai_growth_partners (org_id, runtime_agent_instance_id) values ($1, $2) returning id",
      [org.id, growthPartnerAgentId],
    )).rows[0].id;
    await db.query(
      `insert into ai_growth_partner_versions (partner_id, org_id, version, business_brain, source, created_by)
       values ($1, $2, 1, $3::jsonb, 'onboarding', $4)`,
      [partner, org.id, JSON.stringify(emptyBusinessBrain()), owner.id],
    );
    await db.query("update ai_growth_partners set current_version = 1 where id = $1 and org_id = $2", [partner, org.id]);
    return partner;
  });

  const health = await runHealthCheck(growthPartnerAgentId, { userId: admin.id, kind: "agency" });
  expect(health).toMatchObject({ ok: true, status: "online" });
  growthPartnerConversationId = (await withSystem((db) => db.query<{ id: string }>(
    "select id from chat_conversations where org_id = $1 and growth_partner_id = $2 and deleted_at is null",
    [org.id, partnerId],
  ))).rows[0].id;
});

afterAll(async () => {
  await mock?.close();
});

describe("Business Brain edits from the permanent Growth Partner conversation", () => {
  it("saves an owner edit as an audited draft, keeps it inactive, and rejects member changes", async () => {
    await resetAgentMessageRateLimit(owner.id);
    const ctx = ctxFor(owner, org, "owner");
    const before = await getGrowthPartnerControlState(ctx);
    expect(before).toMatchObject({ currentVersion: 1, draftVersion: null, conversationId: growthPartnerConversationId });
    const requestStart = mock.requests.length;

    const result = await sendChatMessage(ctx, {
      agentRole: "growth_partner",
      conversationId: growthPartnerConversationId,
      content: "Update Business Brain service areas to Orlando metropolitan area\nWinter Park\nKissimmee",
      clientMessageId: crypto.randomUUID(),
    });
    expect(result).toMatchObject({ conversationId: growthPartnerConversationId, runId: null, jobId: null });
    const reply = (await withSystem((db) => db.query<{ content: string }>(
      "select content from chat_messages where id = $1 and org_id = $2", [result.assistantMessageId, org.id],
    ))).rows[0].content;
    expect(reply).toContain("Saved service areas in Business Brain draft version 2");
    expect(reply).toContain("not active yet");

    const after = await getGrowthPartnerControlState(ctx);
    expect(after).toMatchObject({ currentVersion: 1, draftVersion: 2 });
    expect(after?.draftBusinessBrain?.sections.businessIdentity.serviceAreas).toMatchObject({
      value: "Orlando metropolitan area\nWinter Park\nKissimmee",
      state: "client_confirmed",
      clientOverride: true,
    });
    const activeInstructions = await withSystem((db) => buildRunInstructions(db, org.id, growthPartnerAgentId));
    expect(activeInstructions.instructions).not.toContain("serviceAreas: Orlando metropolitan area");
    const audit = (await withSystem((db) => db.query<{ action: string; metadata: Record<string, unknown> }>(
      "select action, metadata from audit_logs where org_id = $1 and action = 'ai_growth_partner.business_brain_fact_edited' order by created_at desc limit 1",
      [org.id],
    ))).rows[0];
    expect(audit).toMatchObject({
      action: "ai_growth_partner.business_brain_fact_edited",
      metadata: { version: 2, submittedFrom: "permanent_growth_partner_chat", section: "businessIdentity", fact: "serviceAreas", activeVersionChanged: false },
    });
    expect(mock.requests.slice(requestStart).some((request) => request.method === "POST" && request.path === "/v1/runs")).toBe(false);

    await resetAgentMessageRateLimit(owner.id);
    const repeated = await sendChatMessage(ctx, {
      agentRole: "growth_partner",
      conversationId: growthPartnerConversationId,
      content: "Update Business Brain service areas to Orlando metropolitan area\nWinter Park\nKissimmee",
      clientMessageId: crypto.randomUUID(),
    });
    const repeatedReply = (await withSystem((db) => db.query<{ content: string }>(
      "select content from chat_messages where id = $1 and org_id = $2", [repeated.assistantMessageId, org.id],
    ))).rows[0].content;
    expect(repeatedReply).toContain("already saved in Business Brain draft version 2");
    expect((await getGrowthPartnerControlState(ctx))?.versions.filter((version) => version.version === 2)).toHaveLength(1);

    await resetAgentMessageRateLimit(member.id);
    const denied = await sendChatMessage(ctxFor(member, org, "member"), {
      agentRole: "growth_partner",
      conversationId: growthPartnerConversationId,
      content: "Update Business Brain industry to roofing",
      clientMessageId: crypto.randomUUID(),
    });
    const deniedReply = (await withSystem((db) => db.query<{ content: string }>(
      "select content from chat_messages where id = $1 and org_id = $2", [denied.assistantMessageId, org.id],
    ))).rows[0].content;
    expect(deniedReply).toContain("Only a workspace owner or admin");
    expect((await getGrowthPartnerControlState(ctx))?.draftVersion).toBe(2);
    await resetAgentMessageRateLimit(owner.id);
    await resetAgentMessageRateLimit(member.id);
  });

  it("updates Messaging hours from the permanent chat, synchronizes the active Brain and draft, and enforces owner permissions", async () => {
    await resetAgentMessageRateLimit(owner.id);
    const ctx = ctxFor(owner, org, "owner");
    const before = await getGrowthPartnerControlState(ctx);
    expect(before?.draftVersion).toBe(2);
    const requestStart = mock.requests.length;
    const result = await sendChatMessage(ctx, {
      agentRole: "growth_partner",
      conversationId: growthPartnerConversationId,
      content: "Set messaging business hours to Mon-Fri 09:00-17:00; Sat-Sun closed",
      clientMessageId: crypto.randomUUID(),
    });
    expect(result).toMatchObject({ conversationId: growthPartnerConversationId, runId: null, jobId: null });
    const reply = (await withSystem((db) => db.query<{ content: string }>(
      "select content from chat_messages where id = $1 and org_id = $2", [result.assistantMessageId, org.id],
    ))).rows[0].content;
    expect(reply).toContain("Saved Messaging hours as Monday 09:00–17:00");
    expect(reply).toContain("synchronized the active Business Brain version 3");
    expect(reply).toContain("Draft version 4 was also aligned");
    expect(reply).toContain("calendar host availability is separate");
    expect(await getMessagingSettings(ctx)).toMatchObject({
      businessHours: { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]] },
      autoReplyEnabled: false,
    });

    const after = await getGrowthPartnerControlState(ctx);
    expect(after).toMatchObject({ currentVersion: 3, draftVersion: 4 });
    expect(after?.currentBusinessBrain?.sections.businessOperations.operatingHours).toMatchObject({
      value: "Monday 09:00–17:00; Tuesday 09:00–17:00; Wednesday 09:00–17:00; Thursday 09:00–17:00; Friday 09:00–17:00",
      state: "client_confirmed",
      clientOverride: true,
    });
    expect(after?.draftBusinessBrain?.sections.businessIdentity.serviceAreas.value).toBe("Orlando metropolitan area\nWinter Park\nKissimmee");
    expect(after?.draftBusinessBrain?.sections.businessOperations.operatingHours.value).toBe(after?.currentBusinessBrain?.sections.businessOperations.operatingHours.value);

    const audits = (await withSystem((db) => db.query<{ action: string; metadata: Record<string, unknown> }>(
      "select action, metadata from audit_logs where org_id = $1 and action in ('messaging.settings_changed', 'ai_growth_partner.business_brain_settings_synced', 'ai_growth_partner.business_brain_draft_rebased') order by id",
      [org.id],
    ))).rows;
    expect(audits.map((entry) => entry.action)).toEqual(expect.arrayContaining([
      "messaging.settings_changed",
      "ai_growth_partner.business_brain_settings_synced",
      "ai_growth_partner.business_brain_draft_rebased",
    ]));

    const settingsBeforeDenied = await getMessagingSettings(ctx);
    await resetAgentMessageRateLimit(member.id);
    const denied = await sendChatMessage(ctxFor(member, org, "member"), {
      agentRole: "growth_partner",
      conversationId: growthPartnerConversationId,
      content: "Set messaging business hours to Mon-Fri 08:00-16:00",
      clientMessageId: crypto.randomUUID(),
    });
    const deniedReply = (await withSystem((db) => db.query<{ content: string }>(
      "select content from chat_messages where id = $1 and org_id = $2", [denied.assistantMessageId, org.id],
    ))).rows[0].content;
    expect(deniedReply).toContain("Only a workspace owner or manager");
    await expect(updateMessagingSettings(ctxFor(member, org, "member"), { businessHours: { mon: [["08:00", "16:00"]] } }))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(await getMessagingSettings(ctx)).toEqual(settingsBeforeDenied);
    expect(mock.requests.slice(requestStart).some((request) => request.method === "POST" && request.path === "/v1/runs")).toBe(false);

    await resetAgentMessageRateLimit(owner.id);
    await resetAgentMessageRateLimit(member.id);
  }, 120_000);
});
