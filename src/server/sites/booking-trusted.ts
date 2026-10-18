import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { computeSlots, loadBookingContext, type BookableSlot, type BookingContext } from "@/server/calendars/availability";
import { bookingPageActor, bookNativeAppointment, findByManageToken, type NativeBookingInput, type NativeBookingResult } from "@/server/calendars/booking";
import { loadWorkspaceBooking, type WorkspaceBooking } from "@/server/sites/booking-data";
import { isVerifiedSite, type LiveSite } from "@/server/sites/runtime";

// The ONLY place the public website runtime reaches the database with trusted (table-owner) access.
//
// Everything else a customer's site does runs as iaq_site_runtime, which has no table privileges (src/server/sites/runtime.ts). Booking
// can't: free times come from the native scheduling engine (hours, overrides, busy blocks, connected-calendar busy times, daily limits),
// and a booking creates a contact and an appointment through the same transaction staff and booking pages use. Rather than spread
// trusted access through the runtime, it is concentrated here, under these rules:
//
//  * Every function takes the LiveSite that resolveSite returned for the request's verified host, and refuses anything else at run time
//    (`isVerifiedSite`: an object resolveSite registered and froze). The workspace is always that site's orgId; nothing the browser sends
//    can name another one.
//  * Every query is scoped to that orgId, and what may be read is narrow: the workspace's calendars and types (public filtering happens
//    in siteData / publicTarget), slots for a type that is public in a public, active calendar, and an appointment only by its manage secret or by
//    an id the caller has already checked against a per-host signature.
//  * Reads that never write run in a READ ONLY transaction, so a bug there can't change data.
//  * The one write is bookNativeAppointment via "website", which itself refuses a type or calendar that isn't public and re-checks the
//    time inside its transaction.
//
// tests/website-booking-boundary.test.ts fails if any other file under src/app/site-runtime or src/server/sites imports trusted database
// access (withSystem, withUser, crmWrite) or the scheduling services that open it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The orgId of a site resolveSite really returned. Anything else is a programming error, never a visitor's input. */
function orgOf(site: LiveSite): string {
  if (!isVerifiedSite(site)) throw new Error("Website booking needs the site resolved from the request's verified host.");
  return site.orgId;
}

async function readOnly<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  return withSystem(async (db) => {
    await db.query("set transaction read only");
    return fn(db);
  });
}

/**
 * The site's workspace calendars and types (public or not; callers show only the public ones). Not read-only: reading a workspace for the
 * first time creates its CRM settings row, exactly as every other CRM read does.
 */
export async function siteWorkspaceBooking(site: LiveSite): Promise<WorkspaceBooking> {
  const orgId = orgOf(site);
  return withSystem((db) => loadWorkspaceBooking(db, orgId));
}

/** Free times for one booking context, within the window the visitor's page asked for. Customers' notice period always applies. */
export type SiteSlots = (q: { from: Date; to: Date; now: Date }) => Promise<BookableSlot[]>;

/**
 * Runs `fn` with a public type's booking context and its free times, in one read-only transaction. Null when the type isn't live and
 * public in a live public calendar of this site's workspace.
 */
export async function withSitePublicType<T>(site: LiveSite, typeId: string, fn: (ctx: BookingContext, slots: SiteSlots) => Promise<T>): Promise<T | null> {
  const orgId = orgOf(site);
  if (!UUID.test(typeId)) return null;
  return readOnly(async (db) => {
    // Public type, in a public and active (never draft) calendar of this workspace. loadBookingContext refuses drafts again.
    const exists = await db.query(
      `select 1 from crm_appointment_types t join crm_calendars c on c.id = t.calendar_id and c.org_id = t.org_id
       where t.id = $1 and t.org_id = $2 and t.archived_at is null and t.public and c.archived_at is null and c.public and c.status = 'active'`,
      [typeId, orgId],
    );
    if (!exists.rows[0]) return null;
    const ctx = await loadBookingContext(db, orgId, typeId);
    if (ctx.orgId !== orgId || !ctx.type.public || !ctx.calendar.public || ctx.calendar.status !== "active") return null;
    return fn(ctx, (q) => computeSlots(db, ctx, { from: q.from, to: q.to, now: q.now }));
  });
}

/** What the page after booking shows about an appointment of this site's workspace. */
export interface SiteAppointment {
  id: string;
  typeId: string;
  typeName: string;
  status: string;
  startAt: string;
  endAt: string;
  timezone: string;
  location: string | null;
  meetingLink: string | null;
  confirmationMessage: string | null;
  allowCustomerChanges: boolean;
}

async function typeExtras(db: Queryable, orgId: string, typeId: string) {
  const { rows } = await db.query<{ confirmation_message: string | null; allow_customer_changes: boolean }>(
    "select confirmation_message, allow_customer_changes from crm_appointment_types where id = $1 and org_id = $2",
    [typeId, orgId],
  );
  return { confirmationMessage: rows[0]?.confirmation_message ?? null, allowCustomerChanges: rows[0]?.allow_customer_changes !== false };
}

/** The appointment a customer's manage secret opens, only when it belongs to this site's workspace. */
export async function siteAppointmentByToken(site: LiveSite, token: string): Promise<SiteAppointment | null> {
  const orgId = orgOf(site);
  const m = await findByManageToken(token);
  if (!m || m.orgId !== orgId) return null;
  const extra = await readOnly((db) => typeExtras(db, orgId, m.typeId));
  return {
    id: m.id, typeId: m.typeId, typeName: m.typeName, status: m.status, startAt: m.startAt, endAt: m.endAt, timezone: m.timezone, location: m.location, meetingLink: m.meetingLink,
    confirmationMessage: extra.confirmationMessage, allowCustomerChanges: m.allowCustomerChanges,
  };
}

/**
 * A native appointment of this site's workspace by id. The caller must already have checked the id against the per-host signature it
 * issued after the booking (an id alone is never enough to see a booking).
 */
export async function siteAppointmentById(site: LiveSite, appointmentId: string): Promise<SiteAppointment | null> {
  const orgId = orgOf(site);
  if (!UUID.test(appointmentId)) return null;
  return readOnly(async (db) => {
    const { rows } = await db.query<{ id: string; type_id: string; type_name: string; status: string; start_at: Date; end_at: Date; invitee_timezone: string | null; timezone: string | null; location: string | null; meeting_link: string | null }>(
      `select a.id, t.id as type_id, t.name as type_name, a.status, a.start_at, a.end_at, a.invitee_timezone, a.timezone, a.location, a.meeting_link
       from appointment_refs a join crm_appointment_types t on t.id = a.appointment_type_id and t.org_id = a.org_id
       where a.id = $1 and a.org_id = $2 and a.provider = 'native'`,
      [appointmentId, orgId],
    );
    const r = rows[0];
    if (!r) return null;
    const extra = await typeExtras(db, orgId, r.type_id);
    return {
      id: r.id, typeId: r.type_id, typeName: r.type_name, status: r.status, startAt: new Date(r.start_at).toISOString(), endAt: new Date(r.end_at).toISOString(),
      timezone: r.invitee_timezone ?? r.timezone ?? "UTC", location: r.location, meetingLink: r.meeting_link, ...extra,
    };
  });
}

/** Books into this site's workspace as its booking page, via "website": only a public type in a public calendar, re-checked inside. */
export async function bookOnSite(site: LiveSite, input: Omit<NativeBookingInput, "via" | "hostId">): Promise<NativeBookingResult> {
  const orgId = orgOf(site);
  return bookNativeAppointment(await bookingPageActor(orgId), { ...input, via: "website" });
}
