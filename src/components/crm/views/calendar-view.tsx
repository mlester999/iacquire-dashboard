import { redirect } from "next/navigation";
import { getWorkspace } from "@/server/crm/workspace";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { ACTIVE_STATUSES, getAppointmentDetail, getScheduleOverlay, listSchedule, listScheduleFilters, SCHEDULE_LIMIT, type HostOverlay } from "@/server/calendars/schedule";
import { AppError } from "@/server/errors";
import { zonedDate } from "@/lib/calendars/slots";
import { GhlOwnedNotice } from "@/components/crm/ghl-owned";
import { CalendarWorkspace } from "@/components/crm/scheduling/calendar-workspace";
import { calendarQuery, parseCalendarState, todayIn, viewRange } from "@/components/crm/scheduling/calendar-math";

type SP = Record<string, string | string[] | undefined>;

/** The calendar workspace (/crm/calendar). Notification links open an appointment here with ?appointment=<id>. */
export async function CalendarView({ actor, scope, searchParams = {} }: { actor: CrmActor; scope: CrmScope; searchParams?: SP; id?: string }) {
  const ws = await getWorkspace(actor);
  if (ws.capabilities.appointments === "ghl") return <GhlOwnedNotice what="Appointments" agency={scope.agency} href="/appointments" />;
  const filters = await listScheduleFilters(actor);
  const workspaceTimeZone = filters.orgTimezone;
  const state = parseCalendarState(searchParams, workspaceTimeZone);
  // A link to one appointment (from a notification) opens on the day it is booked for, unless the link names a date.
  if (state.appointmentId && !searchParams.date) {
    const linked = await getAppointmentDetail(actor, state.appointmentId).catch((err: unknown) => {
      if (err instanceof AppError && err.code === "not_found") return null;
      throw err;
    });
    if (linked) {
      state.date = zonedDate(new Date(linked.startAt).getTime(), state.timeZone);
      // A cancellation notice links to a cancelled appointment: show it on the calendar too.
      if (linked.status === "cancelled") state.showCancelled = true;
    }
  }
  // A calendar or person that no longer exists falls back to everyone, rather than an empty screen.
  if (state.calendarId && !filters.calendars.some((c) => c.id === state.calendarId)) state.calendarId = null;
  if (state.hostId && !filters.hosts.some((h) => h.id === state.hostId)) state.hostId = null;
  // The link then moves on to the address of what it shows, which names the day. Otherwise a refresh after the appointment is moved or
  // cancelled in the drawer would follow the link's rules again: jump to the new day, or tick "Show cancelled" by itself.
  if (state.appointmentId && !searchParams.date) redirect(`${scope.base}/calendar${calendarQuery(state, workspaceTimeZone, todayIn(state.timeZone))}`);
  const range = viewRange(state.view, state.date, state.timeZone);
  const timeView = state.view === "week" || state.view === "day";
  // Working hours and busy bands are one person's: the person filtered to, or the only host there is.
  const overlayHost = timeView ? state.hostId ?? (filters.hosts.length === 1 ? filters.hosts[0].id : null) : null;
  const [items, overlays] = await Promise.all([
    listSchedule(actor, {
      from: range.from, to: range.to, calendarIds: state.calendarId ? [state.calendarId] : undefined, hostIds: state.hostId ? [state.hostId] : undefined,
      statuses: state.showCancelled ? undefined : ACTIVE_STATUSES,
    }),
    overlayHost ? getScheduleOverlay(actor, { from: range.from, to: range.to, hostIds: [overlayHost] }) : Promise.resolve([] as HostOverlay[]),
  ]);
  await auditSupportView(actor, "calendar", state.appointmentId ?? undefined);
  const overlay = overlays[0] ?? null;
  const overlayNote = timeView && !overlay && filters.hosts.length > 1 ? "Choose one person to see their working hours and busy times." : null;
  return (
    <CalendarWorkspace
      scope={scope}
      state={state}
      workspaceTimeZone={workspaceTimeZone}
      today={todayIn(state.timeZone)}
      items={JSON.parse(JSON.stringify(items))}
      truncated={items.length >= SCHEDULE_LIMIT}
      filters={filters}
      overlay={overlay}
      overlayNote={overlayNote}
    />
  );
}
