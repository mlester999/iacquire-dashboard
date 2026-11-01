// Choosing the host and approving the hours, against a real (test) database. The client picks a real, active member as the host (or presses "Make me the host"); the weekly hours are
// written only for an approval of exactly what was shown (a digest the server recomputes); a host added from the questionnaire or by an invitation has NO hours until then; the three
// calendar steps open only after the questionnaire is submitted and the setup payment is confirmed; and the facts name who still needs hours. Test database only; nothing is sent.
import { afterEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { memberActor } from "@/server/crm/actor";
import type { OrgContext } from "@/server/tenancy/context";
import { getLaunchReadiness, loadLaunchFacts, loadLaunchFactsForOrg } from "@/server/setup/launch-readiness";
import { runLaunchIntent } from "@/server/setup/launch-intents";
import { activateCalendar } from "@/server/calendars/activation";
import { createAppointmentType, setCalendarPublic, updateCalendar } from "@/server/calendars/setup";
import { assignInvitedHostFromAnswers } from "@/server/onboarding/scheduling-drafts";
import { ctxFor, uid } from "./support/fixtures";
import { clearSetupPayment } from "./support/billing";
import { approveHours, count, draftClient, itemOf } from "./support/launch";

type Draft = Awaited<ReturnType<typeof draftClient>>;

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const members = async (c: Draft) => (await rows<{ user_id: string }>("select user_id from crm_calendar_members where calendar_id = $1 order by user_id", [c.calendarId])).map((r) => r.user_id);
const audits = async (orgId: string, action: string) => rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where org_id = $1 and action = $2 order by created_at", [orgId, action]);
const facts = async (ctx: OrgContext) => (await loadLaunchFacts(ctx))!.appointments.calendar!;
const readiness = async (ctx: OrgContext) => (await getLaunchReadiness(ctx))!;
const answer = (orgId: string, id: string, value: unknown) => withSystem((db) => db.query("insert into onboarding_answers (org_id, question_id, value) values ($1, $2, $3::jsonb)", [orgId, id, JSON.stringify(value)]));
const unpaid = (orgId: string) => withSystem((db) => db.query("update billing_accounts set setup_payment_status = 'invoiced', waiver_reason = null, waived_at = null where org_id = $1", [orgId]));

/** iAcquire's Google app registration, as a deployment that has set it up has it (obvious test values). */
function googleOAuth(on: boolean) {
  if (on) {
    process.env.GOOGLE_CALENDAR_CLIENT_ID = "google-client-id.apps.example.test";
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "google-client-secret-synthetic";
  } else {
    delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
    delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  }
  resetEnvCache();
}
afterEach(() => googleOAuth(false));

describe("the client chooses a real host", () => {
  it("makes the chosen active member the host with no hours, audits who was chosen, and names them as needing hours", async () => {
    const c = await draftClient("Host Choice Dental", "Asia/Manila");
    const before = await readiness(c.ctx);
    // The select lists every active member of this workspace, and nobody else, and chooses nobody.
    expect(itemOf(before, "calendar.host").hostChoices!.map((p) => p.id).sort()).toEqual(Object.values(c.people).map((p) => p.id).sort());
    expect(itemOf(before, "calendar.host").hostChoices!.find((p) => p.id === c.people.sales.id)!.name).toBe("Sales Person");
    expect(await members(c)).toEqual([]);

    const res = await runLaunchIntent(c.ctx, "assign_host", { userId: c.people.sales.id });
    expect(res).toMatchObject({ ok: true, message: expect.stringContaining("Sales Person is now the host") });
    expect(await members(c)).toEqual([c.people.sales.id]);
    // Choosing a host never gives them hours.
    expect(await count(c.org.id, "crm_availability_rules")).toBe(0);
    const [audit] = await audits(c.org.id, "setup.launch_host_chosen");
    expect(audit.metadata).toMatchObject({ hostUserId: c.people.sales.id, self: false, hours: "not_set" });

    const cal = await facts(c.ctx);
    expect(cal).toMatchObject({ hosts: 1, hostsWithHours: 0, hostsNeedingHours: [{ id: c.people.sales.id, name: "Sales Person" }] });
    const after = await readiness(c.ctx);
    expect(itemOf(after, "calendar.host").state).toBe("done");
    expect(itemOf(after, "calendar.hours")).toMatchObject({ state: "action_required", action: { intent: "apply_hours", params: { hoursDigest: cal.suggestedHours!.digest } } });
    expect(itemOf(after, "calendar.hours").detail).toContain("Sales Person has no weekly hours yet");
    // A second press says so and changes nothing.
    expect((await runLaunchIntent(c.ctx, "assign_host", { userId: c.people.manager.id })).message).toContain("already has a host");
    expect(await members(c)).toEqual([c.people.sales.id]);
    expect((await audits(c.org.id, "setup.launch_host_chosen")).length).toBe(1);
  }, 120_000);

  it("refuses another workspace's user, someone who left, an inactive account and a made-up id, and changes nothing", async () => {
    const c = await draftClient("Host Refusals Clinic", "UTC");
    const other = await draftClient("Host Refusals Other", "UTC");
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [c.org.id, c.people.support.id]));
    await withSystem((db) => db.query("update users set status = 'disabled' where id = $1", [c.people.setter.id]));
    await expect(runLaunchIntent(c.ctx, "assign_host", { userId: other.people.owner.id })).rejects.toThrow(/not a member of this workspace/);
    await expect(runLaunchIntent(c.ctx, "assign_host", { userId: c.people.support.id })).rejects.toThrow(/not a member of this workspace/);
    await expect(runLaunchIntent(c.ctx, "assign_host", { userId: c.people.setter.id })).rejects.toThrow(/account is not active/);
    await expect(runLaunchIntent(c.ctx, "assign_host", { userId: "not-a-person" })).rejects.toThrow(/Choose a person/);
    expect(await members(c)).toEqual([]);
    expect(await members(other)).toEqual([]);
    expect((await audits(c.org.id, "setup.launch_host_chosen")).length).toBe(0);
    // The chosen host can still be a real member afterwards.
    expect(await runLaunchIntent(c.ctx, "assign_host", { userId: c.people.manager.id })).toMatchObject({ ok: true });
    expect(await members(c)).toEqual([c.people.manager.id]);
  }, 120_000);

  it("replaces a host who left, instead of answering 'already has a host' for a calendar nobody can take", async () => {
    const c = await draftClient("Stale Host Dental", "Asia/Manila");
    await runLaunchIntent(c.ctx, "assign_host", { userId: c.people.sales.id });
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [c.org.id, c.people.sales.id]));
    // The row is still there, but nobody active takes bookings, and the panel says so.
    expect(await members(c)).toEqual([c.people.sales.id]);
    expect(await facts(c.ctx)).toMatchObject({ hosts: 0 });
    expect(itemOf(await readiness(c.ctx), "calendar.host")).toMatchObject({ state: "action_required", action: { intent: "assign_host" } });

    expect(await runLaunchIntent(c.ctx, "assign_host")).toMatchObject({ ok: true, message: expect.stringContaining("You are now the host") });
    expect(await members(c)).toEqual([c.people.owner.id]);
    expect((await runLaunchIntent(c.ctx, "assign_host")).message).toContain("already has a host");
  }, 120_000);

  it("gives a member who may not set up calendars no button, no list and a name to ask, and refuses them", async () => {
    const c = await draftClient("Viewer Clinic", "UTC");
    const viewer = ctxFor(c.people.viewer, c.org, "viewer");
    const cal = await facts(viewer);
    expect(cal).toMatchObject({ canManage: false, ownerName: "Owner Person" });
    expect(cal.hostChoices).toBeUndefined();
    const host = itemOf(await readiness(viewer), "calendar.host");
    expect(host.action).toBeUndefined();
    expect(host.hostChoices).toBeUndefined();
    expect(host.detail).toContain("Ask Owner Person");
    for (const intent of ["assign_host", "apply_hours", "activate_calendar"] as const) {
      await expect(runLaunchIntent(viewer, intent, intent === "assign_host" ? { userId: c.people.viewer.id } : {})).rejects.toThrow(/role doesn.t allow this/i);
    }
    expect(await members(c)).toEqual([]);
    // A manager may set up calendars: the owner is not the only one who can choose.
    expect(await runLaunchIntent(ctxFor(c.people.manager, c.org, "admin"), "assign_host", { userId: c.people.sales.id })).toMatchObject({ ok: true });
  }, 120_000);
});

