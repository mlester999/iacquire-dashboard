"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarPlus, ChevronLeft, ChevronRight, Info, ListChecks, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, Input, Select } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { rescheduleAppointmentAction, rescheduleSlotsAction } from "@/app/actions/crm-scheduling";
import { ConfirmDialog, PageTitle, useCrmAction } from "@/components/crm/ui";
import {
  CALENDAR_VIEW_LABELS, CALENDAR_VIEWS, calendarQuery, formatDay, isDateKey, rangeLabel, shiftDate, viewDays, type CalendarState, type CalendarViewMode,
} from "@/components/crm/scheduling/calendar-math";
import { colorFor, dateTimeIn, zoneCity, zoneOffset } from "@/components/crm/scheduling/format";
import { ColorDot, replaceAddress, useBrowserTimeZone, useDrawerLink, useNow } from "@/components/crm/scheduling/bits";
import { TimeGrid } from "@/components/crm/scheduling/time-grid";
import { MonthGrid } from "@/components/crm/scheduling/month-grid";
import { AgendaList } from "@/components/crm/scheduling/agenda-list";
import { AppointmentDrawer } from "@/components/crm/scheduling/appointment-drawer";
import { NewAppointmentDialog } from "@/components/crm/scheduling/new-appointment-dialog";
import { RescheduleDialog } from "@/components/crm/scheduling/reschedule-dialog";
import type { HostOverlay, ScheduleFilters, ScheduleItem, StaffSlot } from "@/server/calendars/schedule";
import type { CrmScope } from "@/server/crm/page";
import { permissionNeeded } from "@/lib/permissions";

/**
 * The calendar workspace: month, week, day and agenda views of native appointments, filtered by calendar and person, in the workspace's
 * time zone or the viewer's own. Everything shown is a real booking; free/busy shading appears only for one person at a time.
 */
