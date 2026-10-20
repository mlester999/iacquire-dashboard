import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { getRequestDetail, submitRequest, postClientMessage } from "@/server/support/service";
import { agencyPostMessage, changePriority, changeRequestStatus, getAgencyRequest, listAgencyRequests } from "@/server/support/agency";
import { loadSupportSettings, loadSupportSettingsFresh, setNotificationRule, updateSupportSettings, listNotificationRules, type SupportSettingsPatch } from "@/server/support/settings";
import { dispatchSupportNotice, flushSupportEmails } from "@/server/support/notify";
import { checkResponseTargets } from "@/server/support/response-clock";
import { autoCloseResolvedRequests, runResponseTargetCheck } from "@/server/support/jobs";
import { countRows, notificationsFor, resetRateLimits, supportWorld, ticketRow, type SupportWorld } from "./support/support-world";

let w: SupportWorld;
beforeAll(async () => {
  w = await supportWorld();
});
beforeEach(resetRateLimits);
afterAll(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

const open = async (subject = "A request about notifications", ctx = w.ctx.member) => (await submitRequest(ctx, { subject, message: "Please help with this request." })).id;
const setMode = (event: string, mode: string) => setNotificationRule(w.agency.superAdmin, event, mode);
const logFor = async (ticketId: string, kind: string) =>
  (await withSystem((db) => db.query<{ channel: string; status: string; detail: string | null; recipient_user_id: string; attempts: number }>(
    "select channel, status, detail, recipient_user_id, attempts from support_notification_log where ticket_id = $1 and event_kind = $2 order by created_at", [ticketId, kind],
  ))).rows;
const settingsRevision = async () => (await loadSupportSettings()).revision;
const configure = async (patch: SupportSettingsPatch) => updateSupportSettings(w.agency.superAdmin, patch, await settingsRevision());
const reset = () => configure({ targetsEnabled: false, showTargetsToClients: false, businessHoursOnly: true, firstResponseMinutes: {}, followUpMinutes: {}, overdueEscalationMinutes: null, autoCloseResolvedDays: null, approachingPercent: 80 });
const quiet = async () => {
  await resetOutbox();
};
const resetOutbox = () => withSystem((db) => db.query("delete from email_outbox"));

describe("how each update is delivered (Super Admin's rule per event)", () => {
  it("starts with sensible defaults and lists every event", async () => {
    const rules = await listNotificationRules(w.agency.superAdmin);
    expect(rules).toHaveLength(11);
    expect(Object.fromEntries(rules.map((r) => [r.event, r.mode]))).toMatchObject({ request_submitted: "in_app", agency_reply: "both", response_overdue: "both", resolved: "both" });
  });

  it("delivers in-app only, email only, both, or nothing, and records what happened for each", async () => {
    await quiet();
    const results: Record<string, { inApp: number; log: string[] }> = {};
    for (const mode of ["in_app", "email", "both", "disabled"] as const) {
      await setMode("agency_reply", mode);
      const id = await open(`Delivery mode ${mode}`);
      const ref = (await ticketRow(id)).ref as string;
      await agencyPostMessage(w.agency.staff, id, { body: `Reply text for ${mode} delivery.` });
      const inApp = (await notificationsFor(w.people.member.id, "support_reply")).filter((n) => n.title.includes(ref)).length;
      const log = (await logFor(id, "agency_reply")).map((l) => `${l.channel}:${l.status}`).sort();
      results[mode] = { inApp, log };
    }
    expect(results.in_app).toEqual({ inApp: 1, log: ["in_app:delivered"] });
    expect(results.email).toEqual({ inApp: 0, log: ["email:captured"] });
    expect(results.both).toEqual({ inApp: 1, log: ["email:captured", "in_app:delivered"] });
    expect(results.disabled).toEqual({ inApp: 0, log: ["in_app:skipped"] });
    await setMode("agency_reply", "both");
  });

  it("emails only the people on the client's side, with a link and the reply, and never an internal note", async () => {
    await quiet();
    await setMode("agency_reply", "both");
    const id = await open("Email content");
    await agencyPostMessage(w.agency.staff, id, { body: "SECRET-NOTE do not share", internal: true });
    await agencyPostMessage(w.agency.staff, id, { body: "Your calendar is fixed now." });
    const mails = (await withSystem((db) => db.query<{ to_email: string; subject: string; body_text: string; status: string }>("select to_email, subject, body_text, status from email_outbox order by created_at"))).rows;
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to_email: w.people.member.email, status: "captured" });
    expect(mails[0].subject).toMatch(/^iAcquire replied to IAQ-\d+$/);
    expect(mails[0].body_text).toContain("Your calendar is fixed now.");
    expect(mails[0].body_text).toContain(`/support/${id}`);
    expect(mails[0].body_text).not.toMatch(/SECRET-NOTE/);
    expect(mails[0].body_text).toMatch(/reply inside iAcquire/i);
  });

  it("never puts what a client wrote into email sent to the team", async () => {
    await quiet();
    await setMode("client_reply", "both");
    const id = await open("Client wrote something private");
    await agencyPostMessage(w.agency.staff, id, { body: "Tell me more." });
    await resetOutbox();
    await postClientMessage(w.ctx.member, id, { body: "My card number is 4111-PRIVATE-CLIENT-TEXT." });
    const mails = (await withSystem((db) => db.query<{ to_email: string; body_text: string }>("select to_email, body_text from email_outbox"))).rows;
    expect(mails.length).toBeGreaterThan(0);
    expect(mails.map((m) => m.body_text).join("\n")).not.toMatch(/PRIVATE-CLIENT-TEXT/);
    expect(mails.every((m) => m.to_email !== w.people.member.email)).toBe(true);
    expect(mails.map((m) => m.to_email)).toContain(w.raw.staff.email);
    await setMode("client_reply", "in_app");
  });

  it("notifies each person once even when the same event is handled twice", async () => {
    const id = await open("Idempotent delivery");
    const ticket = { id, org_id: w.org.id, ref: (await ticketRow(id)).ref as string, subject: "Idempotent delivery" };
    const send = () => withSystem((db) => dispatchSupportNotice(db, { event: "agency_reply", ticket, eventKey: `test:${id}`, recipients: [{ userId: w.people.member.id, audience: "client" }], title: "Once only" }));
    const a = await send();
    const b = await send();
    expect(a.delivered).toBe(1);
    expect(b).toMatchObject({ delivered: 0, duplicates: expect.any(Number) });
    expect((await notificationsFor(w.people.member.id)).filter((n) => n.title === "Once only")).toHaveLength(1);
    expect(await countRows("select 1 from support_notification_log where event_key = $1", [`test:${id}`])).toBeGreaterThanOrEqual(1);
    // The same person listed twice still hears once.
    const twice = await withSystem((db) => dispatchSupportNotice(db, { event: "agency_reply", ticket, eventKey: `test2:${id}`, recipients: [{ userId: w.people.member.id, audience: "client" }, { userId: w.people.member.id, audience: "client" }], title: "Twice listed" }));
    expect(twice.delivered).toBe(1);
  });

  it("never reaches another client's people or staff outside this client's scope", async () => {
    const id = await open("Isolation of notices");
    await agencyPostMessage(w.agency.staff, id, { body: "A reply that must stay inside this client." });
    await changeRequestStatus(w.agency.staff, id, "resolved");
    const ref = (await ticketRow(id)).ref as string;
    for (const person of [w.people.outsider, w.raw.outStaff, w.people.viewer]) {
      expect((await notificationsFor(person.id)).some((n) => n.title.includes(ref)), person.id).toBe(false);
    }
    const recipients = (await withSystem((db) => db.query<{ recipient_user_id: string }>("select distinct recipient_user_id from support_notification_log where ticket_id = $1", [id]))).rows.map((r) => r.recipient_user_id);
    expect(recipients).not.toContain(w.people.outsider.id);
    expect(recipients).not.toContain(w.raw.outStaff.id);
  });

  it("respects a person's own choice to turn email off", async () => {
    await setMode("agency_reply", "email");
    await withSystem((db) => db.query(
      `insert into notification_preferences (user_id, org_id, prefs) values ($1, $2, '{"email":"off"}') on conflict (user_id, org_id) do update set prefs = excluded.prefs`, [w.people.member.id, w.org.id],
    ));
    const id = await open("Email turned off");
    await resetOutbox();
    await agencyPostMessage(w.agency.staff, id, { body: "Reply that cannot be emailed." });
    expect((await logFor(id, "agency_reply"))[0]).toMatchObject({ channel: "email", status: "skipped", detail: expect.stringMatching(/turned email notifications off/i) });
    expect(await countRows("select 1 from email_outbox")).toBe(0);
    await withSystem((db) => db.query("delete from notification_preferences where user_id = $1", [w.people.member.id]));
    await setMode("agency_reply", "both");
  });

  it("records a failed email honestly, retries it a limited number of times, and never claims it was sent", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "");
    resetEnvCache();
    await resetOutbox();
    await setMode("agency_reply", "email");
    const id = await open("Provider is down");
    await agencyPostMessage(w.agency.staff, id, { body: "This email cannot leave." });
    let row = (await logFor(id, "agency_reply"))[0];
    expect(row).toMatchObject({ channel: "email", status: "failed", attempts: 1 });
    expect(row.detail).toMatch(/RESEND_API_KEY|configured/i);
    // Too soon to retry.
    await flushSupportEmails({ ticketId: id });
    expect((await logFor(id, "agency_reply"))[0].attempts).toBe(1);
    for (const expected of [2, 3]) {
      await withSystem((db) => db.query("update support_notification_log set updated_at = now() - interval '11 minutes' where ticket_id = $1", [id]));
      await flushSupportEmails({ ticketId: id });
      row = (await logFor(id, "agency_reply"))[0];
      expect(row).toMatchObject({ status: "failed", attempts: expected });
    }
    // Three attempts is the limit.
    await withSystem((db) => db.query("update support_notification_log set updated_at = now() - interval '2 hours' where ticket_id = $1", [id]));
    await flushSupportEmails({ ticketId: id });
    expect((await logFor(id, "agency_reply"))[0]).toMatchObject({ status: "failed", attempts: 3 });
    expect(await countRows("select 1 from email_outbox where status = 'failed'")).toBe(3);
    expect(await countRows("select 1 from support_notification_log where ticket_id = $1 and channel = 'email' and status in ('sent', 'delivered')", [id])).toBe(0);
    vi.unstubAllEnvs();
    resetEnvCache();
    await setMode("agency_reply", "both");
  });

  it("lets only a Super Admin change the rules, and audits it", async () => {
    await expect(setNotificationRule(w.agency.manager, "resolved", "disabled")).rejects.toThrow(/does not allow/);
    await expect(setNotificationRule(w.agency.staff, "resolved", "disabled")).rejects.toThrow(/does not allow/);
    await expect(setNotificationRule(w.agency.superAdmin, "resolved", "sms")).rejects.toThrow(/in-app, email, both or off/);
    await expect(setNotificationRule(w.agency.superAdmin, "nonsense", "email")).rejects.toThrow(/Unknown/);
    await setMode("resolved", "disabled");
    expect(await countRows("select 1 from audit_logs where action = 'support.notification_rule_updated' and target_id = 'resolved'")).toBeGreaterThanOrEqual(1);
    const id = await open("Resolved with notices off");
    const ref = (await ticketRow(id)).ref as string;
    await changeRequestStatus(w.agency.staff, id, "resolved");
    expect((await logFor(id, "resolved"))[0]).toMatchObject({ status: "skipped", detail: expect.stringMatching(/turned off/) });
    expect((await notificationsFor(w.people.member.id, "support_status")).some((n) => n.title.includes(ref))).toBe(false);
    await setMode("resolved", "both");
  });
});

