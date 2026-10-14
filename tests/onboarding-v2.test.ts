import crypto from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { QUESTIONS, QUESTION_BY_ID } from "@/lib/onboarding/definitions";
import {
  buildReviewModel, computeProgress, confirmedAnswers, effectiveAnswers, neighbour, resolveCurrentQuestion, submitCheck, toKnowledgeSections,
  toLegacyData, toRoleAnswers, validateAnswer, visibleQuestions, type ConnectionFacts,
} from "@/lib/onboarding/engine";
import type { Answers, StoredAnswers } from "@/lib/onboarding/types";
import { getOnboardingReview, getOnboardingSession, readOnboardingWebsite, saveOnboardingStep, submitOnboarding, suggestOnboardingAnswer } from "@/server/onboarding/service";
import type { PageFetcher } from "@/server/onboarding/website";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

const llm = vi.hoisted(() => ({ config: null as null | object, reply: { ok: true, text: "{}" } as { ok: boolean; text?: string; status?: number } }));
vi.mock("@/server/llm/client", () => ({
  resolveLlmConfig: async () => llm.config,
  llmComplete: async () => llm.reply,
}));

const stored = (a: Answers, extra: StoredAnswers = {}): StoredAnswers => {
  const out: StoredAnswers = {};
  for (const [id, value] of Object.entries(a)) out[id] = { value: value as never, skipped: false, source: "user", needsConfirmation: false, updatedAt: new Date().toISOString() };
  return { ...out, ...extra };
};
const ids = (a: Answers) => visibleQuestions(a).map((q) => q.id);

/** Every required question answered, for a local home-services business that wants appointments and a website. */
const baseAnswers = (): Answers => ({
  "a.business_name": "Brightside Roofing",
  "a.industry": "home_services",
  "a.business_model": "local",
  "a.description": "We repair and replace roofs for homeowners in Austin.",
  "a.timezone": "America/Chicago",
  "a.contact_email": "hello@brightside.test",
  "b.goals": ["more_leads", "more_appointments"],
  "b.appointments": true,
  "b.website_need": "new",
  "d.pricing_policy": "never",
  "f.review": true,
});

describe("adaptive question rules", () => {
  it("shows industry-specific questions only to the matching industry", () => {
    expect(ids({ ...baseAnswers(), "a.industry": "real_estate" })).toContain("b.re_property_types");
    expect(ids({ ...baseAnswers(), "a.industry": "real_estate" })).not.toContain("b.hs_emergency");
    expect(ids({ ...baseAnswers(), "a.industry": "healthcare" })).toEqual(expect.arrayContaining(["b.hc_services", "d.hc_insurance", "d.hc_emergency"]));
    expect(ids({ ...baseAnswers(), "a.industry": "agency" })).toEqual(expect.arrayContaining(["b.ag_target_clients", "b.ag_min_budget", "d.ag_discovery"]));
    expect(ids(baseAnswers())).toEqual(expect.arrayContaining(["b.hs_emergency", "d.hs_quote"]));
    expect(ids(baseAnswers())).not.toContain("b.re_buyers");
    expect(ids({ ...baseAnswers(), "a.industry": "ecommerce" })).not.toEqual(expect.arrayContaining(["b.hc_services"]));
  });

  it("asks about appointments, channels and websites only when they apply", () => {
    const withAppts = ids(baseAnswers());
    expect(withAppts).toEqual(expect.arrayContaining(["b.appointment_goal", "d.appt_types", "d.appt_availability", "d.appt_notice", "d.appt_cancellation"]));
    const noAppts = ids({ ...baseAnswers(), "b.appointments": false });
    for (const id of ["b.appointment_goal", "d.appt_types", "d.appt_availability", "d.appt_notice", "d.appt_cancellation"]) expect(noAppts).not.toContain(id);

    expect(ids(baseAnswers())).not.toEqual(expect.arrayContaining(["c.sms_sender"]));
    const sms = ids({ ...baseAnswers(), "c.channels": ["sms", "email"] });
    expect(sms).toEqual(expect.arrayContaining(["c.sms_sender", "c.email_sender"]));
    expect(sms).not.toContain("c.whatsapp_number");

    expect(ids(baseAnswers())).toEqual(expect.arrayContaining(["e.design_style", "e.website_pages", "e.domain_plan", "e.reference_images"]));
    const noSite = ids({ ...baseAnswers(), "b.website_need": "have" });
    for (const id of ["e.design_style", "e.website_pages", "e.domain_plan", "e.reference_images", "e.design_notes"]) expect(noSite).not.toContain(id);
  });

  it("skips service territories for purely online businesses, except where area matters", () => {
    expect(ids({ ...baseAnswers(), "a.business_model": "online", "a.industry": "consulting" })).not.toContain("a.territories");
    expect(ids({ ...baseAnswers(), "a.business_model": "online", "a.industry": "real_estate" })).toContain("a.territories");
    expect(ids({ ...baseAnswers(), "a.business_model": "local" })).toContain("a.territories");
  });

  it("offers appointment purposes that fit the industry", () => {
    const q = QUESTION_BY_ID["b.appointment_goal"];
    const real = validateAnswer(q, "viewing", { ...baseAnswers(), "a.industry": "real_estate" });
    expect(real.ok).toBe(true);
    expect(validateAnswer(q, "viewing", { ...baseAnswers(), "a.industry": "agency" }).ok).toBe(false);
    expect(validateAnswer(q, "discovery", { ...baseAnswers(), "a.industry": "agency" }).ok).toBe(true);
  });

  it("has six sections, unique ids and a final review question", () => {
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(QUESTIONS.length);
    expect([...new Set(QUESTIONS.map((q) => q.section))].sort()).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(QUESTIONS.at(-1)?.id).toBe("f.review");
    expect(visibleQuestions(baseAnswers()).length).toBeGreaterThan(30);
  });
});

