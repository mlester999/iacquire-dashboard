// Every answer the questionnaire asks for reaches an employee, a knowledge section or a rule, in exactly the place it belongs: the industry questions that used to be dropped
// (insurance, emergency handling, viewings, discovery calls, services, property types, budget, kinds of client, appointment purpose, lead sources). Pure rules first, then two clients
// through the real service and the embedded database.
import { describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { QUESTIONS, QUESTION_BY_ID, questionOptions } from "@/lib/onboarding/definitions";
import { confirmedAnswers, toKnowledgeSections, toLegacyData, toRoleAnswers } from "@/lib/onboarding/engine";
import type { Answers, StoredAnswers } from "@/lib/onboarding/types";
import { saveOnboardingStep, submitOnboarding } from "@/server/onboarding/service";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

vi.mock("@/server/llm/client", () => ({ resolveLlmConfig: async () => null, llmComplete: async () => ({ ok: false }) }));

const stored = (a: Answers): StoredAnswers =>
  Object.fromEntries(Object.entries(a).map(([id, value]) => [id, { value: value as never, skipped: false, source: "user" as const, needsConfirmation: false, updatedAt: "2026-11-01T00:00:00Z" }]));
/** The knowledge sections whose text holds this phrase. */
const where = (a: Answers, needle: string) => toKnowledgeSections(a).filter((x) => x.content.includes(needle)).map((x) => x.section);
const everyRoleText = (a: Answers) => Object.entries(toRoleAnswers(a)).flatMap(([role, answers]) => Object.entries(answers).map(([key, text]) => ({ where: `${role}.${key}`, text })));
const WEEK = { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]] };

describe("answers that used to reach nobody", () => {
  const knowledgeCases: Array<{ id: string; answers: Answers; needle: string; section: string }> = [
    { id: "d.hc_insurance", answers: { "d.hc_insurance": "Delta Dental and monthly payment plans." }, needle: "Delta Dental and monthly payment plans.", section: "policies" },
    { id: "d.hc_emergency", answers: { "d.hc_emergency": "call_emergency" }, needle: "Tell them to contact emergency services", section: "escalation" },
    { id: "b.hs_emergency", answers: { "b.hs_emergency": "yes_24_7" }, needle: "Yes, any time", section: "escalation" },
    { id: "d.hs_quote", answers: { "d.hs_quote": "paid_assessment" }, needle: "Paid assessment", section: "customer_service" },
    { id: "d.re_viewings", answers: { "d.re_viewings": "self_guided" }, needle: "Self-guided viewings", section: "customer_service" },
    { id: "d.ag_discovery", answers: { "d.ag_discovery": "Thirty minutes reviewing your funnel." }, needle: "Thirty minutes reviewing your funnel.", section: "customer_service" },
    { id: "b.hc_services", answers: { "b.hc_services": ["ortho", "implants"] }, needle: "Braces or aligners, Implants and restorations", section: "products_services" },
    { id: "b.re_property_types", answers: { "b.re_property_types": ["land", "condo"] }, needle: "Land and lots, Condos and apartments", section: "products_services" },
    { id: "b.pr_engagements", answers: { "b.pr_engagements": ["retainer", "training"] }, needle: "Monthly retainers, Training or workshops", section: "products_services" },
  ];

  it.each(knowledgeCases)("$id lands in the $section knowledge, and in no other section", ({ answers, needle, section }) => {
    expect(where(answers, needle)).toEqual([section]);
  });

  it("keeps the budget, the kinds of client, the purpose and the lead sources out of every knowledge section", () => {
    const a: Answers = {
      "a.description": "We help.", "b.ag_min_budget": "lt1k", "b.re_buyers": ["investors", "first_time"], "b.appointment_goal": "viewing", "b.lead_sources": ["referrals", "walk_in"],
      "d.appt_types": [{ name: "Tour", minutes: "30", mode: "in_person" }], "a.industry": "real_estate",
    };
    const text = toKnowledgeSections(a).map((x) => x.content).join("\n");
    for (const hidden of ["Under $1,000 a month", "smallest budget", "Investors", "First-time buyers", "Property viewings", "Referrals", "Walk-ins"]) expect(text.toLowerCase(), hidden).not.toContain(hidden.toLowerCase());
  });

  it("hands the budget and the kinds of client to the Lead Hunter, and never states the budget to a lead", () => {
    const roles = toRoleAnswers({ "b.ag_min_budget": "1k_3k", "b.re_buyers": ["investors", "relocating"], "b.ag_target_clients": "Local service firms." });
    expect(roles.lead_hunter.qualification).toContain("$1,000 to $3,000 a month");
    expect(roles.lead_hunter.qualification).toMatch(/never state it to a lead/i);
    expect(roles.lead_hunter.targets).toContain("Investors, People relocating");
    expect(roles.lead_hunter.targets).toContain("Local service firms.");
    // "No minimum" is not a rule, so it adds nothing.
    expect(toRoleAnswers({ "b.ag_min_budget": "none" }).lead_hunter.qualification).toBeUndefined();
    // Only the Lead Hunter holds them.
    const holders = everyRoleText({ "b.ag_min_budget": "1k_3k", "b.re_buyers": ["investors"] }).filter((r) => /\$1,000|Investors/.test(r.text)).map((r) => r.where);
    expect(holders.sort()).toEqual(["lead_hunter.qualification", "lead_hunter.targets"]);
  });

  it("gives the appointment purpose to the Appointment Setter's meeting types, and the lead sources to the Performance Analyst's metrics", () => {
    const a: Answers = { "a.industry": "real_estate", "b.appointment_goal": "viewing", "b.appointments": true, "d.appt_types": [{ name: "Tour", minutes: "30", mode: "in_person" }], "b.lead_sources": ["referrals", "phone"] };
    const roles = toRoleAnswers(a);
    expect(roles.appointment_setter.meeting_types).toBe("Main reason people book: Property viewings. Tour (30 min, in person)");
    expect(roles.performance_analyst.metrics).toContain("Lead sources to report on: Referrals, Phone calls.");
    expect(roles.performance_analyst.metrics).toContain("recorded data");
    expect(everyRoleText(a).filter((r) => r.text.includes("Referrals")).map((r) => r.where)).toEqual(["performance_analyst.metrics"]);
    // With no appointment type listed there is nothing to describe, so the purpose does not stand in for one.
    expect(toRoleAnswers({ ...a, "d.appt_types": [] }).appointment_setter.meeting_types).toBeUndefined();
  });

  it("reaches the configuration compiler the same way, for the roles the client has", () => {
    const a: Answers = { "a.business_name": "Harbor", "a.description": "We serve.", "b.goals": ["more_leads"], "b.ag_min_budget": "3k_plus" };
    const data = toLegacyData(a, ["lead_hunter"]);
    expect(data.workforce.answers.lead_hunter.qualification).toContain("More than $3,000 a month");
  });
});

