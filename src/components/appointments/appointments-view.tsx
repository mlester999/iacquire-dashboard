"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CalendarDays, CalendarX2, ChevronLeft, ChevronRight, Clock, ExternalLink, List, MoveRight, RefreshCw, Video } from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardContent, EmptyState } from "@/components/ui/primitives";
import { InfoChip, StatusPill, type StatusTone } from "@/components/ui/status";
import { Panel } from "@/components/overview/panel";
import { Segmented, Sheet } from "@/components/ui/overlays";
import { MetricCard } from "@/components/ui/workspace";
import { refreshCrmAction } from "@/app/actions/records";
import { AGENT_BY_KEY } from "@/lib/agents";
import { cn, formatDate, formatTime, relativeTime, sentenceCase, timeZoneLabel } from "@/lib/utils";
import { BookButton, BookDialog, BookingRules, PendingBookings } from "@/components/appointments/booking-panels";
import type { PendingBookingRow } from "@/server/appointments/overview";
import type { PolicyView } from "@/server/appointments/settings";

interface Appt {
  id: string;
  title: string;
  status: string;
  start_at: string;
  end_at: string;
  timezone: string | null;
  meeting_type: string | null;
  meeting_link: string | null;
  contact_label: string | null;
  synced_at: string;
  late_cancellation?: boolean;
  reschedule_count?: number;
  previous_start_at?: string | null;
  conflict?: boolean;
  origin?: "sync" | "webhook" | "portal_ai" | "portal_staff";
  cancelled_at?: string | null;
}

/** The things worth knowing about an appointment beyond its status, in plain words. */
function flags(a: Appt) {
  const out: Array<{ key: string; label: string; tone: "danger" | "warning" | "primary" | "neutral" }> = [];
  if (a.late_cancellation) out.push({ key: "late", label: "Late cancellation", tone: "warning" });
  if (a.conflict) out.push({ key: "conflict", label: "Overlaps another", tone: "danger" });
  if ((a.reschedule_count ?? 0) > 0) out.push({ key: "moved", label: a.reschedule_count === 1 ? "Moved once" : `Moved ${a.reschedule_count} times`, tone: "primary" });
  if (a.origin === "portal_ai") out.push({ key: "ai", label: "Booked by your AI team", tone: "neutral" });
  return out;
}

const STATUS_TONE: Record<string, StatusTone> = {
  confirmed: "success",
  new: "primary",
  cancelled: "danger",
  showed: "violet",
  noshow: "warning",
  invalid: "neutral",
};

/** Calendar chips carry the appointment's status in their colour; the text label stays in the pill and the sheet. */
const CHIP_TONE: Record<StatusTone, string> = {
  success: "bg-success-soft text-success-ink hover:bg-success/15",
  primary: "bg-primary-soft text-primary-ink hover:bg-primary/15",
  danger: "bg-surface-2 text-faint line-through hover:bg-surface-3",
  violet: "bg-violet-soft text-violet-ink hover:bg-violet/15",
  warning: "bg-warning-soft text-warning-ink hover:bg-warning/15",
  neutral: "bg-surface-2 text-ink-2 hover:bg-surface-3",
};
const STATUS_LABEL: Record<string, string> = { confirmed: "Confirmed", new: "New", cancelled: "Cancelled", showed: "Showed up", noshow: "No-show", invalid: "Invalid" };
const statusLabel = (s: string) => STATUS_LABEL[s] ?? sentenceCase(s);

/** A month tile with the day of the month, used wherever an appointment appears in a list. */
function DateTile({ at, timeZone }: { at: string; timeZone: string }) {
  return (
    <div className="grid w-12 shrink-0 place-items-center rounded-xl bg-surface-2 py-1.5 text-center ring-1 ring-inset ring-line">
      <p className="text-[12px] font-semibold uppercase leading-none tracking-wider text-muted">{new Date(at).toLocaleDateString("en-US", { month: "short", timeZone })}</p>
      <p className="mt-1 text-[18px] font-semibold leading-none tabular-nums text-ink">{new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone }).format(new Date(at))}</p>
    </div>
  );
}

