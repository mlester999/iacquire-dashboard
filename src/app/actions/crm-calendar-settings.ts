"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import type { CrmActor } from "@/server/crm/actor";
import { resolveCrmActor } from "@/server/crm/request";
import {
  archiveAppointmentType, archiveCalendar, clearDayException, createAppointmentType, createCalendar, deleteAvailabilityOverride, duplicateAppointmentType,
  reorderAppointmentTypes, setAppointmentTypePublic, setCalendarPublic, setDayException, setHostAvailability, updateAppointmentType, updateCalendar,
} from "@/server/calendars/setup";
import type { Permission } from "@/lib/permissions";

// Calendar, appointment type, working hours and booking page settings. Every action resolves the actor on the server and the services
// enforce the real rules (calendar management for setup; your own hours and days off for everyone who can see the calendar).

const uuid = z.string().uuid({ error: "That item wasn't found." });
const orgArg = z.string().uuid().nullable().optional();

/** Revalidates the CRM pages the change shows on, for the client workspace and the agency's view of it. */
function refresh(actor: CrmActor) {
  revalidatePath("/crm", "layout");
  if (actor.kind === "agency") revalidatePath(`/admin/clients/${actor.orgId}/crm`, "layout");
}

async function act<T>(orgId: string | null | undefined, permission: Permission, fn: (actor: CrmActor) => Promise<T>, opts: { refresh?: boolean } = {}) {
  return guard(async () => {
    const actor = await resolveCrmActor(orgArg.parse(orgId) ?? null, permission);
    const out = await fn(actor);
    if (opts.refresh !== false) refresh(actor);
    return out;
  });
}

// ---------------------------------------------------------------------------
// Input shapes. Limits here are generous; the services give the precise, friendly messages.
// ---------------------------------------------------------------------------

