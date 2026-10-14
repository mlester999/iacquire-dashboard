import "server-only";
import { withSystem } from "@/server/db";
import { env } from "@/server/env";
import { loadGhlMapping } from "@/server/integrations/ghl";
import { dateWindows, parseFreeSlots, type Slot } from "@/lib/appointments";

// Contract sources: GoHighLevel's published OpenAPI spec for calendars (read 2026-10-14):
//   GET  /calendars/{calendarId}/free-slots   Version 2021-04-15, startDate/endDate in epoch ms (at most 31 days), optional timezone
//   POST /calendars/events/appointments       scope calendars/events.write, required calendarId, locationId, contactId, startTime
//   PUT  /calendars/events/appointments/{id}  scope calendars/events.write
// Nothing here has been exercised against a live GoHighLevel location. Reading availability is allowed; writing is off unless
// GHL_WRITES_ENABLED=true, and the location always comes from the tenant's own server-side mapping, never from a request.

const VERSION = "2021-04-15";
const ID = /^[A-Za-z0-9_-]{6,80}$/;

export type FreeSlotsResult =
  | { ok: true; slots: Slot[] }
  | { ok: false; reason: "not_connected" | "calendar_not_mapped" | "rejected" | "rate_limited" | "unavailable" | "unsupported"; detail: string };

export interface CreateRequest {
  orgId: string;
  calendarId: string;
  contactRef: string;
  startAt: Date;
  endAt: Date;
  title: string;
  assignedUserId?: string | null;
}
export type CreateResult =
  | { ok: true; appointmentId: string; status: string }
  | { ok: false; retryable: boolean; error: string; blocked?: boolean; reconnectRequired?: boolean; slotTaken?: boolean };

export interface AppointmentProvider {
  name: string;
  freeSlots(req: { orgId: string; calendarId: string; from: Date; to: Date; timeZone: string }): Promise<FreeSlotsResult>;
  create(req: CreateRequest): Promise<CreateResult>;
  update(req: { orgId: string; appointmentId: string; status?: "cancelled" | "confirmed"; startAt?: Date; endAt?: Date; calendarId?: string }): Promise<{ ok: true } | { ok: false; error: string; blocked?: boolean; slotTaken?: boolean }>;
}

function base(): URL | null {
  const u = new URL(env().GHL_API_BASE);
  return u.origin === "https://services.leadconnectorhq.com" ? u : null;
}