function dayKey(d: Date, tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function AppointmentsView({ appointments, timeZone, lastSync, canRefresh, setterReady, pending, policy, canBook, canManage, canGoAutonomous }: { appointments: Appt[]; timeZone: string; lastSync: string | null; canRefresh: boolean; setterReady: boolean; pending: PendingBookingRow[]; policy: PolicyView; canBook: boolean; canManage: boolean; canGoAutonomous: boolean }) {
  const router = useRouter();
  const [booking, setBooking] = React.useState(false);
  const [view, setView] = React.useState<"calendar" | "list">("calendar");
  const [cursor, setCursor] = React.useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [open, setOpen] = React.useState<Appt | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  // Fixed at first render so the upcoming/past split is stable across re-renders.
  const [now] = React.useState(() => Date.now());
  const upcoming = appointments.filter((a) => new Date(a.start_at).getTime() >= now && a.status !== "cancelled");
  const past = appointments.filter((a) => new Date(a.start_at).getTime() < now).reverse();
  // The list keeps cancelled future appointments (marked as such) so a cancellation, and a late one, is never hidden.
  const listed = [...appointments.filter((a) => new Date(a.start_at).getTime() >= now), ...past];
  const byDay = React.useMemo(() => {
    const m = new Map<string, Appt[]>();
    for (const a of appointments) {
      const k = dayKey(new Date(a.start_at), timeZone);
      m.set(k, [...(m.get(k) ?? []), a]);
    }
    return m;
  }, [appointments, timeZone]);

  const monthStart = cursor;
  const startWeekday = monthStart.getDay();
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: Math.ceil((startWeekday + daysInMonth) / 7) * 7 }, (_, i) => {
    const day = i - startWeekday + 1;
    return day >= 1 && day <= daysInMonth ? new Date(cursor.getFullYear(), cursor.getMonth(), day, 12) : null;
  });
  const todayKey = dayKey(new Date(), timeZone);

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 xl:col-span-3"><MetricCard label="Upcoming meetings" value={upcoming.length} detail="Future meetings recorded by your calendar." icon={<CalendarDays className="size-4"/>}/><MetricCard label="Confirmed" value={upcoming.filter(appointment=>appointment.status==="confirmed").length} detail="Confirmed appointments among upcoming meetings." icon={<Video className="size-4"/>} tone="green"/><MetricCard label="Calendar time zone" value={<span className="text-[18px]">{timeZoneLabel(timeZone)}</span>} detail={lastSync?`Last checked ${relativeTime(lastSync)}`:"No synchronization timestamp recorded."} icon={<Clock className="size-4"/>} tone="neutral"/></div>
      <PendingBookings rows={pending} canBook={canBook} />
      <div className="space-y-4 xl:col-span-2">
        <Card data-aqi-target="appointments.calendar">
          <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
            {view === "calendar" && (
              <div className="flex items-center gap-1">
                <Button size="icon-sm" variant="ghost" aria-label="Previous month" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
                  <ChevronLeft className="size-4" />
                </Button>
                <p className="min-w-36 text-center text-[15px] font-semibold">{cursor.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</p>
                <Button size="icon-sm" variant="ghost" aria-label="Next month" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            )}
            <div className="ml-auto flex items-center gap-2">
              {canBook && <span data-aqi-target="appointments.book"><BookButton onClick={() => setBooking(true)} /></span>}
              {canRefresh && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={refreshing}
                  onClick={async () => {
                    setRefreshing(true);
                    const res = await refreshCrmAction();
                    setRefreshing(false);
                    if (!res.ok) return toast.error(res.error);
                    toast.success("Calendar refreshed");
                    router.refresh();
                  }}
                >
                  <RefreshCw className="size-3.5" /> Refresh
                </Button>
              )}
              <Segmented
                id="appt-view"
                ariaLabel="View"
                size="sm"
                value={view}
                onChange={setView}
                options={[
                  { value: "calendar", label: <span className="flex items-center gap-1.5"><CalendarDays className="size-3.5" />Calendar</span> },
                  { value: "list", label: <span className="flex items-center gap-1.5"><List className="size-3.5" />List</span> },
                ]}
              />
            </div>
          </div>
          {view === "calendar" ? (
            <div className="p-3 sm:p-4">
              <div className="grid grid-cols-7 gap-1 pb-2 text-center text-[12px] font-medium text-faint">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                  <span key={d}>
                    <span className="sm:hidden">{d[0]}</span>
                    <span className="hidden sm:inline">{d}</span>
                  </span>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {cells.map((d, i) => {
                  if (!d) return <div key={i} className="min-h-14 rounded-xl sm:min-h-24" />;
                  // Grid cells are calendar dates; appointments are bucketed by their date in the workspace time zone.
                  const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
                  const items = byDay.get(k) ?? [];
                  return (
                    <div key={i} className={cn("min-h-14 rounded-xl border p-1 sm:min-h-24 sm:p-1.5", k === todayKey ? "border-primary/40 bg-primary-soft/30" : "border-line bg-surface")}>
                      <p className={cn("text-[12px] font-medium", k === todayKey ? "text-primary" : "text-muted")}>{d.getDate()}</p>
                      <div className="mt-0.5 space-y-0.5">
                        {items.slice(0, 2).map((a) => (
                          <button
                            key={a.id}
                            type="button"
                            onClick={() => setOpen(a)}
                            className={cn("block w-full truncate rounded-md px-1 py-0.5 text-left text-[12px] font-medium transition-colors sm:text-[12px]", CHIP_TONE[STATUS_TONE[a.status] ?? "neutral"])}
                            title={`${a.title} · ${statusLabel(a.status)}`}
                          >
                            <span className="hidden sm:inline">{formatTime(a.start_at, timeZone)} </span>
                            {a.title}
                          </button>
                        ))}
                        {items.length > 2 && <p className="px-1 text-[12px] text-muted">+{items.length - 2} more</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {listed.length === 0 && (
                <li>
                  <EmptyState icon={<CalendarDays className="size-5" />} title="No appointments in the synced window" description="Meetings from your connected calendar appear here once they are booked." />
                </li>
              )}
              {listed.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => setOpen(a)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-surface-2/60 sm:gap-4">
                    <DateTile at={a.start_at} timeZone={timeZone} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-semibold" title={a.title}>{a.title}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <InfoChip icon={<Clock />}>{formatTime(a.start_at, timeZone)} – {formatTime(a.end_at, timeZone)}</InfoChip>
                        {a.meeting_type && <InfoChip icon={<Video />}>{a.meeting_type}</InfoChip>}
                      </div>
                    </div>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <StatusPill tone={STATUS_TONE[a.status] ?? "neutral"}>{statusLabel(a.status)}</StatusPill>
                      {flags(a).filter((f) => f.key !== "ai").map((f) => <StatusPill key={f.key} tone={f.tone} size="sm">{f.label}</StatusPill>)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="flex flex-wrap items-center gap-1.5">
          {view === "calendar" && (["confirmed", "new", "showed", "noshow", "cancelled"] as const).map((s) => <StatusPill key={s} tone={STATUS_TONE[s]} size="sm">{statusLabel(s)}</StatusPill>)}
          <InfoChip icon={<Clock />}>Times shown in {timeZoneLabel(timeZone)}</InfoChip>
          {lastSync && <InfoChip><span suppressHydrationWarning>Last synced {relativeTime(lastSync)}</span></InfoChip>}
        </div>
      </div>

      <div className="space-y-6">
        <Panel icon={<CalendarDays />} title="Upcoming" description="Next confirmed and new bookings.">
          {upcoming.length === 0 ? (
            <EmptyState compact icon={<CalendarDays className="size-5" />} title="No upcoming appointments" description="New bookings from your calendar appear here." />
          ) : (
            <ul className="space-y-2">
              {upcoming.slice(0, 6).map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => setOpen(a)} className="flex w-full items-center gap-3 rounded-xl border border-line p-2.5 text-left transition hover:-translate-y-px hover:border-line-strong hover:shadow-card">
                    <DateTile at={a.start_at} timeZone={timeZone} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-semibold" title={a.title}>{a.title}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5">
                        <InfoChip icon={<Clock />}>{formatTime(a.start_at, timeZone)}</InfoChip>
                        <StatusPill tone={STATUS_TONE[a.status] ?? "neutral"} size="sm">{statusLabel(a.status)}</StatusPill>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Card>
          <CardContent className="flex items-start gap-3 pt-5">
            <AgentAvatar role={AGENT_BY_KEY.appointment_setter} size="md" />
            <div>
              <p className="text-[14px] font-semibold">Appointment Setter</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-muted">Ask about availability or prepare a booking. It only offers times your calendar reports as free, and unless you allow it to book on its own, you confirm each one in Approvals.</p>
              {setterReady ? (
                <ButtonLink href="/chat/appointment-setter" variant="secondary" size="sm" className="mt-3">
                  Ask the Appointment Setter
                </ButtonLink>
              ) : (
                <StatusPill tone="neutral" className="mt-3">Available once it&apos;s online</StatusPill>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {canManage && <BookingRules policy={policy} canGoAutonomous={canGoAutonomous} />}
      {canBook && <BookDialog open={booking} onOpenChange={setBooking} timeZone={timeZone} />}

      <Sheet open={Boolean(open)} onOpenChange={(o) => !o && setOpen(null)} title={open?.title ?? "Appointment"} description={open ? `${formatDate(open.start_at, timeZone)} · ${formatTime(open.start_at, timeZone)} – ${formatTime(open.end_at, timeZone)}` : undefined}>
        {open && (
          <div className="space-y-4 p-5 text-[14px]">
            <div className="flex flex-wrap gap-1.5">
              <StatusPill tone={STATUS_TONE[open.status] ?? "neutral"}>{statusLabel(open.status)}</StatusPill>
              {flags(open).map((f) => <StatusPill key={f.key} tone={f.tone}>{f.label}</StatusPill>)}
            </div>
            {open.conflict && <p className="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2.5 text-[13px] text-danger-ink" role="alert"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />This overlaps another appointment for the same person. Move one of them in your calendar.</p>}
            {open.status === "cancelled" && open.cancelled_at && <p className="flex items-start gap-2 text-[13px] text-muted"><CalendarX2 className="mt-0.5 size-4 shrink-0" aria-hidden />Cancelled {relativeTime(open.cancelled_at)}{open.late_cancellation ? ", close to the start time." : "."}</p>}
            {(open.reschedule_count ?? 0) > 0 && open.previous_start_at && <p className="flex items-start gap-2 text-[13px] text-muted"><MoveRight className="mt-0.5 size-4 shrink-0" aria-hidden />Moved from {formatDate(open.previous_start_at, timeZone)} at {formatTime(open.previous_start_at, timeZone)}.</p>}
            <dl className="space-y-3">
              <div>
                <dt className="text-[12px] text-muted">Meeting type</dt>
                <dd className="mt-1">{open.meeting_type ? <InfoChip icon={<Video />}>{open.meeting_type}</InfoChip> : <span className="text-muted">Not specified</span>}</dd>
              </div>
              <div>
                <dt className="text-[12px] text-muted">Contact</dt>
                <dd>{open.contact_label ?? "Not shared by the calendar"}</dd>
              </div>
              <div>
                <dt className="text-[12px] text-muted">Meeting link</dt>
                <dd>
                  {open.meeting_link ? (
                    <a href={open.meeting_link} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-primary-soft px-3 font-medium text-primary-ink ring-1 ring-inset ring-primary/20 transition hover:bg-primary/15">
                      <Video className="size-4" /> Join meeting <ExternalLink className="size-3" />
                    </a>
                  ) : (
                    <span className="text-muted">No link was returned by the calendar.</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-[12px] text-muted">Time zone</dt>
                <dd>{timeZoneLabel(timeZone)}</dd>
              </div>
            </dl>
            <p className="rounded-xl bg-surface-2 p-3 text-[13px] text-muted">To reschedule or cancel, change it in your calendar. This page follows the calendar&apos;s own record, so the change appears here once the calendar confirms it.</p>
          </div>
        )}
      </Sheet>
    </div>
  );
}