describe("answer validation", () => {
  const q = (id: string) => QUESTION_BY_ID[id];
  it("normalizes contact details and rejects malformed ones", () => {
    expect(validateAnswer(q("a.contact_email"), "  Hello@Brightside.TEST ")).toEqual({ ok: true, value: "hello@brightside.test" });
    expect(validateAnswer(q("a.contact_email"), "not-an-email").ok).toBe(false);
    expect(validateAnswer(q("a.contact_phone"), "+1 (512) 555-0100")).toEqual({ ok: true, value: "+15125550100" });
    expect(validateAnswer(q("a.contact_phone"), "512 555 0100").ok).toBe(false);
    expect(validateAnswer(q("a.website"), "brightside.test/")).toEqual({ ok: true, value: "https://brightside.test" });
    expect(validateAnswer(q("a.website"), "javascript:alert(1)").ok).toBe(false);
    expect(validateAnswer(q("a.timezone"), "Mars/Olympus").ok).toBe(false);
  });

  it("validates choices, multi-selects, hours, lists, colours and files", () => {
    expect(validateAnswer(q("a.industry"), "wizardry").ok).toBe(false);
    expect(validateAnswer(q("b.goals"), ["more_leads", "bogus"]).ok).toBe(false);
    expect(validateAnswer(q("e.design_style"), ["modern", "bold", "classic", "warm"]).ok).toBe(false);
    expect(validateAnswer(q("a.hours"), { mon: [["09:00", "17:00"]] }).ok).toBe(true);
    expect(validateAnswer(q("a.hours"), { mon: [["17:00", "09:00"]] }).ok).toBe(false);
    expect(validateAnswer(q("e.brand_colors"), { primary: "#2C5BFF", accent: "" })).toEqual({ ok: true, value: { primary: "#2c5bff", accent: "" } });
    expect(validateAnswer(q("e.brand_colors"), { primary: "blue", accent: "" }).ok).toBe(false);
    expect(validateAnswer(q("e.logo"), ["not-a-uuid"]).ok).toBe(false);
    expect(validateAnswer(q("e.logo"), [crypto.randomUUID(), crypto.randomUUID()]).ok).toBe(false);
    const rows = validateAnswer(q("d.team"), [{ name: "Sam", email: "SAM@x.test", role: "sales_rep" }, { name: "", email: "", role: "" }]);
    expect(rows).toEqual({ ok: true, value: [{ name: "Sam", email: "sam@x.test", role: "sales_rep" }] });
    expect(validateAnswer(q("d.team"), [{ name: "Sam", email: "bad", role: "sales_rep" }]).ok).toBe(false);
    expect(validateAnswer(q("d.team"), [{ name: "Sam", email: "", role: "sales_rep" }]).ok).toBe(false);
    expect(validateAnswer(q("d.appt_types"), [{ name: "Inspection", minutes: "30", mode: "in_person" }]).ok).toBe(true);
    expect(validateAnswer(q("d.appt_types"), [{ name: "Inspection", minutes: "0", mode: "in_person" }]).ok).toBe(false);
  });

  it("strips control characters and caps length", () => {
    const res = validateAnswer(q("a.business_name"), `Bright\u0000side${"x".repeat(500)}`);
    expect(res.ok && typeof res.value === "string" && res.value.startsWith("Brightside") && res.value.length).toBe(120);
  });
});