describe("choosing the host is one decision, made once", () => {
  it("lets two people pressing at the same moment for different people choose exactly one host: the second is told the calendar has one, and nothing is replaced", async () => {
    const c = await draftClient("Double Press Dental", "Asia/Manila");
    const manager = ctxFor(c.people.manager, c.org, "admin");
    const [first, second] = await Promise.all([
      runLaunchIntent(c.ctx, "assign_host", { userId: c.people.sales.id }),
      runLaunchIntent(manager, "assign_host", { userId: c.people.setter.id }),
    ]);
    const messages = [first.message, second.message];
    expect(messages.filter((m) => m.includes("is now the host")).length).toBe(1);
    expect(messages.filter((m) => m.includes("already has a host")).length).toBe(1);
    // One host stays, whichever press won; the loser's choice did not remove it, and only one choice was audited.
    const chosen = await members(c);
    expect(chosen).toHaveLength(1);
    expect([c.people.sales.id, c.people.setter.id]).toContain(chosen[0]);
    const audited = await audits(c.org.id, "setup.launch_host_chosen");
    expect(audited).toHaveLength(1);
    expect(audited[0].metadata).toMatchObject({ hostUserId: chosen[0] });
  }, 120_000);
});

describe("the host select lists only people who can take appointments", () => {
  it("leaves out someone who left and an account that was disabled, in the facts and on the item, and keeps everyone else", async () => {
    const c = await draftClient("Picker Filter Dental", "UTC");
    const everyone = Object.values(c.people).map((p) => p.id);
    expect((await facts(c.ctx)).hostChoices!.map((p) => p.id).sort()).toEqual([...everyone].sort());
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [c.org.id, c.people.support.id]));
    await withSystem((db) => db.query("update users set status = 'disabled' where id = $1", [c.people.setter.id]));
    const remaining = everyone.filter((id) => id !== c.people.support.id && id !== c.people.setter.id).sort();
    expect((await facts(c.ctx)).hostChoices!.map((p) => p.id).sort()).toEqual(remaining);
    const listed = itemOf(await readiness(c.ctx), "calendar.host").hostChoices!.map((p) => p.id).sort();
    expect(listed).toEqual(remaining);
    expect(listed).not.toContain(c.people.support.id);
    expect(listed).not.toContain(c.people.setter.id);
    // Someone from another workspace is never listed.
    const other = await draftClient("Picker Filter Other", "UTC");
    for (const p of Object.values(other.people)) expect(listed).not.toContain(p.id);
  }, 120_000);
});

