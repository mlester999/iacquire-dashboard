// A re-submission says what it did not do: what it kept as someone wrote it, what is waiting for review, what it left alone and why, what was already as the answers say, and
// how the live calendar now differs from the booking answers. The words are built by one pure function (buildOutcomeNotes); the submission fills it from what really happened and
// keeps the lines in its audit row for the page the person lands on. Embedded Postgres on the real migrations for the server half.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { buildOutcomeNotes } from "@/lib/onboarding/business-profile";
import { getProfile, updateAiPreferences, updateProfile } from "@/server/settings/service";
import { updateMessagingSettings } from "@/server/messaging/inbox";
import { latestOnboardingNotes, saveOnboardingStep, submitOnboarding } from "@/server/onboarding/service";
import { ctxFor } from "./support/fixtures";
import { submitRealOnboarding } from "./support/billing";

type Ctx = ReturnType<typeof ctxFor>;
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const save = (ctx: Ctx, answers: Record<string, unknown>) => saveOnboardingStep(ctx, { answers: Object.fromEntries(Object.entries(answers).map(([k, value]) => [k, { value }])) });
const resubmit = async (ctx: Ctx) => {
  await save(ctx, { "f.review": true });
  return submitOnboarding(ctx);
};
const none = { profile: [], messaging: [], preferences: [] } as const;
const base = { reSubmission: true, knowledgeKept: [], employees: [], scheduling: { state: "unchanged" }, wantsAppointments: true, targetingKept: false, leftAsEdited: none } as const;
const keysOf = (notes: Array<{ key: string }>) => notes.map((n) => n.key);

describe("buildOutcomeNotes", () => {
  it("says nothing when there is nothing to say", () => {
    expect(buildOutcomeNotes({ ...base })).toEqual([]);
    expect(buildOutcomeNotes({ ...base, reSubmission: false, employees: [{ configStatus: "applied" }, { configStatus: "applied" }] })).toEqual([]);
  });

  it("lists the knowledge sections it kept in the person's own words", () => {
    expect(buildOutcomeNotes({ ...base, knowledgeKept: ["policies"] })).toEqual([{ key: "knowledge.kept", message: "We kept your own wording in Policies." }]);
    expect(buildOutcomeNotes({ ...base, knowledgeKept: ["policies", "faq", "business_hours"] })[0].message).toBe("We kept your own wording in Policies, FAQ and Business hours.");
  });

  it("counts employee updates that are waiting for review, never as applied", () => {
    const one = buildOutcomeNotes({ ...base, employees: [{ configStatus: "pending_agency_review" }, { configStatus: "applied" }, { configStatus: "applied" }] });
    expect(one).toEqual([{ key: "employees.held", message: "1 employee update is waiting for iAcquire's review. Until then, that employee keeps the setup already approved." }]);
    const two = buildOutcomeNotes({ ...base, employees: [{ configStatus: "pending_agency_review" }, { configStatus: "pending_agency_review" }] });
    expect(two[0].message).toBe("2 employee updates are waiting for iAcquire's review. Until then, those employees keep the setup already approved.");
  });

  it("names a held unified configuration as the AI Growth Partner", () => {
    expect(buildOutcomeNotes({
      ...base,
      employees: [{ role: "growth_partner", configStatus: "pending_agency_review" }],
    })).toEqual([{
      key: "growth_partner.held",
      message: "An update for your AI Growth Partner is waiting for iAcquire's review. Until then, it keeps the setup already approved.",
    }]);
  });

  it("says how many employees were already as the answers say, only when some changed and some did not", () => {
    const some = buildOutcomeNotes({ ...base, employees: [{ configStatus: "unchanged" }, { configStatus: "applied" }, { configStatus: "unchanged" }] });
    expect(some).toEqual([{ key: "employees.unchanged", message: "2 employees were already set up as your answers say." }]);
    expect(buildOutcomeNotes({ ...base, employees: [{ configStatus: "unchanged" }] })).toEqual([]);
    expect(keysOf(buildOutcomeNotes({ ...base, reSubmission: false, employees: [{ configStatus: "unchanged" }, { configStatus: "applied" }] }))).toEqual([]);
  });

  it("says why no calendar was drafted only for someone who wants appointments, and how a live calendar differs", () => {
    const skipped = { state: "skipped", reason: "You already have a calendar that is not a draft." };
    expect(buildOutcomeNotes({ ...base, scheduling: skipped })).toEqual([{ key: "scheduling.skipped", message: "You already have a calendar that is not a draft." }]);
    expect(buildOutcomeNotes({ ...base, scheduling: skipped, wantsAppointments: false })).toEqual([]);
    const drift = ["Free inspection: your answers now say a 15-minute gap after appointments, your live calendar has no gap after appointments."];
    expect(buildOutcomeNotes({ ...base, scheduling: { state: "skipped", drift } })).toEqual([
      { key: "scheduling.drift", message: `${drift[0]} Your live calendar was not changed: update it in Calendars & Types.` },
    ]);
    const many = buildOutcomeNotes({ ...base, scheduling: { state: "skipped", drift: ["One.", "Two.", "Three.", "Four.", "Five."] } });
    expect(many[0].message).toBe("One. Two. Three. 2 more differences. Your live calendar was not changed: update it in Calendars & Types.");
    expect(buildOutcomeNotes({ ...base, scheduling: { state: "skipped", drift: [] } })).toEqual([]);
  });

  it("says lead targeting was left as it is, and what was left as it was edited elsewhere", () => {
    expect(keysOf(buildOutcomeNotes({ ...base, targetingKept: true }))).toEqual(["targeting.kept"]);
    expect(keysOf(buildOutcomeNotes({ ...base, reSubmission: false, targetingKept: true }))).toEqual([]);
    const notes = buildOutcomeNotes({ ...base, leftAsEdited: { profile: ["industry", "website"], messaging: ["followup"], preferences: ["escalateWhen", "tone", "companyRules"] } });
    expect(notes).toEqual([
      { key: "profile.kept", message: "Left as edited in Settings: industry and website." },
      { key: "messaging.kept", message: "Left as set in Messaging settings: follow-up style." },
      { key: "preferences.kept", message: "Left as set in AI preferences: when to ask a human, tone and company rules." },
    ]);
  });

  it("says plainly that nothing changed, and nothing else", () => {
    expect(buildOutcomeNotes({ ...base, quiet: true, knowledgeKept: ["policies"] })).toEqual([{ key: "nothing.changed", message: "Nothing changed since your last submission, so nothing was updated." }]);
  });
});