describe("limits hold with every answer filled to its maximum", () => {
  /** The largest legal value for every question, whether or not its industry or booking answer would show it. */
  function maxed(): Answers {
    const a: Answers = {};
    for (const q of QUESTIONS) {
      const k = q.kind;
      if (k.type === "text" || k.type === "longtext") a[q.id] = "x".repeat(k.max);
      else if (k.type === "choice") a[q.id] = (questionOptions(q, { "a.industry": "real_estate" })[0] ?? { value: "viewing" }).value;
      else if (k.type === "multi") a[q.id] = k.options.map((o) => o.value);
      else if (k.type === "yesno") a[q.id] = true;
      else if (k.type === "hours") a[q.id] = WEEK;
      else if (k.type === "email") a[q.id] = "owner@example.com";
      else if (k.type === "phone") a[q.id] = "+15125550100";
      else if (k.type === "list") {
        a[q.id] = Array.from({ length: k.maxRows }, () => Object.fromEntries(k.fields.map((f) => [f.key, f.type === "select" ? f.options?.[0]?.value ?? "" : f.type === "number" ? "30" : "x".repeat(f.max ?? 300)])));
      }
    }
    a["a.industry"] = "real_estate";
    a["b.appointment_goal"] = "viewing";
    a["d.appt_cancellation"] = "c".repeat(800);
    return a;
  }

  it("keeps every role answer within 1,000 characters and every knowledge section within 12,000", () => {
    const a = maxed();
    for (const r of everyRoleText(a)) expect(r.text.length, r.where).toBeLessThanOrEqual(1000);
    for (const s of toKnowledgeSections(a)) expect(s.content.length, s.section).toBeLessThanOrEqual(12000);
    // The short structured answers are not the ones trimmed away.
    const roles = toRoleAnswers(a);
    expect(roles.lead_hunter.targets.startsWith("Typical clients:")).toBe(true);
    expect(roles.appointment_setter.meeting_types.startsWith("Main reason people book:")).toBe(true);
    expect(roles.performance_analyst.metrics).toContain("Lead sources to report on:");
    expect(roles.appointment_setter.hours).toContain("c".repeat(800));
  });

  it("keeps a real budget in the Lead Hunter's qualification even when the client's own text fills the answer", () => {
    const a: Answers = { "b.ag_min_budget": "3k_plus", "b.qualification": "q".repeat(1500), "a.territories": "t".repeat(1000) };
    const text = toRoleAnswers(a).lead_hunter.qualification;
    expect(text.length).toBe(1000);
    expect(text.startsWith("Smallest budget the business takes on: More than $3,000 a month.")).toBe(true);
  });
});