const color = z.string().regex(/^#[0-9a-f]{6}$/, { error: "Choose a colour." }).nullable().optional();
const int = (max: number, error: string) => z.number({ error }).int({ error }).min(0, { error }).max(max, { error });

const calendarInput = z.object({
  name: z.string({ error: "Name the calendar." }).max(200, { error: "Calendar names are 1 to 80 characters." }),
  description: z.string().max(2000, { error: "Keep the description to 500 characters." }).nullable().optional(),
  assignment: z.enum(["single", "round_robin", "collective"], { error: "Choose how bookings are assigned." }).optional(),
  roundRobinMode: z.enum(["balanced", "priority"], { error: "Choose how round robin picks the next host." }).optional(),
  color,
  isDefault: z.boolean().optional(),
  public: z.boolean().optional(),
  bookingIntro: z.string().max(2000, { error: "Keep the booking page intro to 500 characters." }).nullable().optional(),
  members: z.array(z.object({ userId: uuid, priority: int(100, "Priority is 0 to 100.").optional() })).max(50, { error: "A calendar has at most 50 hosts." }).optional(),
  // A draft from a Blueprint: give hosts who have no weekly hours yet the calendar's suggested hours (see updateCalendar).
  useHoursTemplate: z.boolean().optional(),
});

const question = z.object({
  key: z.string().max(40, { error: "Each question needs its own short key." }),
  label: z.string().max(200, { error: "Each question needs a label of up to 120 characters." }),
  type: z.enum(["text", "textarea", "select"], { error: "Questions are short text, long text or a choice." }),
  required: z.boolean(),
  options: z.array(z.string().max(200, { error: "Each choice is 1 to 100 characters." })).max(20, { error: "A choice question needs 1 to 20 options." }).optional(),
});

const typeFields = {
  name: z.string({ error: "Name the appointment type." }).max(200, { error: "Name the appointment type (up to 80 characters)." }),
  description: z.string().max(4000, { error: "Keep the description to 1,000 characters." }).nullable().optional(),
  durationMinutes: int(720, "Length is 5 minutes to 12 hours."),
  slotIntervalMinutes: int(240, "Start times are offered every 5 to 240 minutes.").nullable().optional(),
  bufferBeforeMinutes: int(240, "Buffers are up to 4 hours.").optional(),
  bufferAfterMinutes: int(240, "Buffers are up to 4 hours.").optional(),
  minNoticeMinutes: int(43200, "Notice is up to 30 days.").optional(),
  maxDaysAhead: int(365, "Bookings open 1 to 365 days ahead.").optional(),
  dailyLimit: int(100, "The daily limit is 1 to 100.").nullable().optional(),
  capacity: int(500, "Group size is 1 to 500.").optional(),
  locationKind: z.enum(["phone", "video", "in_person", "custom", "none"], { error: "Choose where it happens." }).optional(),
  locationDetail: z.string().max(1000, { error: "Keep the location details to 300 characters." }).nullable().optional(),
  meetingProvider: z.enum(["none", "google_meet", "microsoft_teams", "custom_link"], { error: "Choose a meeting link option." }).optional(),
  meetingLink: z.string().max(500, { error: "Meeting links are up to 500 characters." }).nullable().optional(),
  requiresConfirmation: z.boolean().optional(),
  public: z.boolean().optional(),
  questions: z.array(question).max(10, { error: "Ask at most 10 extra questions." }).optional(),
  color,
  confirmationMessage: z.string().max(2000, { error: "Keep the confirmation message to 500 characters." }).nullable().optional(),
  allowCustomerChanges: z.boolean().optional(),
  changeCutoffMinutes: int(10080, "Customers can be stopped from changing a booking up to 7 days before it starts.").optional(),
  requireEmail: z.boolean().optional(),
  requirePhone: z.boolean().optional(),
};
const typeInput = z.object(typeFields);
const typePatch = z.object(typeFields).partial();

const minuteRange = z.object({ startMinute: int(1440, "Each range needs a start before its end, within one day."), endMinute: int(1440, "Each range needs a start before its end, within one day.") });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Choose a date." });

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

export async function createCalendarAction(orgId: string | null, input: z.input<typeof calendarInput>) {
  return act(orgId, "calendars.manage", (actor) => createCalendar(actor, calendarInput.parse(input)));
}

export async function updateCalendarAction(orgId: string | null, id: string, input: Partial<z.input<typeof calendarInput>>) {
  return act(orgId, "calendars.manage", (actor) => updateCalendar(actor, uuid.parse(id), calendarInput.partial().parse(input)));
}

export async function archiveCalendarAction(orgId: string | null, id: string) {
  return act(orgId, "calendars.manage", (actor) => archiveCalendar(actor, uuid.parse(id)));
}

export async function setCalendarPublicAction(orgId: string | null, id: string, isPublic: boolean) {
  return act(orgId, "calendars.manage", (actor) => setCalendarPublic(actor, uuid.parse(id), z.boolean().parse(isPublic)));
}

// ---------------------------------------------------------------------------
// Appointment types
// ---------------------------------------------------------------------------

export async function createAppointmentTypeAction(orgId: string | null, calendarId: string, input: z.input<typeof typeInput>) {
  return act(orgId, "calendars.manage", (actor) => createAppointmentType(actor, uuid.parse(calendarId), typeInput.parse(input)));
}

export async function updateAppointmentTypeAction(orgId: string | null, id: string, input: z.input<typeof typePatch>) {
  return act(orgId, "calendars.manage", (actor) => updateAppointmentType(actor, uuid.parse(id), typePatch.parse(input)));
}

export async function archiveAppointmentTypeAction(orgId: string | null, id: string) {
  return act(orgId, "calendars.manage", (actor) => archiveAppointmentType(actor, uuid.parse(id)));
}

export async function duplicateAppointmentTypeAction(orgId: string | null, id: string) {
  return act(orgId, "calendars.manage", (actor) => duplicateAppointmentType(actor, uuid.parse(id)));
}

export async function reorderAppointmentTypesAction(orgId: string | null, calendarId: string, ids: string[]) {
  return act(orgId, "calendars.manage", (actor) => reorderAppointmentTypes(actor, uuid.parse(calendarId), z.array(uuid).max(200).parse(ids)));
}

export async function setAppointmentTypePublicAction(orgId: string | null, id: string, isPublic: boolean) {
  return act(orgId, "calendars.manage", (actor) => setAppointmentTypePublic(actor, uuid.parse(id), z.boolean().parse(isPublic)));
}

// ---------------------------------------------------------------------------
// Working hours and days off. Anyone who can see the calendar manages their own; the service requires calendar management for others.
// ---------------------------------------------------------------------------

export async function setHostAvailabilityAction(orgId: string | null, userId: string, input: { timezone: string; accepting?: boolean; rules: Array<{ weekday: number; startMinute: number; endMinute: number }> }) {
  const parsed = z.object({
    timezone: z.string().min(1, { error: "Choose a valid time zone." }).max(64, { error: "Choose a valid time zone." }),
    accepting: z.boolean().optional(),
    rules: z.array(minuteRange.extend({ weekday: z.number().int().min(0).max(6) })).max(50, { error: "Too many time ranges." }),
  });
  return act(orgId, "appointments.view", (actor) => setHostAvailability(actor, uuid.parse(userId), parsed.parse(input)));
}

export async function setDayExceptionAction(orgId: string | null, input: { userId: string | null; date: string; windows: Array<{ startMinute: number; endMinute: number }> | null; reason?: string | null }) {
  const parsed = z.object({
    userId: uuid.nullable(),
    date: isoDate,
    windows: z.array(minuteRange).max(6, { error: "Use at most 6 time ranges in a day." }).nullable(),
    reason: z.string().max(500, { error: "Keep the reason to 120 characters." }).nullable().optional(),
  });
  return act(orgId, "appointments.view", (actor) => setDayException(actor, parsed.parse(input)));
}

export async function clearDayExceptionAction(orgId: string | null, input: { userId: string | null; date: string }) {
  return act(orgId, "appointments.view", (actor) => clearDayException(actor, z.object({ userId: uuid.nullable(), date: isoDate }).parse(input)));
}

export async function deleteAvailabilityOverrideAction(orgId: string | null, id: string) {
  return act(orgId, "appointments.view", (actor) => deleteAvailabilityOverride(actor, uuid.parse(id)));
}
