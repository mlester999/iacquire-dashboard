import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMember, agencyUser, createOrg, createUser } from "./support/fixtures";
import { getAqiInsights, resolveAqiInsightsRange } from "@/server/aqi/insights";

async function seedInsightData() {
  const org = await createOrg({ name: `Insights ${Math.random().toString(16).slice(2)}` });
  const other = await createOrg({ name: `Insights Other ${Math.random().toString(16).slice(2)}` });
  const owner = await createUser({ name: "Insights Owner" });
  await addMember(org.id, owner.id, "owner");
  const tutorial = await withSystem(async (db) => (await db.query<{ id: string }>("select id from aqi_tutorials where slug = 'getting-started'")).rows[0]);
  const suffix = Math.random().toString(16).slice(2);
  const conversation = await withSystem(async (db) => (await db.query<{ id: string }>(
    `insert into aqi_conversations (org_id, user_id, title, saved_at, created_at)
     values ($1, $2, 'Insights chat', now(), now()) returning id`,
    [org.id, owner.id],
  )).rows[0]);
  await withSystem(async (db) => {
    await db.query(
      `insert into aqi_messages (conversation_id, org_id, user_id, role, content, status, model, input_tokens, output_tokens, latency_ms, feedback_rating, context, created_at)
       values ($1, $2, $3, 'user', 'SECRET CUSTOMER TEXT that must never appear in analytics', 'complete', null, null, null, null, null, '{}'::jsonb, now())`,
      [conversation.id, org.id, owner.id],
    );
    await db.query(
      `insert into aqi_messages (conversation_id, org_id, user_id, role, content, status, model, input_tokens, output_tokens, latency_ms, feedback_rating, context, created_at)
       values ($1, $2, $3, 'assistant', 'SECRET ANSWER TEXT', 'complete', 'deepseek-flash', 120, 80, 420, 1, '{"page":"/crm/contacts"}'::jsonb, now())`,
      [conversation.id, org.id, owner.id],
    );
    await db.query(
      `insert into aqi_messages (conversation_id, org_id, user_id, role, content, status, error_code, model, input_tokens, output_tokens, latency_ms, feedback_rating, context, created_at)
       values ($1, $2, $3, 'assistant', 'failed answer', 'failed', 'provider_error', 'deepseek-flash', 20, 0, 900, -1, '{"page":"/crm/contacts"}'::jsonb, now())`,      [conversation.id, org.id, owner.id],
    );
    await db.query(
      `insert into aqi_usage_events (org_id, user_id, kind, status, conversation_id, model, input_tokens, output_tokens, latency_ms, cost_micros, cost_estimated, page_route, created_at)
       values ($1, $2, 'message', 'recorded', $3, 'deepseek-flash', 120, 80, 420, 12345, false, '/crm/contacts', now())`,
      [org.id, owner.id, conversation.id],
    );
    await db.query(
      `insert into aqi_usage_events (org_id, user_id, kind, status, metadata, page_route, intent, created_at)
       values ($1, $2, 'knowledge_retrieval', 'recorded', '{"categories":["CRM","Billing"],"matched":2}'::jsonb, '/crm/contacts', 'how_to', now()),
              ($1, $2, 'knowledge_miss', 'recorded', '{"categories":[],"matched":0,"page":"/crm/contacts"}'::jsonb, '/crm/contacts', 'how_to', now()),
              ($1, $2, 'guidance_offer', 'recorded', '{"tutorialSlug":"create-contact","source":"chat"}'::jsonb, '/crm/contacts', null, now()),
              ($1, $2, 'guidance_accept', 'recorded', '{"tutorialSlug":"create-contact","source":"chat"}'::jsonb, '/crm/contacts', null, now()),
              ($1, $2, 'tip_view', 'recorded', '{"tipSlug":"contacts-help"}'::jsonb, '/crm/contacts', null, now()),
              ($1, $2, 'tip_click', 'recorded', '{"tipSlug":"contacts-help","source":"contextual_tip"}'::jsonb, '/crm/contacts', null, now())`,
      [org.id, owner.id],
    );
    await db.query(
      `insert into aqi_usage_events (org_id, user_id, kind, status, created_at) values ($1, $2, 'rate_limit', 'failed', now())`,
      [org.id, owner.id],
    );
    await db.query(
      `insert into aqi_tutorial_events (org_id, user_id, tutorial_id, tutorial_version, attempt, step_key, kind, dedupe_key, created_at)
       values ($1, $2, $3, 1, 1, 'overview', 'started', $4, now()),
              ($1, $2, $3, 1, 1, 'support', 'completed', $5, now())`,
      [org.id, owner.id, tutorial.id, `test-insights-started-${suffix}`, `test-insights-completed-${suffix}`],
    );
    await db.query(
      `insert into aqi_tutorial_progress (org_id, user_id, tutorial_id, tutorial_version, attempt, current_step, status, started_at, last_activity_at, completed_at)
       values ($1, $2, $3, 1, 1, 5, 'completed', now() - interval '2 minutes', now(), now())`,
      [org.id, owner.id, tutorial.id],
    );
    await db.query(
      `insert into aqi_knowledge_entries (title, category, body, status, source, freshness_days, last_reviewed_at, updated_at, published_at)
       values ($1, 'Insights test', 'A stale knowledge entry for the analytics test.', 'published', 'Test source', 30, now() - interval '200 days', now() - interval '200 days', now())`,
      [`Stale entry ${Math.random().toString(16).slice(2)}`],
    );
  });
  return { org, other, owner, tutorial };
}

