import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createUser, agencyUser } from "./support/fixtures";
import { createGrowthPartnerOnlyTenant, expectNoLegacyEmployeeRows, type GrowthPartnerOnlyTenant } from "./support/growth-partner-tenant";
import { messagingOrg, recordingProvider, type MessagingOrg } from "./support/messaging";
import { agencyOrgId } from "./support/staff-messages";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { adjustCredits } from "@/server/billing/ledger";
import { publishUnitRate } from "@/server/billing/service";
import { savePolicy } from "@/server/appointments/settings";
import { createAppointmentType, createCalendar } from "@/server/calendars/setup";
import { dispatchMessage } from "@/server/messaging/send";
import { appointmentSetterId, claimDueReminders, queueClaimedReminder, syncRemindersFor } from "@/server/appointments/reminders";
import { setAgencyPause, setClientPause } from "@/server/automation/controls";
import { startFollowUps, processDueFollowUps } from "@/server/messaging/followups";
import { ensureConversation } from "@/server/missed-calls/cases";
import { routeToGrowthPartner } from "@/server/missed-calls/routing";
import type { CaseRow } from "@/server/missed-calls/cases";
import { prepareDueSteps } from "@/server/retention/engine";
import { listPrograms, setProgramEnabled } from "@/server/retention/service";
import { memberActor } from "@/server/crm/actor";
import { approveTemplate, createTemplate } from "@/server/crm/message-templates";
import { createSmartList } from "@/server/crm/smart-lists";
import { createCampaign, previewCampaign, requestCampaignApproval } from "@/server/crm/campaigns";
import { processCampaigns } from "@/server/crm/campaigns/job";
import { decideApproval } from "@/server/approvals/service";

type MessagingTenant = { orgId: string; ownerId: string; ownerCtx: GrowthPartnerOnlyTenant["ownerCtx"]; agentId: string };

let partner: GrowthPartnerOnlyTenant;
let legacy: MessagingOrg;
let partnerMessaging: MessagingTenant;
let agencySuperAdmin: ReturnType<typeof agencyUser>;
let originalQuietHours: { quiet_hours_start: string; quiet_hours_end: string } | null = null;
let seq = 0;

const uid = () => crypto.randomUUID().replaceAll("-", "");
const ownerMessaging = (tenant: GrowthPartnerOnlyTenant): MessagingTenant => ({
  orgId: tenant.org.id,
  ownerId: tenant.owner.id,
  ownerCtx: tenant.ownerCtx,
  agentId: tenant.runtimeAgentId,
});

async function seedPartnerMessaging(tenant: GrowthPartnerOnlyTenant): Promise<void> {
  const superUser = await createUser({ platformRole: "agency_super_admin", name: "Outbound Test Admin" });
  const superAdmin = agencyUser(superUser, "agency_super_admin");
  await publishUnitRate(superAdmin, { provider: "ghl", unitType: "sms_segment", wholesaleMicrosPerUnit: 8000 });
  await withSystem(async (db) => {
    await db.query("update messaging_policy set quiet_hours_start = '00:00', quiet_hours_end = '00:00'");
    await db.query(
      `insert into messaging_settings (org_id, auto_reply_enabled, business_hours)
       values ($1, true, $2::jsonb)
       on conflict (org_id) do update set auto_reply_enabled = true, business_hours = excluded.business_hours, followup_preset = 'balanced'`,
      [tenant.org.id, JSON.stringify({ mon: [["00:00", "23:59"]], tue: [["00:00", "23:59"]], wed: [["00:00", "23:59"]], thu: [["00:00", "23:59"]], fri: [["00:00", "23:59"]], sat: [["00:00", "23:59"]], sun: [["00:00", "23:59"]] })],
    );
    await db.query(
      `insert into messaging_channels (org_id, channel, provider, enabled, sender_identity, sender_verified_at, registration_status)
       values ($1, 'sms', 'ghl', true, '+15550009999', now(), 'approved')
       on conflict (org_id, channel) do update set provider = excluded.provider, enabled = true, sender_identity = excluded.sender_identity,
         sender_verified_at = now(), registration_status = 'approved'`,
      [tenant.org.id],
    );
    await adjustCredits(db, { orgId: tenant.org.id, deltaMicros: 30_000_000, reason: "Synthetic B-03 fixture balance", userId: tenant.owner.id });
  });
}

