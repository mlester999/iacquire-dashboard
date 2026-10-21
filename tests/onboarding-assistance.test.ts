import { beforeEach, describe, expect, it, vi } from "vitest";
import { suggestOnboardingAnswer, saveOnboardingStep, getOnboardingSession } from "@/server/onboarding/service";
import { withSystem } from "@/server/db";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import type { OrgContext } from "@/server/tenancy/context";
import { ASSISTANCE_FIELDS, missingDetails } from "@/lib/onboarding/assistance";
import { QUESTIONS, QUESTION_BY_ID } from "@/lib/onboarding/definitions";

const model = vi.hoisted(() => ({ configured: true, complete: vi.fn() }));
vi.mock("@/server/llm/client", () => ({
  resolveLlmConfig: async () => model.configured ? { baseUrl: "https://provider.test/v1", format: "openai", model: "configured-model", apiKey: "server-only-secret", source: "portal" } : null,
  llmComplete: model.complete,
}));

let ctx: OrgContext;
const reply = (value: unknown, evidence = [{ factId: "a.business_name", quote: "Marko Bar" }], reason = "Based on your saved information.") => model.complete.mockResolvedValue({ ok: true, text: JSON.stringify({ value, evidence, reason }) });
const save = (values: Record<string, unknown>) => saveOnboardingStep(ctx, { answers: Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { value }])) });
const payload = () => JSON.parse(model.complete.mock.calls.at(-1)![1].user);

beforeEach(async () => {
  model.configured = true;
  model.complete.mockReset();
  const org = await createOrg({ name: "Marko Bar", status: "onboarding" });
  const user = await createUser();
  await addMember(org.id, user.id, "owner");
  ctx = ctxFor(user, org, "owner");
  await save({ "a.business_name": "Marko Bar", "a.industry": "real_estate", "a.business_model": "mixed" });
});

