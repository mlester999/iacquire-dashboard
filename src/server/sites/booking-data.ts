import "server-only";
import type { Queryable } from "@/server/db";
import { isValidTimeZone } from "@/lib/calendars/slots";
import type { SiteBookingCalendar, SiteBookingData, SiteBookingType } from "@/lib/website/booking";
import { loadWorkspace } from "@/server/crm/workspace";

// A workspace's calendars and appointment types as website booking sees them. Nothing here opens a transaction or decides which workspace
// to read: the caller passes the database handle and the organization. Two callers do: the site runtime's trusted module
// (src/server/sites/booking-trusted.ts, for the workspace of a verified host) and the Website Studio's portal side
// (src/server/websites/booking-setup.ts, for a workspace the signed-in user was authorized for).

export interface TypeRow {
  id: string;
  calendar_id: string;
  slug: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  location_kind: string;
  location_detail: string | null;
  public: boolean;
  require_email: boolean;
  require_phone: boolean;
}
export interface CalendarRow {
  id: string;
  slug: string;
  name: string;
  is_default: boolean;
  public: boolean;
  booking_intro: string | null;
  assignment: "single" | "round_robin" | "collective";
  /** A draft (from a Blueprint, not verified yet) takes no bookings and is never public, so websites never offer it. */
  status: "draft" | "active";
  types: TypeRow[];
}
export interface WorkspaceBooking {
  orgId: string;
  orgName: string;
  timezone: string;
  callingCode: string | null;
  /** Appointments and contacts are both native, so a website booking can be taken here. */
  native: boolean;
  reason: string | null;
  /** Every live calendar and type, public or not. Public pages must only ever use what `siteData` keeps. */
  calendars: CalendarRow[];
}

export const clip = (v: string | null | undefined, n: number) => (v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim().slice(0, n);

export async function loadWorkspaceBooking(db: Queryable, orgId: string): Promise<WorkspaceBooking> {
  const org = (await db.query<{ name: string; timezone: string }>("select name, timezone from organizations where id = $1 and kind = 'client'", [orgId])).rows[0];
  const base = { orgId, orgName: org?.name ?? "", timezone: org?.timezone && isValidTimeZone(org.timezone) ? org.timezone : "UTC" };
  const ws = org ? await loadWorkspace(db, orgId).catch(() => null) : null;
  if (!ws) return { ...base, callingCode: null, native: false, reason: "This workspace has no CRM, so a website can't take bookings.", calendars: [] };
  if (ws.capabilities.appointments !== "native" || ws.capabilities.contacts !== "native") {
    const which = ws.capabilities.appointments !== "native" ? "Appointments are" : "Contacts are";
    return {
      ...base, callingCode: ws.defaultCallingCode, native: false, calendars: [],
      reason: `${which} managed in GoHighLevel for this workspace, so the website can't book into iAcquire. Move appointments and contacts to iAcquire CRM in Settings → CRM provider, or remove the booking element.`,
    };
  }
  const cals = await db.query<Omit<CalendarRow, "types">>(
    "select id, slug, name, is_default, public, booking_intro, assignment, status from crm_calendars where org_id = $1 and archived_at is null order by is_default desc, lower(name), created_at",
    [orgId],
  );
  const types = await db.query<TypeRow>(
    `select id, calendar_id, slug, name, description, duration_minutes, location_kind, location_detail, public, require_email, require_phone
     from crm_appointment_types where org_id = $1 and archived_at is null order by position, lower(name)`,
    [orgId],
  );
  return { ...base, callingCode: ws.defaultCallingCode, native: true, reason: null, calendars: cals.rows.map((c) => ({ ...c, types: types.rows.filter((t) => t.calendar_id === c.id) })) };
}

/** Where a type takes place, in words a visitor can act on. A video type's own link is never shown here; it is on the appointment. */
function publicLocation(t: Pick<TypeRow, "location_kind" | "location_detail">): string {
  switch (t.location_kind) {
    case "phone": return "Phone call";
    case "video": return "Video call";
    case "in_person": return t.location_detail ? `In person: ${clip(t.location_detail, 120)}` : "In person";
    case "custom": return clip(t.location_detail, 120);
    default: return "";
  }
}

const siteType = (t: TypeRow): SiteBookingType => ({ slug: t.slug, name: clip(t.name, 120), durationMinutes: t.duration_minutes, description: clip(t.description, 240), location: publicLocation(t) });

/** Whether visitors may book a calendar at all: public and active. A draft is never public; checking both keeps that true here too. */
const offered = (c: CalendarRow) => c.public && c.status === "active";

/** What visitors may see: public, active calendars that have at least one public type, and only those types. */
export function siteData(ws: WorkspaceBooking): SiteBookingData {
  if (!ws.native) return { available: false, calendars: [], reason: ws.reason };
  const calendars: SiteBookingCalendar[] = ws.calendars
    .filter(offered)
    .map((c) => ({ slug: c.slug, name: clip(c.name, 120), intro: clip(c.booking_intro, 500), isDefault: c.is_default, types: c.types.filter((t) => t.public).map(siteType) }))
    .filter((c) => c.types.length > 0);
  return { available: true, calendars, reason: calendars.length ? null : "There is no public calendar with a public appointment type yet. Make one public in CRM → Calendars & Types." };
}

/** The public calendar and type a visitor's slugs name, or null for anything outside the public set (missing, archived, private or draft alike). */
export function publicTarget(ws: WorkspaceBooking, calendarSlug: string, typeSlug: string): { calendar: CalendarRow; type: TypeRow } | null {
  if (!ws.native) return null;
  const calendar = ws.calendars.find((c) => c.slug === calendarSlug && offered(c));
  const type = calendar?.types.find((t) => t.slug === typeSlug && t.public);
  return calendar && type ? { calendar, type } : null;
}