export const ghlAppointmentProvider: AppointmentProvider = {
  name: "ghl",

  async freeSlots({ orgId, calendarId, from, to, timeZone }) {
    const mapping = await withSystem((db) => loadGhlMapping(db, orgId)).catch(() => null);
    if (!mapping) return { ok: false, reason: "not_connected", detail: "The calendar isn't connected for this workspace." };
    // The calendar must be one this workspace has mapped; an id from anywhere else is never sent to the provider.
    if (!ID.test(calendarId) || !mapping.calendarIds.includes(calendarId)) return { ok: false, reason: "calendar_not_mapped", detail: "That calendar isn't connected to this workspace." };
    const root = base();
    if (!root) return { ok: false, reason: "unavailable", detail: "GoHighLevel must use the official API host." };
    const slots = new Map<string, Slot>();
    for (const w of dateWindows(from, to)) {
      const url = new URL(`/calendars/${calendarId}/free-slots`, root);
      url.searchParams.set("startDate", String(w.from.getTime()));
      url.searchParams.set("endDate", String(w.to.getTime()));
      url.searchParams.set("timezone", timeZone);
      let res: Response;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${mapping.token}`, Version: VERSION, Accept: "application/json" }, signal: AbortSignal.timeout(15000), redirect: "error", cache: "no-store" });
      } catch {
        return { ok: false, reason: "unavailable", detail: "GoHighLevel could not be reached, so real availability can't be shown right now." };
      }
      if (res.status === 401 || res.status === 403) return { ok: false, reason: "rejected", detail: "GoHighLevel rejected the credential or its calendar permissions." };
      if (res.status === 429) return { ok: false, reason: "rate_limited", detail: "GoHighLevel rate limit reached. Try again shortly." };
      if (!res.ok) return { ok: false, reason: "unavailable", detail: `GoHighLevel returned ${res.status}.` };
      const parsed = parseFreeSlots(await res.json().catch(() => null), 0);
      // Slot length comes from the calendar's own configuration in the provider; the portal only knows the start of each free slot here.
      if (!parsed) return { ok: false, reason: "unsupported", detail: "GoHighLevel returned availability in a shape the portal does not recognise." };
      for (const s of parsed) slots.set(s.start, s);
    }
    return { ok: true, slots: [...slots.values()].sort((a, b) => a.start.localeCompare(b.start)) };
  },

  async create(req) {
    if (!env().GHL_WRITES_ENABLED) return { ok: false, retryable: false, blocked: true, error: "Booking through GoHighLevel is switched off for this environment." };
    const mapping = await withSystem((db) => loadGhlMapping(db, req.orgId)).catch(() => null);
    if (!mapping) return { ok: false, retryable: false, blocked: true, reconnectRequired: true, error: "GoHighLevel is not connected for this workspace." };
    if (!mapping.calendarIds.includes(req.calendarId)) return { ok: false, retryable: false, blocked: true, error: "That calendar isn't connected to this workspace." };
    const root = base();
    if (!root) return { ok: false, retryable: false, blocked: true, error: "GoHighLevel must use the official API host." };
    let res: Response;
    try {
      res = await fetch(new URL("/calendars/events/appointments", root), {
        method: "POST",
        headers: { Authorization: `Bearer ${mapping.token}`, Version: VERSION, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          calendarId: req.calendarId,
          locationId: mapping.locationId,
          contactId: req.contactRef,
          startTime: req.startAt.toISOString(),
          endTime: req.endAt.toISOString(),
          title: req.title.slice(0, 200),
          appointmentStatus: "confirmed",
          ...(req.assignedUserId ? { assignedUserId: req.assignedUserId } : {}),
          // The provider must check the slot itself, and must not message the customer: the portal sends its own gated confirmation.
          ignoreFreeSlotValidation: false,
          ignoreDateRange: false,
          toNotify: false,
        }),
        signal: AbortSignal.timeout(20000),
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      // A timeout can mean the booking was made. It is not retried; the calendar's own event (or its absence) settles it.
      return { ok: false, retryable: false, error: "GoHighLevel could not be reached. The booking was not confirmed." };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, retryable: false, reconnectRequired: true, error: "GoHighLevel rejected the credential or its permissions." };
    if (res.status === 429) return { ok: false, retryable: true, error: "GoHighLevel rate limit reached." };
    if (res.status === 400 || res.status === 409 || res.status === 422) return { ok: false, retryable: false, slotTaken: true, error: "GoHighLevel did not accept that time. It is probably no longer free." };
    if (res.status >= 500) return { ok: false, retryable: false, error: `GoHighLevel returned ${res.status}. The booking was not confirmed.` };
    if (!res.ok) return { ok: false, retryable: false, error: `GoHighLevel refused the booking (${res.status}).` };
    const body: unknown = await res.json().catch(() => null);
    const id = body && typeof body === "object" ? (body as { id?: unknown }).id : null;
    if (typeof id !== "string" || !ID.test(id)) return { ok: false, retryable: false, error: "GoHighLevel did not confirm the booking." };
    const status = typeof (body as { appointmentStatus?: unknown }).appointmentStatus === "string" ? (body as { appointmentStatus: string }).appointmentStatus : "confirmed";
    return { ok: true, appointmentId: id, status };
  },

  async update(req) {
    if (!env().GHL_WRITES_ENABLED) return { ok: false, blocked: true, error: "Changing appointments through GoHighLevel is switched off for this environment." };
    const mapping = await withSystem((db) => loadGhlMapping(db, req.orgId)).catch(() => null);
    const root = base();
    if (!mapping || !root || !ID.test(req.appointmentId)) return { ok: false, blocked: true, error: "GoHighLevel is not connected for this workspace." };
    if (req.calendarId && !mapping.calendarIds.includes(req.calendarId)) return { ok: false, blocked: true, error: "That calendar isn't connected to this workspace." };
    try {
      const res = await fetch(new URL(`/calendars/events/appointments/${req.appointmentId}`, root), {
        method: "PUT",
        headers: { Authorization: `Bearer ${mapping.token}`, Version: VERSION, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          ...(req.status ? { appointmentStatus: req.status } : {}),
          ...(req.startAt ? { startTime: req.startAt.toISOString() } : {}),
          ...(req.endAt ? { endTime: req.endAt.toISOString() } : {}),
          ignoreFreeSlotValidation: false,
          toNotify: false,
        }),
        signal: AbortSignal.timeout(20000),
        redirect: "error",
        cache: "no-store",
      });
      if (res.ok) return { ok: true };
      if (res.status === 400 || res.status === 409 || res.status === 422) return { ok: false, slotTaken: true, error: "GoHighLevel did not accept that change." };
      return { ok: false, error: `GoHighLevel refused the change (${res.status}).` };
    } catch {
      return { ok: false, error: "GoHighLevel could not be reached. The change was not confirmed." };
    }
  },
};
