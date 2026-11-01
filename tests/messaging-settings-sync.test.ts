// Settings > Messaging (opening hours, reply hours, follow-up style) and the questionnaire answers they come from are two editors of the same facts. A Messaging edit moves the
// answers and the opening-hours knowledge text; a re-submission writes each messaging value only when its answer changed since the last submission, so neither editor undoes
// the other and a questionnaire edit made after the first submission now applies. Automatic replies are never switched on by any of it. Embedded Postgres, real migrations.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { formatHours } from "@/lib/onboarding/engine";
import { parseProfileSnapshot } from "@/lib/onboarding/business-profile";
import { getMessagingSettings, updateMessagingSettings } from "@/server/messaging/inbox";
import { getOnboardingSession, saveOnboardingStep, submitOnboarding } from "@/server/onboarding/service";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import { submitRealOnboarding } from "./support/billing";

type Ctx = ReturnType<typeof ctxFor>;
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const answerOf = async (orgId: string, id: string) => (await rows<{ value: unknown; source: string }>("select value, source from onboarding_answers where org_id = $1 and question_id = $2", [orgId, id]))[0];
const settingsOf = async (orgId: string) => (await rows<{ business_hours: Record<string, unknown>; reply_business_hours_only: boolean; followup_preset: string; auto_reply_enabled: boolean }>(
  "select business_hours, reply_business_hours_only, followup_preset, auto_reply_enabled from messaging_settings where org_id = $1", [orgId]))[0];
