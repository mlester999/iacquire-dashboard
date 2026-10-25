import { getWorkspace } from "@/server/crm/workspace";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { listAppointmentPage, listScheduleFilters } from "@/server/calendars/schedule";
import { addDays, zonedToInstant } from "@/lib/calendars/slots";
import { GhlOwnedNotice } from "@/components/crm/ghl-owned";
import { AppointmentsList } from "@/components/crm/scheduling/appointments-list";
import { parseListState, todayIn } from "@/components/crm/scheduling/calendar-math";

type SP = Record<string, string | string[] | undefined>;
const PAGE_SIZE = 25;
/** The longest date range the list accepts (the service's limit is 731 days). */
const MAX_RANGE_DAYS = 730;

/** The appointments list (/crm/appointments): upcoming, past or a date range, filtered and searchable by customer. */
export async function CrmAppointmentsView({ actor, scope, searchParams = {} }: { actor: CrmActor; scope: CrmScope; searchParams?: SP; id?: string }) {
  const ws = await getWorkspace(actor);
  if (ws.capabilities.appointments === "ghl") return <GhlOwnedNotice what="Appointments" agency={scope.agency} href="/appointments" />;
  const filters = await listScheduleFilters(actor);
  const tz = filters.orgTimezone;
  const state = parseListState(searchParams);
  if (state.calendarId && !filters.calendars.some((c) => c.id === state.calendarId)) state.calendarId = null;
  if (state.hostId && !filters.hosts.some((h) => h.id === state.hostId)) state.hostId = null;

  // Date ranges are whole days in the workspace's time zone, the end day included.
  let from: Date | null = null;
  let to: Date | null = null;
  let rangeError: string | null = null;
  if (state.when === "range" && state.from && state.to) {
    from = new Date(zonedToInstant(state.from, 0, tz));
    to = new Date(zonedToInstant(addDays(state.to, 1), 0, tz));
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
      rangeError = "Choose a date range of two years or less. Showing upcoming appointments instead.";
      Object.assign(state, { when: "upcoming", from: null, to: null });
      from = to = null;
    }
  }
  const load = (page: number) =>
    listAppointmentPage(actor, {
      when: state.when, from, to, page, pageSize: PAGE_SIZE, search: state.q,
      statuses: state.status === "all" ? undefined : [state.status],
      calendarIds: state.calendarId ? [state.calendarId] : undefined,
      hostIds: state.hostId ? [state.hostId] : undefined,
    });
  let result = await load(state.page);
  // Past the last page (after the data changed, say): show the last page that has rows.
  if (!result.items.length && result.total > 0 && state.page > 1) {
    state.page = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
    result = await load(state.page);
  }
  await auditSupportView(actor, "appointments", state.appointmentId ?? undefined);
  return (
    <>
      {rangeError && <p className="mb-3 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-[14px] text-warning-ink" role="alert">{rangeError}</p>}
      <AppointmentsList scope={scope} state={state} items={JSON.parse(JSON.stringify(result.items))} total={result.total} pageSize={result.pageSize} filters={filters} today={todayIn(tz)} />
    </>
  );
}
