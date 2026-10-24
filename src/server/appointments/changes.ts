import "server-only";
import { withSystem } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { getAvailability } from "@/server/appointments/availability";
import { ghlAppointmentProvider } from "@/server/appointments/provider";
import { applyAppointmentEvent } from "@/server/appointments/ledger";
import { bookingIsNative } from "@/server/calendars/agent-booking";
import { cancelNativeAppointment, rescheduleNativeAppointment } from "@/server/calendars/booking";
import { ghlPathRefusal } from "@/server/crm/provider-guard";
import { systemActor } from "@/server/crm/actor";
import type { AppointmentStatus } from "@/lib/appointments";

type Operation = "cancel" | "reschedule";

interface ExpectedAppointment {
  version: number;
  contactId: string;
  startAt: string;
  endAt: string;
  status: "new" | "confirmed";
  provider: "ghl" | "native";
  lastEventAt: string | null;
}

interface AppointmentChangeAction {
  version: 1;
  proposalId: string;
  appointmentId: string;
  operation: Operation;
  expected: ExpectedAppointment;
  newStartAt: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function parseAction(value: Record<string, unknown>): AppointmentChangeAction | null {
  if (value.version !== 1 || !UUID.test(String(value.proposalId ?? "")) || !UUID.test(String(value.appointmentId ?? ""))) return null;
  if (value.operation !== "cancel" && value.operation !== "reschedule") return null;
  if (value.newStartAt !== null && (typeof value.newStartAt !== "string" || !Number.isFinite(Date.parse(value.newStartAt)) || new Date(value.newStartAt).toISOString() !== value.newStartAt)) return null;
  if ((value.operation === "cancel" && value.newStartAt !== null) || (value.operation === "reschedule" && value.newStartAt === null)) return null;
  if (typeof value.expected !== "object" || value.expected === null || Array.isArray(value.expected)) return null;
  const expected = value.expected as Record<string, unknown>;
  if (
    !Number.isInteger(expected.version)
    || !UUID.test(String(expected.contactId ?? ""))
    || typeof expected.startAt !== "string" || !Number.isFinite(Date.parse(expected.startAt)) || new Date(expected.startAt).toISOString() !== expected.startAt
    || typeof expected.endAt !== "string" || !Number.isFinite(Date.parse(expected.endAt)) || new Date(expected.endAt).toISOString() !== expected.endAt
    || (expected.status !== "new" && expected.status !== "confirmed")
    || (expected.provider !== "ghl" && expected.provider !== "native")
    || (expected.lastEventAt !== null && (typeof expected.lastEventAt !== "string" || !Number.isFinite(Date.parse(expected.lastEventAt))))
  ) return null;
  return {
    version: 1,
    proposalId: value.proposalId as string,
    appointmentId: value.appointmentId as string,
    operation: value.operation,
    expected: {
      version: expected.version as number,
      contactId: expected.contactId as string,
      startAt: expected.startAt as string,
      endAt: expected.endAt as string,
      status: expected.status,
      provider: expected.provider,
      lastEventAt: expected.lastEventAt as string | null,
    },
    newStartAt: value.newStartAt as string | null,
  };
}

async function loadAppointment(orgId: string, appointmentId: string) {
  return withSystem(async (db) => {
    const { rows } = await db.query<{
      id: string; org_id: string; contact_id: string | null; status: string; start_at: Date; end_at: Date; provider: string; version: number; last_event_at: Date | null;
      title: string; timezone: string; ghl_appointment_id: string | null; ghl_calendar_id: string | null;
      ghl_contact_id: string | null; assigned_ghl_user_id: string | null; appointment_type_id: string | null;
    }>(
      `select id, org_id, contact_id, status, start_at, end_at, provider, version, last_event_at, title, timezone,
              ghl_appointment_id, ghl_calendar_id, ghl_contact_id, assigned_ghl_user_id, appointment_type_id
         from appointment_refs where id = $1 and org_id = $2`,
      [appointmentId, orgId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      status: row.status as "new" | "confirmed",
      provider: row.provider as "ghl" | "native",
      start_at: new Date(row.start_at),
      end_at: new Date(row.end_at),
      last_event_at: row.last_event_at ? new Date(row.last_event_at) : null,
    };
  });
}

function expectedMatches(row: Awaited<ReturnType<typeof loadAppointment>>, expected: ExpectedAppointment): row is NonNullable<Awaited<ReturnType<typeof loadAppointment>>> {
  return Boolean(row
    && row.version === expected.version
    && row.contact_id === expected.contactId
    && iso(row.start_at) === expected.startAt
    && iso(row.end_at) === expected.endAt
    && row.status === expected.status
    && row.provider === expected.provider
    && iso(row.last_event_at) === expected.lastEventAt);
}

async function validateReplacement(orgId: string, row: NonNullable<Awaited<ReturnType<typeof loadAppointment>>>, newStartAt: string, now: Date): Promise<{ ok: true; endAt: Date } | { ok: false; detail: string }> {
  const calendarId = row.provider === "native" ? row.appointment_type_id : row.ghl_calendar_id;
  if (!calendarId) return { ok: false, detail: "The appointment's calendar is no longer available." };
  const durationMs = row.end_at.getTime() - row.start_at.getTime();
  if (durationMs <= 0 || new Date(newStartAt).getTime() <= now.getTime()) return { ok: false, detail: "Choose a future start time and request a fresh preview." };
  const availability = await getAvailability(orgId, {
    calendarId,
    from: new Date(Date.parse(newStartAt) - 60_000),
    to: new Date(Date.parse(newStartAt) + 60_000),
    timeZone: row.timezone,
    now,
    limit: 200,
  });
  if (!availability.ok) return { ok: false, detail: availability.detail };
  if (durationMs !== availability.slotMinutes * 60_000) return { ok: false, detail: "This appointment's duration no longer matches the calendar's available slot length. Review it in the calendar before changing it." };
  if (!availability.slots.some((slot) => new Date(slot.start).getTime() === Date.parse(newStartAt))) {
    return { ok: false, detail: "That time is no longer available. Request a fresh preview with another open slot." };
  }
  return { ok: true, endAt: new Date(Date.parse(newStartAt) + durationMs) };
}

/** Executes only from the Approval Center, after an owner/admin approves this exact appointment snapshot. */
export async function executeApprovedAppointmentChange(
  orgId: string,
  approvalId: string,
  rawAction: Record<string, unknown>,
  actorUserId: string,
  agentInstanceId: string | null,
): Promise<{ status: "succeeded" | "failed" | "blocked"; detail: string }> {
  const action = parseAction(rawAction);
  if (!action) return { status: "failed", detail: "The appointment change request could not be verified. No calendar change was made." };
  const setter = agentInstanceId
    ? await withSystem(async (db) => (await db.query<{ id: string }>(
      "select id from agent_instances where id = $1 and org_id = $2 and role_key = 'appointment_setter'",
      [agentInstanceId, orgId],
    )).rows[0] ?? null)
    : null;
  if (!setter) return { status: "blocked", detail: "The Appointment Setter identity for this request is no longer available. No calendar change was made." };
  const row = await loadAppointment(orgId, action.appointmentId);
  if (!expectedMatches(row, action.expected)) return { status: "blocked", detail: "This appointment changed after the request was prepared. Review the current appointment and submit a fresh request." };
  if (!row || !["new", "confirmed"].includes(row.status) || row.start_at.getTime() <= Date.now()) {
    return { status: "blocked", detail: "Only an upcoming, active appointment can be changed. No calendar change was made." };
  }

  const now = new Date();
  if (action.operation === "reschedule") {
    const available = await validateReplacement(orgId, row, action.newStartAt as string, now);
    if (!available.ok) return { status: "blocked", detail: `${available.detail} No calendar change was made.` };
  }

  if (row.provider === "native") {
    if (!(await withSystem((db) => bookingIsNative(db, orgId)))) return { status: "blocked", detail: "The workspace's appointment provider changed after the request. No calendar change was made." };
    const org = await withSystem(async (db) => (await db.query<{ id: string; name: string; timezone: string }>("select id, name, timezone from organizations where id = $1", [orgId])).rows[0] ?? null);
    if (!org) return { status: "failed", detail: "The workspace could not be verified. No calendar change was made." };
    const actor = systemActor(org, "Approved Appointment Setter request");
    if (action.operation === "cancel") {
      await cancelNativeAppointment(actor, row.id, { by: "agent", reason: "Approved in iAcquire", expectedVersion: action.expected.version, now });
    } else {
      await rescheduleNativeAppointment(actor, row.id, { by: "agent", startAt: new Date(action.newStartAt as string), expectedVersion: action.expected.version, now });
    }
  } else {
    const refusal = await withSystem((db) => ghlPathRefusal(db, orgId, "appointments"));
    if (refusal) return { status: "blocked", detail: `${refusal} No calendar change was made.` };
    if (!row.ghl_appointment_id || !row.ghl_calendar_id) return { status: "blocked", detail: "The linked GoHighLevel appointment is incomplete. No calendar change was made." };
    const newStart = action.operation === "reschedule" ? new Date(action.newStartAt as string) : undefined;
    const newEnd = newStart ? new Date(newStart.getTime() + row.end_at.getTime() - row.start_at.getTime()) : undefined;
    const result = await ghlAppointmentProvider.update({
      orgId,
      appointmentId: row.ghl_appointment_id,
      calendarId: row.ghl_calendar_id,
      ...(action.operation === "cancel" ? { status: "cancelled" as const } : { startAt: newStart, endAt: newEnd }),
    });
    if (!result.ok) return { status: result.blocked ? "blocked" : "failed", detail: `${result.error} No change was confirmed.` };

    const eventTime = new Date();
    const status: AppointmentStatus = action.operation === "cancel" ? "cancelled" : row.status;
    const startAt = newStart ?? row.start_at;
    const endAt = newEnd ?? row.end_at;
    const ledger = await withSystem((db) => applyAppointmentEvent(db, {
      orgId,
      source: "portal",
      providerEventId: `portal:approval:${approvalId}`,
      now: eventTime,
      event: {
        kind: "update", locationId: "", appointmentId: row.ghl_appointment_id as string, calendarId: row.ghl_calendar_id,
        contactId: row.ghl_contact_id, status, assignedUserId: row.assigned_ghl_user_id, title: row.title, address: null,
        startAt, endAt, eventTime, source: "portal",
      },
    }));
    if (ledger.outcome !== "applied" && ledger.outcome !== "duplicate") {
      return { status: "blocked", detail: "GoHighLevel accepted the change, but a newer calendar update is already recorded in iAcquire. Refresh Appointments to see the current state." };
    }
  }

  await withSystem((db) => recordAudit({
    orgId,
    actorUserId,
    actorKind: "user",
    agentInstanceId,
    action: action.operation === "cancel" ? "appointment.cancelled" : "appointment.rescheduled",
    targetType: "appointment",
    targetId: row.id,
    approvalId,
    result: "success",
    metadata: { provider: row.provider, from: action.expected.startAt, to: action.operation === "reschedule" ? action.newStartAt : null, proposalId: action.proposalId },
  }, db));

  return {
    status: "succeeded",
    detail: action.operation === "cancel" ? "The appointment was cancelled on its connected calendar." : "The appointment was moved to the approved available time.",
  };
}

/** Snapshot shape used by chat when persisting its short-lived proposal. */
export function appointmentChangeExpected(row: {
  version: number; contact_id: string; start_at: Date | string; end_at: Date | string; status: "new" | "confirmed"; provider: "ghl" | "native"; last_event_at: Date | string | null;
}): ExpectedAppointment {
  return {
    version: row.version,
    contactId: row.contact_id,
    startAt: iso(row.start_at) as string,
    endAt: iso(row.end_at) as string,
    status: row.status,
    provider: row.provider,
    lastEventAt: iso(row.last_event_at),
  };
}
