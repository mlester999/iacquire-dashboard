// The "Allowed actions" switches, enforced where the chat router starts work. An owner can switch an employee's abilities off; typing the exact phrase the router recognises must not
// then produce a booking preview, an approval request or a schedule preview, and a preview made BEFORE the switch-off must not be confirmable afterwards. Also the wording and the marker
// of a booking that still waits for the host's confirmation, as the staff member sees it in the chat. Real chat flow, real calendar, real approvals; the Hermes server is a local
// stand-in that is never asked for a model answer (every request here is answered by the router itself).
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import { sendChatMessage } from "@/server/chat/service";
import { decideApproval } from "@/server/approvals/service";
import { bookNativeAppointment, setNativeAppointmentStatus } from "@/server/calendars/booking";
import { nativeAvailability } from "@/server/calendars/native-availability";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import type { AgentRoleKey } from "@/lib/agents";
import type { EvidenceMarker } from "@/lib/evidence-class";
import { agentId, createUser, ctxFor } from "./support/fixtures";
import { crmOrg, type CrmOrg } from "./support/crm";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const KEY = "r".repeat(40);
const DAY = 86_400_000;
const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
const ROLES: AgentRoleKey[] = ["appointment_setter", "operations_manager"];

let mock: MockHermes;
let admin: Awaited<ReturnType<typeof createUser>>;
let seq = 0;
// Each workspace in this file connects its own pair of profiles (the stand-in gateway needs them named up front).
const MAX_WORKSPACES = 12;
const profileName = (role: AgentRoleKey, index: number) => `c-router-${role.replaceAll("_", "-")}-${index}`;

interface Harness { a: CrmOrg; agents: Record<AgentRoleKey, string>; typeId: string }