describe("the readers behind the host and busy-calendar lines", () => {
  const inviteRow = (orgId: string, email: string, invitedBy: string, over: { acceptedAt?: string; revokedAt?: string; expires?: string }) => withSystem((db) => db.query(
    `insert into invitations (org_id, email, role, token_hash, invited_by, created_at, expires_at, accepted_at, revoked_at)
     values ($1, $2, 'member', $3, $4, now() - interval '30 days', coalesce($5::timestamptz, now() + interval '7 days'), $6::timestamptz, $7::timestamptz)`,
    [orgId, email, `launch-test-${uid()}`, invitedBy, over.expires ?? null, over.acceptedAt ?? null, over.revokedAt ?? null],
  ));

  it("reads a revoked, expired or accepted invitation as not invited, and only a live one as invited", async () => {
    const c = await draftClient("Invitation States Dental", "UTC");
    const emails = { live: `live-${uid()}@example.test`, revoked: `revoked-${uid()}@example.test`, expired: `expired-${uid()}@example.test`, accepted: `accepted-${uid()}@example.test` };
    await answer(c.org.id, "d.appt_host", "team");
    await answer(c.org.id, "d.team", Object.entries(emails).map(([name, email]) => ({ name: `P ${name}`, email, role: "support", hosts: "yes" })));
    await inviteRow(c.org.id, emails.live, c.people.owner.id, {});
    await inviteRow(c.org.id, emails.revoked, c.people.owner.id, { revokedAt: new Date().toISOString() });
    await inviteRow(c.org.id, emails.expired, c.people.owner.id, { expires: new Date(Date.now() - 86_400_000).toISOString() });
    await inviteRow(c.org.id, emails.accepted, c.people.owner.id, { acceptedAt: new Date().toISOString() });
    expect((await loadLaunchFacts(c.ctx))!.appointments.teamHosts).toEqual([
      { name: "P live", state: "invited" }, { name: "P revoked", state: "not_invited" }, { name: "P expired", state: "not_invited" }, { name: "P accepted", state: "not_invited" },
    ]);
  }, 120_000);

  it("counts a busy connection only for the host who is looking, only with conflict checking on, and only while it was read within three poll intervals", async () => {
    googleOAuth(true);
    const c = await draftClient("Busy Freshness Dental", "Asia/Manila");
    await runLaunchIntent(c.ctx, "assign_host");
    await approveHours(c.ctx);
    await answer(c.org.id, "d.appt_busy_calendar", "google");
    const connect = (userId: string, over: { checkConflicts?: boolean; readAgoMs: number }) => withSystem((db) => db.query(
      `insert into crm_calendar_connections (org_id, user_id, provider, account_label, status, check_conflicts, write_events, last_success_at)
       values ($1, $2, 'google', $3, 'connected', $4, false, $5)`,
      [c.org.id, userId, `${uid()}@example.test`, over.checkConflicts ?? true, new Date(Date.now() - over.readAgoMs)],
    ));
    const busyDone = async () => itemOf(await readiness(c.ctx), "calendar.busy").state === "done";
    const hostBusy = async () => (await facts(c.ctx)).hostConnections!.find((h) => h.userId === c.people.owner.id)!.busy.google;
    // Another member's fresh connection never satisfies the host.
    await connect(c.people.sales.id, { readAgoMs: 60_000 });
    expect(await hostBusy()).toBe(false);
    expect(await busyDone()).toBe(false);
    // The host's own connection that was last read days ago is stale, however it was set up.
    await connect(c.people.owner.id, { readAgoMs: 3 * 86_400_000 });
    expect(await hostBusy()).toBe(false);
    expect(await busyDone()).toBe(false);
    // Conflict checking off reads nothing, so a fresh row does not count either.
    await withSystem((db) => db.query("delete from crm_calendar_connections where org_id = $1 and user_id = $2", [c.org.id, c.people.owner.id]));
    await connect(c.people.owner.id, { checkConflicts: false, readAgoMs: 60_000 });
    expect(await hostBusy()).toBe(false);
    // A fresh read with conflict checking on is what it asks for.
    await withSystem((db) => db.query("delete from crm_calendar_connections where org_id = $1 and user_id = $2", [c.org.id, c.people.owner.id]));
    await connect(c.people.owner.id, { readAgoMs: 60_000 });
    expect(await hostBusy()).toBe(true);
    expect(await busyDone()).toBe(true);
  }, 120_000);

  it("states no busy-calendar requirement when the client takes no appointments, and ignores an answer the client has not confirmed", async () => {
    const off = await draftClient("No Appointments Busy Dental", "UTC");
    await answer(off.org.id, "d.appt_busy_calendar", "google");
    await withSystem((db) => db.query("update onboarding_answers set value = 'false'::jsonb where org_id = $1 and question_id = 'b.appointments'", [off.org.id]));
    expect((await facts(off.ctx)).busyProvider).toBeNull();
    // A suggestion the client has not looked at is not their answer: with nothing else said, nothing is required.
    const guess = await draftClient("Guessed Busy Dental", "UTC");
    await withSystem((db) => db.query("insert into onboarding_answers (org_id, question_id, value, source, needs_confirmation) values ($1, 'd.appt_busy_calendar', '\"google\"'::jsonb, 'ai_suggestion', true)", [guess.org.id]));
    expect((await facts(guess.ctx)).busyProvider).toBeNull();
    expect((await readiness(guess.ctx)).steps.flatMap((i) => i.items).some((i) => i.key === "calendar.busy")).toBe(false);
    // Confirmed, the same answer counts.
    await withSystem((db) => db.query("update onboarding_answers set needs_confirmation = false where org_id = $1 and question_id = 'd.appt_busy_calendar'", [guess.org.id]));
    expect((await facts(guess.ctx)).busyProvider).toBe("google");
  }, 120_000);
});