describe("progress, resume and hidden answers", () => {
  it("counts required questions outstanding and finishes at zero", () => {
    expect(computeProgress({}).requiredOutstanding).toEqual(expect.arrayContaining(["a.business_name", "a.industry", "b.goals", "b.appointments"]));
    const done = computeProgress(stored(baseAnswers()));
    expect(done.requiredOutstanding.filter((id) => id !== "f.review")).toEqual([]);
  });

  it("ignores answers whose question is hidden by a later answer", () => {
    const withTypes = stored({ ...baseAnswers(), "d.appt_types": [{ name: "Inspection", minutes: "30", mode: "in_person" }] });
    expect(toRoleAnswers(effectiveAnswers(withTypes)).appointment_setter.meeting_types).toContain("Inspection");
    const switchedOff = stored({ ...baseAnswers(), "b.appointments": false, "d.appt_types": [{ name: "Inspection", minutes: "30", mode: "in_person" }] });
    expect(effectiveAnswers(switchedOff)["d.appt_types"]).toBeUndefined();
    expect(toRoleAnswers(confirmedAnswers(switchedOff)).appointment_setter.meeting_types).toMatch(/not enabled/i);
    expect(computeProgress(switchedOff).total).toBeLessThan(computeProgress(withTypes).total);
  });

  it("resumes on the saved question, or the next visible one if it became hidden", () => {
    const s = stored({ ...baseAnswers(), "b.appointments": false });
    expect(resolveCurrentQuestion(s, "c.tone")).toBe("c.tone");
    const next = resolveCurrentQuestion(s, "d.appt_types");
    expect(next).not.toBe("d.appt_types");
    expect(QUESTIONS.findIndex((x) => x.id === next)).toBeGreaterThan(QUESTIONS.findIndex((x) => x.id === "d.appt_types"));
    expect(resolveCurrentQuestion({}, null)).toBe("a.business_name");
    // With every required answer in and no saved position, continue at the review.
    expect(resolveCurrentQuestion(stored({ ...baseAnswers(), "f.review": false }), null)).toBe("f.review");
    expect(resolveCurrentQuestion({}, "not.a.question")).toBe("a.business_name");
    expect(neighbour(s, "a.business_name", -1)).toBeNull();
    expect(neighbour(s, "a.business_name", 1)).toBe("a.industry");
  });

  it("blocks submission until required answers, AI confirmations and approval are all in", () => {
    const base = stored(baseAnswers());
    expect(submitCheck(base).canSubmit).toBe(true);
    expect(submitCheck(stored({ ...baseAnswers(), "f.review": false })).blockers).toContain("Confirm that you approve this setup");
    const aiFaq = stored(baseAnswers(), { "e.faqs": { value: [{ question: "Q?", answer: "A" }], skipped: false, source: "website_analysis", needsConfirmation: true, updatedAt: "" } });
    const check = submitCheck(aiFaq);
    expect(check.canSubmit).toBe(false);
    expect(check.blockers.some((b) => b.startsWith("Check the AI-suggested answer"))).toBe(true);
    expect(submitCheck(stored({}, {})).blockers.length).toBeGreaterThan(3);
  });

  it("uses only confirmed answers when building knowledge and configurations", () => {
    const s = stored(baseAnswers(), {
      "e.faqs": { value: [{ question: "Do you offer warranties?", answer: "Invented by a model." }], skipped: false, source: "ai_suggestion", needsConfirmation: true, updatedAt: "" },
      "e.policies": { value: "30-day workmanship warranty.", skipped: false, source: "user", needsConfirmation: false, updatedAt: "" },
    });
    const sections = Object.fromEntries(toKnowledgeSections(confirmedAnswers(s)).map((x) => [x.section, x.content]));
    expect(sections.faq).toBeUndefined();
    expect(sections.policies).toContain("30-day workmanship warranty.");
    expect(JSON.stringify(toLegacyData(confirmedAnswers(s), ["lead_hunter"]))).not.toContain("Invented by a model");
  });
});

