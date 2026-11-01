// The questionnaire asks what is missing for the employees the workspace's plan includes, says what the plan includes, and refuses a "business hours only" reply preference that has no hours
// to follow. Pure rules first, then the same through the real service and the embedded database (a plan that leaves an employee out, a plan that exists or not).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { QUESTIONNAIRE_VERSION, QUESTION_BY_ID } from "@/lib/onboarding/definitions";
import {
  buildReviewModel, computeProgress, confirmedAnswers, countWord, describeValue, isRequired, planAddOns, planScope, questionState, submitCheck, toRoleAnswers, validateAnswer, visibleQuestions,
  type ConnectionFacts,
} from "@/lib/onboarding/engine";
import { planLeadTargeting } from "@/lib/onboarding/lead-targeting-draft";
import type { Answers, QuestionScope, StoredAnswers } from "@/lib/onboarding/types";
import { getOnboardingReview, getOnboardingSession, saveOnboardingStep } from "@/server/onboarding/service";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import { submitRealOnboarding } from "./support/billing";

vi.mock("@/server/llm/client", () => ({ resolveLlmConfig: async () => null, llmComplete: async () => ({ ok: false }) }));

const stored = (a: Answers): StoredAnswers =>
  Object.fromEntries(Object.entries(a).map(([id, value]) => [id, { value: value as never, skipped: false, source: "user" as const, needsConfirmation: false, updatedAt: "2026-11-01T00:00:00Z" }]));
const WEEK = { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]] };
/** Every required question answered, for a home-services business that wants appointments. */
const base = (extra: Answers = {}): Answers => ({
  "a.business_name": "Plan Co", "a.industry": "home_services", "a.business_model": "local", "a.description": "We repair roofs for homeowners in Austin.", "a.timezone": "America/Chicago",
  "a.contact_email": "hello@plan.test", "a.hours": WEEK, "b.goals": ["more_leads"], "b.appointments": true, "b.website_need": "have", "d.pricing_policy": "never", "f.review": true, ...extra,
});
const without = (...gone: AgentRoleKey[]): QuestionScope => ({ roles: AGENT_ROLE_KEYS.filter((r) => !gone.includes(r)) });
const idsOf = (a: Answers, scope?: QuestionScope) => visibleQuestions(a, scope).map((q) => q.id);
const facts: ConnectionFacts = {
  crmLinked: false, aiEmployeesVerified: 0, aiEmployeesTotal: 6, automationMapped: false,
  channels: { sms: { enabled: false, registration: "not_started" }, whatsapp: { enabled: false, registration: "not_started" }, email: { enabled: false, registration: "not_started" } },
  calendarConnected: false, websiteDomainVerified: false, invitedStaff: 0,
};