describe("what a real re-submission says", () => {
  it("says nothing changed when nothing did, and the first submission only says what is waiting or was skipped", async () => {
    const c = await submitRealOnboarding({ name: "Quiet Notes Roofing", clearPayment: true });
    // The CRM Manager's first configuration waits for review with these answers, and no appointment types were listed: both are said. Nothing is "kept" or "unchanged" yet.
    expect(keysOf(c.result.notes)).toEqual(["employees.held", "scheduling.skipped"]);
    const again = await submitOnboarding(c.ctx);
    expect(keysOf(again.notes)).toEqual(["nothing.changed"]);
    expect(await latestOnboardingNotes(c.ctx)).toEqual(["Nothing changed since your last submission, so nothing was updated."]);
  }, 120_000);

  it("keeps a knowledge section a person edited, and says so", async () => {
    const c = await submitRealOnboarding({ name: "Kept Notes Roofing", clearPayment: true, extraAnswers: { "e.policies": "Cancellations need 24 hours notice." } });
    await withSystem((db) => db.query("update company_knowledge set content = 'Written by a person in the Knowledge Center.' where org_id = $1 and section = 'policies'", [c.org.id]));
    await save(c.ctx, { "e.policies": "Cancellations need 48 hours notice." });
    const out = await resubmit(c.ctx);
    expect(out.knowledge.kept).toContain("policies");
    expect(out.notes).toContainEqual({ key: "knowledge.kept", message: "We kept your own wording in Policies." });
    expect((await rows<{ content: string }>("select content from company_knowledge where org_id = $1 and section = 'policies'", [c.org.id]))[0].content).toBe("Written by a person in the Knowledge Center.");
  }, 120_000);

  it("counts the employee updates that wait for review, never as applied", async () => {
    const c = await submitRealOnboarding({ name: "Held Notes Roofing", clearPayment: true });
    // A rewrite of the company rules is a guardrail change, so those employees' new versions wait for a person.
    await save(c.ctx, { "c.company_rules": "Always greet customers by name and offer a call-back." });
    const out = await resubmit(c.ctx);
    const held = out.employees.filter((e) => e.configStatus === "pending_agency_review");
    expect(held.length).toBeGreaterThan(0);
    expect(out.notes.find((n) => n.key === "employees.held")?.message).toMatch(new RegExp(`^${held.length} employee updates? (is|are) waiting for iAcquire's review`));
    expect(await latestOnboardingNotes(c.ctx)).toEqual(out.notes.map((n) => n.message));
  }, 120_000);

  it("says how many employees were already set up as the answers say", async () => {
    const c = await submitRealOnboarding({ name: "Unchanged Notes Roofing", clearPayment: true });
    // The follow-up style is a Sales Assistant answer: the other employees are exactly as they were.
    await save(c.ctx, { "d.followup": "gentle" });
    const out = await resubmit(c.ctx);
    const unchanged = out.employees.filter((e) => e.configStatus === "unchanged").length;
    const changed = out.employees.length - unchanged;
    expect(unchanged).toBeGreaterThan(0);
    expect(changed).toBeGreaterThan(0);
    expect(out.notes.find((n) => n.key === "employees.unchanged")?.message).toBe(`${unchanged} employee${unchanged === 1 ? " was" : "s were"} already set up as your answers say.`);
  }, 120_000);

  it("says what it left as it was edited in Settings, in Messaging settings and in AI preferences", async () => {
    const c = await submitRealOnboarding({ name: "Left Notes Roofing", clearPayment: true });
    const p = (await getProfile(c.ctx))!;
    // An industry that is none of the listed ones cannot be an answer, so the answers keep saying "Home services".
    await updateProfile(c.ctx, { name: p.name, industry: "Roofing contractor", website: p.website ?? "", region: p.region ?? "", timezone: p.timezone, description: p.description ?? "", services: p.services ?? "", idealCustomers: p.ideal_customers ?? "", brandColor: "" });
    await updateMessagingSettings(c.ctx, { followUpPreset: "custom", followUpCustom: { attempts: 2, daysBetween: [1, 3], channel: "same", businessHoursOnly: true } });
    await updateAiPreferences(c.ctx, { tone: "friendly", replyLength: "concise", language: "English", companyRules: "", neverPromise: "", escalateWhen: "Hand over anything involving a ladder." });
    await save(c.ctx, { "c.tone": "casual" });
    const out = await resubmit(c.ctx);
    expect(out.notes.find((n) => n.key === "profile.kept")?.message).toBe("Left as edited in Settings: industry.");
    expect(out.notes.find((n) => n.key === "messaging.kept")?.message).toBe("Left as set in Messaging settings: follow-up style.");
    expect(out.notes.find((n) => n.key === "preferences.kept")?.message).toBe("Left as set in AI preferences: when to ask a human.");
    // What was kept is really what the workspace holds.
    expect((await rows<{ industry: string }>("select industry from organizations where id = $1", [c.org.id]))[0].industry).toBe("Roofing contractor");
    expect((await rows<{ followup_preset: string }>("select followup_preset from messaging_settings where org_id = $1", [c.org.id]))[0].followup_preset).toBe("custom");
  }, 120_000);

  it("names how the answers now differ from a live booking calendar, and leaves the calendar as it is", async () => {
    const booking = { "d.appt_types": [{ name: "Free inspection", minutes: "30", mode: "in_person" }], "d.appt_availability": { mon: [["09:00", "17:00"]] }, "d.appt_notice": "24h" };
    const c = await submitRealOnboarding({ name: "Drift Notes Roofing", clearPayment: true, extraAnswers: booking });
    await withSystem((db) => db.query("update crm_calendars set status = 'active', verified_at = now() where org_id = $1", [c.org.id]));
    const typesBefore = await rows("select name, buffer_after_minutes, min_notice_minutes from crm_appointment_types where org_id = $1 order by position", [c.org.id]);
    await save(c.ctx, { "d.appt_buffer": "15m" });
    const out = await resubmit(c.ctx);
    const drift = out.notes.find((n) => n.key === "scheduling.drift");
    expect(drift?.message).toContain("your answers now say a 15-minute gap after appointments, your live calendar has no gap after appointments.");
    expect(drift?.message).toContain("Your live calendar was not changed");
    // The page the person lands on gets the whole line, not one cut short by the audit's own limit on a string.
    expect(drift!.message.length).toBeGreaterThan(120);
    expect(await latestOnboardingNotes(c.ctx)).toContain(drift!.message);
    expect(await rows("select name, buffer_after_minutes, min_notice_minutes from crm_appointment_types where org_id = $1 order by position", [c.org.id])).toEqual(typesBefore);
  }, 120_000);

  it("keeps the notes of each workspace to itself", async () => {
    const a = await submitRealOnboarding({ name: "Notes Iso A", clearPayment: true });
    const b = await submitRealOnboarding({ name: "Notes Iso B", clearPayment: true });
    await submitOnboarding(a.ctx);
    expect(await latestOnboardingNotes(a.ctx)).toEqual(["Nothing changed since your last submission, so nothing was updated."]);
    expect(await latestOnboardingNotes(b.ctx)).toEqual(b.result.notes.map((n) => n.message));
  }, 120_000);
});
