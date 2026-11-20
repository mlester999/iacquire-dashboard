import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyBusinessBrain } from "@/lib/ai-growth-partner";
import { defaultSettings } from "@/server/workforce/compiler";
import { activateGrowthPartnerBusinessBrainVersion, getGrowthPartnerControlState, saveGrowthPartnerBusinessBrainFactDraft } from "@/server/ai-growth-partner/service";
import { buildRunInstructions, connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { hermesReplyGenerator, replyClaimProblems, type ReplyContext } from "@/server/messaging/responder";
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

async function waitForMockRun(input: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = [...mock.runs.values()].find((candidate) => candidate.body.input === input);
    if (run) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Growth Partner mock run did not start.");
}

async function waitForChatMessage(messageId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const row = (await withSystem((db) => db.query<{ status: string }>("select status from chat_messages where id = $1", [messageId]))).rows[0];
    if (row?.status === "complete") return;
    if (row && ["failed", "cancelled"].includes(row.status)) throw new Error(`Growth Partner run ended as ${row.status}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Growth Partner reply did not finish.");
}

beforeAll(async () => {
  mock = await startMockHermes({ [PROFILE]: { key: KEY, runToolScopeNoTools: true } });
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

  it("uses a customer-only active Brain prompt for a real Hermes customer reply", async () => {
    const ownerContext = ctxFor(owner, org, "owner");
    const before = await getGrowthPartnerControlState(ownerContext);
    if (!before?.currentVersion) throw new Error("The active Business Brain is missing.");
    let baseVersion = before.currentVersion;
    if (before.draftVersion) {
      await activateGrowthPartnerBusinessBrainVersion(ownerContext, { expectedCurrentVersion: before.currentVersion, version: before.draftVersion });
      baseVersion = before.draftVersion;
    }
    const company = await saveGrowthPartnerBusinessBrainFactDraft(ownerContext, {
      baseVersion,
      section: "businessIdentity",
      key: "companyName",
      valueText: "Public Reply Roofing",
    });
    const price = await saveGrowthPartnerBusinessBrainFactDraft(ownerContext, {
      baseVersion: company.version,
      section: "productsServicesOffers",
      key: "pricing",
      valueText: "Roof inspections cost $150.",
    });
    const privateBudget = await saveGrowthPartnerBusinessBrainFactDraft(ownerContext, {
      baseVersion: price.version,
      section: "idealCustomers",
      key: "minimumBudget",
      valueText: "PRIVATE_REPLY_BUDGET_MARKER: $9,000 monthly.",
    });
    await activateGrowthPartnerBusinessBrainVersion(ownerContext, { expectedCurrentVersion: baseVersion, version: privateBudget.version });

    const input = "A customer asked for the roof inspection price.";
    const ctx: ReplyContext = {
      orgId: org.id,
      agentId: growthPartnerAgentId,
      agentRole: "growth_partner",
      conversationId: crypto.randomUUID(),
      contactId: crypto.randomUUID(),
      inboundMessageId: crypto.randomUUID(),
      channel: "email",
      businessName: org.name,
      customerMessage: input,
      history: [],
      confirmedFacts: [],
    };
    await withSystem((db) => db.query(
      `insert into company_knowledge (org_id, section, content, review_status, risk_flags)
       values ($1, 'escalation', 'PRIVATE_KNOWLEDGE_PRICE_MARKER: qualifying projects may receive a $900 rate.', 'approved', '{}')`,
      [org.id],
    ));
    const configRow = (await withSystem((db) => db.query<{ id: string; compiled_instructions: string }>(
      `select v.id, v.compiled_instructions from agent_instances a
       join agent_config_versions v on v.id = a.active_config_version_id
       where a.id = $1 and a.org_id = $2`,
      [growthPartnerAgentId, org.id],
    ))).rows[0];
    const originalConfig = configRow.compiled_instructions;
    const canaryConfig = originalConfig
      .replace("## Your role", "## Your role\nPRIVATE_ROLE_CONFIG_MARKER")
      .replace("</client_context>", "Ideal customers: PRIVATE_COMPILED_PROFILE_MARKER\n</client_context>");
    await withSystem((db) => db.query("update agent_config_versions set compiled_instructions = $1 where id = $2", [canaryConfig, configRow.id]));

    try {
      const runIdsBefore = new Set(mock.runs.keys());
      const generated = await hermesReplyGenerator(ctx);
      expect(generated.kind).toBe("reply");
      const run = [...mock.runs.values()].find((candidate) => !runIdsBefore.has(candidate.id) && candidate.body.input === input);
      expect(run).toBeTruthy();
      const instructions = String(run?.body.instructions ?? "");
      expect(instructions).toContain("businessIdentity.companyName: Public Reply Roofing");
      expect(instructions).toContain("productsServicesOffers.pricing: Roof inspections cost $150.");
      expect(instructions).not.toContain("PRIVATE_REPLY_BUDGET_MARKER");
      expect(instructions).not.toContain("PRIVATE_ROLE_CONFIG_MARKER");
      expect(instructions).not.toContain("PRIVATE_COMPILED_PROFILE_MARKER");
      expect(instructions).not.toContain("PRIVATE_KNOWLEDGE_PRICE_MARKER");
      expect(instructions).not.toContain("WORKSPACE GROWTH GOALS");
      expect(instructions).not.toContain("WORKSPACE MEMORY CONTEXT");
      expect(instructions).not.toContain("sourceId:");
      expect(instructions).not.toContain("evidenceUrl:");
      expect(run?.body.iacquire_tool_scope).toBe("no_tools");
      expect(run?.headers["x-iacquire-tool-scope"]).toBe("no_tools");
      expect(run?.headers["x-hermes-session-key"]).toBeUndefined();
      expect(await replyClaimProblems(org.id, "A roof inspection costs $150.", "", "growth_partner")).toEqual([]);
      expect(await replyClaimProblems(org.id, "A roof inspection costs $450.", "", "growth_partner")).toContain("an amount ($450)");
      expect(await replyClaimProblems(org.id, "A qualifying project costs $900.", "", "growth_partner")).toContain("an amount ($900)");
    } finally {
      await withSystem((db) => db.query("update agent_config_versions set compiled_instructions = $1 where id = $2", [originalConfig, configRow.id]));
    }
  });

  it("fails closed when Hermes cannot verify that a customer reply has no tools", async () => {
    const ctx: ReplyContext = {
      orgId: org.id,
      agentId: growthPartnerAgentId,
      agentRole: "growth_partner",
      conversationId: crypto.randomUUID(),
      contactId: crypto.randomUUID(),
      inboundMessageId: crypto.randomUUID(),
      channel: "email",
      businessName: org.name,
      customerMessage: "Can you tell me about your services?",
      history: [],
      confirmedFacts: [],
    };
    const runIdsBefore = new Set(mock.runs.keys());
    const submissionsBefore = mock.requests.filter((request) => request.method === "POST" && request.path === "/v1/runs").length;
    mock.setRunToolScopeNoTools(PROFILE, false);
    try {
      const generated = await hermesReplyGenerator(ctx);
      expect(generated.kind).toBe("unavailable");
      expect([...mock.runs.keys()].filter((id) => !runIdsBefore.has(id))).toEqual([]);
      expect(mock.requests.filter((request) => request.method === "POST" && request.path === "/v1/runs")).toHaveLength(submissionsBefore);
    } finally {
      mock.setRunToolScopeNoTools(PROFILE, true);
    }
  });

  it("rejects new chat credentials before persistence and redacts credentials from old history before Hermes", async () => {
    await resetAgentMessageRateLimit(owner.id);
    const context = ctxFor(owner, org, "owner");
    const rejectedMessageId = crypto.randomUUID();
    const pastedSecret = "My password is hunter2-QA-ONLY.";
    await expect(sendChatMessage(context, {
      agentRole: "growth_partner",
      conversationId: growthPartnerConversationId,
      content: pastedSecret,
      clientMessageId: rejectedMessageId,
    })).rejects.toMatchObject({ code: "invalid_input" });
    const rejected = await withSystem((db) => db.query("select id from chat_messages where client_message_id = $1", [rejectedMessageId]));
    expect(rejected.rows).toEqual([]);

    const legacySecret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    await withSystem((db) => db.query(
      `insert into chat_messages (conversation_id, org_id, role, content, status)
       values ($1, $2, 'user', $3, 'complete')`,
      [growthPartnerConversationId, org.id, `A legacy turn included ${legacySecret}.`],
    ));
    const safeInput = `Can you explain how the AI Growth Partner helps a team? ${crypto.randomUUID()}`;
    const sent = await sendChatMessage(context, {
      agentRole: "growth_partner",
      conversationId: growthPartnerConversationId,
      content: safeInput,
      clientMessageId: crypto.randomUUID(),
    });
    const run = await waitForMockRun(safeInput);
    expect(JSON.stringify(run.body.conversation_history)).not.toContain(legacySecret);
    expect(JSON.stringify(run.body.conversation_history)).toContain("[redacted]");
    expect(run.body.iacquire_tool_scope).toBe("no_tools");
    expect(run.body.session_id).toBeUndefined();
    expect(run.headers["x-iacquire-tool-scope"]).toBe("no_tools");
    expect(run.headers["x-hermes-session-key"]).toBeUndefined();
    await waitForChatMessage(sent.assistantMessageId);
  });
});