describe("questions that belong to one employee", () => {
  const roleOnly = ["b.qualification", "b.lead_target", "d.handoff_requirements"];

  it("are asked on the full plan, and left out when no employee that uses them is in the plan", () => {
    for (const id of roleOnly) expect(idsOf(base())).toContain(id);
    for (const id of roleOnly) expect(idsOf(base(), { roles: AGENT_ROLE_KEYS })).toContain(id);
    const manila = idsOf(base(), without("lead_hunter", "performance_analyst"));
    expect(manila).not.toContain("b.qualification");
    expect(manila).not.toContain("b.lead_target");
    expect(manila).toContain("d.handoff_requirements");
    expect(idsOf(base(), without("crm_manager"))).not.toContain("d.handoff_requirements");
    // One employee out leaves the others' questions alone.
    expect(idsOf(base(), without("lead_hunter"))).toContain("b.lead_target");
    expect(idsOf(base(), without("sales_assistant"))).toEqual(idsOf(base()));
  });

  it("shrink the progress total for a plan that leaves their employees out, and the full plan still sees them", () => {
    const full = computeProgress(stored(base())).total;
    expect(computeProgress(stored(base()), { roles: AGENT_ROLE_KEYS }).total).toBe(full);
    expect(computeProgress(stored(base()), without("lead_hunter", "performance_analyst")).total).toBe(full - 2);
    expect(computeProgress(stored(base()), without("lead_hunter", "performance_analyst", "crm_manager")).total).toBe(full - 3);
  });

  it("do not count against a plan that never asks them, even when an answer is saved", () => {
    const a = stored(base({ "b.qualification": "Owns the property.", "b.lead_target": "20_50" }));
    const p = computeProgress(a, without("lead_hunter", "performance_analyst"));
    expect(p.total).toBe(computeProgress(stored(base()), without("lead_hunter", "performance_analyst")).total);
    expect(p.done).toBe(computeProgress(stored(base()), without("lead_hunter", "performance_analyst")).done);
  });

  it("keep a hidden saved answer out of the role answers and the lead targeting", () => {
    const a = stored(base({ "b.qualification": "Owns the property and wants work within three months.", "b.lead_target": "50_150", "a.territories": "Austin; Round Rock" }));
    const noHunter = without("lead_hunter", "performance_analyst");
    const hidden = confirmedAnswers(a, noHunter);
    expect(hidden["b.qualification"]).toBeUndefined();
    expect(hidden["b.lead_target"]).toBeUndefined();
    expect(toRoleAnswers(hidden).lead_hunter.qualification ?? "").not.toContain("Owns the property");
    expect(toRoleAnswers(hidden).performance_analyst.results ?? "").not.toContain("lead target");
    expect(planLeadTargeting(hidden)?.targeting.minimumCriteria ?? "").toBe("");
    const full = confirmedAnswers(a, { roles: AGENT_ROLE_KEYS });
    expect(toRoleAnswers(full).lead_hunter.qualification).toContain("Owns the property");
    expect(toRoleAnswers(full).performance_analyst.results).toContain("Monthly lead target");
    expect(planLeadTargeting(full)?.targeting.minimumCriteria).toContain("Owns the property");
  });

  it("treat a workspace with no employees listed as having no plan to go by, and ask everything", () => {
    expect(planScope([])).toBeUndefined();
    expect(planScope(["lead_hunter"])).toEqual({ roles: ["lead_hunter"] });
    expect(idsOf(base(), planScope([]))).toEqual(idsOf(base()));
  });
});

describe("opening hours, required when something depends on them", () => {
  const hoursQ = QUESTION_BY_ID["a.hours"];
  const noHours = (extra: Answers = {}): Answers => {
    const { "a.hours": _hours, ...rest } = base(extra);
    void _hours;
    return rest;
  };

  it("blocks a reply preference of business hours only that has no hours, and names the question", () => {
    const answers = noHours({ "b.appointments": false, "c.response_hours": "business_hours" });
    const check = submitCheck(stored(answers));
    expect(check.canSubmit).toBe(false);
    expect(check.blockers).toContain("Answer: Business hours");
    expect(computeProgress(stored(answers)).requiredOutstanding).toContain("a.hours");
    expect(isRequired(hoursQ, answers)).toBe(true);
    // The same preference with hours given submits.
    expect(submitCheck(stored({ ...answers, "a.hours": WEEK })).canSubmit).toBe(true);
    // An empty hours object and days with no ranges are "not set", not hours.
    expect(submitCheck(stored({ ...answers, "a.hours": {} })).canSubmit).toBe(false);
    expect(submitCheck(stored({ ...answers, "a.hours": { mon: [] } })).canSubmit).toBe(false);
  });

  it("blocks appointments with neither bookable hours nor opening hours, and lets bookable hours stand in", () => {
    const answers = noHours({ "b.appointments": true });
    expect(submitCheck(stored(answers)).blockers).toContain("Answer: Business hours");
    expect(submitCheck(stored({ ...answers, "d.appt_availability": { mon: [["10:00", "16:00"]] } })).canSubmit).toBe(true);
    expect(submitCheck(stored({ ...answers, "d.appt_availability": {} })).canSubmit).toBe(false);
  });

  it("asks for nothing when no reply preference or booking depends on hours", () => {
    const answers = noHours({ "b.appointments": false });
    expect(isRequired(hoursQ, answers)).toBe(false);
    expect(submitCheck(stored(answers)).canSubmit).toBe(true);
    expect(isRequired(hoursQ, { ...answers, "c.response_hours": "always" })).toBe(false);
  });

  it("does not let a skip stand for an answer while the hours are required", () => {
    const answers = noHours({ "c.response_hours": "business_hours" });
    const skipped: StoredAnswers = { ...stored(answers), "a.hours": { value: null, skipped: true, source: "user", needsConfirmation: false, updatedAt: "" } };
    expect(questionState(hoursQ, skipped["a.hours"], answers)).toBe("outstanding");
    expect(questionState(hoursQ, skipped["a.hours"], { ...answers, "c.response_hours": "always", "b.appointments": false })).toBe("skipped");
    expect(submitCheck(skipped).blockers).toContain("Answer: Business hours");
  });

  it("resolves blank bookable hours to the opening hours in the review, and shows the client's own when given", () => {
    const row = (a: Answers) => buildReviewModel(stored(a), facts, [...AGENT_ROLE_KEYS]).sections.flatMap((s) => s.rows).find((r) => r.questionId === "d.appt_availability");
    expect(row(base())?.value).toMatch(/^Same as your opening hours: Mon 09:00.17:00/);
    expect(row(base({ "d.appt_availability": { sat: [["10:00", "12:00"]] } }))?.value).toBe("Sat 10:00–12:00");
    // Nothing to resolve to: it stays "not answered" rather than inventing hours.
    expect(row(base({ "a.hours": {} }))?.value).toBe("");
  });
});