describe("review model", () => {
  const facts = (over: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
    crmLinked: false, aiEmployeesVerified: 0, aiEmployeesTotal: 6, automationMapped: false,
    channels: { sms: { enabled: false, registration: "not_started" }, whatsapp: { enabled: false, registration: "not_started" }, email: { enabled: false, registration: "not_started" } },
    calendarConnected: false, websiteDomainVerified: false, invitedStaff: 0, ...over,
  });
  const six = ["operations_manager", "lead_hunter", "appointment_setter", "sales_assistant", "crm_manager", "performance_analyst"] as const;

  it("reports real missing connections and tasks instead of assuming readiness", () => {
    const s = stored({ ...baseAnswers(), "c.channels": ["sms", "email"], "d.team": [{ name: "Sam", email: "sam@x.test", role: "sales_rep" }] });
    const r = buildReviewModel(s, facts(), [...six]);
    const keys = r.missingConnections.map((m) => m.key);
    expect(keys).toEqual(expect.arrayContaining(["crm", "ai", "automation", "channel:sms", "channel:email", "calendar"]));
    expect(r.humanTasks.some((t) => t.key === "invite" && t.owner === "you")).toBe(true);
    expect(r.humanTasks.some((t) => t.key === "crm" && t.owner === "iacquire")).toBe(true);
    expect(r.messaging.find((m) => m.label === "Automatic replies")?.value).toMatch(/off until/i);
    expect(r.employees).toHaveLength(6);
    expect(r.permissions.join(" ")).toMatch(/AI assistant/);
  });

  it("drops missing-connection warnings once the facts say they are connected", () => {
    const s = stored({ ...baseAnswers(), "c.channels": ["email"] });
    const ready = facts({
      crmLinked: true, aiEmployeesVerified: 6, automationMapped: true, calendarConnected: true,
      channels: { sms: { enabled: false, registration: "x" }, whatsapp: { enabled: false, registration: "x" }, email: { enabled: true, registration: "approved" } },
    });
    expect(buildReviewModel(s, ready, [...six]).missingConnections).toEqual([]);
  });

  it("distinguishes optional gaps from required ones in the summary", () => {
    const r = buildReviewModel(stored({ ...baseAnswers(), "a.business_name": "" }), facts(), [...six]);
    const rows = Object.fromEntries(r.sections.flatMap((s) => s.rows).map((row) => [row.questionId, row]));
    expect(rows["a.business_name"]).toMatchObject({ required: true, state: "outstanding" });
    expect(rows["a.website"]).toMatchObject({ required: false, state: "outstanding", value: "" });
  });

  it("flags employees that lack what they need", () => {
    const noAppts = buildReviewModel(stored({ ...baseAnswers(), "b.appointments": false }), facts(), [...six]);
    expect(noAppts.employees.find((e) => e.role === "appointment_setter")?.gaps.join(" ")).toMatch(/booking is off/i);
    const noTypes = buildReviewModel(stored(baseAnswers()), facts(), [...six]);
    expect(noTypes.employees.find((e) => e.role === "appointment_setter")?.gaps.join(" ")).toMatch(/no appointment types/i);
  });
});

// ---------------------------------------------------------------------------
// Persistence against the real migrations and row-level security
// ---------------------------------------------------------------------------

let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let rep: { id: string; email: string };
let stranger: { id: string; email: string };
const as = (u: typeof owner, o: typeof org, role: "owner" | "admin" | "member" | "sales_rep") => ctxFor(u, o, role);

beforeAll(async () => {
  org = await createOrg({ name: "Persist Co", status: "onboarding" });
  other = await createOrg({ name: "Other Co" });
  owner = await createUser();
  rep = await createUser();
  stranger = await createUser();
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, rep.id, "sales_rep");
  await addMember(other.id, stranger.id, "owner");
  await withSystem((db) => db.query("update organizations set industry = 'Real estate', website = 'https://persist.test' where id = $1", [org.id]));
});

const save = (answers: Record<string, { value?: unknown; skipped?: boolean; source?: "user" | "ai_suggestion" | "website_analysis"; confirmed?: boolean }>, currentQuestionId?: string, who = owner) =>
  saveOnboardingStep(as(who, org, "owner"), { answers, currentQuestionId });

