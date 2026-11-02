// Answer edits that nobody approved: the rule is the questionnaire's own, it blocks "100% Ready to Launch" while an edit waits, and the facts that decide what is required (are appointments
// wanted, which channels) keep reading what was last approved until the client approves. Test database only; nothing is sent, booked or contacted.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { approvedAnswersOf, channelsWithApprovedSender, pendingChangesOf, readPendingAnswerChanges } from "@/server/onboarding/pending-changes";
import { getOnboardingSession, saveOnboardingStep, submitOnboarding } from "@/server/onboarding/service";
import { getLaunchReadiness, loadLaunchFacts } from "@/server/setup/launch-readiness";
import { runLaunchIntent } from "@/server/setup/launch-intents";
import { sweepLaunchVerification } from "@/server/setup/launch-sweep";
import { submitRealOnboarding } from "./support/billing";
import { itemOf, markSubmitted, readyClient, settled } from "./support/launch";

const T0 = Date.parse("2026-10-26T06:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const row = (question_id: string, minutes: number, over: Record<string, unknown> = {}) => ({ question_id, value: true, skipped: false, source: "user" as const, needs_confirmation: false, updated_at: at(minutes), ...over });

describe("the rule: an answer saved after the last approval is an edit nobody approved", () => {
  it("is never pending before a first submission, and not pending while every answer is older than it", () => {
    expect(pendingChangesOf([row("b.appointments", 5)], null)).toEqual({ pending: false, editedIds: [], appliedAt: 0 });
    expect(pendingChangesOf([row("b.appointments", 5)], { submittedAt: null, snapshot: null }).pending).toBe(false);
    expect(pendingChangesOf([row("b.appointments", 5), row("a.timezone", 10, { value: "UTC" })], { submittedAt: at(10), snapshot: null })).toMatchObject({ pending: false, editedIds: [] });
  });

  it("names the answers saved after the submission, ignores rows that are not questions, and lets a Settings edit that left nothing waiting move the line", () => {
    const rows = [row("b.appointments", 5), row("c.channels", 20, { value: ["sms"] }), row("website_analysis_internal", 30)];
    const state = pendingChangesOf(rows, { submittedAt: at(10), snapshot: null });
    expect(state).toMatchObject({ pending: true, editedIds: ["c.channels"] });
    // The snapshot's own "applied through" (a Settings edit that left nothing waiting) counts as applied, exactly as getOnboardingSession reads it.
    const applied = pendingChangesOf(rows, { submittedAt: at(10), snapshot: { version: 1, fields: {}, appliedThrough: at(25).toISOString() } });
    expect(applied).toMatchObject({ pending: false, editedIds: [] });
    expect(applied.appliedAt).toBe(at(25).getTime());
  });

  it("keeps the approved answers without the edited ones, and gives a sender answer that did not change as evidence of a channel", () => {
    const rows = [
      row("b.appointments", 5), row("c.channels", 20, { value: ["email"] }),
      row("c.email_sender", 5, { value: "hello@brightside.example" }), row("c.sms_sender", 5, { value: "+1 512 555 0100", needs_confirmation: true }), row("c.whatsapp_number", 20, { value: "+1 512 555 0111" }),
    ];
    const state = pendingChangesOf(rows, { submittedAt: at(10), snapshot: null });
    expect(state.editedIds.sort()).toEqual(["c.channels", "c.whatsapp_number"]);
    expect(approvedAnswersOf(rows, state)["b.appointments"]).toBe(true);
    expect(approvedAnswersOf(rows, state)["c.channels"]).toBeUndefined();
    // Only an unchanged, confirmed sender counts: not an unconfirmed guess, not one that was edited since.
    expect(channelsWithApprovedSender(rows, state)).toEqual(["email"]);
  });
});

describe("it is the same rule the questionnaire uses, read from the real rows", () => {
  it("agrees with getOnboardingSession before and after an edit, and a real submission leaves nothing pending behind", async () => {
    const c = await submitRealOnboarding({ name: "Same Rule Roofing", clearPayment: true });
    const pending = async () => (await withSystem((db) => readPendingAnswerChanges(db, c.org.id))).pending;
    // The submission's own side effects (a drafted calendar, lead targeting) must not look like edits.
    expect(await pending()).toBe(false);
    expect((await getOnboardingSession(c.ctx)).hasUnsubmittedChanges).toBe(false);
    expect((await loadLaunchFacts(c.ctx))!.pendingAnswerChanges).toBeUndefined();

    await saveOnboardingStep(c.ctx, { answers: { "b.services": { value: "Roof repair, inspection and gutters" } } });
    expect(await pending()).toBe(true);
    expect((await getOnboardingSession(c.ctx)).hasUnsubmittedChanges).toBe(true);
    expect((await loadLaunchFacts(c.ctx))!.pendingAnswerChanges).toBe(true);
    // The edit also withdraws the client's confirmation ("I approve this setup"), so approving means confirming again.
    expect((await withSystem((db) => readPendingAnswerChanges(db, c.org.id))).editedIds.sort()).toEqual(["b.services", "f.review"]);

    await saveOnboardingStep(c.ctx, { answers: { "f.review": { value: true } } });
    await submitOnboarding(c.ctx);
    expect(await pending()).toBe(false);
    expect((await getOnboardingSession(c.ctx)).hasUnsubmittedChanges).toBe(false);
    expect((await loadLaunchFacts(c.ctx))!.pendingAnswerChanges).toBeUndefined();
  }, 180_000);
});

describe("an unapproved edit does not turn a requirement off", () => {
  it("on a client that is ready: not 100%, the calendar is not marked not applicable, the sweep still checks the Appointment Setter, and after approval everything is consistent", async () => {
    const c = await readyClient({ name: "Pending Appointments Roofing", timezone: "America/Chicago" });
    await markSubmitted(c.org.id);
    expect((await loadLaunchFacts(c.ctx))!.pendingAnswerChanges).toBeUndefined();

    // The client says "we do not book appointments any more" and has not approved it yet.
    const saved = await saveOnboardingStep(c.ctx, { answers: { "b.appointments": { value: false } } });
    expect(saved.rejected).toEqual({});
    const facts = (await loadLaunchFacts(c.ctx))!;
    expect(facts.pendingAnswerChanges).toBe(true);
    // The live setup still has a calendar, so appointments are still wanted until the edit is approved.
    expect(facts.appointments.wanted).toBe(true);

    // The final checks still cover the Appointment Setter: the sweep reads what was approved, not the draft.
    expect((await sweepLaunchVerification(c.org.id)).queued.sort()).toEqual([...AGENT_ROLE_KEYS].sort());
    await settled(c.org.id, 6);

    const held = (await getLaunchReadiness(c.ctx))!;
    expect(held.state).toBe("action_required");
    expect(held.percent).toBeLessThan(100);
    expect(held.blocking.map((i) => i.key)).toEqual(["profile.pending_changes"]);
    expect(itemOf(held, "profile.pending_changes")).toMatchObject({ owner: "you", required: true, action: { href: "/onboarding" } });
    // Nothing is marked not applicable ahead of the approval.
    expect(held.steps.find((s) => s.key === "calendar")!.state).toBe("done");
    expect(itemOf(held, "calendar.active").state).toBe("done");
    expect(itemOf(held, "employees.appointment_setter").state).toBe("done");
    expect(itemOf(held, "verification.appointment_setter").state).toBe("done");

    // Approved (the submission stamps the row again): now it is what the client said, everywhere at once.
    await markSubmitted(c.org.id);
    // A real submission also brings the employees up to what was approved; stamping the row only records the approval, so the guided step does the rest (the Appointment Setter's
    // role answers followed "no appointments", and until they are updated that employee is behind what the client approved).
    await runLaunchIntent(c.ctx, "sync_employees");
    const approved = (await getLaunchReadiness(c.ctx))!;
    expect(approved.steps.find((s) => s.key === "calendar")!.state).toBe("not_applicable");
    expect(itemOf(approved, "employees.appointment_setter").state).toBe("not_applicable");
    expect(itemOf(approved, "verification.appointment_setter").state).toBe("not_applicable");
    expect(approved.steps.flatMap((s) => s.items).some((i) => i.key === "profile.pending_changes")).toBe(false);
    expect(approved).toMatchObject({ state: "ready_to_launch", percent: 100 });
  }, 300_000);

  it("on a real submission: an unapproved 'no appointments' and an unapproved channel change change nothing until the client submits again", async () => {
    const booking = {
      "d.appt_types": [{ name: "Free inspection", minutes: "45", mode: "in_person" }],
      "d.appt_availability": { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]] },
      "d.appt_notice": "2h", "d.appt_buffer": "15m", "d.appt_confirmation": "manual", "d.appt_changes": "24h", "d.appt_cancellation": "Free to reschedule up to 24 hours before.",
    };
    const c = await submitRealOnboarding({ name: "Pending Channels Roofing", clearPayment: true, extraAnswers: { ...booking, "c.channels": ["email"], "c.email_sender": "hello@pending-channels.example" } });
    const before = (await loadLaunchFacts(c.ctx))!;
    expect(before.appointments.wanted).toBe(true);
    expect(before.appointments.calendar).not.toBeNull();
    expect(before.channels.filter((ch) => ch.wanted).map((ch) => ch.channel)).toEqual(["email"]);

    // Edited, not approved: no appointments, and SMS instead of email.
    const saved = await saveOnboardingStep(c.ctx, { answers: { "b.appointments": { value: false }, "c.channels": { value: ["sms"] } } });
    expect(saved.rejected).toEqual({});
    const pending = (await loadLaunchFacts(c.ctx))!;
    expect(pending.pendingAnswerChanges).toBe(true);
    // The requirements are what was approved: appointments still wanted (the calendar exists), email still wanted (its sender answer is unchanged), SMS not yet.
    expect(pending.appointments.wanted).toBe(true);
    expect(pending.channels.filter((ch) => ch.wanted).map((ch) => ch.channel)).toEqual(["email"]);
    const held = (await getLaunchReadiness(c.ctx))!;
    expect(held.steps.find((s) => s.key === "calendar")!.state).not.toBe("not_applicable");
    expect(itemOf(held, "employees.appointment_setter").state).not.toBe("not_applicable");
    expect(held.steps.find((s) => s.key === "integrations")!.items.map((i) => i.key)).toEqual(["integrations.email"]);
    expect(itemOf(held, "profile.pending_changes").state).toBe("action_required");

    // The client approves by submitting again: now the edit is the setup.
    await saveOnboardingStep(c.ctx, { answers: { "f.review": { value: true } } });
    await submitOnboarding(c.ctx);
    const after = (await loadLaunchFacts(c.ctx))!;
    expect(after.pendingAnswerChanges).toBeUndefined();
    expect(after.appointments.wanted).toBe(false);
    expect(after.channels.filter((ch) => ch.wanted).map((ch) => ch.channel)).toEqual(["sms"]);
    const done = (await getLaunchReadiness(c.ctx))!;
    expect(done.steps.find((s) => s.key === "calendar")!.state).toBe("not_applicable");
    expect(done.steps.flatMap((s) => s.items).some((i) => i.key === "profile.pending_changes")).toBe(false);
  }, 300_000);
});