async function harness(name: string, opts: { requiresConfirmation?: boolean } = {}): Promise<Harness> {
  seq += 1;
  if (seq > MAX_WORKSPACES) throw new Error("this file connects more workspaces than it declared profiles for");
  const a = await crmOrg({ name });
  const actor = a.actor("owner");
  await setHostAvailability(actor, a.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
  const calendar = await createCalendar(actor, { name: "Consultations", assignment: "single", public: false, isDefault: true, members: [{ userId: a.people.owner.id }] });
  const type = await createAppointmentType(actor, calendar.id, {
    name: "Free Consultation", durationMinutes: 30, bufferAfterMinutes: 0, minNoticeMinutes: 24 * 60, maxDaysAhead: 60, locationKind: "phone", requiresConfirmation: opts.requiresConfirmation ?? false,
    public: false, allowCustomerChanges: true, changeCutoffMinutes: 120,
  });
  const agents = {} as Record<AgentRoleKey, string>;
  for (const role of ROLES) {
    const id = await agentId(a.org.id, role);
    agents[role] = id;
    const profile = profileName(role, seq);
    await withSystem((db) => createConfigVersion(db, { orgId: a.org.id, agentId: id, settings: defaultSettings(role), source: "onboarding", userId: a.people.owner.id, apply: true }));
    await connectHermesProfile({ agentId: id, baseUrl: mock.url, profile, apiKey: KEY, agencyUserId: admin.id });
    expect(await runHealthCheck(id, { userId: admin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });
  }
  return { a, agents, typeId: type.id };
}

/** Replaces the employee's applied configuration with one that has exactly these abilities switched off. */
async function switchOff(h: Harness, role: AgentRoleKey, disabledTools: string[]) {
  const id = h.agents[role];
  await withSystem(async (db) => {
    const v = await db.query<{ id: string }>(
      `insert into agent_config_versions (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status)
       values ($1, $2, (select coalesce(max(version), 0) + 1 from agent_config_versions where agent_instance_id = $2), $3, 's', '# config', 'p', 'onboarding', 'applied') returning id`,
      [h.a.org.id, id, JSON.stringify({ disabledTools })],
    );
    // The profile is recorded as already in step with the new version, as it is once the sync has run, so the employee stays ready to chat.
    await db.query("update agent_instances set active_config_version_id = $2, hermes_profile_config_version_id = $2 where id = $1", [id, v.rows[0].id]);
  });
}

async function ask(h: Harness, role: AgentRoleKey, content: string, conversationId?: string) {
  await withSystem((db) => db.query("delete from rate_limit_buckets where bucket_key = $1", [`${RATE_LIMITS.agentMessageByUser.name}:${h.a.people.owner.id}`]));
  const sent = await sendChatMessage(ctxFor(h.a.people.owner, h.a.org, "owner"), { agentRole: role, content, clientMessageId: crypto.randomUUID(), ...(conversationId ? { conversationId } : {}) });
  const row = (await withSystem((db) => db.query<{ content: string; evidence: EvidenceMarker | null }>("select content, evidence from chat_messages where id = $1 and org_id = $2", [sent.assistantMessageId, h.a.org.id]))).rows[0];
  return { ...sent, reply: row.content, evidence: row.evidence };
}

const n = async (sql: string, orgId: string) => Number((await withSystem((db) => db.query<{ n: number }>(sql, [orgId]))).rows[0].n);
const bookings = (h: Harness) => n("select count(*)::int as n from appointment_bookings where org_id = $1", h.a.org.id);
const approvals = (h: Harness) => n("select count(*)::int as n from approval_requests where org_id = $1 and kind in ('appointment_booking', 'appointment_change')", h.a.org.id);
const schedules = (h: Harness) => n("select count(*)::int as n from ai_work_schedules where org_id = $1", h.a.org.id);
const denials = async (h: Harness, actionId: string) => Number((await withSystem((db) => db.query<{ n: number }>(
  "select count(*)::int as n from audit_logs where org_id = $1 and action = 'agent.action_denied' and metadata->>'actionId' = $2", [h.a.org.id, actionId]))).rows[0].n);
async function pending(conversationId: string, column: "pending_workforce_booking" | "pending_workforce_appointment_change" | "pending_workforce_schedule") {
  return (await withSystem((db) => db.query<{ p: { status?: string } | null }>(`select ${column} as p from chat_conversations where id = $1`, [conversationId]))).rows[0].p;
}
/** The first offered start at least `minDays` out, as the router reads it ("YYYY-MM-DDTHH:mmZ"). */
async function offeredStart(h: Harness, skip = 0, minDays = 2): Promise<{ iso: string; ms: number }> {
  const from = new Date(Date.now() + minDays * DAY);
  const res = await nativeAvailability(h.a.org.id, { from, to: new Date(from.getTime() + 10 * DAY), timeZone: "Asia/Manila", limit: 100 });
  if (!res.ok) throw new Error("no availability");
  const slot = res.slots.filter((s) => new Date(s.start).getTime() >= from.getTime())[skip];
  const ms = new Date(slot.start).getTime();
  return { iso: `${new Date(ms).toISOString().slice(0, 16)}Z`, ms };
}
async function contact(h: Harness, name: string) {
  return (await withSystem((db) => db.query<{ id: string }>("insert into contacts (org_id, display_name, timezone) values ($1, $2, 'UTC') returning id", [h.a.org.id, name]))).rows[0].id;
}

beforeAll(async () => {
  mock = await startMockHermes(Object.fromEntries(ROLES.flatMap((role) => Array.from({ length: MAX_WORKSPACES }, (_, i) => [profileName(role, i + 1), { key: KEY }] as const))));
  admin = await createUser({ platformRole: "agency_super_admin", name: "Router Admin" });
}, 120_000);
afterAll(async () => {
  await mock.close();
});

describe("a booking request in chat", () => {
  it("is refused with the ability off: no preview, no approval, no booking, and the refusal is recorded", async () => {
    const h = await harness("Router Booking Off Co");
    await contact(h, "Router Prospect");
    const start = await offeredStart(h);
    const phrase = `Book an appointment with Router Prospect at ${start.iso}`;

    // On: a preview.
    const on = await ask(h, "appointment_setter", phrase);
    expect(on.reply).toContain("Appointment preview for Router Prospect");
    expect(await pending(on.conversationId, "pending_workforce_booking")).toMatchObject({ status: "pending" });

    await switchOff(h, "appointment_setter", ["appointments.request_change"]);
    const off = await ask(h, "appointment_setter", phrase);
    expect(off.reply).toMatch(/switched off in Allowed actions/);
    expect(off.reply).toMatch(/Nothing was started/);
    expect(off.reply).not.toContain("Appointment preview");
    expect(off.evidence).toEqual({ v: 1, class: "system_notice" });
    // A fresh conversation has no preview at all; nothing was booked or sent for approval.
    expect(await pending(off.conversationId, "pending_workforce_booking")).toBeNull();
    expect(await bookings(h)).toBe(0);
    expect(await approvals(h)).toBe(0);
    expect(await denials(h, "chat:booking_request")).toBeGreaterThanOrEqual(1);
  });

  it("cannot be confirmed after the ability was switched off, and can once it is switched back on", async () => {
    const h = await harness("Router Booking Confirm Co");
    await contact(h, "Router Confirm Prospect");
    const start = await offeredStart(h);
    const preview = await ask(h, "appointment_setter", `Book an appointment with Router Confirm Prospect at ${start.iso}`);
    expect(preview.reply).toContain("Appointment preview");

    await switchOff(h, "appointment_setter", ["appointments.request_change"]);
    const refused = await ask(h, "appointment_setter", "confirm booking", preview.conversationId);
    expect(refused.reply).toMatch(/switched off in Allowed actions/);
    expect(refused.reply).not.toMatch(/not booked yet|confirmed it/);
    expect(await bookings(h)).toBe(0);
    expect(await approvals(h)).toBe(0);
    // The preview is still there, untouched, and discarding it is still allowed.
    expect(await pending(preview.conversationId, "pending_workforce_booking")).toMatchObject({ status: "pending" });

    await switchOff(h, "appointment_setter", []);
    const submitted = await ask(h, "appointment_setter", "confirm booking", preview.conversationId);
    expect(submitted.reply).toContain("not booked yet");
    expect(await bookings(h)).toBe(1);
    expect(await approvals(h)).toBe(1);
  });

  it("is not blocked by an unrelated switch-off, and one workspace's switch-off never reaches another", async () => {
    const mine = await harness("Router Unrelated Co");
    const theirs = await harness("Router Neighbour Co");
    await contact(mine, "Unrelated Prospect");
    await contact(theirs, "Neighbour Prospect");
    await switchOff(mine, "appointment_setter", ["calendar.read_availability", "appointments.read"]);
    const a = await ask(mine, "appointment_setter", `Book an appointment with Unrelated Prospect at ${(await offeredStart(mine)).iso}`);
    expect(a.reply).toContain("Appointment preview");

    await switchOff(mine, "appointment_setter", ["appointments.request_change"]);
    const b = await ask(theirs, "appointment_setter", `Book an appointment with Neighbour Prospect at ${(await offeredStart(theirs)).iso}`);
    expect(b.reply).toContain("Appointment preview");
    expect(await denials(theirs, "chat:booking_request")).toBe(0);
  });
});

describe("an appointment change request in chat", () => {
  it("is refused with the ability off at the preview and at the confirmation, and the approval card carries the type's customer-change policy", async () => {
    const h = await harness("Router Change Co");
    const contactId = await contact(h, "Router Change Prospect");
    const start = await offeredStart(h);
    const booked = await bookNativeAppointment(h.a.actor("owner"), { typeId: h.typeId, startAt: new Date(start.ms), contact: { id: contactId }, via: "staff", now: new Date() });
    expect(booked.status).toBe("confirmed");
    const phrase = `Cancel the appointment for Router Change Prospect at ${start.iso}`;

    const preview = await ask(h, "appointment_setter", phrase);
    expect(preview.reply).toContain("Cancellation preview");

    await switchOff(h, "appointment_setter", ["appointments.request_change"]);
    const refusedConfirm = await ask(h, "appointment_setter", "confirm appointment change", preview.conversationId);
    expect(refusedConfirm.reply).toMatch(/switched off in Allowed actions/);
    expect(await approvals(h)).toBe(0);
    const refusedPreview = await ask(h, "appointment_setter", phrase);
    expect(refusedPreview.reply).toMatch(/switched off in Allowed actions/);
    expect(refusedPreview.reply).not.toContain("Cancellation preview");
    expect(await pending(refusedPreview.conversationId, "pending_workforce_appointment_change")).toBeNull();
    expect(await denials(h, "chat:appointment_change")).toBeGreaterThanOrEqual(2);

    await switchOff(h, "appointment_setter", []);
    const submitted = await ask(h, "appointment_setter", "confirm appointment change", preview.conversationId);
    expect(submitted.reply).toContain("not changed yet");
    expect(await approvals(h)).toBe(1);
    const card = (await withSystem((db) => db.query<{ reason: string; expected_effect: string }>("select reason, expected_effect from approval_requests where org_id = $1 and kind = 'appointment_change'", [h.a.org.id]))).rows[0];
    expect(card.reason).toContain('Customer change policy for "Free Consultation": customers may move or cancel it themselves online until 2 hours before it starts.');
    expect(card.reason).toContain("not changed until an owner or admin approves");
  });
});

describe("a schedule request in chat", () => {
  it("is refused when the ability its review needs is switched off, and a preview made earlier cannot be confirmed", async () => {
    const h = await harness("Router Schedule Co");
    const phrase = "Review unresolved operational tasks every weekday at 9 AM";
    const preview = await ask(h, "operations_manager", phrase);
    expect(preview.reply).toContain("Schedule preview");
    expect(await pending(preview.conversationId, "pending_workforce_schedule")).toMatchObject({ status: "pending" });

    await switchOff(h, "operations_manager", ["tasks.read"]);
    const refusedConfirm = await ask(h, "operations_manager", "confirm schedule", preview.conversationId);
    expect(refusedConfirm.reply).toMatch(/switched off in Allowed actions/);
    expect(await schedules(h)).toBe(0);
    expect(await pending(preview.conversationId, "pending_workforce_schedule")).toMatchObject({ status: "pending" });
    const refusedPreview = await ask(h, "operations_manager", phrase);
    expect(refusedPreview.reply).toMatch(/switched off in Allowed actions/);
    expect(refusedPreview.reply).not.toContain("Schedule preview");
    expect(await pending(refusedPreview.conversationId, "pending_workforce_schedule")).toBeNull();
    expect(await denials(h, "capability:proactive_review")).toBeGreaterThanOrEqual(2);

    await switchOff(h, "operations_manager", []);
    const saved = await ask(h, "operations_manager", "confirm schedule", preview.conversationId);
    expect(saved.reply).toContain("Saved");
    expect(await schedules(h)).toBe(1);
  });
});

describe("a booking that lands waiting for the host to confirm it", () => {
  it("is described to the staff member as on the calendar but not confirmed, marked as an approved write, and becomes a completed action only once the host confirms it", async () => {
    const h = await harness("Router Waiting Host Co", { requiresConfirmation: true });
    await contact(h, "Waiting Prospect");
    // The owner switched on booking by the employee and the employee is autonomous, so the request goes straight in; the type still needs the host's yes.
    await withSystem(async (db) => {
      await db.query("insert into appointment_settings (org_id, ai_booking_enabled) values ($1, true) on conflict (org_id) do update set ai_booking_enabled = true", [h.a.org.id]);
      await db.query("update agent_instances set mode = 'autonomous' where id = $1", [h.agents.appointment_setter]);
    });
    const start = await offeredStart(h);
    const preview = await ask(h, "appointment_setter", `Book an appointment with Waiting Prospect at ${start.iso}`);
    const result = await ask(h, "appointment_setter", "confirm booking", preview.conversationId);
    const booking = (await withSystem((db) => db.query<{ id: string; status: string; appointment_id: string }>("select id, status, appointment_id from appointment_bookings where org_id = $1", [h.a.org.id]))).rows[0];
    expect(booking.status).toBe("booked");
    expect((await withSystem((db) => db.query<{ status: string }>("select status from appointment_refs where id = $1", [booking.appointment_id]))).rows[0].status).toBe("new");

    // Neither "booked" nor a claim that the calendar confirmed it: only the plain fact that the host has not.
    expect(result.reply).toContain("is on the calendar but the host has not confirmed it yet");
    expect(result.reply.replace("the host has not confirmed it yet", "")).not.toMatch(/booked|confirmed/i);
    expect(result.reply).not.toContain("The calendar confirmed");
    expect(result.evidence).toEqual({ v: 1, class: "approved_write", ledger: { kind: "appointment_booking", id: booking.id } });

    // Repeating the confirmation says the same, from the appointment's state now.
    const again = await ask(h, "appointment_setter", "confirm booking", preview.conversationId);
    expect(again.reply).toContain("host has not confirmed it yet");
    expect(again.evidence?.class).toBe("approved_write");

    await setNativeAppointmentStatus(h.a.actor("owner"), booking.appointment_id, "confirmed");
    const settled = await ask(h, "appointment_setter", "confirm booking", preview.conversationId);
    expect(settled.reply).toContain("the calendar confirmed it");
    expect(settled.evidence).toEqual({ v: 1, class: "completed_action", ledger: { kind: "appointment_booking", id: booking.id } });
    expect(await bookings(h)).toBe(1);
  });

  it("lands as before for a type that needs no confirmation: the calendar confirmed it, and the marker is a completed action", async () => {
    const h = await harness("Router Immediate Co", { requiresConfirmation: false });
    await contact(h, "Immediate Prospect");
    await withSystem(async (db) => {
      await db.query("insert into appointment_settings (org_id, ai_booking_enabled) values ($1, true) on conflict (org_id) do update set ai_booking_enabled = true", [h.a.org.id]);
      await db.query("update agent_instances set mode = 'autonomous' where id = $1", [h.agents.appointment_setter]);
    });
    const preview = await ask(h, "appointment_setter", `Book an appointment with Immediate Prospect at ${(await offeredStart(h)).iso}`);
    const result = await ask(h, "appointment_setter", "confirm booking", preview.conversationId);
    const booking = (await withSystem((db) => db.query<{ id: string }>("select id from appointment_bookings where org_id = $1", [h.a.org.id]))).rows[0];
    expect(result.reply).toContain("The calendar confirmed Immediate Prospect");
    expect(result.evidence).toEqual({ v: 1, class: "completed_action", ledger: { kind: "appointment_booking", id: booking.id } });
  });

  it("an owner who approves the booking is told what will really happen, and the booking still waits for the host afterwards", async () => {
    const h = await harness("Router Approval Host Co", { requiresConfirmation: true });
    await contact(h, "Approval Prospect");
    const preview = await ask(h, "appointment_setter", `Book an appointment with Approval Prospect at ${(await offeredStart(h)).iso}`);
    const submitted = await ask(h, "appointment_setter", "confirm booking", preview.conversationId);
    expect(submitted.reply).toContain("not booked yet");
    const waiting = (await withSystem((db) => db.query<{ approval_id: string }>("select approval_id from appointment_bookings where org_id = $1", [h.a.org.id]))).rows[0];
    const decided = await decideApproval(ctxFor(h.a.people.owner, h.a.org, "owner"), waiting.approval_id, "approve");
    expect(decided.outcome?.status).toBe("succeeded");
    const booking = (await withSystem((db) => db.query<{ appointment_id: string }>("select appointment_id from appointment_bookings where org_id = $1", [h.a.org.id]))).rows[0];
    expect((await withSystem((db) => db.query<{ status: string }>("select status from appointment_refs where id = $1", [booking.appointment_id]))).rows[0].status).toBe("new");
  });
});
