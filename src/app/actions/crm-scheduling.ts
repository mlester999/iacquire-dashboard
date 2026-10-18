"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import type { CrmActor } from "@/server/crm/actor";
import { resolveCrmActor } from "@/server/crm/request";
import { getAppointmentDetail, listBookableSlots, listRescheduleSlots } from "@/server/calendars/schedule";
import { bookNativeAppointment, cancelNativeAppointment, rescheduleNativeAppointment, setNativeAppointmentStatus } from "@/server/calendars/booking";
import type { Permission } from "@/lib/permissions";

// Server actions for the calendar workspace and the appointments list. Each one resolves the actor on the server (a client user acts on their
// own workspace; an agency person needs a support session for the client named), checks the permission, validates input, and calls the
// calendar services, which check again and do the work in one transaction.

const uuid = z.string().uuid();
const orgArg = z.string().uuid().nullable().optional();
const instant = z.string().datetime({ message: "Choose a time." });

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

const windowSchema = z.object({ from: instant, to: instant });

export async function appointmentDetailAction(orgId: string | null, id: string) {
  return act(orgId, "appointments.view", (actor) => getAppointmentDetail(actor, uuid.parse(id)), { refresh: false });
}

export async function bookableSlotsAction(orgId: string | null, input: { typeId: string; from: string; to: string; hostId?: string | null }) {
  return act(orgId, "appointments.book", (actor) => {
    const q = windowSchema.extend({ typeId: uuid, hostId: uuid.nullable().optional() }).parse(input);
    return listBookableSlots(actor, { typeId: q.typeId, from: new Date(q.from), to: new Date(q.to), hostId: q.hostId ?? null });
  }, { refresh: false });
}

export async function rescheduleSlotsAction(orgId: string | null, id: string, input: { from: string; to: string }) {
  return act(orgId, "appointments.manage", (actor) => {
    const q = windowSchema.parse(input);
    return listRescheduleSlots(actor, uuid.parse(id), { from: new Date(q.from), to: new Date(q.to) });
  }, { refresh: false });
}

const contactSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), id: uuid }),
  z.object({
    kind: z.literal("new"),
    firstName: z.string().trim().min(1, "Enter the customer's first name.").max(80, "First names are up to 80 characters."),
    lastName: z.string().trim().max(80, "Last names are up to 80 characters.").nullable().optional(),
    email: z.string().trim().max(254, "Email addresses are up to 254 characters.").refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Enter a valid email address.").nullable().optional(),
    phone: z.string().trim().max(40, "Phone numbers are up to 40 characters.").regex(/^[+0-9 ().-]*$/, "Phone numbers use digits, spaces and + ( ) - only.").nullable().optional(),
  }).refine((c) => Boolean(c.email?.trim() || c.phone?.trim()), { message: "Add an email address or a phone number for the customer.", path: ["email"] }),
]);

const bookSchema = z.object({
  typeId: uuid,
  startAt: instant,
  hostId: uuid.nullable().optional(),
  contact: contactSchema,
  answers: z.record(z.string().max(40), z.string().max(2000)).optional(),
  notes: z.string().max(2000, "Notes are up to 2,000 characters.").nullable().optional(),
  // A new key per dialog: submitting twice (a double click, a retry after a timeout) books once.
  idempotencyKey: z.string().regex(/^staff:[0-9a-f-]{36}$/i, "Reload and try again."),
});

export type StaffBookingRequest = z.input<typeof bookSchema>;

/** A person books for a customer. The customer's manage link is not returned here: staff never need it, and it is shown only to the customer. */
export async function bookAppointmentAction(orgId: string | null, input: StaffBookingRequest) {
  return act(orgId, "appointments.book", async (actor) => {
    const b = bookSchema.parse(input);
    const contact = b.contact.kind === "existing"
      ? { id: b.contact.id }
      : { firstName: b.contact.firstName, lastName: b.contact.lastName || null, email: b.contact.email?.trim() || null, phone: b.contact.phone?.trim() || null, source: "Booked by staff" };
    const r = await bookNativeAppointment(actor, {
      typeId: b.typeId, startAt: new Date(b.startAt), contact, answers: b.answers, notes: b.notes?.trim() || null, via: "staff", hostId: b.hostId ?? null, idempotencyKey: b.idempotencyKey,
    });
    return { appointmentId: r.appointmentId, status: r.status, hostIds: r.hostIds, created: r.created, startAt: r.startAt, endAt: r.endAt };
  });
}

/** Moves an appointment. The version it was read at is required, so a stale screen can't overwrite someone else's change. */
export async function rescheduleAppointmentAction(orgId: string | null, id: string, input: { startAt: string; expectedVersion: number }) {
  return act(orgId, "appointments.manage", (actor) => {
    const q = z.object({ startAt: instant, expectedVersion: z.number().int().min(1) }).parse(input);
    return rescheduleNativeAppointment(actor, uuid.parse(id), { startAt: new Date(q.startAt), by: "staff", expectedVersion: q.expectedVersion });
  });
}

export async function cancelAppointmentAction(orgId: string | null, id: string, reason?: string | null) {
  return act(orgId, "appointments.manage", (actor) => {
    const why = z.string().trim().max(300, "Keep the reason to 300 characters.").nullable().optional().parse(reason);
    return cancelNativeAppointment(actor, uuid.parse(id), { reason: why || null, by: "staff" });
  });
}

/** Confirms a booking that was waiting for a person, or records whether the customer came (only once it has started). */
export async function setAppointmentStatusAction(orgId: string | null, id: string, status: "confirmed" | "showed" | "noshow") {
  return act(orgId, "appointments.manage", async (actor) => {
    await setNativeAppointmentStatus(actor, uuid.parse(id), z.enum(["confirmed", "showed", "noshow"]).parse(status));
    return true;
  });
}