describe("what your plan includes", () => {
  const five = AGENT_ROLE_KEYS.filter((r) => r !== "sales_assistant");
  const entitlement = (entitled: boolean) => ({ studio: { entitled, reason: entitled ? "" : "Automation Studio comes with the Managed Maintenance plan." }, managedStorage: entitled });

  it("lists five included and one not included for a plan that leaves the Sales Assistant out, and says five", () => {
    const review = buildReviewModel(stored(base()), facts, five, planScope(five), planAddOns(entitlement(false)));
    expect(review.plan.included).toEqual(five);
    expect(review.plan.notIncluded).toEqual(["sales_assistant"]);
    expect(review.employees).toHaveLength(5);
    expect(review.humanTasks.find((t) => t.key === "profiles")?.label).toBe("Create and verify your five AI employees");
    expect(countWord(five.length)).toBe("five");
  });

  it("says six for the full plan, and does not hard-code the word", () => {
    const review = buildReviewModel(stored(base()), facts, [...AGENT_ROLE_KEYS]);
    expect(review.plan.included).toHaveLength(6);
    expect(review.plan.notIncluded).toEqual([]);
    expect(review.humanTasks.find((t) => t.key === "profiles")?.label).toBe("Create and verify your six AI employees");
    const one = buildReviewModel(stored(base()), facts, ["crm_manager"]);
    expect(one.humanTasks.find((t) => t.key === "profiles")?.label).toBe("Create and verify your one AI employee");
  });

  it("words the paid extras from the entitlement, and an empty list when none were read", () => {
    expect(planAddOns(entitlement(true)).map((a) => [a.key, a.state])).toEqual([["automation_studio", "included"], ["managed_storage", "included"]]);
    const off = planAddOns(entitlement(false));
    expect(off.map((a) => a.state)).toEqual(["not_included", "not_included"]);
    expect(off[0].detail).toContain("Managed Maintenance");
    expect(buildReviewModel(stored(base()), facts, five).plan.addOns).toEqual([]);
  });
});

