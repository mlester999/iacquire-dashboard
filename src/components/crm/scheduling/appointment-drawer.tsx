"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, CalendarClock, Check, CheckCircle2, Clock, ExternalLink, History, MapPin, RotateCcw, User, UserX, Video, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Skeleton, Textarea } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { appointmentDetailAction, cancelAppointmentAction, setAppointmentStatusAction } from "@/app/actions/crm-scheduling";
import { Avatar, ConfirmDialog, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { permissionNeeded } from "@/lib/permissions";
import { ColorDot, StatusBadge, useLatest, useNow } from "@/components/crm/scheduling/bits";
import { colorFor, dateTimeIn, isUpcomingStatus, longDateIn, timeRangeIn, VIA_LABEL, zoneCity } from "@/components/crm/scheduling/format";
import { RescheduleDialog } from "@/components/crm/scheduling/reschedule-dialog";
import type { AppointmentDetail } from "@/server/calendars/schedule";
import type { CrmScope } from "@/server/crm/page";
import { RelativeTime } from "@/components/crm/relative-time";

const ASSIGNMENT: Record<string, string> = { single: "One host", round_robin: "Round robin", collective: "Everyone attends" };

/**
 * One appointment, opened from the calendar, the list or a notification link (?appointment=<id>). Shows everything recorded about it and,
 * for people who manage appointments, the actions that apply to its current state: confirm, reschedule, cancel with a reason, and the
 * outcome once it has started.
 */
export function AppointmentDrawer({
  scope, appointmentId, timeZone, today, hostNames, onClose,
}: {
  scope: CrmScope;
  appointmentId: string;
  timeZone: string;
  today: string;
  hostNames: Record<string, string>;
  onClose: () => void;
}) {
  const { run, busy } = useCrmAction();
  const [version, setVersion] = React.useState(0);
  const [result, setResult] = React.useState<{ key: string; detail?: AppointmentDetail; error?: string } | null>(null);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [moveOpen, setMoveOpen] = React.useState(false);
  const now = useNow();
  const key = `${appointmentId}:${version}`;
  const orgId = useLatest(scope.orgId);

  React.useEffect(() => {
    let live = true;
    appointmentDetailAction(orgId.current, appointmentId).then(
      (r) => live && setResult(r.ok ? { key, detail: r.data } : { key, error: r.error }),
      () => live && setResult({ key, error: "This appointment couldn't be loaded. Check your connection and try again." }),
    );
    return () => {
      live = false;
    };
  }, [key, appointmentId, orgId]);

  const loading = result?.key !== key;
  const d = result?.detail && result.detail.id === appointmentId ? result.detail : null;
  const canManage = !!scope.can["appointments.manage"] && !scope.readOnly;
  const started = d ? now > 0 && new Date(d.startAt).getTime() <= now : false;
  const upcoming = d ? isUpcomingStatus(d.status) : false;
  const live = d ? d.status !== "cancelled" && d.status !== "invalid" : false;
  const refresh = () => setVersion((v) => v + 1);
  const color = d ? colorFor(d) : "#94a3b8";

  const outcome = async (status: "confirmed" | "showed" | "noshow") => {
    const msg = status === "confirmed" ? "Appointment confirmed." : status === "showed" ? "Marked as showed." : "Marked as a no-show.";
    if (await run(status, () => setAppointmentStatusAction(scope.orgId, appointmentId, status), msg)) refresh();
  };

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={d ? d.type?.name ?? d.title : loading ? "Appointment" : "Appointment unavailable"}
      description={d ? `${dateTimeIn(d.startAt, timeZone)} · ${zoneCity(timeZone)} time` : undefined}
    >
      {loading && !d ? (
        <div className="space-y-3 p-5" aria-busy="true">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : !d ? (
        <div className="p-5">
          <p className="rounded-xl border border-line bg-surface-2 px-3 py-3 text-[13px] text-muted" role="alert">{result?.error ?? "This appointment couldn't be found."}</p>
        </div>
      ) : (
        <div className={cn("space-y-5 p-5", loading && "opacity-70")}>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={d.status} />
            {d.bookedVia && <Badge tone="outline">{VIA_LABEL[d.bookedVia] ?? d.bookedVia}</Badge>}
            {d.rescheduleCount > 0 && <Badge tone="primary">{d.rescheduleCount === 1 ? "Moved once" : `Moved ${d.rescheduleCount} times`}</Badge>}
            {d.lateCancellation && <Badge tone="warning">Late cancellation</Badge>}
          </div>

          <section aria-label="When and where" className="space-y-3 rounded-2xl border border-line p-4">
            <div className="flex items-start gap-3">
              <span className="mt-1 h-10 w-1 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
              <div className="min-w-0">
                <p className="text-[15px] font-semibold text-ink">{longDateIn(d.startAt, timeZone)}</p>
                <p className="text-[13.5px] tabular-nums text-ink-2">{timeRangeIn(d.startAt, d.endAt, timeZone)} <span className="text-muted">({zoneCity(timeZone)})</span></p>
                {d.inviteeTimezone && d.inviteeTimezone !== timeZone && (
                  <p className="mt-0.5 text-[12.5px] text-muted">Their time: {timeRangeIn(d.startAt, d.endAt, d.inviteeTimezone)} in {zoneCity(d.inviteeTimezone)}</p>
                )}
                {d.previousStartAt && <p className="mt-0.5 text-[12.5px] text-muted">Previously {dateTimeIn(d.previousStartAt, timeZone)}</p>}
              </div>
            </div>
            <dl className="grid gap-2 text-[13px]">
              <div className="flex items-start gap-2.5">
                <dt className="sr-only">Calendar</dt>
                <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                <dd className="min-w-0 text-ink-2">
                  <span className="inline-flex items-center gap-1.5"><ColorDot color={color} />{d.type?.name ?? "Appointment"}</span>
                  {d.calendar && <span className="text-muted"> · {d.calendar.name}{d.assignment ? ` · ${ASSIGNMENT[d.assignment]}` : ""}</span>}
                  {d.type && <span className="text-muted"> · {d.type.durationMinutes} min</span>}
                </dd>
              </div>
              {d.location && (
                <div className="flex items-start gap-2.5">
                  <dt className="sr-only">Location</dt>
                  <MapPin className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                  <dd className="min-w-0 break-words text-ink-2">{d.location}</dd>
                </div>
              )}
              {d.meetingLink && (
                <div className="flex items-start gap-2.5">
                  <dt className="sr-only">Meeting link</dt>
                  <Video className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                  <dd className="min-w-0">
                    <a href={d.meetingLink} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 break-all font-medium text-primary hover:underline">
                      Join the meeting<ExternalLink className="size-3.5 shrink-0" aria-hidden /><span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </dd>
                </div>
              )}
            </dl>
          </section>

          <section aria-labelledby="appt-people" className="space-y-2">
            <h3 id="appt-people" className="text-[13px] font-semibold text-ink">People</h3>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <User className="size-4 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium text-ink">{d.contact?.name ?? "No contact recorded"}</p>
                  <p className="text-[12px] text-muted">Customer</p>
                </div>
              </div>
              {d.contact && scope.can["contacts.view"] && (
                <Link href={`${scope.base}/contacts/${d.contact.id}`} className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-2 text-[13px] font-medium text-primary hover:underline sm:min-h-8">Open contact</Link>
              )}
            </div>
            <ul className="space-y-1.5" aria-label="Hosts">
              {d.hosts.map((h) => (
                <li key={h.id} className="flex items-center gap-2.5 rounded-xl px-1 py-1 text-[13px] text-ink-2"><Avatar name={h.name} size="sm" />{h.name}<span className="text-[12px] text-muted">Host</span></li>
              ))}
              {!d.hosts.length && <li className="text-[13px] text-muted">No host is recorded.</li>}
            </ul>
          </section>

          {canManage && live && (upcoming || started) && (
            <section aria-label="Actions" className="flex flex-wrap gap-2">
              {d.status === "new" && <Button size="sm" loading={busy("confirmed")} onClick={() => outcome("confirmed")}><Check className="size-4" />Confirm</Button>}
              {upcoming && <Button size="sm" variant="secondary" onClick={() => setMoveOpen(true)}><RotateCcw className="size-4" />Reschedule</Button>}
              {started && d.status !== "showed" && <Button size="sm" variant="secondary" loading={busy("showed")} onClick={() => outcome("showed")}><CheckCircle2 className="size-4" />Mark showed</Button>}
              {started && d.status !== "noshow" && <Button size="sm" variant="secondary" loading={busy("noshow")} onClick={() => outcome("noshow")}><UserX className="size-4" />Mark no-show</Button>}
              {upcoming && <Button size="sm" variant="ghost" className="text-danger-ink hover:bg-danger-soft" onClick={() => setCancelOpen(true)}><XCircle className="size-4" />Cancel appointment</Button>}
            </section>
          )}
          {!canManage && live && (upcoming || started) && (
            <ReadOnlyNotice>{scope.readOnly ? "This support session is read-only." : permissionNeeded("Confirming, moving, cancelling and recording outcomes", "appointments.manage")}</ReadOnlyNotice>
          )}
          {canManage && upcoming && !started && (
            <p className="flex items-start gap-2 text-[12.5px] text-muted"><Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden />You can record whether they came once the appointment has started.</p>
          )}

          {d.status === "cancelled" && (
            <section aria-label="Cancellation" className="rounded-xl border border-danger/20 bg-danger-soft/50 px-3 py-2.5 text-[13px]">
              <p className="font-medium text-danger-ink">Cancelled{d.cancelledAt ? <> <RelativeTime iso={d.cancelledAt} timezone={timeZone} /></> : ""}</p>
              <p className="mt-0.5 text-ink-2">{d.cancelReason ? `Reason: ${d.cancelReason}` : "No reason was given."}</p>
            </section>
          )}

          {d.answers.length > 0 && (
            <section aria-labelledby="appt-answers">
              <h3 id="appt-answers" className="text-[13px] font-semibold text-ink">Answers</h3>
              <dl className="mt-2 divide-y divide-line rounded-xl border border-line">
                {d.answers.map((a) => (
                  <div key={a.key} className="px-3 py-2">
                    <dt className="text-[12px] text-muted">{a.label}</dt>
                    <dd className="whitespace-pre-wrap break-words text-[13px] text-ink">{a.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {d.description && (
            <section aria-labelledby="appt-notes">
              <h3 id="appt-notes" className="text-[13px] font-semibold text-ink">Notes</h3>
              <p className="mt-1.5 whitespace-pre-wrap break-words rounded-xl bg-surface-2 px-3 py-2 text-[13px] text-ink-2">{d.description}</p>
            </section>
          )}

          <section aria-labelledby="appt-history">
            <h3 id="appt-history" className="flex items-center gap-1.5 text-[13px] font-semibold text-ink"><History className="size-4 text-muted" aria-hidden />History</h3>
            <ol className="mt-2 space-y-2 border-l border-line pl-4">
              {d.history.map((h) => (
                <li key={h.id} className="relative text-[13px]">
                  <span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-line-strong" aria-hidden />
                  <p className="text-ink-2">{h.summary}</p>
                  <p className="text-[11.5px] text-muted">{h.actor ? `${h.actor} · ` : ""}<RelativeTime iso={h.at} timezone={timeZone} /></p>
                </li>
              ))}
              {!d.history.length && <li className="text-[13px] text-muted">Booked <RelativeTime iso={d.createdAt} timezone={timeZone} />{d.createdBy ? ` by ${d.createdBy}` : ""}.</li>}
            </ol>
          </section>
        </div>
      )}

      {d && (
        <ConfirmDialog
          open={cancelOpen}
          onOpenChange={(o) => {
            setCancelOpen(o);
            if (!o) setReason("");
          }}
          title="Cancel this appointment?"
          description={<>{d.contact?.name ?? d.title} on {dateTimeIn(d.startAt, timeZone)}. The time opens up for new bookings, hosts are notified and any waiting reminders are withdrawn.</>}
          confirmLabel="Cancel appointment"
          danger
          loading={busy("cancel")}
          onConfirm={async () => {
            const r = await run("cancel", () => cancelAppointmentAction(scope.orgId, appointmentId, reason.trim() || null), (res) =>
              res.late ? "Cancelled. Under your policy this counts as a late cancellation." : "Appointment cancelled.",
            );
            if (r) {
              setCancelOpen(false);
              setReason("");
              refresh();
            }
          }}
        >
          <Field label="Reason" htmlFor="cancel-reason" optional hint="Kept on the appointment for your team.">
            <Textarea id="cancel-reason" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The customer asked to cancel" />
          </Field>
          <p className="mt-3 flex items-start gap-2 text-[12.5px] text-muted"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />Let the customer know if they don&apos;t already.</p>
        </ConfirmDialog>
      )}

      {d && moveOpen && upcoming && canManage && (
        <RescheduleDialog
          scope={scope}
          appointment={{ id: d.id, title: d.title, startAt: d.startAt, version: d.version, hosts: d.hosts }}
          timeZone={timeZone}
          today={today}
          hostNames={hostNames}
          onClose={() => setMoveOpen(false)}
          onMoved={refresh}
        />
      )}
    </Sheet>
  );
}