describe("onboarding persistence", () => {
  it("prefills from the workspace profile once and keeps it as editable prefill", async () => {
    const s = await getOnboardingSession(as(owner, org, "owner"));
    expect(s.answers["a.business_name"].value).toBe("Persist Co");
    expect(s.answers["a.business_name"].source).toBe("prefill");
    expect(s.answers["a.industry"].value).toBe("real_estate");
    expect(s.answers["a.description"].value).toBe("We help local homeowners.");
    expect(s.currentQuestionId).toBeTruthy();
    expect(s.status).toBe("draft");
    const again = await getOnboardingSession(as(owner, org, "owner"));
    expect(Object.keys(again.answers).sort()).toEqual(Object.keys(s.answers).sort());
  });

  it("stores each answer and the exact question, and resumes there from a fresh session", async () => {
    const res = await save({ "a.location": { value: "Austin, Texas" }, "a.contact_email": { value: "Owner@Persist.test" } }, "a.contact_phone");
    expect(res.rejected).toEqual({});
    expect(res.currentQuestionId).toBe("a.contact_phone");
    expect(res.revision).toBeGreaterThan(0);
    const later = await getOnboardingSession(as(owner, org, "owner")); // "new device": nothing carried from the browser
    expect(later.currentQuestionId).toBe("a.contact_phone");
    expect(later.answers["a.location"].value).toBe("Austin, Texas");
    expect(later.answers["a.contact_email"].value).toBe("owner@persist.test");
    expect(later.revision).toBe(res.revision);
  });

  it("rejects bad answers without losing the good ones, and never reports a rejected write as saved", async () => {
    const res = await save({ "a.contact_phone": { value: "5125550100" }, "a.hours": { value: { mon: [["09:00", "17:00"]] } } });
    expect(res.rejected["a.contact_phone"]).toMatch(/country code/);
    const s = await getOnboardingSession(as(owner, org, "owner"));
    expect(s.answers["a.contact_phone"]).toBeUndefined();
    expect(s.answers["a.hours"].value).toEqual({ mon: [["09:00", "17:00"]] });
  });

  it("refuses unknown questions and lets only optional questions be skipped", async () => {
    await expect(save({ "z.nonsense": { value: "x" } })).rejects.toThrow(/doesn't exist/);
    await expect(saveOnboardingStep(as(owner, org, "owner"), { answers: {}, currentQuestionId: "nope" })).rejects.toThrow(/doesn't exist/);
    const required = await save({ "a.business_name": { skipped: true } });
    expect(required.rejected["a.business_name"]).toMatch(/required/);
    const optional = await save({ "a.target_customers": { skipped: true } });
    expect(optional.rejected).toEqual({});
    expect((await getOnboardingSession(as(owner, org, "owner"))).answers["a.target_customers"].skipped).toBe(true);
  });

  it("detects a stale base revision from another device but still merges the answers", async () => {
    const before = await getOnboardingSession(as(owner, org, "owner"));
    await save({ "a.location": { value: "Dallas" } });
    const stale = await saveOnboardingStep(as(owner, org, "owner"), { answers: { "a.territories": { value: "Dallas" } }, baseRevision: before.revision });
    expect(stale.staleBase).toBe(true);
    const s = await getOnboardingSession(as(owner, org, "owner"));
    expect(s.answers["a.location"].value).toBe("Dallas");
    expect(s.answers["a.territories"].value).toBe("Dallas");
  });

  it("only owners and managers can save, and another tenant sees nothing", async () => {
    await expect(saveOnboardingStep(as(rep, org, "sales_rep"), { answers: { "a.location": { value: "Hacked" } } })).rejects.toThrow(/Only owners/);
    expect((await getOnboardingSession(as(owner, org, "owner"))).answers["a.location"].value).not.toBe("Hacked");
    const leak = await withUser(stranger.id, (db) => db.query("select * from onboarding_answers where org_id = $1", [org.id]));
    expect(leak.rows).toEqual([]);
    await expect(withUser(stranger.id, (db) => db.query("insert into onboarding_answers (org_id, question_id, value) values ($1, 'a.location', '\"x\"')", [org.id]))).rejects.toThrow();
    await expect(withUser(stranger.id, (db) => db.query("update onboarding_answers set value = '\"x\"' where org_id = $1", [org.id])).then((r) => { if (r.rowCount) throw new Error("updated"); })).resolves.toBeUndefined();
  });

  it("keeps AI-suggested policy-like answers unconfirmed until the owner vouches for them", async () => {
    await save({ "e.faqs": { value: [{ question: "Do you offer financing?", answer: "Yes, through partners." }], source: "website_analysis" } });
    let s = await getOnboardingSession(as(owner, org, "owner"));
    expect(s.answers["e.faqs"].needsConfirmation).toBe(true);
    expect(s.progress.needsConfirmation).toContain("e.faqs");
    await save({ "e.faqs": { value: [{ question: "Do you offer financing?", answer: "Yes, through partners." }], source: "website_analysis", confirmed: true } });
    s = await getOnboardingSession(as(owner, org, "owner"));
    expect(s.answers["e.faqs"].needsConfirmation).toBe(false);
    // A non-sensitive AI suggestion is simply an editable answer, labelled by source.
    await save({ "a.target_customers": { value: "Local homeowners.", source: "ai_suggestion" } });
    s = await getOnboardingSession(as(owner, org, "owner"));
    expect(s.answers["a.target_customers"]).toMatchObject({ source: "ai_suggestion", needsConfirmation: false });
  });
});

describe("submission", () => {
  it("is refused until the questionnaire is complete and approved", async () => {
    await expect(submitOnboarding(as(owner, org, "owner"))).rejects.toThrow();
    await expect(submitOnboarding(as(rep, org, "sales_rep"))).rejects.toThrow(/Only owners/);
  });

  it("applies the answers: six configurations, profile, contact details, messaging preferences (off), knowledge", async () => {
    await save({
      "a.business_name": { value: "Persist Co" },
      "a.business_model": { value: "local" },
      "a.description": { value: "We help homeowners in Austin with roof repair and replacement." },
      "a.timezone": { value: "America/Chicago" },
      "a.contact_phone": { value: "+1 512 555 0100" },
      "a.hours": { value: { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]] } },
      "b.goals": { value: ["more_leads", "more_appointments"] },
      "b.services": { value: "Roof inspections, repairs and gutters." },
      "b.appointments": { value: true },
      "b.website_need": { value: "new" },
      "c.tone": { value: "professional" },
      "c.channels": { value: ["sms"] },
      "c.response_hours": { value: "business_hours" },
      "c.never_promise": { value: "Exact prices before an inspection." },
      "c.human_escalation": { value: ["complaint", "refund_concern"] },
      "d.appt_types": { value: [{ name: "Free inspection", minutes: "30", mode: "in_person" }] },
      "d.pricing_policy": { value: "never" },
      "d.followup": { value: "gentle" },
      "e.policies": { value: "30-day workmanship warranty." },
      "e.brand_colors": { value: { primary: "#2C5BFF", accent: "#12C9A5" } },
      "e.faqs": { value: [{ question: "Do you offer financing?", answer: "Yes, through partners." }], source: "website_analysis", confirmed: true },
      "f.review": { value: true },
    });
    const ready = await getOnboardingSession(as(owner, org, "owner"));
    expect(submitCheck(ready.answers).blockers).toEqual([]);

    const outcome = await submitOnboarding(as(owner, org, "owner"));
    expect(outcome.employees).toHaveLength(6);
    const q = (sql: string, p: unknown[] = [org.id]) => withSystem((db) => db.query<Record<string, unknown>>(sql, p)).then((r) => r.rows);

    const versions = await q("select count(*)::int as n from agent_config_versions where org_id = $1 and source = 'onboarding'");
    expect(versions[0].n).toBe(6);
    const appointment = await q("select v.settings from agent_instances a join agent_config_versions v on v.id = a.active_config_version_id where a.org_id = $1 and a.role_key = 'appointment_setter'");
    expect(JSON.stringify(appointment[0].settings)).toContain("Free inspection");
    expect(JSON.stringify(appointment[0].settings)).toContain("professional");

    const profile = (await q("select contact_phone, brand_color, brand_accent_color from company_profiles where org_id = $1"))[0];
    expect(profile).toMatchObject({ contact_phone: "+15125550100", brand_color: "#2c5bff", brand_accent_color: "#12c9a5" });
    expect((await q("select timezone from organizations where id = $1"))[0].timezone).toBe("America/Chicago");

    const ms = (await q("select auto_reply_enabled, reply_business_hours_only, followup_preset, business_hours from messaging_settings where org_id = $1"))[0];
    expect(ms.auto_reply_enabled).toBe(false); // preferences configure; they never switch sending on
    expect(ms.reply_business_hours_only).toBe(true);
    expect(ms.followup_preset).toBe("gentle");
    expect(ms.business_hours).toEqual({ mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]] });
    expect((await q("select count(*)::int as n from messaging_channels where org_id = $1 and enabled"))[0].n).toBe(0);

    const knowledge = Object.fromEntries((await q("select section, content, seeded_hash from company_knowledge where org_id = $1")).map((r) => [r.section, r]));
    expect(knowledge.faq.content).toContain("Do you offer financing?");
    expect(knowledge.policies.content).toContain("30-day workmanship warranty.");
    expect(knowledge.approved_pricing.content).toMatch(/Do not share prices/);
    expect(knowledge.faq.seeded_hash).toMatch(/^[0-9a-f]{64}$/);

    const session = await getOnboardingSession(as(owner, org, "owner"));
    expect(session.status).toBe("submitted");
    expect(session.completedAt).toBeTruthy();
    expect(session.hasUnsubmittedChanges).toBe(false);
    expect((await q("select action from audit_logs where org_id = $1 and action = 'onboarding.completed'")).length).toBe(1);
  });

  it("on re-submission refreshes untouched knowledge, keeps edits made elsewhere, and preserves per-employee customisation", async () => {
    // The owner personalised one employee after setup, and rewrote policies in the Knowledge Center.
    await withSystem(async (db) => {
      const { rows } = await db.query<{ id: string; v: string }>("select a.id, a.active_config_version_id as v from agent_instances a where a.org_id = $1 and a.role_key = 'sales_assistant'", [org.id]);
      await db.query("update agent_config_versions set settings = jsonb_set(settings, '{displayName}', '\"Sunny\"') where id = $1", [rows[0].v]);
      await db.query("update company_knowledge set content = 'Our own rewritten policy.' where org_id = $1 and section = 'policies'", [org.id]);
    });
    await save({
      "e.faqs": { value: [{ question: "Do you offer financing?", answer: "Yes, through partners." }, { question: "Are you insured?", answer: "Yes, fully." }], source: "user" },
      "e.policies": { value: "Brand-new policy text from onboarding." },
      "c.tone": { value: "casual" },
    });
    const session = await getOnboardingSession(as(owner, org, "owner"));
    expect(session.hasUnsubmittedChanges).toBe(true);
    // Editing withdrew the earlier approval: the owner has to approve the new answers.
    expect(session.answers["f.review"].value).toBe(false);
    await expect(submitOnboarding(as(owner, org, "owner"))).rejects.toThrow(/approve/i);
    await save({ "f.review": { value: true } });
    const outcome = await submitOnboarding(as(owner, org, "owner"));
    expect(outcome.knowledge.written).toContain("faq");
    expect(outcome.knowledge.kept).toContain("policies");
    const rows = await withSystem((db) => db.query<{ section: string; content: string }>("select section, content from company_knowledge where org_id = $1", [org.id]));
    const k = Object.fromEntries(rows.rows.map((r) => [r.section, r.content]));
    expect(k.policies).toBe("Our own rewritten policy.");
    expect(k.faq).toContain("Are you insured?");
    const sales = await withSystem((db) => db.query<{ settings: { displayName: string; tone: string } }>("select v.settings from agent_instances a join agent_config_versions v on v.id = a.active_config_version_id where a.org_id = $1 and a.role_key = 'sales_assistant'", [org.id]));
    expect(sales.rows[0].settings.displayName).toBe("Sunny");
    expect(sales.rows[0].settings.tone).toBe("casual");
    // Re-submitting identical answers does not create version noise.
    const count = async () => (await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from agent_config_versions where org_id = $1", [org.id]))).rows[0].n;
    await save({ "f.review": { value: true } });
    const before = await count();
    const again = await submitOnboarding(as(owner, org, "owner"));
    expect(again.employees.every((e) => e.configStatus === "unchanged")).toBe(true);
    expect(await count()).toBe(before);
  });

  it("builds a review from real connection state", async () => {
    const review = await getOnboardingReview(as(owner, org, "owner"));
    expect(review.missingConnections.map((m) => m.key)).toEqual(expect.arrayContaining(["crm", "ai", "channel:sms"]));
    expect(review.canSubmit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Website reading and the optional assistant: suggestions only
// ---------------------------------------------------------------------------

const html = (body: string, head = "") => `<html><head><title>Brightside Roofing</title><meta name="description" content="Family-owned roofing in Austin."/>${head}</head><body>${body}</body></html>`;
const site = (pages: Record<string, { status?: number; body: string; type?: string }>): PageFetcher => async (url) => {
  const hit = pages[url.pathname];
  if (!hit) return { url: url.toString(), status: 404, contentType: "text/html", body: "" };
  return { url: url.toString(), status: hit.status ?? 200, contentType: hit.type ?? "text/html", body: hit.body };
};

describe("website reading and AI suggestions", () => {
  let fresh: Awaited<ReturnType<typeof createOrg>>;
  let ownerB: { id: string; email: string };
  beforeAll(async () => {
    fresh = await createOrg({ name: "Reader Co", status: "onboarding" });
    ownerB = await createUser();
    await addMember(fresh.id, ownerB.id, "owner");
  });
  const ctxB = () => as(ownerB, fresh, "owner");

  it("reads a public site, stores an unverified reference and offers suggestions the owner must accept", async () => {
    const fetcher = site({
      "/": { body: html('<h1>Roofing done right</h1><a href="/faq">FAQ</a><a href="mailto:info@brightside.test">Mail</a>') },
      "/faq": { body: html("<h2>Do you offer free inspections?</h2><p>Yes, every roof gets a free inspection first.</p>") },
    });
    await getOnboardingSession(ctxB());
    await saveOnboardingStep(ctxB(), { answers: { "a.description": { skipped: true } as never } }).catch(() => undefined);
    const summary = await readOnboardingWebsite(ctxB(), "https://brightside.example", fetcher);
    expect(summary.suggestions.map((s) => s.questionId)).toEqual(expect.arrayContaining(["a.contact_email", "e.faqs"]));
    const stored = await withSystem((db) => db.query("select source, needs_confirmation from onboarding_answers where org_id = $1 and question_id = 'x.website_analysis'", [fresh.id]));
    expect(stored.rows[0]).toMatchObject({ source: "website_analysis" });
    // Nothing was written as an answer by merely reading the site.
    const s = await getOnboardingSession(ctxB());
    expect(s.answers["e.faqs"]).toBeUndefined();
    expect(s.websiteAnalysis?.origin).toBe("https://brightside.example");
  });

  it("refuses private addresses and sites that disallow automated readers", async () => {
    await expect(readOnboardingWebsite(ctxB(), "http://169.254.169.254/latest/meta-data", site({}))).rejects.toThrow(/can't be read/);
    await expect(readOnboardingWebsite(ctxB(), "http://localhost:3000", site({}))).rejects.toThrow(/can't be read/);
    await expect(readOnboardingWebsite(ctxB(), "https://user:pw@brightside.example", site({}))).rejects.toThrow(/username or password/);
    const blocked = site({ "/robots.txt": { body: "User-agent: *\nDisallow: /" }, "/": { body: html("hi") } });
    await expect(readOnboardingWebsite(ctxB(), "https://blocked.example", blocked)).rejects.toThrow(/stay away/);
  });

  it("explains honestly when no AI assistant is connected", async () => {
    llm.config = null;
    await expect(suggestOnboardingAnswer(ctxB(), "a.description")).rejects.toThrow(/isn't connected/);
    await expect(suggestOnboardingAnswer(ctxB(), "a.business_name")).rejects.toThrow(/no suggestion/);
  });

  it("will not compose FAQs or prices without the owner's website to read", async () => {
    llm.config = { baseUrl: "https://llm.test", format: "openai", model: "m", apiKey: "k", source: "environment" };
    const fresh2 = await createOrg({ name: "No Site Co", status: "onboarding" });
    const o = await createUser();
    await addMember(fresh2.id, o.id, "owner");
    await expect(suggestOnboardingAnswer(as(o, fresh2, "owner"), "e.faqs")).rejects.toThrow(/only suggest this from your website/);
    await expect(suggestOnboardingAnswer(as(o, fresh2, "owner"), "d.pricing_info")).rejects.toThrow(/only suggest this from your website/);
  });

  it("returns validated, labelled suggestions and rejects malformed model output", async () => {
    llm.config = { baseUrl: "https://llm.test", format: "openai", model: "m", apiKey: "k", source: "environment" };
    await saveOnboardingStep(ctxB(), { answers: { "a.business_name": { value: "Reader Co" }, "a.industry": { value: "home_services" }, "b.services": { value: "Roof repair" } } });
    llm.reply = { ok: true, text: '```json\n{"value": "Reader Co repairs roofs for local homeowners.", "reason": "Based on your services."}\n```' };
    const good = await suggestOnboardingAnswer(ctxB(), "a.description");
    expect(good).toMatchObject({ questionId: "a.description", value: "Reader Co repairs roofs for local homeowners.", needsConfirmation: false });
    expect(good.basis).toBe("your_website"); // the earlier analysis is available as context
    llm.reply = { ok: true, text: '{"value": "not-an-option", "reason": "x"}' };
    await expect(suggestOnboardingAnswer(ctxB(), "c.tone")).rejects.toThrow(/wrong shape/);
    llm.reply = { ok: true, text: '{"value": null, "reason": "Not enough information."}' };
    await expect(suggestOnboardingAnswer(ctxB(), "a.description")).rejects.toThrow(/Not enough information/);
    llm.reply = { ok: false, status: 500 };
    await expect(suggestOnboardingAnswer(ctxB(), "a.description")).rejects.toThrow(/couldn't answer/);
    llm.reply = { ok: true, text: '{"value": [{"question": "Do you offer free inspections?", "answer": "Yes, every roof gets a free inspection first."}], "reason": "From your FAQ page."}' };
    const faq = await suggestOnboardingAnswer(ctxB(), "e.faqs");
    expect(faq).toMatchObject({ source: "website_analysis", needsConfirmation: true });
  });
});