async function addContact(
  tenant: MessagingTenant,
  input: { name: string; lifecycle?: "lead_captured" | "customer"; city?: string; consent?: Array<"service" | "marketing"> },
): Promise<{ id: string; phone: string }> {
  const suffix = String((seq += 1) + Math.floor(Math.random() * 100_000)).padStart(7, "0").slice(-7);
  const phone = `+1555${suffix}`;
  const ghlContactId = `ghl_${uid()}`;
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into contacts (org_id, display_name, first_name, phone, city, source, created_via, ghl_contact_id, timezone, lifecycle_stage, customer_since)
       values ($1, $2, $3, $4, $5, 'manual', 'manual', $6, 'UTC', $7, case when $7 = 'customer' then now() else null end)
       returning id`,
      [tenant.orgId, input.name, input.name.split(/\s+/)[0], phone, input.city ?? "springfield", ghlContactId, input.lifecycle ?? "lead_captured"],
    );
    const id = rows[0].id;
    await db.query(
      "insert into contact_identities (org_id, contact_id, kind, value, verified, verified_via) values ($1, $2, 'phone', $3, true, 'staff_confirmed')",
      [tenant.orgId, id, phone],
    );
    for (const purpose of input.consent ?? []) {
      await db.query(
        "insert into contact_consent_events (org_id, contact_id, channel, purpose, status, source, evidence) values ($1, $2, 'sms', $3, 'granted', 'test', 'Synthetic B-03 fixture consent.')",
        [tenant.orgId, id, purpose],
      );
    }
    return { id, phone };
  });
}

async function addConversation(tenant: MessagingTenant, contactId: string, opts: { ownerKind?: "ai" | "unassigned"; agentId?: string | null; thread?: string } = {}): Promise<string> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into conversations (org_id, contact_id, channel, thread_key, ai_agent_id, owner_kind, last_inbound_at)
       values ($1, $2, 'sms', $3, $4, $5, now()) returning id`,
      [tenant.orgId, contactId, opts.thread ?? "main", opts.agentId === undefined ? tenant.agentId : opts.agentId, opts.ownerKind ?? "ai"],
    );
    return rows[0].id;
  });
}