describe("a read with no signed-in person", () => {
  it("says nothing about what a person may do and reads no list of people", async () => {
    const c = await draftClient("System Read Dental", "UTC");
    const cal = (await loadLaunchFactsForOrg(c.org.id))!.appointments.calendar!;
    expect(cal.canManage).toBeUndefined();
    expect(cal.hostChoices).toBeUndefined();
    // The same workspace as its owner sees it does carry both.
    expect(await facts(c.ctx)).toMatchObject({ canManage: true, ownerName: "Owner Person" });
  }, 120_000);
});

describe("the three calendar steps open only after the questionnaire and the setup payment", () => {
  it("refuses each one before the payment is confirmed, changes nothing, and works after it is", async () => {
    const c = await draftClient("Unpaid Calendar Roofing", "Asia/Manila");
    await unpaid(c.org.id);
    const intents: Array<[Parameters<typeof runLaunchIntent>[1], Parameters<typeof runLaunchIntent>[2]]> = [["assign_host", {}], ["apply_hours", { hoursDigest: "a".repeat(64) }], ["activate_calendar", {}]];
    for (const [intent, params] of intents) await expect(runLaunchIntent(c.ctx, intent, params), intent).rejects.toThrow(/setup payment is not confirmed/i);
    expect(await members(c)).toEqual([]);
    expect(await count(c.org.id, "crm_availability_rules")).toBe(0);
    expect((await facts(c.ctx)).status).toBe("draft");
    expect((await audits(c.org.id, "setup.launch_host_chosen")).length).toBe(0);
    // The panel offers no button that would only be refused.
    const r = await readiness(c.ctx);
    expect(r.state).toBe("questionnaire_submitted");
    expect(itemOf(r, "calendar.host").action).toBeUndefined();
    expect(itemOf(r, "calendar.host").detail).toContain("setup payment is confirmed");

    await clearSetupPayment(c.org.id);
    expect(await runLaunchIntent(c.ctx, "assign_host")).toMatchObject({ ok: true });
    expect(await approveHours(c.ctx)).toMatchObject({ ok: true, message: expect.stringContaining("Weekly hours saved") });
    expect(await runLaunchIntent(c.ctx, "activate_calendar")).toMatchObject({ ok: true });
  }, 120_000);

  it("refuses each one before the questionnaire is submitted, and a sample workspace is never held on a setup fee", async () => {
    const c = await draftClient("Unsubmitted Calendar Clinic", "UTC");
    await withSystem((db) => db.query("update organizations set onboarding_completed_at = null where id = $1", [c.org.id]));
    for (const intent of ["assign_host", "apply_hours", "activate_calendar"] as const) await expect(runLaunchIntent(c.ctx, intent), intent).rejects.toThrow(/company information/i);
    expect(await members(c)).toEqual([]);

    const demo = await draftClient("Sample Calendar Clinic", "UTC");
    await withSystem((db) => db.query("update organizations set is_demo = true where id = $1", [demo.org.id]));
    await unpaid(demo.org.id);
    expect(await runLaunchIntent(demo.ctx, "assign_host")).toMatchObject({ ok: true });
  }, 120_000);
});

