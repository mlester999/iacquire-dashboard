"use client";

import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle, CalendarCheck2, Link2Off, RefreshCw, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, Select } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { cn, relativeTime } from "@/lib/utils";
import { disconnectCalendarAction, syncCalendarNowAction, updateCalendarConnectionAction } from "@/app/actions/crm-calendar-connections";
import { connectionStatus, providerName } from "@/components/crm/scheduling/connections/status";
import { ProviderMark } from "@/components/crm/scheduling/connections/provider-mark";
import type { CalendarConnectionSettings, ConnectionView } from "@/server/calendars/connections";
import type { CrmScope } from "@/server/crm/page";

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * One of the person's own connected calendars: its honest status, which of its calendars count as busy, where appointments they host
 * are added, and sync / reconnect / disconnect. Changes are saved together with one button, so a half-made choice is never applied.
 */
export function ConnectionCard({ scope, connection: c, settings, renderedAt, onReconnect }: {
  scope: CrmScope;
  connection: ConnectionView;
  settings: CalendarConnectionSettings;
  renderedAt: number;
  /** For CalDAV and ICS, reconnecting means entering the password or link again. */
  onReconnect: (c: ConnectionView) => void;
}) {
  const { run, busy } = useCrmAction();
  const editable = !scope.readOnly && !scope.agency && !!scope.can["calendars.connect"];
  const status = connectionStatus(c, renderedAt);
  const [checkConflicts, setCheckConflicts] = React.useState(c.checkConflicts);
  const [conflictIds, setConflictIds] = React.useState<string[]>(c.conflictCalendarIds);
  const writable = c.calendars.filter((x) => x.canWrite);
  const [writeEvents, setWriteEvents] = React.useState(c.writeEvents);
  const [writeCalendarId, setWriteCalendarId] = React.useState<string>(c.writeCalendarId ?? writable.find((x) => x.primary)?.id ?? writable[0]?.id ?? "");
  const [confirm, setConfirm] = React.useState(false);
  // When the server data changes (after a save or a sync), start again from it.
  const signature = `${c.checkConflicts}|${c.conflictCalendarIds.join(",")}|${c.writeEvents}|${c.writeCalendarId ?? ""}`;
  const [seen, setSeen] = React.useState(signature);
  if (seen !== signature) {
    setSeen(signature);
    setCheckConflicts(c.checkConflicts);
    setConflictIds(c.conflictCalendarIds);
    setWriteEvents(c.writeEvents);
    setWriteCalendarId(c.writeCalendarId ?? writable.find((x) => x.primary)?.id ?? writable[0]?.id ?? "");
  }
  const dirty = checkConflicts !== c.checkConflicts || !sameSet(conflictIds, c.conflictCalendarIds) || writeEvents !== c.writeEvents || (writeEvents && writeCalendarId !== (c.writeCalendarId ?? ""));
  const invalid = checkConflicts && conflictIds.length === 0 ? "Choose at least one calendar, or turn conflict checking off." : writeEvents && !writeCalendarId ? "Choose the calendar to add appointments to." : null;
  const live = c.status === "connected" || c.status === "error";
  const oauth = c.provider === "google" || c.provider === "microsoft";
  const name = providerName(c);
  const groupId = React.useId();
  const minutes = c.provider === "ics" ? settings.icsMinutes : settings.syncMinutes;

  const save = () =>
    run(`save-${c.id}`, () => updateCalendarConnectionAction(scope.orgId, c.id, { checkConflicts, conflictCalendarIds: conflictIds, writeEvents, writeCalendarId: writeEvents ? writeCalendarId : null }), "Calendar settings saved.");

  const syncNow = async () => {
    const r = await run(`sync-${c.id}`, () => syncCalendarNowAction(scope.orgId, c.id));
    if (!r) return;
    if (r.status === "ok") toast.success(`Synced: ${r.busy ?? 0} busy ${r.busy === 1 ? "time" : "times"} found.`);
    else if (r.status === "unchanged") toast.success("Synced: nothing changed since the last sync.");
    else toast.error(r.error ?? "The calendar couldn't be read. It will be retried automatically.");
  };

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <ProviderMark provider={c.provider} icloud={name === "Apple iCloud"} />
          <div className="min-w-0">
            <h4 className="truncate text-[14.5px] font-semibold text-ink">{c.accountLabel}</h4>
            <p className="text-[12.5px] text-muted">
              {name} · {c.provider === "ics" ? `read-only, updates about every ${minutes} minutes (not instant)` : `checked about every ${minutes} minutes`}
            </p>
          </div>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>

      <div className="space-y-5 px-4 py-4 sm:px-5">
        <p className={cn("text-[13px] leading-relaxed", status.tone === "danger" ? "text-danger-ink" : "text-ink-2")}>{status.detail}</p>
        {c.lastError && c.status !== "needs_reauth" && (
          <p className="flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2 text-[12.5px] text-warning-ink">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>Last problem{c.lastSyncedAt ? ` (${relativeTime(c.lastSyncedAt, renderedAt)})` : ""}: {c.lastError}</span>
          </p>
        )}

        {live && (
          <fieldset className="space-y-3" disabled={!editable} aria-labelledby={`${groupId}-conflicts`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[13.5px] font-medium text-ink" id={`${groupId}-conflicts`}>Check for conflicts</p>
                <p className="text-[12.5px] text-muted">Busy times on the calendars you tick are kept off your booking pages. Only start and end times are stored.</p>
              </div>
              <Switch checked={checkConflicts} onCheckedChange={setCheckConflicts} aria-labelledby={`${groupId}-conflicts`} className="mt-0.5" />
            </div>
            {checkConflicts && (
              <ul className="grid gap-1.5 sm:grid-cols-2" aria-labelledby={`${groupId}-conflicts`}>
                {c.calendars.map((cal) => {
                  const id = `${groupId}-cal-${cal.id}`;
                  const on = conflictIds.includes(cal.id);
                  return (
                    <li key={cal.id}>
                      <label htmlFor={id} className={cn("flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-[13px] transition sm:min-h-10", on ? "border-primary/40 bg-primary-soft/50" : "border-line hover:bg-surface-2")}>
                        <input id={id} type="checkbox" className="size-4 accent-primary" checked={on} onChange={(e) => setConflictIds((prev) => (e.target.checked ? [...prev, cal.id] : prev.filter((x) => x !== cal.id)))} />
                        <span className="min-w-0 flex-1 truncate text-ink">{cal.name}</span>
                        {cal.primary && <span className="inline-flex items-center gap-1 text-[12px] text-muted"><Star className="size-3" aria-hidden />Main</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
        )}

        {live && (
          <div className="space-y-3 border-t border-line pt-4">
            {c.provider === "ics" ? (
              <p className="text-[12.5px] text-muted">A feed is read-only: iAcquire can&apos;t add appointments to it. Connect the calendar itself (Google, Microsoft, iCloud or CalDAV) if you want bookings to appear there.</p>
            ) : !c.canWriteEvents ? (
              <p className="text-[12.5px] text-muted">This connection wasn&apos;t given permission to add events. Reconnect and allow calendar access if you want your appointments added to it.</p>
            ) : (
              <fieldset className="space-y-3" disabled={!editable} aria-labelledby={`${groupId}-write`}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[13.5px] font-medium text-ink" id={`${groupId}-write`}>Add appointments I host to this calendar</p>
                    <p className="text-[12.5px] text-muted">
                      New, moved and cancelled bookings are updated within a few minutes. Only the type, the customer&apos;s first name, the time and the location are written, never their answers or contact details.
                      {c.provider === "google" && " Appointment types set to Google Meet get a Meet link from Google."}
                      {c.provider === "microsoft" && " Appointment types set to Microsoft Teams get a Teams link where your Microsoft 365 account allows it."}
                      {c.provider === "caldav" && " CalDAV can't create meeting links."}
                    </p>
                  </div>
                  <Switch checked={writeEvents} onCheckedChange={setWriteEvents} aria-labelledby={`${groupId}-write`} className="mt-0.5" />
                </div>
                {writeEvents && (
                  <div className="max-w-sm">
                    <label htmlFor={`${groupId}-target`} className="text-[12.5px] font-medium text-ink-2">Calendar to add them to</label>
                    <Select id={`${groupId}-target`} className="mt-1" value={writeCalendarId} onChange={(e) => setWriteCalendarId(e.target.value)}>
                      {!writable.length && <option value="">No calendar here accepts new events</option>}
                      {writable.map((cal) => <option key={cal.id} value={cal.id}>{cal.name}{cal.primary ? " (main)" : ""}</option>)}
                    </Select>
                  </div>
                )}
                {c.writeEvents && !writeEvents && <p className="text-[12.5px] text-muted">Turning this off stops all changes to this calendar. Appointments already added stay as they are.</p>}
              </fieldset>
            )}
          </div>
        )}

        {editable && live && (dirty || invalid) && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {invalid && <p role="alert" className="mr-auto text-[12.5px] text-danger-ink">{invalid}</p>}
            <Button variant="secondary" size="sm" onClick={() => setSeen("")}>Undo changes</Button>
            <Button size="sm" disabled={!dirty || !!invalid} loading={busy(`save-${c.id}`)} onClick={save}>Save changes</Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface-2/60 px-4 py-3 sm:px-5">
        {editable && live && (
          <Button variant="secondary" size="sm" disabled={settings.syncPaused} loading={busy(`sync-${c.id}`)} onClick={syncNow}>
            <RefreshCw className="size-3.5" aria-hidden />Sync now
          </Button>
        )}
        {editable && (c.status === "needs_reauth" || c.status === "error") && (
          oauth ? (
            <a href={`/api/crm/calendar-oauth/${c.provider}/start?return=${encodeURIComponent("/crm/calendar-connections")}`} className="inline-flex h-11 items-center gap-2 rounded-xl bg-ink px-3 text-[13px] font-medium text-surface shadow-soft transition hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-8">
              <CalendarCheck2 className="size-3.5" aria-hidden />Reconnect
            </a>
          ) : (
            <Button size="sm" onClick={() => onReconnect(c)}><CalendarCheck2 className="size-3.5" aria-hidden />Reconnect</Button>
          )
        )}
        <span className="flex-1" />
        {!scope.readOnly && !scope.agency && (
          <Button variant="ghost" size="sm" className="text-danger-ink hover:bg-danger-soft" onClick={() => setConfirm(true)}>
            <Link2Off className="size-3.5" aria-hidden />Disconnect
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Disconnect ${c.accountLabel}?`}
        danger
        confirmLabel="Disconnect"
        loading={busy(`disconnect-${c.id}`)}
        description="Its busy times stop counting straight away and are deleted. iAcquire stops adding appointments to it; events it already added stay in your calendar."
        onConfirm={async () => {
          const r = await run(`disconnect-${c.id}`, () => disconnectCalendarAction(scope.orgId, c.id), (d) => (d.revoked ? "Disconnected, and iAcquire's access was revoked at Google." : c.provider === "microsoft" ? "Disconnected. You can also remove iAcquire from your Microsoft account's app permissions." : "Disconnected."));
          if (r) setConfirm(false);
        }}
      >
        {c.provider === "caldav" && <p className="text-[12.5px] text-muted">The app-specific password is deleted from iAcquire. You can also revoke it in your account settings.</p>}
      </ConfirmDialog>
    </Card>
  );
}
