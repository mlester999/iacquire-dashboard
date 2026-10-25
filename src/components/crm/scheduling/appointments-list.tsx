"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CalendarDays, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, Input, Select } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { Pagination, PageTitle } from "@/components/crm/ui";
import { listQuery, LIST_STATUS_FILTERS, type AppointmentListState, type ListStatusFilter, type ListWhen } from "@/components/crm/scheduling/calendar-math";
import { colorFor, dateTimeIn, STATUS_LABEL, timeRangeIn, VIA_LABEL, zoneCity } from "@/components/crm/scheduling/format";
import { ColorDot, replaceAddress, StatusBadge, useDrawerLink } from "@/components/crm/scheduling/bits";
import { useUrlSearch } from "@/components/crm/url-search";
import { AppointmentDrawer } from "@/components/crm/scheduling/appointment-drawer";
import { NewAppointmentDialog } from "@/components/crm/scheduling/new-appointment-dialog";
import type { ScheduleFilters, ScheduleItem } from "@/server/calendars/schedule";
import type { CrmScope } from "@/server/crm/page";

const WHEN: Array<{ value: ListWhen; label: string }> = [
  { value: "upcoming", label: "Upcoming" },
  { value: "past", label: "Past" },
  { value: "range", label: "Dates" },
];

/** Every native appointment as a list: a table on wider screens and cards on phones, filtered, searchable by customer and paged. */
export function AppointmentsList({
  scope, state, items, total, pageSize, filters, today,
}: {
  scope: CrmScope;
  state: AppointmentListState;
  items: ScheduleItem[];
  total: number;
  pageSize: number;
  filters: ScheduleFilters;
  today: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = React.useTransition();
  const [range, setRange] = React.useState({ from: state.from ?? today, to: state.to ?? today });
  // Following a link to an appointment (a notification, say) opens it, even the same one again after its drawer was closed.
  const [openId, setOpenId] = useDrawerLink(state);
  const [newOpen, setNewOpen] = React.useState(false);
  const tz = filters.orgTimezone;
  const canBook = !!scope.can["appointments.book"] && !scope.readOnly && filters.calendars.some((c) => c.types.length);
  const hostNames = React.useMemo(() => Object.fromEntries(filters.hosts.map((h) => [h.id, h.name])), [filters.hosts]);

  const hrefWith = (changes: Partial<AppointmentListState>) => `${pathname}${listQuery(state, { page: 1, ...changes, appointmentId: null })}`;
  const go = (changes: Partial<AppointmentListState>) => startTransition(() => router.push(hrefWith(changes), { scroll: false }));
  // Typing replaces the address rather than adding to history, so Back leaves the screen instead of stepping through searches.
  const search = useUrlSearch(state.q, state, (q) => startTransition(() => router.replace(hrefWith({ q }), { scroll: false })), 350);

  const open = (id: string) => {
    setOpenId(id);
    replaceAddress(`${pathname}${listQuery(state, { appointmentId: id })}`);
  };
  const close = () => {
    setOpenId(null);
    replaceAddress(`${pathname}${listQuery(state, { appointmentId: null })}`);
  };
  const filtered = state.status !== "all" || !!state.calendarId || !!state.hostId || !!state.q || state.when === "range";

  return (
    <div className="space-y-4">
      <PageTitle
        title="Appointments"
        description={<>Every appointment in your calendars, shown in {zoneCity(tz)} time.</>}
        actions={
          <>
            <Link href={`${scope.base}/calendar`} className="inline-flex h-11 items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-2 sm:h-9"><CalendarDays className="size-4" aria-hidden />Calendar</Link>
            {canBook && <Button onClick={() => setNewOpen(true)}><Plus className="size-4" />New appointment</Button>}
          </>
        }
      />

      <Card className="space-y-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
            <Input type="search" aria-label="Search by customer" placeholder="Search by customer" className="pl-9" value={search.text} maxLength={80} onChange={(e) => search.setText(e.target.value)} />
          </div>
          <Segmented<ListWhen> id="appt-when" ariaLabel="When" size="sm" value={state.when} onChange={(v) => (v === "range" ? go({ when: "range", from: range.from, to: range.to }) : go({ when: v, from: null, to: null }))} options={WHEN} />
        </div>
        {state.when === "range" && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (range.from && range.to && range.from <= range.to) go({ when: "range", from: range.from, to: range.to });
            }}
          >
            <label className="space-y-1 text-[12.5px] text-muted">
              <span className="block">From</span>
              <Input type="date" className="w-[10.5rem]" value={range.from} max={range.to || undefined} onChange={(e) => setRange({ ...range, from: e.target.value })} required />
            </label>
            <label className="space-y-1 text-[12.5px] text-muted">
              <span className="block">To</span>
              <Input type="date" className="w-[10.5rem]" value={range.to} min={range.from || undefined} onChange={(e) => setRange({ ...range, to: e.target.value })} required />
            </label>
            <Button type="submit" variant="secondary" disabled={!range.from || !range.to || range.from > range.to}>Show</Button>
            {range.from && range.to && range.from > range.to && <p className="text-[12.5px] text-danger-ink" role="alert">The start date must be on or before the end date.</p>}
          </form>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="appt-status">Status</label>
          <Select id="appt-status" className="w-auto max-w-full" value={state.status} onChange={(e) => go({ status: e.target.value as ListStatusFilter })}>
            {LIST_STATUS_FILTERS.map((s) => <option key={s} value={s}>{s === "all" ? "Any status" : STATUS_LABEL[s]}</option>)}
          </Select>
          <label className="sr-only" htmlFor="appt-calendar">Calendar</label>
          <Select id="appt-calendar" className="w-auto max-w-full" value={state.calendarId ?? ""} onChange={(e) => go({ calendarId: e.target.value || null })}>
            <option value="">All calendars</option>
            {filters.calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <label className="sr-only" htmlFor="appt-host">Person</label>
          <Select id="appt-host" className="w-auto max-w-full" value={state.hostId ?? ""} onChange={(e) => go({ hostId: e.target.value || null })}>
            <option value="">Everyone</option>
            {filters.hosts.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </Select>
          {filtered && (
            <Button variant="ghost" size="sm" onClick={() => { search.reset(); go({ when: "upcoming", from: null, to: null, status: "all", calendarId: null, hostId: null, q: "" }); }}>
              <X className="size-3.5" />Clear filters
            </Button>
          )}
          <p className="ml-auto text-[12.5px] text-muted" role="status">{total.toLocaleString("en-US")} {total === 1 ? "appointment" : "appointments"}</p>
        </div>
      </Card>

      <div className={cn("transition-opacity", pending && "opacity-60")} aria-busy={pending || undefined}>
        {!items.length ? (
          <Card>
            <EmptyState
              icon={<CalendarDays className="size-5" />}
              title={filtered ? "No appointments match" : state.when === "past" ? "No past appointments" : "Nothing booked yet"}
              description={filtered ? "Try other filters, or clear them." : "Appointments booked from booking pages, by your team and by your AI employees appear here."}
              action={canBook && !filtered ? <Button variant="secondary" onClick={() => setNewOpen(true)}><Plus className="size-4" />New appointment</Button> : undefined}
            />
          </Card>
        ) : (
          <>
            <Card className="hidden overflow-hidden md:block">
              <div className="overflow-x-auto">
                <table className="workspace-table w-full min-w-[820px] text-left text-[13px]">
                  <thead>
                    <tr>
                      <th scope="col" className="px-4 py-2.5">When</th>
                      <th scope="col" className="px-4 py-2.5">Customer</th>
                      <th scope="col" className="px-4 py-2.5">Type</th>
                      <th scope="col" className="px-4 py-2.5">Host</th>
                      <th scope="col" className="px-4 py-2.5">Status</th>
                      <th scope="col" className="px-4 py-2.5">Booked</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {items.map((a) => (
                      <tr key={a.id} className="hover:bg-surface-2/60">
                        <td className="whitespace-nowrap px-4 py-2.5">
                          <button type="button" onClick={() => open(a.id)} className="text-left font-medium text-ink hover:text-primary hover:underline">
                            {dateTimeIn(a.startAt, tz)}
                            <span className="sr-only">. Open the appointment.</span>
                          </button>
                          <p className="text-[12px] tabular-nums text-muted">{timeRangeIn(a.startAt, a.endAt, tz)}</p>
                        </td>
                        <td className="max-w-[220px] px-4 py-2.5">
                          {a.contact && scope.can["contacts.view"] ? (
                            <Link href={`${scope.base}/contacts/${a.contact.id}`} className="block truncate text-ink-2 hover:text-primary hover:underline">{a.contact.name}</Link>
                          ) : (
                            <span className="block truncate text-ink-2">{a.contact?.name ?? "—"}</span>
                          )}
                        </td>
                        <td className="max-w-[220px] px-4 py-2.5">
                          <span className="flex min-w-0 items-center gap-1.5"><ColorDot color={colorFor(a)} /><span className="truncate">{a.type?.name ?? "Appointment"}</span></span>
                          {a.calendar && <span className="block truncate text-[12px] text-muted">{a.calendar.name}</span>}
                        </td>
                        <td className="max-w-[200px] truncate px-4 py-2.5 text-ink-2">{a.hosts.map((h) => h.name).join(", ") || "—"}</td>
                        <td className="px-4 py-2.5"><StatusBadge status={a.status} /></td>
                        <td className="px-4 py-2.5 text-[12.5px] text-muted">{a.bookedVia ? VIA_LABEL[a.bookedVia] ?? a.bookedVia : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <ul className="space-y-2 md:hidden" aria-label="Appointments">
              {items.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => open(a.id)} className="flex w-full min-w-0 items-start gap-3 rounded-2xl border border-line bg-surface p-3 text-left shadow-soft">
                    <span aria-hidden className="mt-0.5 h-10 w-1 shrink-0 rounded-full" style={{ background: colorFor(a) }} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-start justify-between gap-2">
                        <span className={cn("truncate text-[14px] font-medium text-ink", a.status === "cancelled" && "line-through")}>{a.contact?.name ?? a.title}</span>
                        <StatusBadge status={a.status} className="h-5 text-[12px]" />
                      </span>
                      <span className="block text-[12.5px] tabular-nums text-ink-2">{dateTimeIn(a.startAt, tz)}</span>
                      <span className="block truncate text-[12px] text-muted">{a.type?.name ?? "Appointment"}{a.hosts.length ? ` · ${a.hosts.map((h) => h.name).join(", ")}` : ""}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <Pagination page={state.page} pageSize={pageSize} total={total} hrefFor={(p) => `${pathname}${listQuery(state, { page: p, appointmentId: null })}`} />

      {openId && <AppointmentDrawer key={openId} scope={scope} appointmentId={openId} timeZone={tz} today={today} hostNames={hostNames} onClose={close} />}
      {newOpen && <NewAppointmentDialog scope={scope} filters={filters} timeZone={tz} today={today} defaultDate={today} onClose={() => setNewOpen(false)} onBooked={open} />}
    </div>
  );
}