describe("hours are written only for an approval of exactly what was shown", () => {
  it("refuses a missing, wrong, stale or zone-changed approval, writes nothing, and then saves the hours with the zone and the hours in the audit", async () => {
    const c = await draftClient("Digest Dental", "Asia/Manila");
    await runLaunchIntent(c.ctx, "assign_host");
    const shown = (await facts(c.ctx)).suggestedHours!;
    expect(shown).toMatchObject({ zone: "Asia/Manila", summary: "Mon to Fri, 9:00 AM to 5:00 PM (Asia/Manila time)" });
    const refused = /changed since you looked/;
    await expect(runLaunchIntent(c.ctx, "apply_hours")).rejects.toThrow(refused);
    await expect(runLaunchIntent(c.ctx, "apply_hours", { hoursDigest: "0".repeat(64) })).rejects.toThrow(refused);

    // A second host joins after the hours were shown: the approval no longer describes what is true.
    await updateCalendar(memberActor(c.ctx), c.calendarId, { assignment: "round_robin", members: [{ userId: c.people.owner.id }, { userId: c.people.sales.id }] });
    await expect(runLaunchIntent(c.ctx, "apply_hours", { hoursDigest: shown.digest })).rejects.toThrow(refused);
    expect(await count(c.org.id, "crm_availability_rules")).toBe(0);
    expect((await facts(c.ctx)).suggestedHours!.digest).not.toBe(shown.digest);

    // A different zone or different hours is a different approval, too.
    const second = (await facts(c.ctx)).suggestedHours!;
    await withSystem((db) => db.query("update crm_calendars set timezone = 'Europe/London' where id = $1", [c.calendarId]));
    await expect(runLaunchIntent(c.ctx, "apply_hours", { hoursDigest: second.digest })).rejects.toThrow(refused);
    await withSystem((db) => db.query("update crm_calendars set timezone = 'Asia/Manila' where id = $1", [c.calendarId]));
    await withSystem((db) => db.query("update crm_calendars set hours_template = $2::jsonb where id = $1", [c.calendarId, JSON.stringify([{ weekday: 1, startMinute: 600, endMinute: 900 }])]));
    await expect(runLaunchIntent(c.ctx, "apply_hours", { hoursDigest: second.digest })).rejects.toThrow(refused);
    await withSystem((db) => db.query("update crm_calendars set hours_template = $2::jsonb where id = $1", [c.calendarId, JSON.stringify([1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })))]));
    expect(await count(c.org.id, "crm_availability_rules")).toBe(0);
    expect((await audits(c.org.id, "crm.calendar_hours_applied")).length).toBe(0);

    // The approval of what is true now saves the hours for both hosts, and the audit names the zone and the hours.
    const fresh = (await facts(c.ctx)).suggestedHours!;
    expect(fresh.digest).toBe(second.digest);
    expect(await runLaunchIntent(c.ctx, "apply_hours", { hoursDigest: fresh.digest })).toMatchObject({ ok: true, message: expect.stringContaining("Weekly hours saved for 2 hosts") });
    expect(await count(c.org.id, "crm_availability_rules")).toBe(10);
    const [audit] = await audits(c.org.id, "crm.calendar_hours_applied");
    expect(audit.metadata).toMatchObject({ hosts: 2, approved: true, zone: "Asia/Manila", digest: fresh.digest });
    expect(String(audit.metadata.hours)).toContain("Mon to Fri, 9:00 AM to 5:00 PM");
    // Nothing is waiting for hours now, so there is nothing to approve and nothing changes.
    expect((await facts(c.ctx)).suggestedHours).toBeNull();
    expect(await runLaunchIntent(c.ctx, "apply_hours", { hoursDigest: fresh.digest })).toMatchObject({ ok: true, message: expect.stringContaining("nothing was changed") });
    expect(await count(c.org.id, "crm_availability_rules")).toBe(10);
  }, 120_000);

  it("never saves hours for a host nobody has chosen, and says there is nothing suggested when the calendar has no hours", async () => {
    const c = await draftClient("No Host Hours Clinic", "UTC");
    await expect(runLaunchIntent(c.ctx, "apply_hours", { hoursDigest: "a".repeat(64) })).rejects.toThrow(/Assign hosts first/);
    await runLaunchIntent(c.ctx, "assign_host");
    await withSystem((db) => db.query("update crm_calendars set hours_template = '[]'::jsonb where id = $1", [c.calendarId]));
    expect((await facts(c.ctx)).suggestedHours).toBeNull();
    await expect(runLaunchIntent(c.ctx, "apply_hours", { hoursDigest: "a".repeat(64) })).rejects.toThrow(/no suggested hours/);
    expect(await count(c.org.id, "crm_availability_rules")).toBe(0);
  }, 120_000);

  it("keeps another client's approval from ever applying here", async () => {
    const a = await draftClient("Approval A", "Asia/Manila");
    const b = await draftClient("Approval B", "Asia/Manila");
    await runLaunchIntent(a.ctx, "assign_host");
    await runLaunchIntent(b.ctx, "assign_host");
    const digestA = (await facts(a.ctx)).suggestedHours!.digest;
    await expect(runLaunchIntent(b.ctx, "apply_hours", { hoursDigest: digestA })).rejects.toThrow(/changed since you looked/);
    expect(await count(b.org.id, "crm_availability_rules")).toBe(0);
    expect(await count(a.org.id, "crm_availability_rules")).toBe(0);
  }, 120_000);
});

describe("a host from the questionnaire's team answer has no hours until the client approves them", () => {
  it("shows who has been invited and who still needs hours, and gives a host who joined by invitation none of their own", async () => {
    const c = await draftClient("Team Host Dental", "Asia/Manila");
    await answer(c.org.id, "d.appt_host", "team");
    await answer(c.org.id, "d.team", [
      { name: "Marcus Hale", email: c.people.sales.email, role: "sales_rep", hosts: "yes" },
      { name: "Priya Shah", email: `priya-${uid()}@example.test`, role: "support", hosts: "yes" },
      { name: "Lee Tan", email: `lee-${uid()}@example.test`, role: "support", hosts: "yes" },
      { name: "Not A Host", email: `nobody-${uid()}@example.test`, role: "viewer", hosts: "no" },
    ]);
    const team = (await withSystem((db) => db.query<{ answer: Array<{ email: string }> }>("select value as answer from onboarding_answers where org_id = $1 and question_id = 'd.team'", [c.org.id]))).rows[0].answer;
    const priya = team[1].email;
    await withSystem((db) => db.query("insert into invitations (org_id, email, role, token_hash, invited_by, expires_at) values ($1, $2, 'member', $3, $4, now() + interval '7 days')", [c.org.id, priya, `launch-test-${uid()}`, c.people.owner.id]));

    const f = (await loadLaunchFacts(c.ctx))!.appointments;
    expect(f.hostChoice).toBe("team");
    expect(f.teamHosts).toEqual([{ name: "Marcus Hale", state: "member" }, { name: "Priya Shah", state: "invited" }, { name: "Lee Tan", state: "not_invited" }]);
    const waiting = itemOf(await readiness(c.ctx), "calendar.host");
    expect(waiting).toMatchObject({ state: "in_progress", owner: "you" });
    expect(waiting.detail).toContain("Waiting for Priya Shah");
    expect(waiting.detail).not.toContain("Lee Tan");

    // Marcus is a member whose email the owner marked as a host: accepting joins him to the draft calendar, with no hours.
    expect(await withSystem((db) => assignInvitedHostFromAnswers(db, { orgId: c.org.id, userId: c.people.sales.id }))).toBe(true);
    expect(await members(c)).toEqual([c.people.sales.id]);
    expect(await count(c.org.id, "crm_availability_rules")).toBe(0);
    const cal = await facts(c.ctx);
    expect(cal).toMatchObject({ hosts: 1, hostsWithHours: 0, hostsNeedingHours: [{ id: c.people.sales.id, name: "Sales Person" }] });
    const r = await readiness(c.ctx);
    expect(itemOf(r, "calendar.host")).toMatchObject({ state: "done" });
    expect(itemOf(r, "calendar.host").detail).toContain("Still waiting for Priya Shah");
    expect(itemOf(r, "calendar.hours")).toMatchObject({ state: "action_required", action: { intent: "apply_hours" } });
    expect(itemOf(r, "calendar.hours").detail).toContain("Sales Person has no weekly hours yet");
    // The calendar cannot go live on hours nobody approved.
    const early = await runLaunchIntent(c.ctx, "activate_calendar");
    expect(early.ok).toBe(false);
    expect(early.message).toMatch(/no weekly hours/);
    expect(await count(c.org.id, "crm_availability_rules")).toBe(0);
    // The client approves exactly what was shown, and only then does Marcus have hours.
    expect(await approveHours(c.ctx)).toMatchObject({ ok: true });
    expect(await rows("select 1 from crm_availability_rules where org_id = $1 and user_id = $2", [c.org.id, c.people.sales.id])).toHaveLength(5);
  }, 120_000);

  it("reads 'I take them myself' from the confirmed answer only", async () => {
    const c = await draftClient("Owner Host Dental", "UTC");
    expect((await loadLaunchFacts(c.ctx))!.appointments.hostChoice).toBeNull();
    await answer(c.org.id, "d.appt_host", "owner");
    expect((await loadLaunchFacts(c.ctx))!.appointments.hostChoice).toBe("owner");
    // A guess that the client has not looked at is not an answer.
    const guess = await draftClient("Guessed Host Dental", "UTC");
    await withSystem((db) => db.query("insert into onboarding_answers (org_id, question_id, value, source, needs_confirmation) values ($1, 'd.appt_host', '\"owner\"'::jsonb, 'ai_suggestion', true)", [guess.org.id]));
    expect((await loadLaunchFacts(guess.ctx))!.appointments.hostChoice).toBeNull();
  }, 120_000);
});