describe("the contract-C1 questions", () => {
  const NEW = ["d.appt_host", "d.appt_busy_calendar", "d.appt_video_link"];
  const withVideo = (extra: Answers = {}): Answers => base({ "d.appt_types": [{ name: "Video call", minutes: "30", mode: "video" }], "d.appt_video": "own", ...extra });

  it("exist, are optional, and the questionnaire is still version 3", () => {
    expect(QUESTIONNAIRE_VERSION).toBe(3);
    for (const id of NEW) {
      expect(QUESTION_BY_ID[id], id).toBeDefined();
      expect(QUESTION_BY_ID[id].required, id).toBeFalsy();
      expect(QUESTION_BY_ID[id].requiredWhen, id).toBeUndefined();
    }
    expect(QUESTION_BY_ID["a.local_kind"].required).toBeFalsy();
  });

  it("are hidden when the answer they hang on says so", () => {
    expect(idsOf(base())).toEqual(expect.arrayContaining(["d.appt_host", "d.appt_busy_calendar"]));
    expect(idsOf(base())).not.toContain("d.appt_video_link");
    const noAppts = idsOf(base({ "b.appointments": false }));
    for (const id of NEW) expect(noAppts).not.toContain(id);
    expect(idsOf(withVideo())).toContain("d.appt_video_link");
    expect(idsOf(withVideo({ "d.appt_video": "google_meet" }))).not.toContain("d.appt_video_link");
    expect(idsOf(withVideo({ "b.appointments": false }))).not.toContain("d.appt_video_link");
  });

  it("validate their values: owner or team, google, microsoft or none, an https link only", () => {
    const q = (id: string) => QUESTION_BY_ID[id];
    expect(validateAnswer(q("d.appt_host"), "owner").ok).toBe(true);
    expect(validateAnswer(q("d.appt_host"), "team").ok).toBe(true);
    expect(validateAnswer(q("d.appt_host"), "nobody").ok).toBe(false);
    for (const v of ["google", "microsoft", "none"]) expect(validateAnswer(q("d.appt_busy_calendar"), v).ok).toBe(true);
    expect(validateAnswer(q("d.appt_busy_calendar"), "outlook").ok).toBe(false);
    expect(validateAnswer(q("d.appt_video_link"), "https://meet.example.com/room-1")).toEqual({ ok: true, value: "https://meet.example.com/room-1" });
    expect(validateAnswer(q("d.appt_video_link"), "https://us02web.zoom.us/j/123?pwd=abc")).toEqual({ ok: true, value: "https://us02web.zoom.us/j/123?pwd=abc" });
    expect(validateAnswer(q("d.appt_video_link"), "meet.example.com/room-1")).toEqual({ ok: true, value: "https://meet.example.com/room-1" });
    expect(validateAnswer(q("d.appt_video_link"), "")).toEqual({ ok: true, value: "" });
    for (const bad of ["http://meet.example.com/room", "javascript:alert(1)", "ftp://meet.example.com", "https://user:pass@meet.example.com/", "https://localhost/room", "not a link", `https://meet.example.com/${"x".repeat(500)}`]) {
      expect(validateAnswer(q("d.appt_video_link"), bad).ok, bad).toBe(false);
    }
  });

  it("add a yes-or-no host field to the team rows, optional, validated, and only asked when appointments are wanted", () => {
    const team = QUESTION_BY_ID["d.team"];
    const rows = (hosts: string) => [{ name: "Sam", email: "sam@plan.test", role: "sales_rep", hosts }];
    expect(validateAnswer(team, rows("yes"))).toEqual({ ok: true, value: rows("yes") });
    expect(validateAnswer(team, rows("no"))).toEqual({ ok: true, value: rows("no") });
    expect(validateAnswer(team, rows("maybe")).ok).toBe(false);
    // Left unchosen, the row keeps the shape it always had.
    expect(validateAnswer(team, rows(""))).toEqual({ ok: true, value: [{ name: "Sam", email: "sam@plan.test", role: "sales_rep" }] });
    expect(validateAnswer(team, [{ name: "Sam", email: "sam@plan.test", role: "sales_rep" }]).ok).toBe(true);
    if (team.kind.type !== "list") throw new Error("d.team is a list");
    const hosts = team.kind.fields.find((f) => f.key === "hosts");
    expect(hosts?.type).toBe("select");
    expect(hosts?.required).toBeFalsy();
    expect(hosts?.options?.map((o) => o.value)).toEqual(["yes", "no"]);
    expect(hosts?.show?.(base())).toBe(true);
    expect(hosts?.show?.(base({ "b.appointments": false }))).toBe(false);
  });

  it("do not read a hidden host value back in the review once appointments are switched off", () => {
    const team = QUESTION_BY_ID["d.team"];
    const rows = [{ name: "Sam", email: "sam@plan.test", role: "sales_rep", hosts: "yes" }];
    expect(describeValue(team, rows, base())).toContain("Takes appointments");
    // The value stays saved, but the field is no longer asked, so the review does not present it as an answer.
    const off = describeValue(team, rows, base({ "b.appointments": false }));
    expect(off).not.toContain("Takes appointments");
    expect(off).toContain("Sam");
    const review = buildReviewModel(stored(base({ "b.appointments": false, "d.team": rows })), facts, [...AGENT_ROLE_KEYS]);
    const teamRow = review.sections.flatMap((s) => s.rows).find((r) => r.questionId === "d.team");
    expect(teamRow?.value).not.toContain("Takes appointments");
  });

  it("let a workspace that submitted before re-submit without answering any of them", () => {
    expect(submitCheck(stored(base())).canSubmit).toBe(true);
    expect(submitCheck(stored(base({ "b.appointments": false }))).canSubmit).toBe(true);
    expect(submitCheck(stored(withVideo())).canSubmit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The same, through the service and the embedded database
// ---------------------------------------------------------------------------

async function workspace(name: string, off: AgentRoleKey[] = []) {
  const org = await createOrg({ name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  if (off.length) await withSystem((db) => db.query("update agent_instances set enabled = false where org_id = $1 and role_key = any($2::text[])", [org.id, off]));
  return { org, owner, ctx: ctxFor(owner, org, "owner") };
}
const asValues = (a: Answers) => Object.fromEntries(Object.entries(a).map(([id, value]) => [id, { value }]));

describe("a workspace's plan, read from the database", () => {
  let full: Awaited<ReturnType<typeof workspace>>;
  let manila: Awaited<ReturnType<typeof workspace>>;
  let noHunter: Awaited<ReturnType<typeof workspace>>;

  beforeAll(async () => {
    full = await workspace("Full Plan Co");
    manila = await workspace("Harbor Smile Dental", ["sales_assistant"]);
    noHunter = await workspace("Narrow Plan Co", ["lead_hunter", "performance_analyst"]);
  });

  it("lists five included and one not included for the plan without a Sales Assistant, six for the full plan", async () => {
    const m = await getOnboardingReview(manila.ctx);
    expect(m.plan.included).toHaveLength(5);
    expect(m.plan.notIncluded).toEqual(["sales_assistant"]);
    expect(m.employees.map((e) => e.role)).not.toContain("sales_assistant");
    expect(m.humanTasks.find((t) => t.key === "profiles")?.label).toContain("five");
    const f = await getOnboardingReview(full.ctx);
    expect(f.plan.included).toHaveLength(6);
    expect(f.plan.notIncluded).toEqual([]);
    expect(f.humanTasks.find((t) => t.key === "profiles")?.label).toContain("six");
  });

  it("follows maintenance_subscriptions for the paid extras", async () => {
    const before = await getOnboardingReview(manila.ctx);
    expect(before.plan.addOns.map((a) => [a.key, a.state])).toEqual([["automation_studio", "not_included"], ["managed_storage", "not_included"]]);
    await withSystem((db) => db.query(
      "insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on) values ($1, 'active', 29900, 4, 'test', $2, now(), current_date)",
      [manila.org.id, manila.owner.id],
    ));
    const after = await getOnboardingReview(manila.ctx);
    expect(after.plan.addOns.map((a) => [a.key, a.state])).toEqual([["automation_studio", "included"], ["managed_storage", "included"]]);
    // Another workspace is not given it.
    expect((await getOnboardingReview(full.ctx)).plan.addOns.map((a) => a.state)).toEqual(["not_included", "not_included"]);
  });

  it("asks fewer questions of a plan that leaves their employees out, and the same of the full plan", async () => {
    const f = await getOnboardingSession(full.ctx);
    const n = await getOnboardingSession(noHunter.ctx);
    expect(n.enabledRoles).not.toContain("lead_hunter");
    expect(n.progress.total).toBe(f.progress.total - 2);
    const manilaSession = await getOnboardingSession(manila.ctx);
    expect(manilaSession.progress.total).toBe(f.progress.total);
  });

  it("applies the plan when saving: the position and progress it returns follow the same scope", async () => {
    const saved = await saveOnboardingStep(noHunter.ctx, { answers: asValues({ "a.industry": "home_services", "b.qualification": "Owns the property." }), currentQuestionId: "b.qualification" });
    expect(saved.rejected).toEqual({});
    // The saved answer stays, the question is not asked, and the position moves on to one that is.
    expect(saved.currentQuestionId).not.toBe("b.qualification");
    const session = await getOnboardingSession(noHunter.ctx);
    expect(session.answers["b.qualification"].value).toBe("Owns the property.");
    expect(session.currentQuestionId).not.toBe("b.qualification");
    const again = await saveOnboardingStep(full.ctx, { answers: asValues({ "a.industry": "home_services", "b.qualification": "Owns the property." }), currentQuestionId: "b.qualification" });
    expect(again.currentQuestionId).toBe("b.qualification");
  });

  it("refuses to skip the opening hours while a business-hours-only reply preference needs them", async () => {
    const ws = await workspace("Hours Co");
    await saveOnboardingStep(ws.ctx, { answers: asValues({ "b.appointments": false, "c.response_hours": "business_hours" }) });
    const refused = await saveOnboardingStep(ws.ctx, { answers: { "a.hours": { skipped: true } } });
    expect(refused.rejected["a.hours"]).toBe("This question is required.");
    const session = await getOnboardingSession(ws.ctx);
    expect(session.progress.requiredOutstanding).toContain("a.hours");
    // With no such preference the same skip is fine.
    await saveOnboardingStep(ws.ctx, { answers: asValues({ "c.response_hours": "always" }) });
    expect((await saveOnboardingStep(ws.ctx, { answers: { "a.hours": { skipped: true } } })).rejected).toEqual({});
  });
});

describe("a real submission on a plan that leaves employees out", () => {
  const MARKER = "Owns the roof and decides within the month, marker-ZQ7.";
  const extra = { "b.qualification": MARKER, "b.lead_target": "50_150" };
  const storedText = async (orgId: string) => {
    const { rows } = await withSystem((db) => db.query<{ t: string }>(
      `select coalesce((select string_agg(criteria::text, ' ') from lead_targeting_profiles where org_id = $1), '') || ' '
           || coalesce((select string_agg(settings::text, ' ') from agent_config_versions where org_id = $1), '') || ' '
           || coalesce((select string_agg(content, ' ') from company_knowledge where org_id = $1), '') as t`,
      [orgId],
    ));
    return rows[0].t;
  };

  it("keeps an answer saved for an employee that is not in the plan out of the lead targeting, the role settings and the knowledge, and puts it in for the full plan", async () => {
    const narrow = await submitRealOnboarding({ name: "Narrow Submit Co", clearPayment: true, disableRoles: ["lead_hunter", "performance_analyst"], extraAnswers: extra });
    // The answer is saved (nothing is lost if the plan changes), but nothing built from the submission may use it.
    const saved = await withSystem((db) => db.query("select 1 from onboarding_answers where org_id = $1 and question_id = 'b.qualification'", [narrow.org.id]));
    expect(saved.rows).toHaveLength(1);
    const narrowText = await storedText(narrow.org.id);
    expect(narrowText).not.toContain("marker-ZQ7");
    expect(narrowText).not.toContain("Monthly lead target");
    expect((await withSystem((db) => db.query("select 1 from lead_targeting_profiles where org_id = $1 and criteria::text like '%marker-ZQ7%'", [narrow.org.id]))).rows).toHaveLength(0);

    // The same answers on the full plan are used: the check above can fail.
    const full = await submitRealOnboarding({ name: "Full Submit Co", clearPayment: true, extraAnswers: extra });
    expect(await storedText(full.org.id)).toContain("marker-ZQ7");
  });
});
