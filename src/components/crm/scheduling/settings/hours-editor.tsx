"use client";

import * as React from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Select } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { setHostAvailabilityAction } from "@/app/actions/crm-calendar-settings";
import { useCrmAction } from "@/components/crm/ui";
import { SettingRow } from "@/components/crm/scheduling/settings/shared";
import {
  copyToWorkdays, dayProblem, minuteLabel, rangeLabel, sameRules, sortRules, timeOptions, WEEK_ORDER, WEEKDAY_NAMES, WORKDAYS, type Range, type WeeklyRange,
} from "@/components/crm/scheduling/settings/hours";
import type { HostAvailability } from "@/server/calendars/setup";
import type { CrmScope } from "@/server/crm/page";

/** A start/end pair of time selects. Times are in the person's own time zone. */
export function RangeSelects({ id, range, onChange, label }: { id: string; range: Range; onChange: (r: Range) => void; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1 sm:w-36 sm:flex-none">
        <label htmlFor={`${id}-s`} className="sr-only">{label} start</label>
        <Select id={`${id}-s`} value={String(range.startMinute)} onChange={(e) => onChange({ ...range, startMinute: Number(e.target.value) })}>
          {timeOptions("start", 15, range.startMinute).map((m) => <option key={m} value={m}>{minuteLabel(m)}</option>)}
        </Select>
      </div>
      <span className="text-[13px] text-muted" aria-hidden>to</span>
      <div className="min-w-0 flex-1 sm:w-36 sm:flex-none">
        <label htmlFor={`${id}-e`} className="sr-only">{label} end</label>
        <Select id={`${id}-e`} value={String(range.endMinute)} onChange={(e) => onChange({ ...range, endMinute: Number(e.target.value) })}>
          {timeOptions("end", 15, range.endMinute).map((m) => <option key={m} value={m}>{minuteLabel(m)}</option>)}
        </Select>
      </div>
    </div>
  );
}

const noSubscribe = () => () => {};
function deviceZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** The next free hour after a day's last range, or null when the day is full. */
function nextRange(ranges: Range[]): Range | null {
  if (!ranges.length) return { startMinute: 9 * 60, endMinute: 17 * 60 };
  const last = Math.max(...ranges.map((r) => r.endMinute));
  const start = Math.min(last + 60, 1380);
  if (start < last || start + 15 > 1440) return null;
  return { startMinute: start, endMinute: Math.min(start + 60, 1440) };
}

const NINE_TO_FIVE: WeeklyRange[] = WORKDAYS.map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 }));

/**
 * One person's weekly hours: a time zone, whether they take new bookings, and any number of ranges per day. Saved as a whole, so a
 * half-edited week is never live. Read-only when the viewer may not change this person's hours.
 */