describe("the existing calendar the client said must block times", () => {
  it("is required only for google or microsoft, the questionnaire's answer comes before the setup guide, and 'none' holds no one back", async () => {
    googleOAuth(true);
    const c = await draftClient("Busy Answer Dental", "Asia/Manila");
    await runLaunchIntent(c.ctx, "assign_host");
    await approveHours(c.ctx);
    await answer(c.org.id, "d.appt_busy_calendar", "google");
    expect((await facts(c.ctx)).busyProvider).toBe("google");
    const busy = itemOf(await readiness(c.ctx), "calendar.busy");
    expect(busy).toMatchObject({ state: "action_required", required: true, owner: "you", action: { href: "/api/crm/calendar-oauth/google/start?return=/setup" } });
    const refused = await runLaunchIntent(c.ctx, "activate_calendar");
    expect(refused).toMatchObject({ ok: false, message: expect.stringMatching(/events in your Google Calendar must block times/) });
    // A connected calendar that is being read for busy times is what the answer asks for.
    await withSystem((db) => db.query(
      "insert into crm_calendar_connections (org_id, user_id, provider, account_label, status, check_conflicts, write_events, last_success_at) values ($1, $2, 'google', 'owner@example.test', 'connected', true, false, $3)",
      [c.org.id, c.people.owner.id, new Date(Date.now() - 5 * 60_000)],
    ));
    expect(itemOf(await readiness(c.ctx), "calendar.busy")).toMatchObject({ state: "done", required: true });
    expect(await runLaunchIntent(c.ctx, "activate_calendar")).toMatchObject({ ok: true });

    // "None" is the client's own answer and wins over what the setup guide once said.
    const none = await draftClient("Busy None Dental", "Asia/Manila");
    await withSystem((db) => db.query("insert into crm_setup_guides (org_id, answers) values ($1, $2::jsonb)", [none.org.id, JSON.stringify({ appointments: true, calendarSource: "google" })]));
    await answer(none.org.id, "d.appt_busy_calendar", "none");
    await runLaunchIntent(none.ctx, "assign_host");
    await approveHours(none.ctx);
    expect((await facts(none.ctx)).busyProvider).toBe("none");
    expect(itemOf(await readiness(none.ctx), "calendar.busy")).toMatchObject({ state: "not_applicable", required: false });
    expect(await runLaunchIntent(none.ctx, "activate_calendar")).toMatchObject({ ok: true });

    // Without a questionnaire answer the setup guide still decides, as it did.
    const guide = await draftClient("Busy Guide Dental", "Asia/Manila");
    await withSystem((db) => db.query("insert into crm_setup_guides (org_id, answers) values ($1, $2::jsonb)", [guide.org.id, JSON.stringify({ appointments: true, calendarSource: "microsoft" })]));
    expect((await facts(guide.ctx)).busyProvider).toBe("microsoft");
    // Nothing said anywhere: no line at all, and nothing is required.
    const silent = await draftClient("Busy Silent Dental", "Asia/Manila");
    expect((await facts(silent.ctx)).busyProvider).toBeNull();
    expect((await readiness(silent.ctx)).steps.flatMap((s) => s.items).some((i) => i.key === "calendar.busy")).toBe(false);
  }, 120_000);
});