async function addReminder(tenant: MessagingTenant, contactId: string, now: Date): Promise<{ appointmentId: string; dueAt: Date }> {
  await savePolicy(tenant.ownerCtx, { remindersEnabled: true, reminderOffsetsMinutes: [120] }, now);
  const startAt = new Date(now.getTime() + 4 * 60 * 60_000);
  const dueAt = new Date(startAt.getTime() - 120 * 60_000);
  const { appointmentId } = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at, contact_id, timezone, last_event_at)
       values ($1, $2, 'cal_b03_0001', 'B-03 confirmed appointment', 'confirmed', $3, $4, $5, 'UTC', $6) returning id`,
      [tenant.orgId, `b03_${uid()}`, startAt.toISOString(), new Date(startAt.getTime() + 30 * 60_000).toISOString(), contactId, now],
    );
    await syncRemindersFor(db, tenant.orgId, rows[0].id, now);
    return { appointmentId: rows[0].id };
  });
  return { appointmentId, dueAt };
}

function claimedFor(claimed: Awaited<ReturnType<typeof claimDueReminders>>, tenant: MessagingTenant, appointmentId: string) {
  return claimed.find((row) => row.org_id === tenant.orgId && row.appointment_id === appointmentId) ?? null;
}

async function createFollowupPlan(tenant: MessagingTenant, contactId: string, planNow: Date): Promise<string> {
  const conversationId = await addConversation(tenant, contactId, { thread: `b03-followup-${uid()}` });
  const plan = await withSystem((db) => startFollowUps(db, { orgId: tenant.orgId, conversationId, now: planNow }));
  if (!plan.planId) throw new Error(`Expected a synthetic active follow-up plan, received ${plan.reason ?? "none"}.`);
  return plan.planId;
}

beforeAll(async () => {
  resetEnvCache();
  await agencyOrgId();
  originalQuietHours = await withSystem(async (db) => (await db.query<{ quiet_hours_start: string; quiet_hours_end: string }>(
    "select quiet_hours_start, quiet_hours_end from messaging_policy limit 1",
  )).rows[0] ?? null);
  partner = await createGrowthPartnerOnlyTenant({ name: "B-03 Partner Only", mode: "autonomous" });
  partnerMessaging = ownerMessaging(partner);
  await seedPartnerMessaging(partner);
  await expectNoLegacyEmployeeRows(partner.org.id);
  legacy = await messagingOrg({ name: "B-03 Legacy Six Role", autonomous: true });
  const agencyUserRecord = await createUser({ platformRole: "agency_super_admin", name: "B-03 Agency Admin" });
  agencySuperAdmin = agencyUser(agencyUserRecord, "agency_super_admin");
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where org_id = $1 and role_key = 'appointment_setter'", [legacy.org.id]));
}, 120000);

afterAll(async () => {
  await withSystem(async (db) => {
    if (originalQuietHours) {
      await db.query("update messaging_policy set quiet_hours_start = $1, quiet_hours_end = $2", [originalQuietHours.quiet_hours_start, originalQuietHours.quiet_hours_end]);
    }
    await db.query("update agent_instances set mode = 'autonomous', status = 'online', last_health_ok = true where org_id = $1 and role_key = 'growth_partner'", [partner?.org.id]);
    await db.query("update automation_pauses set active = false where org_id = $1 and scope in ('messaging', 'outbound')", [partner?.org.id]);
    await db.query("update automation_pauses set active = false where scope = 'agency' and org_id = (select id from organizations where kind = 'agency' limit 1)");
  });
  resetEnvCache();
});

describe("Partner-first outbound program actors", () => {
  it("plans and queues a Partner-owned appointment reminder, while legacy reminders retain the Appointment Setter", async () => {
    const planNow = new Date();
    const partnerContact = await addContact(partnerMessaging, { name: "Partner Reminder", consent: ["service"] });
    const reminder = await addReminder(partnerMessaging, partnerContact.id, planNow);
    expect(await withSystem((db) => appointmentSetterId(db, partner.org.id))).toBe(partner.runtimeAgentId);

    const dueNow = new Date(reminder.dueAt.getTime() + 5 * 60_000);
    const partnerClaims = await claimDueReminders(dueNow, 100);
    const claimed = claimedFor(partnerClaims, partnerMessaging, reminder.appointmentId);
    expect(claimed).toMatchObject({ agent_id: partner.runtimeAgentId, approval_live: true });
    if (!claimed) throw new Error("Expected the due reminder to be claimed.");
    expect(await queueClaimedReminder(claimed, dueNow)).toBe("queued");
    const partnerMessage = await withSystem(async (db) => (await db.query<{ agent_id: string; scope: string; status: string }>(
      `select m.agent_id, m.scope, m.status from appointment_reminders r join conversation_messages m on m.id = r.message_id
       where r.org_id = $1 and r.appointment_id = $2`,
      [partner.org.id, reminder.appointmentId],
    )).rows[0]);
    expect(partnerMessage).toEqual({ agent_id: partner.runtimeAgentId, scope: "reminder", status: "queued" });

    const legacyCtx: MessagingTenant = { orgId: legacy.org.id, ownerId: legacy.people.owner.id, ownerCtx: legacy.ctx("owner"), agentId: legacy.salesAgentId };
    const legacySetter = await withSystem((db) => appointmentSetterId(db, legacy.org.id));
    expect(legacySetter).toEqual((await withSystem((db) => db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = 'appointment_setter'", [legacy.org.id]))).rows[0].id);
    const legacyContact = await addContact(legacyCtx, { name: "Legacy Reminder", consent: ["service"] });
    const legacyReminder = await addReminder(legacyCtx, legacyContact.id, planNow);
    const legacyClaims = await claimDueReminders(dueNow, 100);
    const legacyClaim = claimedFor(legacyClaims, legacyCtx, legacyReminder.appointmentId);
    expect(legacyClaim?.agent_id).toBe(legacySetter);
  }, 120000);

  it("rechecks standing authorization before delivering a native appointment reminder", async () => {
    const owner = memberActor(partner.ownerCtx);
    const calendar = await createCalendar(owner, { name: "Synthetic reminder calendar", members: [{ userId: partner.owner.id }] });
    const type = await createAppointmentType(owner, calendar.id, { name: "Synthetic appointment", durationMinutes: 30 });
    const planNow = new Date();
    await savePolicy(partner.ownerCtx, { remindersEnabled: true, reminderOffsetsMinutes: [120] }, planNow);
    const startAt = new Date(planNow.getTime() + 4 * 3_600_000);
    const dispatchAt = new Date(planNow.getTime() + 3 * 3_600_000);
    const appointmentFor = async (name: string, consent: Array<"service">) => {
      const contact = await addContact(partnerMessaging, { name, consent });
      return withSystem(async (db) => {
        const appointment = (await db.query<{ id: string }>(
          `insert into appointment_refs (org_id, provider, calendar_ref, appointment_type_id, title, status, start_at, end_at, contact_id, timezone)
           values ($1, 'native', $2, $3, 'Synthetic appointment', 'confirmed', $4, $4::timestamptz + interval '30 minutes', $5, 'UTC') returning id`,
          [partner.org.id, calendar.id, type.id, startAt.toISOString(), contact.id],
        )).rows[0];
        await syncRemindersFor(db, partner.org.id, appointment.id, planNow);
        return appointment.id;
      });
    };
    const first = await appointmentFor("Authorized reminder", ["service"]);
    const second = await appointmentFor("Revoked reminder", ["service"]);
    const noConsent = await appointmentFor("No reminder consent", []);
    await withSystem((db) => db.query("update agent_instances set mode = 'approval_required' where id = $1", [partner.runtimeAgentId]));
    let expiredApproval: { id: string; expires_at: Date | null } | undefined;
    try {
      const claims = await claimDueReminders(dispatchAt, 100);
      const mine = claims.filter((claim) => claim.org_id === partner.org.id && [first, second, noConsent].includes(claim.appointment_id));
      expect(mine).toHaveLength(3);
      for (const claim of mine) {
        expect(claim).toMatchObject({ agent_id: partner.runtimeAgentId, approval_live: true });
        expect(await queueClaimedReminder(claim, dispatchAt)).toBe(claim.appointment_id === noConsent ? "blocked" : "queued");
      }
      const { rows } = await withSystem((db) => db.query<{ appointment_id: string; message_id: string | null; reason: string | null; message_status: string | null }>(
        `select r.appointment_id, r.message_id, r.reason, m.status as message_status
           from appointment_reminders r left join conversation_messages m on m.id = r.message_id and m.org_id = r.org_id
          where r.org_id = $1 and r.appointment_id = any($2::uuid[])`,
        [partner.org.id, [first, second, noConsent]],
      ));
      expect(rows.find((row) => row.appointment_id === noConsent)).toMatchObject({ reason: "no_consent", message_id: null });
      const firstMessage = rows.find((row) => row.appointment_id === first);
      const pendingMessage = rows.find((row) => row.appointment_id === second);
      expect(firstMessage?.message_status).toBe("queued");
      expect(pendingMessage?.message_status).toBe("queued");
      if (!firstMessage?.message_id || !pendingMessage?.message_id) throw new Error("Expected two authorized reminders to have queued messages.");

      const recorder = recordingProvider();
      expect(await dispatchMessage(firstMessage.message_id, { provider: recorder.provider, now: dispatchAt })).toEqual({ status: "sent" });
      expiredApproval = await withSystem(async (db) => {
        const a = (await db.query<{ id: string; expires_at: Date | null }>(
          `select a.id, a.expires_at from appointment_settings p join approval_requests a on a.id = p.reminders_approval_id and a.org_id = p.org_id where p.org_id = $1`,
          [partner.org.id],
        )).rows[0];
        await db.query("update approval_requests set expires_at = now() - interval '1 minute' where id = $1", [a.id]);
        return a;
      });
      expect(await dispatchMessage(pendingMessage.message_id, { provider: recorder.provider, now: dispatchAt })).toEqual({ status: "blocked" });
      const denied = await withSystem((db) => db.query<{ blocked_reason: string }>(
        "select blocked_reason from conversation_messages where id = $1 and org_id = $2",
        [pendingMessage.message_id, partner.org.id],
      ));
      expect(denied.rows[0]?.blocked_reason).toBe("authorization_needed");
      expect(recorder.calls.map((call) => call.messageId)).toEqual([firstMessage.message_id]);
    } finally {
      await withSystem(async (db) => {
        if (expiredApproval) await db.query("update approval_requests set expires_at = $2 where id = $1", [expiredApproval.id, expiredApproval.expires_at]);
        await db.query("update agent_instances set mode = 'autonomous' where id = $1", [partner.runtimeAgentId]);
      });
    }
  });

  it("keeps a paused Partner visibly blocked and sends one daily owner notice for reminders", async () => {
    await withSystem((db) => db.query("update agent_instances set mode = 'paused' where id = $1", [partner.runtimeAgentId]));
    try {
      const planNow = new Date();
      const firstContact = await addContact(partnerMessaging, { name: "Paused Reminder One", consent: ["service"] });
      const secondContact = await addContact(partnerMessaging, { name: "Paused Reminder Two", consent: ["service"] });
      const first = await addReminder(partnerMessaging, firstContact.id, planNow);
      const second = await addReminder(partnerMessaging, secondContact.id, planNow);
      const dueNow = new Date(Math.max(first.dueAt.getTime(), second.dueAt.getTime()) + 5 * 60_000);
      const claims = await claimDueReminders(dueNow, 100);
      for (const appointmentId of [first.appointmentId, second.appointmentId]) {
        const claimed = claimedFor(claims, partnerMessaging, appointmentId);
        expect(claimed?.agent_id).toBe(partner.runtimeAgentId);
        if (!claimed) throw new Error("Expected the due reminder to be claimed.");
        expect(await queueClaimedReminder(claimed, dueNow)).toBe("blocked");
      }

      const state = await withSystem(async (db) => {
        const reminders = await db.query<{ reason: string; status: string }>(
          "select reason, status from appointment_reminders where org_id = $1 and appointment_id = any($2::uuid[]) order by appointment_id",
          [partner.org.id, [first.appointmentId, second.appointmentId]],
        );
        const notices = await db.query<{ n: number; user_ids: string[]; body: string | null }>(
          "select count(*)::int as n, array_agg(user_id::text) as user_ids, max(body) as body from notifications where org_id = $1 and kind = 'booking_needs_action' and dedupe_key = $2",
          [partner.org.id, `reminders-agent:${partner.org.id}:${dueNow.toISOString().slice(0, 10)}`],
        );
        return { reminders: reminders.rows, notice: notices.rows[0] };
      });
      expect(state.reminders).toHaveLength(2);
      expect(state.reminders.every((row) => row.status === "blocked" && /The AI runtime is paused\./i.test(row.reason))).toBe(true);
      expect(state.notice).toMatchObject({ n: 1, user_ids: [partner.owner.id] });
      expect(state.notice?.body).toMatch(/paused/i);
    } finally {
      await withSystem((db) => db.query("update agent_instances set mode = 'autonomous' where id = $1", [partner.runtimeAgentId]));
    }
  }, 120000);

  it("keeps an unready Partner visibly blocked and sends one daily owner notice for reminders", async () => {
    await withSystem((db) => db.query("update agent_instances set mode = 'autonomous', status = 'setup_required' where id = $1", [partner.runtimeAgentId]));
    try {
      const planNow = new Date(Date.now() + 24 * 60 * 60_000);
      const firstContact = await addContact(partnerMessaging, { name: "Unready Reminder One", consent: ["service"] });
      const secondContact = await addContact(partnerMessaging, { name: "Unready Reminder Two", consent: ["service"] });
      const first = await addReminder(partnerMessaging, firstContact.id, planNow);
      const second = await addReminder(partnerMessaging, secondContact.id, planNow);
      const dueNow = new Date(Math.max(first.dueAt.getTime(), second.dueAt.getTime()) + 5 * 60_000);
      const claims = await claimDueReminders(dueNow, 100);
      for (const appointmentId of [first.appointmentId, second.appointmentId]) {
        const claimed = claimedFor(claims, partnerMessaging, appointmentId);
        expect(claimed?.agent_id).toBe(partner.runtimeAgentId);
        if (!claimed) throw new Error("Expected the due reminder to be claimed.");
        expect(await queueClaimedReminder(claimed, dueNow)).toBe("blocked");
      }

      const state = await withSystem(async (db) => {
        const reminders = await db.query<{ reason: string; status: string }>(
          "select reason, status from appointment_reminders where org_id = $1 and appointment_id = any($2::uuid[]) order by appointment_id",
          [partner.org.id, [first.appointmentId, second.appointmentId]],
        );
        const notices = await db.query<{ n: number; user_ids: string[]; body: string | null }>(
          "select count(*)::int as n, array_agg(user_id::text) as user_ids, max(body) as body from notifications where org_id = $1 and kind = 'booking_needs_action' and dedupe_key = $2",
          [partner.org.id, `reminders-agent:${partner.org.id}:${dueNow.toISOString().slice(0, 10)}`],
        );
        return { reminders: reminders.rows, notice: notices.rows[0] };
      });
      expect(state.reminders).toHaveLength(2);
      expect(state.reminders.every((row) => row.status === "blocked" && /connection check/i.test(row.reason))).toBe(true);
      expect(state.notice).toMatchObject({ n: 1, user_ids: [partner.owner.id] });
      expect(state.notice?.body).toMatch(/connection check/i);
    } finally {
      await withSystem((db) => db.query("update agent_instances set mode = 'autonomous', status = 'online', last_health_ok = true where id = $1", [partner.runtimeAgentId]));
    }
  }, 120000);

  it("queues an approved retention step under the Growth Partner runtime", async () => {
    const programs = await listPrograms(partner.ownerCtx);
    expect(programs.length).toBeGreaterThan(0);
    await setProgramEnabled(partner.ownerCtx, "welcome", true);
    const program = await withSystem((db) => db.query<{ id: string; steps: Array<{ key: string }> }>(
      "select id, steps from retention_programs where org_id = $1 and kind = 'welcome'",
      [partner.org.id],
    ));
    const contact = await addContact(partnerMessaging, { name: "Partner Retention", lifecycle: "customer", consent: ["service"] });
    const stepKey = program.rows[0].steps[0].key;
    const enrollment = await withSystem(async (db) => {
      const row = await db.query<{ id: string }>(
        "insert into retention_enrollments (org_id, program_id, contact_id, trigger_ref) values ($1, $2, $3, $4) returning id",
        [partner.org.id, program.rows[0].id, contact.id, `b03-${uid()}`],
      );
      await db.query(
        "insert into retention_steps (org_id, enrollment_id, step_key, due_at, status) values ($1, $2, $3, $4, 'scheduled')",
        [partner.org.id, row.rows[0].id, stepKey, new Date(Date.now() - 60_000)],
      );
      return row.rows[0].id;
    });

    const result = await prepareDueSteps({ now: new Date(), limit: 100 });
    expect(result.queued).toBeGreaterThanOrEqual(1);
    const queued = await withSystem(async (db) => (await db.query<{ status: string; agent_id: string; scope: string }>(
      `select s.status, m.agent_id, m.scope from retention_steps s join conversation_messages m on m.id = s.message_id
       where s.org_id = $1 and s.enrollment_id = $2`,
      [partner.org.id, enrollment],
    )).rows[0]);
    expect(queued).toEqual({ status: "queued", agent_id: partner.runtimeAgentId, scope: "retention" });
  }, 120000);

  it("routes missed calls to the bound Partner and leaves legacy conversation ownership intact", async () => {
    const partnerContact = await addContact(partnerMessaging, { name: "Partner Caller", consent: ["service"] });
    const partnerMain = await withSystem((db) => ensureConversation(db, partner.org.id, partnerContact.id));
    expect(await withSystem(async (db) => (await db.query<{ ai_agent_id: string; owner_kind: string }>(
      "select ai_agent_id, owner_kind from conversations where id = $1 and org_id = $2",
      [partnerMain, partner.org.id],
    )).rows[0])).toEqual({ ai_agent_id: partner.runtimeAgentId, owner_kind: "ai" });

    const routeConversation = await addConversation(partnerMessaging, partnerContact.id, { ownerKind: "unassigned", agentId: null, thread: `b03-route-${uid()}` });
    const caseInput = { id: crypto.randomUUID(), org_id: partner.org.id, conversation_id: routeConversation } as CaseRow;
    const routed = await withSystem((db) => routeToGrowthPartner(db, caseInput));
    expect(routed).toMatchObject({ status: "done", reason: "assigned", agentId: partner.runtimeAgentId });
    const event = await withSystem((db) => db.query<{ detail: Record<string, unknown> }>(
      "select detail from conversation_events where org_id = $1 and conversation_id = $2 and kind = 'ai_assigned' order by created_at desc limit 1",
      [partner.org.id, routeConversation],
    ));
    expect(event.rows[0]?.detail).toMatchObject({ agentId: partner.runtimeAgentId, roleKey: "growth_partner", by: "missed_call" });

    const legacyContact = await addContact({ orgId: legacy.org.id, ownerId: legacy.people.owner.id, ownerCtx: legacy.ctx("owner"), agentId: legacy.salesAgentId }, { name: "Legacy Caller" });
    const legacyMain = await withSystem((db) => ensureConversation(db, legacy.org.id, legacyContact.id));
    expect(await withSystem(async (db) => (await db.query<{ ai_agent_id: string; owner_kind: string }>(
      "select ai_agent_id, owner_kind from conversations where id = $1 and org_id = $2",
      [legacyMain, legacy.org.id],
    )).rows[0])).toEqual({ ai_agent_id: legacy.salesAgentId, owner_kind: "ai" });
    const legacyRouteConversation = await addConversation({ orgId: legacy.org.id, ownerId: legacy.people.owner.id, ownerCtx: legacy.ctx("owner"), agentId: legacy.salesAgentId }, legacyContact.id, { ownerKind: "unassigned", agentId: null, thread: `b03-legacy-route-${uid()}` });
    const legacyCase = { id: crypto.randomUUID(), org_id: legacy.org.id, conversation_id: legacyRouteConversation } as CaseRow;
    const legacyRouted = await withSystem((db) => routeToGrowthPartner(db, legacyCase));
    expect(legacyRouted).toEqual({ status: "blocked", reason: "no_growth_partner" });
    const crossTenant = await withSystem((db) => routeToGrowthPartner(db, { ...legacyCase, org_id: partner.org.id }));
    expect(crossTenant).toEqual({ status: "skipped", reason: "no_conversation" });
    const legacyOwnership = await withSystem((db) => db.query<{ ai_agent_id: string | null; owner_kind: string }>(
      "select ai_agent_id, owner_kind from conversations where id = $1 and org_id = $2",
      [legacyRouteConversation, legacy.org.id],
    ));
    expect(legacyOwnership.rows[0]).toEqual({ ai_agent_id: null, owner_kind: "unassigned" });
  }, 120000);

  it.each(["messaging", "outbound", "agency"] as const)("stops active follow-up plans during a %s pause", async (scope) => {
    const contact = await addContact(partnerMessaging, { name: `Paused ${scope} follow-up` });
    const planId = await createFollowupPlan(partnerMessaging, contact.id, new Date(Date.now() - 4 * 86_400_000));
    const now = new Date();
    if (scope === "agency") {
      await setAgencyPause(agencySuperAdmin, { orgId: null, paused: true, reason: "Synthetic follow-up pause check" });
    } else {
      await setClientPause(partner.ownerCtx, { scope, paused: true, reason: `Synthetic ${scope} pause check` });
    }
    try {
      await processDueFollowUps({ now, plan: false });
      const plan = await withSystem((db) => db.query<{ status: string; cancel_reason: string | null }>(
        "select status, cancel_reason from follow_up_plans where id = $1 and org_id = $2",
        [planId, partner.org.id],
      ));
      expect(plan.rows[0]).toMatchObject({ status: "cancelled", cancel_reason: "automation_paused" });
      const steps = await withSystem((db) => db.query<{ status: string; reason: string | null }>("select status, reason from follow_up_steps where plan_id = $1", [planId]));
      expect(steps.rows.length).toBeGreaterThan(0);
      expect(steps.rows.every((step) => step.status === "cancelled" || (step.status === "blocked" && step.reason === "automation_paused"))).toBe(true);
      expect(steps.rows.some((step) => step.status === "cancelled")).toBe(true);
    } finally {
      if (scope === "agency") await setAgencyPause(agencySuperAdmin, { orgId: null, paused: false, reason: "Synthetic follow-up pause check complete" });
      else await setClientPause(partner.ownerCtx, { scope, paused: false });
    }
  }, 120000);

  it("creates campaign recipient conversations under the Partner, while legacy campaigns keep the Sales Assistant", async () => {
    vi.stubEnv("GHL_WRITES_ENABLED", "true");
    resetEnvCache();
    try {
      async function queueCampaign(tenant: MessagingTenant, name: string) {
        const contact = await addContact(tenant, { name, city: "springfield", consent: ["marketing"] });
        const actor = memberActor(tenant.ownerCtx);
        const template = await createTemplate(actor, {
          name: `B-03 ${name} offer`, channel: "sms", purpose: "marketing",
          body: "Hi {{contact.first_name}}, thanks from {{business.name}}. Reply STOP to opt out.",
        });
        await approveTemplate(actor, template.id, { version: template.currentVersion, contentHash: template.contentHash });
        const list = await createSmartList(actor, {
          entity: "contact", name: `B-03 ${name} list`, visibility: "team",
          filter: { op: "and", conditions: [{ field: "city", op: "equals", value: "springfield" }] },
        });
        const campaign = await createCampaign(actor, {
          name: `B-03 ${name} campaign`, channel: "sms", smartListId: list.id, templateId: template.id,
          schedule: { mode: "now" }, ratePerMinute: 30,
        });
        const preview = await previewCampaign(actor, { campaignId: campaign.id });
        expect(preview.problems).toEqual([]);
        const request = await requestCampaignApproval(actor, campaign.id, { fingerprint: preview.fingerprint! });
        const approved = await decideApproval(tenant.ownerCtx, request.approvalId, "approve");
        expect(approved.outcome?.status).toBe("succeeded");
        await processCampaigns({ now: new Date() });
        const recipient = await withSystem((db) => db.query<{ message_id: string; status: string }>(
          "select message_id, status from crm_campaign_recipients where campaign_id = $1 and contact_id = $2",
          [campaign.id, contact.id],
        ));
        expect(recipient.rows[0]?.status).toBe("queued");
        const conversation = await withSystem((db) => db.query<{ ai_agent_id: string; owner_kind: string }>(
          `select c.ai_agent_id, c.owner_kind from conversation_messages m join conversations c on c.id = m.conversation_id
           where m.id = $1 and m.org_id = $2`,
          [recipient.rows[0].message_id, tenant.orgId],
        ));
        return conversation.rows[0];
      }

      expect(await queueCampaign(partnerMessaging, "Partner Campaign")).toEqual({ ai_agent_id: partner.runtimeAgentId, owner_kind: "ai" });
      expect(await queueCampaign({ orgId: legacy.org.id, ownerId: legacy.people.owner.id, ownerCtx: legacy.ctx("owner"), agentId: legacy.salesAgentId }, "Legacy Campaign")).toEqual({ ai_agent_id: legacy.salesAgentId, owner_kind: "ai" });
    } finally {
      vi.unstubAllEnvs();
      resetEnvCache();
    }
  }, 120000);
});