describe("response targets", () => {
  it("are off until the Super Admin turns them on, and only the Super Admin can", async () => {
    const id = await open("No targets yet");
    expect(await countRows("select 1 from support_ticket_ops where ticket_id = $1 and response_due_at is not null", [id])).toBe(0);
    expect(await checkResponseTargets()).toEqual({ approaching: 0, overdue: 0, escalated: 0 });
    await expect(updateSupportSettings(w.agency.manager, { targetsEnabled: true }, await settingsRevision())).rejects.toThrow(/does not allow/);
    await expect(updateSupportSettings(w.agency.staff, { targetsEnabled: true }, await settingsRevision())).rejects.toThrow(/does not allow/);
  });

  it("validates settings and refuses stale edits", async () => {
    const rev = await settingsRevision();
    await expect(updateSupportSettings(w.agency.superAdmin, { timezone: "Mars/Olympus" }, rev)).rejects.toThrow(/valid time zone/i);
    await expect(updateSupportSettings(w.agency.superAdmin, { businessHours: { mon: [["17:00", "09:00"]] } }, rev)).rejects.toThrow(/end after/i);
    await expect(updateSupportSettings(w.agency.superAdmin, { holidays: ["2026-02-30"] }, rev)).rejects.toThrow(/real date/i);
    await expect(updateSupportSettings(w.agency.superAdmin, { firstResponseMinutes: { normal: -5 } }, rev)).rejects.toThrow(/whole minutes/i);
    await expect(updateSupportSettings(w.agency.superAdmin, { maxAttachmentMb: 50 }, rev)).rejects.toThrow();
    await expect(updateSupportSettings(w.agency.superAdmin, { defaultPriority: { support: "critical" } }, rev)).rejects.toThrow(/default priority/i);
    await updateSupportSettings(w.agency.superAdmin, { approachingPercent: 70 }, rev);
    await expect(updateSupportSettings(w.agency.superAdmin, { approachingPercent: 80 }, rev)).rejects.toThrow(/Someone else changed/);
    expect((await loadSupportSettings()).approachingPercent).toBe(70);
    expect(await countRows("select 1 from audit_logs where action = 'support.settings_updated'")).toBeGreaterThanOrEqual(1);
    await reset();
  });

  it("reads the saved row for the Settings page even when this process holds an older cached copy", async () => {
    const before = await loadSupportSettings(); // warms the in-process cache
    // Another server instance (or another bundle of this one) saves a change: only the row changes, this cache is not told.
    await withSystem((db) => db.query("update support_settings set reopen_window_days = $1, revision = revision + 1 where id", [before.reopenWindowDays === 21 ? 14 : 21]));
    expect((await loadSupportSettings()).reopenWindowDays).toBe(before.reopenWindowDays);
    const fresh = await loadSupportSettingsFresh();
    expect(fresh.reopenWindowDays).not.toBe(before.reopenWindowDays);
    expect(fresh.revision).toBe(before.revision + 1);
    expect((await loadSupportSettings()).revision).toBe(fresh.revision);
    await reset();
  });

  it("start with the request, stop when the team replies, restart on the client's reply and pause while waiting", async () => {
    await configure({ targetsEnabled: true, businessHoursOnly: false, firstResponseMinutes: { normal: 60, high: 30 }, followUpMinutes: { normal: 30, high: 20 } });
    const before = Date.now();
    const id = await open("Clock behaviour");
    const clock = async () => (await withSystem((db) => db.query<{ response_due_at: Date | null; response_kind: string | null }>("select response_due_at, response_kind from support_ticket_ops where ticket_id = $1", [id]))).rows[0];
    let c = await clock();
    expect(c.response_kind).toBe("first");
    expect(new Date(c.response_due_at!).getTime() - before).toBeGreaterThan(59 * 60_000);
    expect(new Date(c.response_due_at!).getTime() - before).toBeLessThan(61 * 60_000);

    // A priority change re-times the running clock from when it started.
    await changePriority(w.agency.manager, id, "high");
    c = await clock();
    expect(new Date(c.response_due_at!).getTime() - before).toBeLessThan(31 * 60_000);

    // An internal note is not a reply: the clock keeps running. A public reply stops it.
    await agencyPostMessage(w.agency.staff, id, { body: "Private.", internal: true });
    expect((await clock()).response_due_at).not.toBeNull();
    await agencyPostMessage(w.agency.staff, id, { body: "Public reply." });
    expect((await clock()).response_due_at).toBeNull();
    expect((await ticketRow(id)).status).toBe("waiting_for_client");

    // The client answers: a follow-up clock starts (the first response has happened).
    await postClientMessage(w.ctx.member, id, { body: "Here is more information." });
    c = await clock();
    expect(c.response_kind).toBe("follow_up");
    expect(c.response_due_at).not.toBeNull();
    // A second message from the client does not push the deadline out.
    const first = c.response_due_at!.toISOString();
    await postClientMessage(w.ctx.member, id, { body: "And one more thing." });
    expect((await clock()).response_due_at!.toISOString()).toBe(first);
    // Finishing the request stops the clock.
    await changeRequestStatus(w.agency.staff, id, "resolved");
    expect((await clock()).response_due_at).toBeNull();
    await reset();
  });

  it("raise 'approaching' and 'overdue' notices once each, to the right people, and escalate after the threshold", async () => {
    await configure({ targetsEnabled: true, businessHoursOnly: false, firstResponseMinutes: { normal: 100 }, overdueEscalationMinutes: 15 });
    const id = await open("Targets in motion");
    const ref = (await ticketRow(id)).ref as string;
    const due = new Date((await withSystem((db) => db.query<{ d: Date }>("select response_due_at as d from support_ticket_ops where ticket_id = $1", [id]))).rows[0].d);
    const at = (minutesFromDue: number) => new Date(due.getTime() + minutesFromDue * 60_000);
    const slaNotices = async (userId: string) => (await notificationsFor(userId, "support_sla")).filter((n) => n.title.startsWith(ref));

    expect(await checkResponseTargets(at(-90))).toEqual({ approaching: 0, overdue: 0, escalated: 0 });
    // 80% of 100 minutes has passed.
    expect((await checkResponseTargets(at(-15))).approaching).toBe(1);
    expect((await checkResponseTargets(at(-10))).approaching).toBe(0);
    // Everyone watching this client's queue hears the warning once.
    for (const staff of [w.raw.staff, w.raw.staff2, w.raw.manager, w.raw.superAdmin]) expect((await slaNotices(staff.id)).map((n) => n.title)).toEqual([`${ref}: first reply due soon`]);
    expect(await slaNotices(w.people.owner.id)).toEqual([]);
    expect(await slaNotices(w.raw.outStaff.id)).toEqual([]);

    // Overdue goes to managers (people who manage priorities), once.
    const overdue = await checkResponseTargets(at(5));
    expect(overdue).toMatchObject({ overdue: 1, escalated: 0 });
    expect((await checkResponseTargets(at(6))).overdue).toBe(0);
    expect((await slaNotices(w.raw.manager.id)).map((n) => n.title)).toContain(`${ref}: first reply overdue`);
    expect((await slaNotices(w.raw.staff.id)).map((n) => n.title)).not.toContain(`${ref}: first reply overdue`);

    // Late by more than the escalation threshold: flagged once for managers; priority is untouched.
    expect((await checkResponseTargets(at(20))).escalated).toBe(1);
    expect((await checkResponseTargets(at(25))).escalated).toBe(0);
    const detail = await getAgencyRequest(w.agency.superAdmin, id);
    expect(detail!.ticket.escalation?.reason).toMatch(/overdue by more than 15 minutes/);
    expect((await ticketRow(id)).priority).toBe("normal");
    expect(detail!.timeline.filter((e) => e.kind === "sla_alert").map((e) => e.to)).toEqual(["approaching", "overdue"]);
    expect(await countRows("select 1 from support_ticket_events where ticket_id = $1 and kind = 'escalated' and actor_kind = 'system'", [id])).toBe(1);

    // The queue shows the state and can be filtered by it; the client sees none of it.
    const real = (await listAgencyRequests(w.agency.superAdmin, { view: "all", q: "Targets in motion" })).items[0];
    expect(["approaching", "overdue", "on_track"]).toContain(real.sla.state);
    expect(JSON.stringify(await getRequestDetail(w.ctx.member, id))).not.toMatch(/overdue|approaching|response_due/i);
    expect(await runResponseTargetCheck()).toBeGreaterThanOrEqual(0);
    await reset();
  });

  it("report waiting on client and finished requests without a running clock", async () => {
    await configure({ targetsEnabled: true, businessHoursOnly: false, firstResponseMinutes: { normal: 60 } });
    const waiting = await open("Waiting state");
    await agencyPostMessage(w.agency.staff, waiting, { body: "Question." });
    const done = await open("Finished state");
    await changeRequestStatus(w.agency.staff, done, "resolved");
    const items = (await listAgencyRequests(w.agency.superAdmin, { view: "all", pageSize: 100 })).items;
    expect(items.find((i) => i.id === waiting)!.sla.state).toBe("waiting_on_client");
    expect(items.find((i) => i.id === done)!.sla.state).toBe("resolved");
    await reset();
  });
});

describe("auto-closing resolved requests", () => {
  it("is off by default, then closes only requests resolved longer ago than the period, with a clear note", async () => {
    const old = await open("Resolved long ago");
    const recent = await open("Resolved just now");
    await changeRequestStatus(w.agency.staff, old, "resolved");
    await changeRequestStatus(w.agency.staff, recent, "resolved");
    await withSystem((db) => db.query("update support_tickets set resolved_at = now() - interval '3 days' where id = $1", [old]));
    expect(await autoCloseResolvedRequests()).toBe(0);
    await configure({ autoCloseResolvedDays: 2 });
    expect(await autoCloseResolvedRequests()).toBeGreaterThanOrEqual(1);
    expect((await ticketRow(old)).status).toBe("closed");
    expect((await ticketRow(recent)).status).toBe("resolved");
    const detail = await getRequestDetail(w.ctx.member, old);
    expect(detail!.messages.at(-1)!.body).toMatch(/closed automatically 2 days after it was resolved/);
    expect(detail!.timeline.at(-1)).toMatchObject({ kind: "closed", actorKind: "system" });
    // Running it again changes nothing.
    expect(await autoCloseResolvedRequests()).toBe(0);
    await reset();
  });
});
