"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { actionError } from "@/server/errors";
import { getAvailability } from "@/server/appointments/availability";
import { bookForContact, cancelPendingBooking } from "@/server/appointments/booking";
import { searchBookableContacts } from "@/server/appointments/overview";
import { policySchema, renewRemindersAuthorization, savePolicy } from "@/server/appointments/settings";
import { formatSlot } from "@/lib/appointments";

const uuid = z.string().uuid();

function fail(err: unknown) {
  if (err instanceof z.ZodError) return { ok: false as const, error: err.issues[0]?.message ?? "Check the form.", code: "invalid_input" as const };
  return actionError(err);
}

export async function searchContactsAction(query: string) {
  try {
    const ctx = await requireOrgContextOrThrow("appointments.book");
    return { ok: true as const, data: await searchBookableContacts(ctx, z.string().max(80).parse(query)) };
  } catch (err) {
    return fail(err);
  }
}

/** The calendar's real free times for the next two weeks, as the Appointment Setter sees them. Nothing is added to what the calendar reports. */
export async function loadSlotsAction() {
  try {
    const ctx = await requireOrgContextOrThrow("appointments.book");
    const now = new Date();
    const res = await getAvailability(ctx.org.orgId, { timeZone: ctx.org.timezone, limit: 60, perDay: 10, to: new Date(now.getTime() + 14 * 86_400_000) });
    if (!res.ok) return { ok: false as const, error: res.detail, code: "integration_unavailable" as const };
    return { ok: true as const, data: { calendarId: res.calendarId, timeZone: res.timeZone, checkedAt: res.checkedAt, slots: res.slots.map((s) => ({ start: s.start, label: formatSlot(s.start, res.timeZone) })) } };
  } catch (err) {
    return fail(err);
  }
}

const bookSchema = z.object({ contactId: uuid, startIso: z.string().datetime(), calendarId: z.string().max(80).nullable().optional() });

/** Books a time for a contact. The result says exactly what happened: booked, waiting for someone to add it by hand, or the time was taken. */
export async function bookAppointmentAction(input: z.input<typeof bookSchema>) {
  try {
    const ctx = await requireOrgContextOrThrow("appointments.book");
    const d = bookSchema.parse(input);
    const r = await bookForContact(ctx, { contactId: d.contactId, startAt: new Date(d.startIso), calendarId: d.calendarId ?? null });
    revalidatePath("/appointments");
    switch (r.status) {
      case "booked":
        return { ok: true as const, data: { outcome: "booked" as const } };
      case "needs_manual":
        return { ok: true as const, data: { outcome: "needs_manual" as const, message: r.reason } };
      case "awaiting_approval":
        return { ok: true as const, data: { outcome: "awaiting_approval" as const } };
      case "unavailable":
        return { ok: false as const, error: r.detail, code: "conflict" as const };
      default:
        return { ok: false as const, error: r.reason, code: "upstream_error" as const };
    }
  } catch (err) {
    return fail(err);
  }
}

export async function cancelBookingAction(bookingId: string) {
  try {
    const ctx = await requireOrgContextOrThrow("appointments.book");
    await cancelPendingBooking(ctx, uuid.parse(bookingId));
    revalidatePath("/appointments");
    return { ok: true as const };
  } catch (err) {
    return fail(err);
  }
}

export async function savePolicyAction(input: z.input<typeof policySchema>) {
  try {
    const ctx = await requireOrgContextOrThrow("appointments.manage");
    await savePolicy(ctx, input);
    revalidatePath("/appointments");
    return { ok: true as const };
  } catch (err) {
    return fail(err);
  }
}

export async function renewRemindersAction() {
  try {
    const ctx = await requireOrgContextOrThrow("appointments.manage");
    await renewRemindersAuthorization(ctx);
    revalidatePath("/appointments");
    return { ok: true as const };
  } catch (err) {
    return fail(err);
  }
}