describe("AQi Insights", () => {
  it("aggregates real usage, performance, knowledge, tutorial, feedback and guidance data", async () => {
    const { org, owner } = await seedInsightData();
    const admin = agencyUser({ id: owner.id, email: "admin@example.test" }, "agency_super_admin");
    const insights = await getAqiInsights(admin, { days: 30 });
    expect(insights.usage.available).toBe(true);
    expect(insights.usage.conversations).toBe(1);
    expect(insights.usage.savedConversations).toBe(1);
    expect(insights.usage.messages).toBe(3);
    expect(insights.usage.activeUsers).toBe(1);
    expect(insights.performance.successful).toBe(1);
    expect(insights.performance.failed).toBe(1);
    expect(insights.performance.latencyP50).not.toBeNull();
    expect(insights.performance.costMicros).toBe(12345);
    expect(insights.performance.rateLimits).toBe(1);
    expect(insights.performance.errors[0].code).toBe("provider_error");

    expect(insights.knowledge.retrievals).toBe(1);
    expect(insights.knowledge.misses).toBe(1);
    expect(insights.knowledge.topCategories.map((row) => row.category).sort()).toEqual(["Billing", "CRM"]);
    expect(insights.knowledge.unansweredByPage[0]).toEqual({ page: "/crm/contacts", count: 1 });
    expect(insights.knowledge.staleCount).toBeGreaterThan(0);

    expect(insights.tutorials.starts).toBe(1);
    expect(insights.tutorials.completions).toBe(1);
    expect(insights.tutorials.completionRate).toBe(100);
    expect(insights.tutorials.averageSeconds).toBeGreaterThanOrEqual(119);
    expect(insights.tutorials.perTutorial[0].slug).toBe("getting-started");

    expect(insights.feedback.helpful).toBe(1);
    expect(insights.feedback.notHelpful).toBe(1);
    expect(insights.feedback.byPage[0].page).toBe("/crm/contacts");
    expect(insights.guidance.offers).toBe(1);
    expect(insights.guidance.accepted).toBe(1);
    expect(insights.guidance.tipsShown).toBe(1);
    expect(insights.guidance.tipsClicked).toBe(1);
    expect(insights.guidance.requestsByPage[0].page).toBe("/crm/contacts");

    // Privacy: no message or feedback text reaches the analytics payload.
    const serialized = JSON.stringify(insights);
    expect(serialized).not.toContain("SECRET CUSTOMER TEXT");
    expect(serialized).not.toContain("SECRET ANSWER TEXT");
    expect(org.id).toBeTruthy();
  });

  it("filters by organization and by role, and labels an empty period honestly", async () => {
    const { other, owner } = await seedInsightData();
    const admin = agencyUser({ id: owner.id, email: "admin@example.test" }, "agency_super_admin");
    const otherOrg = await getAqiInsights(admin, { days: 30, orgId: other.id });
    expect(otherOrg.usage.available).toBe(false);
    expect(otherOrg.usage.messages).toBe(0);
    expect(otherOrg.performance.available).toBe(false);
    expect(otherOrg.tutorials.available).toBe(false);

    const viewerFilter = await getAqiInsights(admin, { days: 30, role: "viewer" });
    expect(viewerFilter.usage.available).toBe(false);

    const empty = await getAqiInsights(admin, { from: "2020-01-01", to: "2020-01-02" });
    expect(empty.range.days).toBe(2);
    expect(empty.usage.available).toBe(false);
    expect(empty.usage.note).toMatch(/No AQi messages|No .* recorded/i);
    expect(empty.knowledge.available).toBe(false);
    expect(empty.tutorials.available).toBe(false);
    expect(empty.performance.provider.available).toBeTypeOf("boolean");
  });

  it("rejects non-Super-Admin access and invalid ranges", async () => {
    const org = await createOrg({});
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const nonAdmin = agencyUser({ id: owner.id, email: "owner@example.test" }, "agency_manager");
    await expect(getAqiInsights(nonAdmin, { days: 30 })).rejects.toThrow(/Super Admin/i);
    const admin = agencyUser({ id: owner.id, email: "admin@example.test" }, "agency_super_admin");
    await expect(getAqiInsights(admin, { from: "2026-10-10", to: "2026-10-01" })).rejects.toThrow(/start date/i);
    await expect(getAqiInsights(admin, { from: "2020-01-01", to: "2026-01-01" })).rejects.toThrow(/366/i);
    await expect(getAqiInsights(admin, { days: 30, role: "not_a_role" })).rejects.toThrow(/valid workspace role/i);
  });

  it("resolves preset and explicit date ranges consistently", () => {
    const preset = resolveAqiInsightsRange({ days: 7 });
    expect(preset.days).toBe(7);
    const explicit = resolveAqiInsightsRange({ from: "2026-10-01", to: "2026-10-19" });
    expect(explicit.days).toBe(19);
    expect(explicit.label).toContain("Oct");
  });
});