describe("a video appointment with no way to join", () => {
  it("is a required line until the client chooses a tool or writes how the link is sent, and a fixed link counts", async () => {
    const c = await draftClient("Own Link Roofing", "Asia/Manila");
    await withSystem((db) => db.query("update crm_appointment_types set location_kind = 'video' where org_id = $1", [c.org.id]));
    expect((await facts(c.ctx)).typesWithoutJoinInfo).toEqual(["Free consultation"]);
    const line = itemOf(await readiness(c.ctx), "calendar.own_link");
    expect(line).toMatchObject({ state: "action_required", required: true, action: { href: `/crm/calendars/${c.calendarId}` } });
    expect(line.detail).toContain("Free consultation is a video appointment");
    await runLaunchIntent(c.ctx, "assign_host");
    await approveHours(c.ctx);
    expect(await runLaunchIntent(c.ctx, "activate_calendar")).toMatchObject({ ok: false, message: expect.stringMatching(/video appointment with no meeting tool/) });
    // Words of the client's own are what a customer is told: that is enough.
    await withSystem((db) => db.query("update crm_appointment_types set location_detail = 'We email the video link the morning of your visit.' where org_id = $1", [c.org.id]));
    expect((await facts(c.ctx)).typesWithoutJoinInfo).toEqual([]);
    expect((await readiness(c.ctx)).steps.flatMap((s) => s.items).some((i) => i.key === "calendar.own_link")).toBe(false);
    // A fixed link does too.
    await withSystem((db) => db.query("update crm_appointment_types set location_detail = null, meeting_provider = 'custom_link', meeting_link = 'https://meet.example.test/room' where org_id = $1", [c.org.id]));
    expect((await facts(c.ctx)).typesWithoutJoinInfo).toEqual([]);
  }, 120_000);
});

describe("what each host has connected, per host and strict", () => {
  async function meetClient(name: string) {
    const c = await draftClient(name, "Asia/Manila");
    await withSystem((db) => db.query("update crm_appointment_types set location_kind = 'video', meeting_provider = 'google_meet' where org_id = $1", [c.org.id]));
    await runLaunchIntent(c.ctx, "assign_host");
    await approveHours(c.ctx);
    return c;
  }
  const connect = (c: Draft, userId: string, over: { writeEvents: boolean; calendarId: string | null }) => withSystem((db) => db.query(
    `insert into crm_calendar_connections (org_id, user_id, provider, account_label, status, check_conflicts, write_events, external_calendar_id, last_success_at)
     values ($1, $2, 'google', 'account@example.test', 'connected', false, $3, $4, now())`,
    [c.org.id, userId, over.writeEvents, over.calendarId],
  ));

  it("is not satisfied by another person's account or by an account that cannot add events, only by the host's own", async () => {
    googleOAuth(true);
    const c = await meetClient("Strict Meet Roofing");
    // Someone else's connected account that can add events, and the host's own that cannot: neither makes the host's meeting links.
    await connect(c, c.people.sales.id, { writeEvents: true, calendarId: "primary" });
    await connect(c, c.people.owner.id, { writeEvents: false, calendarId: null });
    const cal = await facts(c.ctx);
    expect(cal.hostConnections).toEqual([{ userId: c.people.owner.id, name: "Owner Person", viewer: true, meet: { google: false, microsoft: false }, busy: { google: false, microsoft: false } }]);
    expect(itemOf(await readiness(c.ctx), "calendar.connection")).toMatchObject({ state: "action_required", owner: "you", action: { href: "/api/crm/calendar-oauth/google/start?return=/setup" } });
    // Another member looking at the same calendar is told to ask the host, not handed a button for an account that is not theirs.
    const other = itemOf(await readiness(ctxFor(c.people.manager, c.org, "admin")), "calendar.connection");
    expect(other.action).toBeUndefined();
    expect(other.detail).toContain("Owner Person has not connected");
    expect(await runLaunchIntent(c.ctx, "activate_calendar").then((r) => r.ok)).toBe(false);

    // The host's own connected account that can add events is what satisfies it.
    await withSystem((db) => db.query("delete from crm_calendar_connections where org_id = $1 and user_id = $2", [c.org.id, c.people.owner.id]));
    await connect(c, c.people.owner.id, { writeEvents: true, calendarId: "primary" });
    expect((await facts(c.ctx)).hostConnections![0]).toMatchObject({ meet: { google: true } });
    expect((await readiness(c.ctx)).steps.flatMap((s) => s.items).some((i) => i.key === "calendar.connection")).toBe(false);
  }, 120_000);

  it("says whether sign-in is set up as a yes or no, and never carries a value", async () => {
    const c = await meetClient("Oauth Flag Roofing");
    expect((await facts(c.ctx)).oauthAvailable).toEqual({ google: false, microsoft: false });
    // Not set up: the client is told so, and is not handed a button that goes nowhere.
    const dead = itemOf(await readiness(c.ctx), "calendar.connection");
    expect(dead).toMatchObject({ owner: "iacquire" });
    expect(dead.action).toBeUndefined();
    googleOAuth(true);
    const on = await loadLaunchFacts(c.ctx);
    expect(on!.appointments.calendar!.oauthAvailable).toEqual({ google: true, microsoft: false });
    expect(JSON.stringify(on)).not.toContain("google-client-secret-synthetic");
    expect(JSON.stringify(on)).not.toContain("google-client-id.apps.example.test");
  }, 120_000);
});