describe("these questions are marked sensitive, so a suggestion is checked before it becomes approved knowledge", () => {
  it.each(["d.hc_emergency", "d.hc_insurance", "b.hs_emergency", "d.hs_quote"])("%s", (id) => {
    expect(QUESTION_BY_ID[id].sensitive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Two clients through the service: one client's instruction never reaches the other's knowledge
// ---------------------------------------------------------------------------

async function submitClient(name: string, answers: Answers) {
  const org = await createOrg({ name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const ctx = ctxFor(owner, org, "owner");
  const saved = await saveOnboardingStep(ctx, { answers: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, { value }])), currentQuestionId: "f.review" });
  expect(saved.rejected).toEqual({});
  await submitOnboarding(ctx);
  const rows = await withSystem((db) => db.query<{ section: string; content: string }>("select section, content from company_knowledge where org_id = $1", [org.id]));
  return { org, ctx, knowledge: Object.fromEntries(rows.rows.map((r) => [r.section, r.content])) };
}

describe("two clients", () => {
  it("puts the Manila dental emergency instruction in that client's escalation knowledge and not in the Chicago client's", async () => {
    const manila = await submitClient("Harbor Smile Dental", {
      "a.business_name": "Harbor Smile Dental", "a.industry": "healthcare", "a.business_model": "local", "a.description": "We provide orthodontic braces and clear aligners in Makati.",
      "a.timezone": "Asia/Manila", "a.contact_email": "hello@harborsmile.test", "b.goals": ["more_appointments"], "b.appointments": false, "b.website_need": "have",
      "d.hc_emergency": "call_emergency", "d.hc_insurance": "PhilHealth and most HMO cards.", "b.hc_services": ["ortho"], "f.review": true,
    });
    // The Chicago client even has a stale dental answer saved: its industry hides it, so it must not travel.
    const chicago = await submitClient("Lakeside Roofing", {
      "a.business_name": "Lakeside Roofing", "a.industry": "home_services", "a.business_model": "local", "a.description": "We repair residential roofs in Chicago.", "a.timezone": "America/Chicago",
      "a.contact_email": "hello@lakeside.test", "a.hours": WEEK, "b.goals": ["more_leads"], "b.appointments": false, "b.website_need": "have",
      "b.hs_emergency": "yes_24_7", "d.hs_quote": "free_quote", "d.hc_emergency": "call_us", "d.hc_insurance": "Stale dental insurance text.", "f.review": true,
    });
    expect(manila.knowledge.escalation).toContain("When someone describes an emergency: Tell them to contact emergency services.");
    expect(manila.knowledge.policies).toContain("PhilHealth and most HMO cards.");
    expect(manila.knowledge.products_services).toContain("Braces or aligners");
    expect(chicago.knowledge.escalation).toContain("Emergency call-outs: Yes, any time.");
    expect(chicago.knowledge.customer_service).toContain("How jobs are priced: Free on-site quote.");
    for (const [section, text] of Object.entries(chicago.knowledge)) {
      expect(text, section).not.toContain("Tell them to contact emergency services");
      expect(text, section).not.toContain("Tell them to call us immediately");
      expect(text, section).not.toContain("Stale dental insurance text.");
    }
    for (const [section, text] of Object.entries(manila.knowledge)) expect(text, section).not.toContain("Emergency call-outs");
    // Nothing leaked through the confirmed answers either.
    expect(confirmedAnswers(stored({ "a.industry": "home_services", "d.hc_emergency": "call_us" }))["d.hc_emergency"]).toBeUndefined();
  });
});