export function CalendarWorkspace({
  scope, state, workspaceTimeZone, today, items, truncated, filters, overlay, overlayNote,
}: {
  scope: CrmScope;
  state: CalendarState;
  workspaceTimeZone: string;
  today: string;
  items: ScheduleItem[];
  truncated: boolean;
  filters: ScheduleFilters;
  overlay: HostOverlay | null;
  overlayNote: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = React.useTransition();
  const { run, busy } = useCrmAction();
  // Following a link to an appointment (a notification, say) opens it, even the same one again after its drawer was closed.
  const [openId, setOpenId] = useDrawerLink(state);
  const [newOpen, setNewOpen] = React.useState(false);
  const [move, setMove] = React.useState<{ item: ScheduleItem; slot: StaffSlot } | null>(null);
  const [pick, setPick] = React.useState<{ item: ScheduleItem; date: string } | null>(null);
  const [checking, setChecking] = React.useState(false);
  const now = useNow();
  const browserTz = useBrowserTimeZone();
  const tz = state.timeZone;
  const canBook = !!scope.can["appointments.book"] && !scope.readOnly;
  const canManage = !!scope.can["appointments.manage"] && !scope.readOnly;
  const hasTypes = filters.calendars.some((c) => c.types.length);
  const hostNames = React.useMemo(() => Object.fromEntries(filters.hosts.map((h) => [h.id, h.name])), [filters.hosts]);
  const days = viewDays(state.view, state.date);

  const go = (changes: Partial<CalendarState>) => {
    const next = { ...state, ...changes, appointmentId: openId };
    startTransition(() => router.push(`${pathname}${calendarQuery(next, workspaceTimeZone, today)}`, { scroll: false }));
  };
  const open = (id: string) => {
    setOpenId(id);
    replaceAddress(`${pathname}${calendarQuery({ ...state, appointmentId: id }, workspaceTimeZone, today)}`);
  };
  const close = () => {
    setOpenId(null);
    replaceAddress(`${pathname}${calendarQuery({ ...state, appointmentId: null }, workspaceTimeZone, today)}`);
  };

  // A drag proposes a time; only a time the server would accept is offered for confirmation, anything else opens the picker on that day.
  const onMove = async (item: ScheduleItem, start: Date, day: string) => {
    setChecking(true);
    try {
      const from = new Date(start.getTime() - 12 * 3_600_000).toISOString();
      const to = new Date(start.getTime() + 12 * 3_600_000).toISOString();
      const res = await rescheduleSlotsAction(scope.orgId, item.id, { from, to });
      if (!res.ok) return void toast.error(res.error);
      const slot = res.data.find((s) => new Date(s.start).getTime() === start.getTime());
      if (slot) setMove({ item, slot });
      else {
        toast("That time isn't free for this appointment. Choose one of the free times.");
        setPick({ item, date: day });
      }
    } catch {
      toast.error("Free times couldn't be checked. Check your connection and try again.");
    } finally {
      setChecking(false);
    }
  };

  const zones = Array.from(new Set([workspaceTimeZone, ...(browserTz ? [browserTz] : []), tz]));
  const zoneLabel = (z: string) => `${zoneCity(z)} (${zoneOffset(z, Date.parse(`${state.date}T12:00:00Z`))})${z === workspaceTimeZone ? " · workspace" : z === browserTz ? " · yours" : ""}`;
  const legend = React.useMemo(() => {
    const m = new Map<string, { id: string; name: string; color: string }>();
    for (const a of items) if (a.type) m.set(a.type.id, { id: a.type.id, name: a.type.name, color: colorFor(a) });
    return [...m.values()].slice(0, 12);
  }, [items]);
  const isTimeView = state.view === "week" || state.view === "day";
  // New bookings start from the day in view: today when it's shown, otherwise the first day ahead.
  const bookDate = days.includes(today) ? (state.view === "day" ? state.date : today) : days[0] > today ? (state.view === "day" ? state.date : days[0]) : today;

  return (
    <div className="space-y-4">
      <PageTitle
        title="Calendar"
        description="Every appointment booked in iAcquire: from booking pages, your team and your AI employees."
        actions={
          <>
            <Link href={`${scope.base}/appointments`} className="inline-flex h-11 items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-2 sm:h-9"><ListChecks className="size-4" aria-hidden />All appointments</Link>
            {canBook && hasTypes && <Button data-aqi-target="crm.calendar.new-appointment" onClick={() => setNewOpen(true)}><Plus className="size-4" />New appointment</Button>}
          </>
        }
      />

      {!filters.calendars.length && (
        <div className="flex flex-wrap items-start gap-3 rounded-2xl border border-line bg-surface-2/60 px-4 py-3 text-[13px] text-ink-2">
          <CalendarPlus className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <p className="min-w-0 flex-1">No calendars yet. {scope.can["calendars.manage"] && !scope.readOnly ? "Create one with its appointment types, then set working hours, and bookings will appear here." : scope.readOnly ? "Bookings will appear here once the workspace has calendars." : permissionNeeded("Creating calendars and appointment types", "calendars.manage")}</p>
          {scope.can["calendars.manage"] && !scope.readOnly && <Link href={`${scope.base}/calendars`} className="font-medium text-primary hover:underline">Set up calendars</Link>}
        </div>
      )}

      <Card className="overflow-hidden" data-aqi-target="crm.calendar.grid">
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3 sm:p-4">
          <div className="flex items-center gap-1">
            <Button variant="secondary" size="sm" onClick={() => go({ date: today })}>Today</Button>
            <Button variant="ghost" size="icon-sm" aria-label={`Previous ${state.view === "agenda" ? "30 days" : state.view}`} onClick={() => go({ date: shiftDate(state.view, state.date, -1) })}><ChevronLeft className="size-4" /></Button>
            <Button variant="ghost" size="icon-sm" aria-label={`Next ${state.view === "agenda" ? "30 days" : state.view}`} onClick={() => go({ date: shiftDate(state.view, state.date, 1) })}><ChevronRight className="size-4" /></Button>
          </div>
          <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-ink" aria-live="polite">
            {rangeLabel(state.view, state.date)}
            {(pending || checking) && <Loader2 className="ml-2 inline size-4 animate-spin text-muted" aria-label="Loading" />}
          </h3>
          <label className="sr-only" htmlFor="cal-goto">Go to date</label>
          <Input id="cal-goto" type="date" className="h-11 w-[10.5rem] sm:h-9" value={state.date} onChange={(e) => isDateKey(e.target.value) && go({ date: e.target.value })} />
          <Segmented<CalendarViewMode> id="cal-view" ariaLabel="View" size="sm" value={state.view} onChange={(v) => go({ view: v })} options={CALENDAR_VIEWS.map((v) => ({ value: v, label: CALENDAR_VIEW_LABELS[v] }))} />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2/40 px-3 py-2.5 sm:px-4">
          <label className="sr-only" htmlFor="cal-calendar">Calendar</label>
          <Select id="cal-calendar" className="w-auto min-w-[10rem] max-w-full" value={state.calendarId ?? ""} onChange={(e) => go({ calendarId: e.target.value || null })}>
            <option value="">All calendars</option>
            {filters.calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <label className="sr-only" htmlFor="cal-host">Person</label>
          <Select id="cal-host" className="w-auto min-w-[10rem] max-w-full" value={state.hostId ?? ""} onChange={(e) => go({ hostId: e.target.value || null })}>
            <option value="">Everyone</option>
            {filters.hosts.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </Select>
          {/* Long names would otherwise widen a select past the card on a phone; the label wraps above its select when space runs out. */}
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1">
            <label htmlFor="cal-tz" className="whitespace-nowrap text-[12.5px] text-muted">Show times in</label>
            <Select id="cal-tz" className="w-auto max-w-full" value={tz} onChange={(e) => go({ timeZone: e.target.value })}>
              {zones.map((z) => <option key={z} value={z}>{zoneLabel(z)}</option>)}
            </Select>
          </div>
          <label className="ml-auto inline-flex min-h-11 cursor-pointer items-center gap-2 text-[12.5px] text-ink-2 sm:min-h-8">
            <input type="checkbox" className="size-4 accent-[var(--color-primary)]" checked={state.showCancelled} onChange={(e) => go({ showCancelled: e.target.checked })} />
            Show cancelled
          </label>
        </div>

        <div className={cn("transition-opacity", pending && "opacity-60")} aria-busy={pending || undefined}>
          {isTimeView ? (
            <TimeGrid
              days={days}
              timeZone={tz}
              today={today}
              now={now}
              items={items}
              overlay={overlay}
              canDrag={canManage}
              onOpen={open}
              onMove={onMove}
              onOpenDay={(d) => go({ view: "day", date: d })}
            />
          ) : state.view === "month" ? (
            <MonthGrid days={days} month={state.date.slice(0, 7)} today={today} timeZone={tz} items={items} onOpen={open} onOpenDay={(d) => go({ view: "day", date: d })} />
          ) : (
            <AgendaList
              days={days}
              today={today}
              timeZone={tz}
              items={items}
              onOpen={open}
              emptyAction={canBook && hasTypes ? <Button variant="secondary" onClick={() => setNewOpen(true)}><Plus className="size-4" />New appointment</Button> : undefined}
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-3 py-2.5 text-[12px] text-muted sm:px-4">
          {legend.map((l) => <span key={l.id} className="inline-flex items-center gap-1.5"><ColorDot color={l.color} />{l.name}</span>)}
          <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-3 w-4 rounded-sm border border-dashed border-ink-2" />Unconfirmed</span>
          {isTimeView && overlay && <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-3 w-4 rounded-sm bg-surface-2 ring-1 ring-line" />Outside {overlay.name}&apos;s hours</span>}
          {isTimeView && overlay && overlay.busy.length > 0 && <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-3 w-4 rounded-sm bg-[repeating-linear-gradient(135deg,transparent_0_3px,var(--color-line-strong)_3px_4px)] ring-1 ring-line" />Busy in a connected calendar</span>}
          {canManage && isTimeView && <span className="hidden sm:inline">Drag an appointment to move it, or open it and choose Reschedule.</span>}
        </div>
      </Card>

      {(truncated || (isTimeView && overlayNote) || (isTimeView && overlay && !overlay.accepting)) && (
        <p className="flex items-start gap-2 text-[12.5px] text-muted" role="status">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {truncated ? "Only the first 2,000 appointments in this range are shown. Choose a calendar or a person to see the rest. " : ""}
            {isTimeView && overlay && !overlay.accepting ? `${overlay.name} isn't taking bookings at the moment. ` : ""}
            {isTimeView && overlayNote ? overlayNote : ""}
          </span>
        </p>
      )}

      {openId && <AppointmentDrawer key={openId} scope={scope} appointmentId={openId} timeZone={tz} today={today} hostNames={hostNames} onClose={close} />}

      {newOpen && (
        <NewAppointmentDialog
          scope={scope}
          filters={filters}
          timeZone={tz}
          today={today}
          defaultDate={bookDate}
          onClose={() => setNewOpen(false)}
          onBooked={open}
        />
      )}

      {move && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setMove(null)}
          title="Move this appointment?"
          description={
            <>
              {move.item.contact?.name ?? move.item.title}: from {dateTimeIn(move.item.startAt, tz)} to {dateTimeIn(move.slot.start, tz)}.
              {move.slot.keepsHost === false && move.slot.hostIds[0] ? ` It will be with ${hostNames[move.slot.hostIds[0]] ?? "another host"}, because the current host isn't free then.` : ""} Hosts are notified and any reminders move with it.
            </>
          }
          confirmLabel="Move appointment"
          loading={busy("drag-move")}
          onConfirm={async () => {
            const m = move;
            const r = await run("drag-move", () => rescheduleAppointmentAction(scope.orgId, m.item.id, { startAt: m.slot.start, expectedVersion: m.item.version }), `Moved to ${dateTimeIn(m.slot.start, tz)}.`);
            if (r) setMove(null);
          }}
        />
      )}

      {pick && (
        <RescheduleDialog
          scope={scope}
          appointment={{ id: pick.item.id, title: pick.item.title, startAt: pick.item.startAt, version: pick.item.version, hosts: pick.item.hosts }}
          timeZone={tz}
          today={today}
          initialDate={pick.date < today ? today : pick.date}
          hostNames={hostNames}
          onClose={() => setPick(null)}
        />
      )}
      <p className="sr-only" aria-live="polite">{pending ? "Loading the calendar" : `${items.length} ${items.length === 1 ? "appointment" : "appointments"} shown, ${formatDay(days[0], { month: "long", day: "numeric" })} to ${formatDay(days[days.length - 1], { month: "long", day: "numeric" })}`}</p>
    </div>
  );
}