describe("authorized onboarding writing assistance", () => {
  it("covers every existing AI-enabled question with a field-specific intent", () => {
    expect(QUESTIONS.filter((q) => q.assist).map((q) => q.id).sort()).toEqual(Object.keys(ASSISTANCE_FIELDS).sort());
  });

  it("invokes the configured shared provider and returns a limited draft plus optional relevant questions", async () => {
    reply("Marko Bar is a real estate business serving customers in person and online.");
    const result = await suggestOnboardingAnswer(ctx, "a.description");
    expect(model.complete).toHaveBeenCalledWith(expect.objectContaining({ model: "configured-model", source: "portal" }), expect.objectContaining({ timeoutMs: 25000, maxTokens: 1200 }), undefined);
    expect(result).toMatchObject({ limited: true, source: "ai_suggestion" });
    expect(result.clarifications?.map((question) => question.fieldId)).toEqual(["b.services", "a.target_customers"]);
    expect(result.clarifications?.[0].example).toMatch(/Examples only: property sales/);
    expect(payload().question.example).toBeUndefined();
    expect((await getOnboardingSession(ctx)).answers["a.description"]).toBeUndefined();
  });

  it.each(["Marko Bar provides property sales and rentals.", "Marko Bar helps wealthy investors in Manila.", "Marko Bar has 20 years of award winning experience.", "Marko Bar guarantees free brokerage services."])("rejects invented sparse-context detail: %s", async (value) => {
    reply(value);
    await expect(suggestOnboardingAnswer(ctx, "a.description")).rejects.toThrow(/haven't provided/);
  });

  it("passes useful details, current wording and only relevant context to the model", async () => {
    await save({ "b.services": "Property management for small rental portfolios", "a.target_customers": "Independent property owners", "a.location": "Cebu", "a.description": "We manage small rental portfolios", "a.contact_email": "private@example.test", "b.goals": ["more_leads"] });
    reply("Marko Bar manages small rental portfolios for independent property owners in Cebu.", [{ factId: "b.services", quote: "Property management for small rental portfolios" }, { factId: "a.target_customers", quote: "Independent property owners" }, { factId: "a.location", quote: "Cebu" }]);
    const result = await suggestOnboardingAnswer(ctx, "a.description");
    expect(result.limited).toBe(false);
    expect(payload().owner_facts["a.description"].value).toBe("We manage small rental portfolios");
    expect(payload().owner_facts["b.services"].value).toContain("small rental portfolios");
    expect(JSON.stringify(payload())).not.toMatch(/private@example|more_leads/);
    expect(model.complete.mock.calls[0][1].system).toMatch(/UNTRUSTED BUSINESS DATA/);
    expect(model.complete.mock.calls[0][1].system).toMatch(/Never use industry stereotypes/);
  });

  it("rejects new services even when the surrounding business context is detailed", async () => {
    await save({ "b.services": "Property management", "a.target_customers": "Independent property owners", "a.location": "Cebu" });
    reply("Marko Bar provides mortgage brokerage and guarantees investment returns.", [{ factId: "b.services", quote: "Property management" }]);
    await expect(suggestOnboardingAnswer(ctx, "a.description")).rejects.toThrow(/outside your information/);
  });

  it.each(["old", "different-site"])("excludes %s website context", async (kind) => {
    await save({ "a.website": "https://current.example" });
    const analysis = { origin: kind === "old" ? "https://current.example" : "https://previous.example", analyzedAt: new Date(Date.now() - (kind === "old" ? 48 * 3600_000 : 0)).toISOString(), pages: [{ url: "https://previous.example", title: "UNRELATED WEBSITE FACT", description: "UNRELATED WEBSITE FACT", headings: [], paragraphs: [], faqs: [], emails: [], phones: [] }] };
    await withSystem((db) => db.query("insert into onboarding_answers (org_id, question_id, value, source) values ($1, 'x.website_analysis', $2, 'website_analysis')", [ctx.org.orgId, JSON.stringify(analysis)]));
    reply("Marko Bar is a real estate business.");
    await suggestOnboardingAnswer(ctx, "a.description");
    expect(payload().website_excerpt).toBeNull();
    expect(JSON.stringify(payload())).not.toContain("UNRELATED WEBSITE FACT");
  });

  it("uses explicit optional details without persisting them as approved facts or repeating known questions", async () => {
    reply("Marko Bar provides property management.", [{ factId: "b.services", quote: "Property management" }]);
    const result = await suggestOnboardingAnswer(ctx, "a.description", { clarifications: { "b.services": "Property management" } });
    expect(payload().owner_facts["b.services"].value).toBe("Property management");
    expect(result.clarifications?.map((q) => q.fieldId)).toEqual(["a.target_customers"]);
    expect((await getOnboardingSession(ctx)).answers["b.services"]).toBeUndefined();
    await expect(suggestOnboardingAnswer(ctx, "a.description", { clarifications: { "d.pricing_info": "invented" } })).rejects.toThrow(/don't belong/);
  });

  it("offers lightweight clarification for unsupported fields instead of copying the company overview", async () => {
    reply(null, [], "Who are your actual customers?");
    const result = await suggestOnboardingAnswer(ctx, "a.target_customers");
    expect(result.value).toBeNull();
    expect(result.clarifications).toHaveLength(1);
    expect(result.clarifications?.[0].fieldId).toBe("a.target_customers");
    expect(missingDetails(QUESTION_BY_ID["a.description"], { "b.services": "Rentals", "a.target_customers": "Renters" })).toEqual([]);
  });

  it("uses only relevant approved knowledge and lets saved answers take precedence", async () => {
    await withSystem((db) => db.query("insert into company_knowledge (org_id, section, content, review_status) values ($1, 'products_services', 'Approved property management', 'approved'), ($1, 'business_description', 'Pending secret draft', 'pending_agency_review'), ($1, 'policies', 'Unrelated sensitive policy', 'approved')", [ctx.org.orgId]));
    reply("Marko Bar provides property management.", [{ factId: "knowledge.products_services", quote: "Approved property management" }]);
    await suggestOnboardingAnswer(ctx, "a.description");
    expect(JSON.stringify(payload())).toContain("Approved property management");
    expect(JSON.stringify(payload())).not.toMatch(/Pending secret draft|Unrelated sensitive policy/);
    await save({ "e.products": "Current rental services" });
    reply("Marko Bar provides rental services.", [{ factId: "e.products", quote: "Current rental services" }]);
    await suggestOnboardingAnswer(ctx, "a.description");
    expect(JSON.stringify(payload())).not.toContain("Approved property management");
  });

  it("isolates tenants even when the same owner belongs to both", async () => {
    const other = await createOrg({ name: "Other Tenant", status: "onboarding" });
    await addMember(other.id, ctx.user.id, "owner");
    await saveOnboardingStep(ctxFor(ctx.user, other, "owner"), { answers: { "b.services": { value: "OTHER TENANT PRIVATE SERVICE" } } });
    reply("Marko Bar is a real estate business.");
    await suggestOnboardingAnswer(ctx, "a.description");
    expect(JSON.stringify(payload())).not.toContain("OTHER TENANT");
  });

  it("keeps unconfirmed policies out of model context", async () => {
    await saveOnboardingStep(ctx, { answers: { "d.handoff_rules": { value: "Unapproved automatic discounts", source: "ai_suggestion", confirmed: false } } });
    reply(null, [], "Which situations need a person?");
    await suggestOnboardingAnswer(ctx, "d.handoff_rules");
    expect(JSON.stringify(payload())).not.toContain("Unapproved automatic discounts");
    expect((await getOnboardingSession(ctx)).answers["d.handoff_rules"].needsConfirmation).toBe(true);
  });

  it("reuses unchanged drafts, regenerates explicitly and invalidates cache when context changes", async () => {
    reply("Marko Bar is a real estate business.");
    await suggestOnboardingAnswer(ctx, "a.description");
    await suggestOnboardingAnswer(ctx, "a.description");
    expect(model.complete).toHaveBeenCalledTimes(1);
    await suggestOnboardingAnswer(ctx, "a.description", { regenerate: true });
    expect(model.complete).toHaveBeenCalledTimes(2);
    await save({ "a.location": "Cebu" });
    await suggestOnboardingAnswer(ctx, "a.description");
    expect(model.complete).toHaveBeenCalledTimes(3);
  });

  it("deduplicates concurrent identical generation", async () => {
    let release!: (value: { ok: true; text: string }) => void;
    model.complete.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const first = suggestOnboardingAnswer(ctx, "a.description");
    const second = suggestOnboardingAnswer(ctx, "a.description");
    await vi.waitFor(() => expect(model.complete).toHaveBeenCalledTimes(1));
    release({ ok: true, text: JSON.stringify({ value: "Marko Bar is a real estate business.", reason: "Based on your information.", evidence: [{ factId: "a.business_name", quote: "Marko Bar" }] }) });
    expect(await first).toEqual(await second);
  });

  it.each(["not JSON", JSON.stringify({ value: "Invented", reason: "x", evidence: [{ factId: "foreign", quote: "Secret" }] }), JSON.stringify({ value: "Invented", reason: "x", evidence: [{ factId: "a.business_name", quote: "Not supplied" }] }), JSON.stringify({ value: "x".repeat(2001), reason: "x", evidence: [{ factId: "a.business_name", quote: "Marko Bar" }] })])("rejects malformed or ungrounded provider output", async (text) => {
    model.complete.mockResolvedValue({ ok: true, text });
    await expect(suggestOnboardingAnswer(ctx, "a.description")).rejects.toThrow();
  });

  it("reports a disconnected provider and upstream failure without falling back to a template", async () => {
    model.configured = false;
    await expect(suggestOnboardingAnswer(ctx, "a.description")).rejects.toThrow(/Integrations/);
    expect(model.complete).not.toHaveBeenCalled();
    model.configured = true;
    model.complete.mockResolvedValue({ ok: false, status: 0 });
    await expect(suggestOnboardingAnswer(ctx, "a.description")).rejects.toThrow(/couldn't answer/);
  });

  it("enforces permission, request size, hidden-field and usage limits", async () => {
    await expect(suggestOnboardingAnswer({ ...ctx, can: () => false }, "a.description")).rejects.toThrow(/Only owners/);
    await expect(suggestOnboardingAnswer(ctx, "a.description", { clarifications: { "b.services": "x".repeat(801) } })).rejects.toThrow();
    await expect(suggestOnboardingAnswer(ctx, "d.pricing_info")).rejects.toThrow(/current setup/);
    await withSystem((db) => db.query("insert into rate_limit_buckets (bucket_key, window_start, hits) values ($1, to_timestamp(floor(extract(epoch from now()) / 3600) * 3600), 25)", [`onboarding:assist:${ctx.org.orgId}`]));
    reply("Marko Bar is a real estate business.");
    await expect(suggestOnboardingAnswer(ctx, "a.description")).rejects.toThrow(/lot of suggestions/);
    expect(model.complete).not.toHaveBeenCalled();
  });
});