export function HoursEditor({ scope, host, editable, timeZones, isMe }: { scope: CrmScope; host: HostAvailability; editable: boolean; timeZones: string[]; isMe: boolean }) {
  const { run, busy } = useCrmAction();
  const [timezone, setTimezone] = React.useState(host.timezone);
  const [accepting, setAccepting] = React.useState(host.accepting);
  const [rules, setRules] = React.useState<WeeklyRange[]>(sortRules(host.rules));
  // The browser's zone, which the server can't know: null while server rendering, so the first client render matches it.
  const device = React.useSyncExternalStore(noSubscribe, deviceZone, () => null);
  const zones = timeZones.includes(timezone) ? timeZones : [timezone, ...timeZones];
  const dirty = timezone !== host.timezone || accepting !== host.accepting || !sameRules(rules, host.rules);
  const problems = new Map<number, string>();
  for (const d of WEEK_ORDER) {
    const p = dayProblem(rules.filter((r) => r.weekday === d));
    if (p) problems.set(d, p);
  }
  const id = `hours-${host.userId}`;
  const who = isMe ? "your" : `${host.name}'s`;

  // Ranges keep the order they were added in while editing, so a row doesn't jump away from the control being used.
  const setDay = (weekday: number, ranges: Range[]) => setRules((rs) => [...rs.filter((r) => r.weekday !== weekday), ...ranges.map((r) => ({ ...r, weekday }))]);

  if (!editable) {
    return (
      <div className="space-y-3">
        <p className="text-[12.5px] text-muted">Times are in {host.timezone}. {host.accepting ? "Taking new bookings." : "New bookings are paused."}</p>
        <dl className="divide-y divide-line rounded-xl border border-line">
          {WEEK_ORDER.map((d) => {
            const day = rules.filter((r) => r.weekday === d);
            return (
              <div key={d} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2 text-[13px]">
                <dt className="font-medium text-ink-2">{WEEKDAY_NAMES[d]}</dt>
                <dd className={cn("text-right", day.length ? "text-ink" : "text-faint")}>{day.length ? day.map(rangeLabel).join(", ") : "Unavailable"}</dd>
              </div>
            );
          })}
        </dl>
      </div>
    );
  }

  return (
    <form
      className="space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        if (problems.size) return;
        await run("save", () => setHostAvailabilityAction(scope.orgId, host.userId, { timezone, accepting, rules: rules.map((r) => ({ weekday: r.weekday, startMinute: r.startMinute, endMinute: r.endMinute })) }), isMe ? "Your hours are saved." : `${host.name}'s hours are saved.`);
      }}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-tz`} className="text-[13px] font-medium text-ink-2">Time zone</label>
          <Select id={`${id}-tz`} value={timezone} onChange={(e) => setTimezone(e.target.value)} aria-describedby={`${id}-tz-hint`}>
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
          </Select>
          <div id={`${id}-tz-hint`} className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted">
            <span>The hours below are in this zone.</span>
            {isMe && device && device !== timezone && zones.includes(device) && (
              <button type="button" className="font-medium text-primary hover:underline" onClick={() => setTimezone(device)}>Use this device&apos;s ({device.replace(/_/g, " ")})</button>
            )}
          </div>
        </div>
        <div className="rounded-xl border border-line p-3">
          <SettingRow id={`${id}-acc`} label="Taking new bookings" hint="Turn off to pause new bookings on every calendar. Appointments already booked stay."
            control={<Switch id={`${id}-acc`} checked={accepting} onCheckedChange={setAccepting} aria-describedby={`${id}-acc-hint`} />} />
        </div>
      </div>

      {!host.configured && !rules.length && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2.5 text-[12.5px] text-warning-ink">
          <span>{isMe ? "You have" : `${host.name} has`} no working hours yet, so no times can be offered for {isMe ? "you" : "them"}.</span>
          <Button type="button" size="sm" variant="secondary" onClick={() => setRules(NINE_TO_FIVE)}>Fill in 9 to 5, Monday to Friday</Button>
        </div>
      )}

      <fieldset>
        <legend className="sr-only">Weekly hours</legend>
        <ul className="divide-y divide-line rounded-xl border border-line">
          {WEEK_ORDER.map((d) => {
            const day = rules.filter((r) => r.weekday === d);
            const open = day.length > 0;
            const problem = problems.get(d);
            const next = nextRange(day);
            const dayId = `${id}-d${d}`;
            return (
              <li key={d} className="grid gap-2 px-3 py-3 sm:grid-cols-[150px_minmax(0,1fr)_auto] sm:items-start">
                <label className="flex min-h-11 items-center gap-2.5 text-[13px] font-medium text-ink sm:min-h-10">
                  <input type="checkbox" className="size-4 accent-primary" checked={open} onChange={(e) => setDay(d, e.target.checked ? [{ startMinute: 540, endMinute: 1020 }] : [])} />
                  <span id={`${dayId}-name`}>{WEEKDAY_NAMES[d]}</span>
                </label>
                <div className="min-w-0 space-y-2" role="group" aria-labelledby={`${dayId}-name`}>
                  {open ? (
                    day.map((r, i) => (
                      <div key={i} className="flex min-w-0 items-center gap-1">
                        <RangeSelects id={`${dayId}-r${i}`} range={r} label={`${WEEKDAY_NAMES[d]} range ${i + 1}`} onChange={(nr) => setDay(d, day.map((x, j) => (j === i ? nr : x)))} />
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${WEEKDAY_NAMES[d]} ${rangeLabel(r)}`} onClick={() => setDay(d, day.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
                      </div>
                    ))
                  ) : (
                    <p className="flex min-h-11 items-center text-[13px] text-faint sm:min-h-10">Unavailable</p>
                  )}
                  {problem && <p role="alert" className="text-[12.5px] text-danger-ink">{problem}</p>}
                </div>
                {open && (
                  <div className="flex flex-wrap items-center gap-1 sm:justify-end">
                    <Button type="button" variant="ghost" size="sm" disabled={!next} onClick={() => next && setDay(d, [...day, next])} aria-label={`Add range on ${WEEKDAY_NAMES[d]}`}><Plus className="size-4" /><span className="sm:hidden xl:inline">Add range</span></Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setRules((rs) => copyToWorkdays(rs, d))} aria-label={`Copy to weekdays: ${WEEKDAY_NAMES[d]}'s hours onto Monday to Friday`}><Copy className="size-4" /><span className="sm:hidden xl:inline">Copy to weekdays</span></Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {dirty && <Badge tone="warning">Unsaved changes</Badge>}
        <Button type="button" variant="secondary" disabled={!dirty} onClick={() => { setTimezone(host.timezone); setAccepting(host.accepting); setRules(sortRules(host.rules)); }}>Discard</Button>
        <Button type="submit" disabled={!dirty || problems.size > 0} loading={busy("save")}>Save {who} hours</Button>
      </div>
    </form>
  );
}