const knowledgeOf = async (orgId: string, section: string) => (await rows<{ content: string }>("select content from company_knowledge where org_id = $1 and section = $2", [orgId, section]))[0]?.content;
const snapshotOf = async (orgId: string) => parseProfileSnapshot((await rows<{ s: unknown }>("select submitted_snapshot as s from onboarding_responses where org_id = $1", [orgId]))[0]?.s);
const save = (ctx: Ctx, answers: Record<string, unknown>) => saveOnboardingStep(ctx, { answers: Object.fromEntries(Object.entries(answers).map(([k, value]) => [k, { value }])) });
const resubmit = async (ctx: Ctx) => {
  await save(ctx, { "f.review": true });
  return submitOnboarding(ctx);
};
const TUESDAY = { tue: [["10:00", "16:00"]] };
const lastAudit = async (orgId: string) => (await rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where org_id = $1 and action = 'messaging.settings_changed' order by id desc limit 1", [orgId]))[0]?.metadata;

describe("a Settings > Messaging edit and the answers it comes from", () => {
  it("moves the answers and the opening-hours knowledge, and an unrelated re-submission does not revert them", async () => {
    const c = await submitRealOnboarding({ name: "Hours Roofing", clearPayment: true });
    const original = await knowledgeOf(c.org.id, "business_hours");
    expect(original).toContain("Time zone: America/Chicago");

    await updateMessagingSettings(c.ctx, { businessHours: TUESDAY, replyBusinessHoursOnly: true, followUpPreset: "gentle" });

    expect(await settingsOf(c.org.id)).toMatchObject({ business_hours: TUESDAY, reply_business_hours_only: true, followup_preset: "gentle" });
    expect(await answerOf(c.org.id, "a.hours")).toMatchObject({ value: TUESDAY, source: "user" });
    expect(await answerOf(c.org.id, "c.response_hours")).toMatchObject({ value: "business_hours", source: "user" });
    expect(await answerOf(c.org.id, "d.followup")).toMatchObject({ value: "gentle", source: "user" });
    const moved = await knowledgeOf(c.org.id, "business_hours");
    expect(moved).toContain(formatHours({ tue: [["10:00", "16:00"]] }));
    expect(moved).not.toBe(original);
    // The edit is in the live workspace, so it is not an unsubmitted change.
    expect((await getOnboardingSession(c.ctx)).hasUnsubmittedChanges).toBe(false);

    await save(c.ctx, { "c.tone": "casual" });
    await resubmit(c.ctx);
    expect(await settingsOf(c.org.id)).toMatchObject({ business_hours: TUESDAY, reply_business_hours_only: true, followup_preset: "gentle" });
    expect(await knowledgeOf(c.org.id, "business_hours")).toBe(moved);
    expect((await snapshotOf(c.org.id))?.messaging).toMatchObject({ replyHours: "business_hours", followup: "gentle" });
  }, 120_000);

  it("applies a questionnaire edit of the reply hours made after the first submission, and leaves automatic replies off", async () => {
    const c = await submitRealOnboarding({ name: "Reply Hours Roofing", clearPayment: true });
    expect((await settingsOf(c.org.id)).reply_business_hours_only).toBe(false);
    await save(c.ctx, { "c.response_hours": "business_hours", "d.followup": "persistent" });
    await resubmit(c.ctx);
    const live = await settingsOf(c.org.id);
    expect(live).toMatchObject({ reply_business_hours_only: true, followup_preset: "persistent" });
    expect(live.auto_reply_enabled).toBe(false);
  }, 120_000);

  it("writes only the value whose answer changed: a Settings edit of the hours survives a questionnaire edit of the follow-up style", async () => {
    const c = await submitRealOnboarding({ name: "Only Changed Roofing", clearPayment: true });
    await updateMessagingSettings(c.ctx, { businessHours: TUESDAY });
    await save(c.ctx, { "d.followup": "off" });
    await resubmit(c.ctx);
    expect(await settingsOf(c.org.id)).toMatchObject({ business_hours: TUESDAY, followup_preset: "off" });
    // And the other way round: the questionnaire changes the hours, Settings' follow-up choice stays.
    await updateMessagingSettings(c.ctx, { followUpPreset: "gentle" });
    await save(c.ctx, { "a.hours": { mon: [["08:00", "12:00"]] } });
    await resubmit(c.ctx);
    expect(await settingsOf(c.org.id)).toMatchObject({ business_hours: { mon: [["08:00", "12:00"]] }, followup_preset: "gentle" });
  }, 120_000);

  // The two tests above run after the sync has made the answers and the live settings agree, so re-writing every value would give the same state and they could not tell. Here the
  // live settings differ from the answers without going through the sync (as when a value is changed while its answer is skipped or waiting, or by a direct write), and the
  // answers have not changed since the last submission: the next unrelated re-submission must leave the live values alone and say so.
  const setLive = (orgId: string) => withSystem((db) => db.query("update messaging_settings set business_hours = $2::jsonb, reply_business_hours_only = true where org_id = $1", [orgId, JSON.stringify(TUESDAY)]));

  it("does not revert hours or reply hours that differ from unchanged answers, and says it kept them", async () => {
    const c = await submitRealOnboarding({ name: "Kept Live Roofing", clearPayment: true });
    await setLive(c.org.id);
    await save(c.ctx, { "c.tone": "casual" });
    const out = await resubmit(c.ctx);
    expect(await settingsOf(c.org.id)).toMatchObject({ business_hours: TUESDAY, reply_business_hours_only: true });
    expect(out.notes.find((n) => n.key === "messaging.kept")?.message).toBe("Left as set in Messaging settings: opening hours and reply hours.");
  }, 120_000);

  it("does the same for a workspace submitted before snapshots kept the messaging values (the answers' edit times are the baseline)", async () => {
    const c = await submitRealOnboarding({ name: "Kept Live Legacy Roofing", clearPayment: true });
    await withSystem((db) => db.query("update onboarding_responses set submitted_snapshot = null where org_id = $1", [c.org.id]));
    await setLive(c.org.id);
    await save(c.ctx, { "c.tone": "casual" });
    const out = await resubmit(c.ctx);
    expect(await settingsOf(c.org.id)).toMatchObject({ business_hours: TUESDAY, reply_business_hours_only: true });
    expect(out.notes.find((n) => n.key === "messaging.kept")?.message).toBe("Left as set in Messaging settings: opening hours and reply hours.");
  }, 120_000);

  it("still writes the hours when their answer is the thing that changed, and keeps the reply hours whose answer did not", async () => {
    const c = await submitRealOnboarding({ name: "Answer Wins Roofing", clearPayment: true });
    await setLive(c.org.id);
    await save(c.ctx, { "a.hours": { mon: [["08:00", "12:00"]] } });
    await resubmit(c.ctx);
    expect(await settingsOf(c.org.id)).toMatchObject({ business_hours: { mon: [["08:00", "12:00"]] }, reply_business_hours_only: true });
  }, 120_000);

  it("keeps a custom follow-up schedule through a re-submission: it has no answer to write back", async () => {
    const c = await submitRealOnboarding({ name: "Custom Roofing", clearPayment: true });
    await updateMessagingSettings(c.ctx, { followUpPreset: "custom", followUpCustom: { attempts: 2, daysBetween: [1, 3], channel: "same", businessHoursOnly: true } });
    expect((await answerOf(c.org.id, "d.followup"))?.source).not.toBe("user");
    await save(c.ctx, { "c.tone": "casual" });
    await resubmit(c.ctx);
    expect((await settingsOf(c.org.id)).followup_preset).toBe("custom");
  }, 120_000);

  it("keeps opening-hours text a person edited in the Knowledge Center", async () => {
    const c = await submitRealOnboarding({ name: "Edited Knowledge Roofing", clearPayment: true });
    await withSystem((db) => db.query("update company_knowledge set content = 'Open when the gate is up.' where org_id = $1 and section = 'business_hours'", [c.org.id]));
    await updateMessagingSettings(c.ctx, { businessHours: TUESDAY });
    expect(await knowledgeOf(c.org.id, "business_hours")).toBe("Open when the gate is up.");
    expect((await answerOf(c.org.id, "a.hours")).value).toEqual(TUESDAY);
  }, 120_000);

  it("works for a workspace submitted before snapshots kept the messaging values", async () => {
    const c = await submitRealOnboarding({ name: "Legacy Messaging Roofing", clearPayment: true });
    await withSystem((db) => db.query("update onboarding_responses set submitted_snapshot = null where org_id = $1", [c.org.id]));
    await updateMessagingSettings(c.ctx, { businessHours: TUESDAY });
    await save(c.ctx, { "c.tone": "casual" });
    await resubmit(c.ctx);
    expect((await settingsOf(c.org.id)).business_hours).toEqual(TUESDAY);
  }, 120_000);

  it("leaves a questionnaire edit that is still waiting as it is", async () => {
    const c = await submitRealOnboarding({ name: "Waiting Messaging Roofing", clearPayment: true });
    await save(c.ctx, { "d.followup": "persistent" });
    await updateMessagingSettings(c.ctx, { businessHours: TUESDAY });
    expect((await answerOf(c.org.id, "d.followup")).value).toBe("persistent");
    expect((await getOnboardingSession(c.ctx)).hasUnsubmittedChanges).toBe(true);
    expect((await settingsOf(c.org.id)).followup_preset).toBe("balanced");
  }, 120_000);

  it("refuses hours that do not make sense and changes nothing", async () => {
    const c = await submitRealOnboarding({ name: "Bad Hours Roofing", clearPayment: true });
    const before = await settingsOf(c.org.id);
    const answer = await answerOf(c.org.id, "a.hours");
    await expect(updateMessagingSettings(c.ctx, { businessHours: { tue: [["17:00", "09:00"]] } })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await settingsOf(c.org.id)).toEqual(before);
    expect(await answerOf(c.org.id, "a.hours")).toEqual(answer);
  }, 120_000);

  it("does not create answers for a workspace that has not started the questionnaire", async () => {
    const org = await createOrg({ name: "Not Started Messaging Co" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const ctx = ctxFor(owner, org, "owner");
    await updateMessagingSettings(ctx, { businessHours: TUESDAY, replyBusinessHoursOnly: true });
    expect(await rows("select 1 from onboarding_answers where org_id = $1", [org.id])).toHaveLength(0);
    expect((await getMessagingSettings(ctx)).replyBusinessHoursOnly).toBe(true);
  }, 60_000);

  it("only moves its own workspace's answers and knowledge", async () => {
    const a = await submitRealOnboarding({ name: "Messaging Iso A", clearPayment: true });
    const b = await submitRealOnboarding({ name: "Messaging Iso B", clearPayment: true });
    const bAnswer = await answerOf(b.org.id, "a.hours");
    const bKnowledge = await knowledgeOf(b.org.id, "business_hours");
    const bSnapshot = await snapshotOf(b.org.id);
    await updateMessagingSettings(a.ctx, { businessHours: TUESDAY, followUpPreset: "off" });
    expect(await answerOf(b.org.id, "a.hours")).toEqual(bAnswer);
    expect(await knowledgeOf(b.org.id, "business_hours")).toBe(bKnowledge);
    expect(await snapshotOf(b.org.id)).toEqual(bSnapshot);
    expect((await settingsOf(b.org.id)).followup_preset).toBe("balanced");
  }, 120_000);

  it("records in the audit row what the edit did", async () => {
    const c = await submitRealOnboarding({ name: "Audit Messaging Roofing", clearPayment: true });
    await updateMessagingSettings(c.ctx, { businessHours: TUESDAY, replyBusinessHoursOnly: true, followUpPreset: "gentle" });
    expect(await lastAudit(c.org.id)).toMatchObject({ hoursChanged: true, replyBusinessHoursOnly: true, followUpPreset: "gentle" });
    await updateMessagingSettings(c.ctx, { businessHours: TUESDAY });
    expect(await lastAudit(c.org.id)).toMatchObject({ hoursChanged: false });
  }, 120_000);

  it("a save that does not name any of the three leaves the questionnaire alone", async () => {
    const c = await submitRealOnboarding({ name: "Timeouts Only Roofing", clearPayment: true });
    const before = await rows<{ question_id: string; updated_at: Date }>("select question_id, updated_at from onboarding_answers where org_id = $1 order by question_id", [c.org.id]);
    await updateMessagingSettings(c.ctx, { ownerTimeoutUrgentSeconds: 90 });
    expect(await rows("select question_id, updated_at from onboarding_answers where org_id = $1 order by question_id", [c.org.id])).toEqual(before);
    expect((await getOnboardingSession(c.ctx)).hasUnsubmittedChanges).toBe(false);
  }, 120_000);
});
