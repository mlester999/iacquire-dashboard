import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { bookingElements, bookingRefs, defaultCalendar, type BookingOptions } from "@/lib/website/booking";
import type { SiteContent } from "@/lib/website/doc";
import type { Issue } from "@/lib/website/lint";
import { computeSlots, loadBookingContext } from "@/server/calendars/availability";
import { loadWorkspaceBooking, siteData, type CalendarRow } from "@/server/sites/booking-data";

// The Website Studio's side of the booking element (portal, not the public runtime): the editor's calendar and type pickers, and the
// publish check. Callers have already authorized the signed-in user for `orgId` (studioContext / the publish flow), which is why these
// may read every calendar, public or not.

/** Every live calendar and type for the editor's pickers (public or not), plus what a live page would draw. The caller has authorized the editor. */
export async function bookingOptionsFor(orgId: string, opts: { agency: boolean }): Promise<BookingOptions> {
  const ws = await withSystem((db) => loadWorkspaceBooking(db, orgId));
  const site = siteData(ws);
  return {
    unavailable: ws.native ? site.reason ?? null : ws.reason,
    calendars: ws.calendars.map((c) => ({
      slug: c.slug, name: c.name, isDefault: c.is_default, public: c.public,
      types: c.types.map((t) => ({ slug: t.slug, name: t.name, durationMinutes: t.duration_minutes, public: t.public })),
    })),
    site,
    manageHref: opts.agency ? `/admin/clients/${orgId}/crm/calendars` : "/crm/calendars",
  };
}

/**
 * What stops a site with booking elements from publishing: appointments or contacts managed in GoHighLevel, an element whose calendar or
 * type is missing, archived or private, or a calendar that could never offer a time (no active host, everyone paused, no weekly hours).
 * A type with no open time in the next 30 days (fully booked, holidays) is only a warning: the site works, it just shows no times yet.
 */
export async function bookingReadiness(orgId: string, content: SiteContent, now = new Date()): Promise<{ blockers: Issue[]; warnings: Issue[] }> {
  const els = bookingElements(content);
  const blockers: Issue[] = [];
  const warnings: Issue[] = [];
  if (!els.length) return { blockers, warnings };
  return withSystem(async (db) => {
    const ws = await loadWorkspaceBooking(db, orgId);
    if (!ws.native) {
      blockers.push({ code: "booking_unavailable", message: ws.reason ?? "This workspace can't take website bookings.", where: `${els[0].where} › Book appointment`, nodeId: els[0].el.id });
      return { blockers, warnings };
    }
    const site = siteData(ws);
    const offered = new Map<string, { name: string; where: string; nodeId: string }>();
    const hosting = new Map<string, string | null>();
    for (const { el, where } of els) {
      const at = `${where} › Book appointment`;
      const { calendar, type } = bookingRefs(el);
      const add = (code: string, message: string) => blockers.push({ code, message, where: at, nodeId: el.id });
      let cal: CalendarRow | undefined;
      if (!calendar) {
        const def = defaultCalendar(site);
        if (!def) {
          add("booking_no_calendar", "There is no public calendar to book into. In CRM → Calendars & Types, make a calendar and at least one of its appointment types public, or remove this booking element.");
          continue;
        }
        cal = ws.calendars.find((c) => c.slug === def.slug);
      } else {
        cal = ws.calendars.find((c) => c.slug === calendar);
        if (!cal) {
          add("booking_calendar_missing", `The calendar this booking element uses ("${calendar}") no longer exists. Choose another calendar.`);
          continue;
        }
        if (cal.status === "draft") {
          add("booking_calendar_draft", `"${cal.name}" is a draft calendar, so it takes no bookings. Verify and activate it in CRM → Calendars & Types, or choose another calendar.`);
          continue;
        }
        if (!cal.public) {
          add("booking_calendar_private", `"${cal.name}" is a private calendar, so visitors can't book it. Make it public in CRM → Calendars & Types, or choose another calendar.`);
          continue;
        }
      }
      if (!cal) continue;
      let types = cal.types.filter((t) => t.public);
      if (type) {
        const t = cal.types.find((x) => x.slug === type);
        if (!t) {
          add("booking_type_missing", `The appointment type this element offers ("${type}") no longer exists in "${cal.name}". Choose another type.`);
          continue;
        }
        if (!t.public) {
          add("booking_type_private", `"${t.name}" is private, so visitors can't book it. Make it public in CRM → Calendars & Types, or choose another type.`);
          continue;
        }
        types = [t];
      } else if (!types.length) {
        add("booking_no_types", `"${cal.name}" has no public appointment types. Make one public, or choose another calendar.`);
        continue;
      }
      if (!hosting.has(cal.id)) hosting.set(cal.id, await whyNoHosts(db, orgId, cal));
      const noHosts = hosting.get(cal.id);
      if (noHosts) {
        add("booking_no_hosts", noHosts);
        continue;
      }
      for (const t of types) if (!offered.has(t.id)) offered.set(t.id, { name: t.name, where: at, nodeId: el.id });
    }
    // Checking for open times is a courtesy; it is bounded so a site with many types still publishes quickly.
    for (const [typeId, info] of [...offered.entries()].slice(0, 12)) {
      const ctx = await loadBookingContext(db, orgId, typeId);
      const slots = await computeSlots(db, ctx, { from: now, to: new Date(now.getTime() + 30 * 86_400_000), now });
      if (!slots.length) warnings.push({ code: "booking_no_times", message: `Nobody is free to take "${info.name}" in the next 30 days, so visitors would see no times. Check the hosts' working hours in CRM → Availability.`, where: info.where, nodeId: info.nodeId });
    }
    return { blockers, warnings };
  });
}

/**
 * Why nobody could ever be offered a time in this calendar, or null. The same rules as the Booking Pages screen and as availability itself:
 * a one-person calendar needs its first accepting host to have weekly hours, round robin needs any accepting host with hours, collective
 * needs every accepting host to have them.
 */
async function whyNoHosts(db: Queryable, orgId: string, cal: CalendarRow): Promise<string | null> {
  const { rows } = await db.query<{ name: string; accepting: boolean; has_hours: boolean }>(
    `select coalesce(nullif(u.full_name, ''), u.email::text) as name, coalesce(h.accepting, true) as accepting,
            exists (select 1 from crm_availability_rules r where r.org_id = cm.org_id and r.user_id = cm.user_id) as has_hours
     from crm_calendar_members cm join organization_memberships m on m.org_id = cm.org_id and m.user_id = cm.user_id and m.status = 'active'
     join users u on u.id = cm.user_id and u.status = 'active'
     left join crm_host_settings h on h.org_id = cm.org_id and h.user_id = cm.user_id
     where cm.org_id = $1 and cm.calendar_id = $2 and cm.active order by cm.priority desc, cm.created_at`,
    [orgId, cal.id],
  );
  if (!rows.length) return `Nobody takes bookings for "${cal.name}". Add a host to it in CRM → Calendars & Types.`;
  const accepting = rows.filter((r) => r.accepting);
  if (!accepting.length) return `Everyone on "${cal.name}" has paused new bookings, so visitors couldn't book it.`;
  const need = cal.assignment === "single" ? accepting.slice(0, 1) : cal.assignment === "collective" ? accepting : accepting.some((r) => r.has_hours) ? [] : accepting;
  const missing = need.filter((r) => !r.has_hours).map((r) => r.name);
  if (!missing.length) return null;
  return `${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""} ${missing.length === 1 ? "has" : "have"} no weekly hours, so "${cal.name}" can't offer any times. Set hours in CRM → Availability.`;
}