describe("an active calendar keeps being judged", () => {
  async function activeClient(name: string) {
    const c = await draftClient(name, "Asia/Manila");
    await runLaunchIntent(c.ctx, "assign_host");
    await approveHours(c.ctx);
    expect(await runLaunchIntent(c.ctx, "activate_calendar")).toMatchObject({ ok: true });
    return c;
  }

  it("shows a host who paused new bookings as a failing check, not Done", async () => {
    const c = await activeClient("Paused Host Dental");
    expect(itemOf(await readiness(c.ctx), "calendar.verified").state).toBe("done");
    await withSystem((db) => db.query("update crm_host_settings set accepting = false where org_id = $1", [c.org.id]));
    const r = await readiness(c.ctx);
    expect(itemOf(r, "calendar.verified")).toMatchObject({ state: "failed", required: true });
    expect(itemOf(r, "calendar.verified").detail).toContain("paused new bookings");
    expect(r.steps.find((s) => s.key === "calendar")!.state).toBe("action_required");
    expect(r.blocking.map((i) => i.key)).toContain("calendar.verified");
  }, 120_000);

  it("adds a line for a type with no open time, and keeps the calendar from reading as ready until it is fixed", async () => {
    const c = await activeClient("Long Type Dental");
    // Two-hour windows: the 30-minute type fits, a three-hour survey never does.
    await withSystem((db) => db.query("update crm_availability_rules set end_minute = 660 where org_id = $1", [c.org.id]));
    await createAppointmentType(memberActor(c.ctx), c.calendarId, { name: "Full-day survey", durationMinutes: 180, minNoticeMinutes: 60, maxDaysAhead: 30 });
    expect((await facts(c.ctx)).typesWithoutTimes).toEqual(["Full-day survey"]);
    const r = await readiness(c.ctx);
    expect(itemOf(r, "calendar.type_times")).toMatchObject({ state: "action_required", required: true, action: { href: `/crm/calendars/${c.calendarId}` } });
    expect(itemOf(r, "calendar.type_times").detail).toContain("Full-day survey");
    expect(r.blocking.map((i) => i.key)).toContain("calendar.type_times");
    await withSystem((db) => db.query("update crm_availability_rules set end_minute = 1020 where org_id = $1", [c.org.id]));
    expect((await facts(c.ctx)).typesWithoutTimes).toEqual([]);
    expect((await readiness(c.ctx)).steps.flatMap((s) => s.items).some((i) => i.key === "calendar.type_times")).toBe(false);
  }, 120_000);

  it("fails the public page line while the page is on and a check fails, and asks for one line per failing check", async () => {
    const c = await activeClient("Public Fails Dental");
    await setCalendarPublic(memberActor(c.ctx), c.calendarId, true);
    expect(itemOf(await readiness(c.ctx), "calendar.public")).toMatchObject({ state: "done", required: false });
    // The host's hours are removed behind the page's back: the page is still on, and the calendar no longer passes.
    await withSystem((db) => db.query("delete from crm_availability_rules where org_id = $1", [c.org.id]));
    const r = await readiness(c.ctx);
    expect(itemOf(r, "calendar.public")).toMatchObject({ state: "failed", required: true });
    expect(itemOf(r, "calendar.hours")).toMatchObject({ state: "action_required" });
    expect(r.blocking.map((i) => i.key)).toEqual(expect.arrayContaining(["calendar.public", "calendar.hours"]));
    expect(r.state).toBe("action_required");
    // Turning the page off is always allowed, and the line is optional again.
    await setCalendarPublic(memberActor(c.ctx), c.calendarId, false);
    expect(itemOf(await readiness(c.ctx), "calendar.public")).toMatchObject({ state: "done", required: false });
  }, 120_000);

  it("keeps a host's disconnected account from reading as Done on an active calendar that needs it", async () => {
    googleOAuth(true);
    const c = await draftClient("Disconnected Meet Dental", "Asia/Manila");
    await withSystem((db) => db.query("update crm_appointment_types set location_kind = 'video', meeting_provider = 'google_meet' where org_id = $1", [c.org.id]));
    await runLaunchIntent(c.ctx, "assign_host");
    await approveHours(c.ctx);
    await withSystem((db) => db.query(
      "insert into crm_calendar_connections (org_id, user_id, provider, account_label, status, check_conflicts, write_events, external_calendar_id, last_success_at) values ($1, $2, 'google', 'a@example.test', 'connected', false, true, 'primary', now())",
      [c.org.id, c.people.owner.id],
    ));
    expect(await runLaunchIntent(c.ctx, "activate_calendar")).toMatchObject({ ok: true });
    expect((await readiness(c.ctx)).state).not.toBe("ready_to_launch");
    expect((await readiness(c.ctx)).steps.flatMap((s) => s.items).some((i) => i.key === "calendar.connection")).toBe(false);
    await withSystem((db) => db.query("update crm_calendar_connections set status = 'needs_reauth' where org_id = $1", [c.org.id]));
    const r = await readiness(c.ctx);
    expect(itemOf(r, "calendar.connection")).toMatchObject({ state: "action_required", required: true });
    expect(r.blocking.map((i) => i.key)).toContain("calendar.connection");
  }, 120_000);
});

describe("the activation still works for the client who does everything in order", () => {
  it("takes a drafted calendar to active with the chosen host and the approved hours, and the booking page stays off", async () => {
    const c = await draftClient("In Order Dental", "Asia/Manila");
    await runLaunchIntent(c.ctx, "assign_host", { userId: c.people.manager.id });
    await approveHours(c.ctx);
    const res = await activateCalendar(memberActor(c.ctx), c.calendarId);
    expect(res.activated).toBe(true);
    expect(await facts(c.ctx)).toMatchObject({ status: "active", bookingPageOn: false, hosts: 1, hostsWithHours: 1 });
    expect(await rows("select 1 from crm_availability_rules where org_id = $1 and user_id = $2", [c.org.id, c.people.owner.id])).toHaveLength(0);
  }, 120_000);
});
