"use client";

import * as React from "react";
import { Check, ChevronLeft, ChevronRight, CircleAlert, Globe, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { addDays, weekdayOf, zonedDate } from "@/lib/calendars/slots";
import { formatDayHeading, formatMonth, formatTime, zoneCity, zoneOffset } from "./time";

export interface PublicSlot {
  start: string;
  end: string;
  remaining: number | null;
}

export type SlotSource = { kind: "page"; org: string; calendar: string; type: string } | { kind: "manage"; token: string };

const noop = () => () => {};

/** True once the component runs in the browser (false during server rendering and hydration). */
export function useMounted(): boolean {
  return React.useSyncExternalStore(noop, () => true, () => false);
}

/** The visitor's own time zone as their browser reports it, or null on the server. */
export function useDetectedTimeZone(): string | null {
  return React.useSyncExternalStore(
    noop,
    () => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
      } catch {
        return null;
      }
    },
    () => null,
  );
}

const FALLBACK_ZONES = [
  "UTC", "Asia/Manila", "Asia/Singapore", "Asia/Hong_Kong", "Asia/Tokyo", "Asia/Seoul", "Asia/Shanghai", "Asia/Kolkata", "Asia/Dubai", "Asia/Jakarta", "Asia/Bangkok",
  "Australia/Sydney", "Australia/Perth", "Pacific/Auckland", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "America/New_York", "America/Chicago",
  "America/Denver", "America/Los_Angeles", "America/Toronto", "America/Mexico_City", "America/Sao_Paulo", "Africa/Johannesburg", "Pacific/Honolulu",
];

function allZones(): string[] {
  try {
    const list = Intl.supportedValuesOf("timeZone");
    return list.length ? list : FALLBACK_ZONES;
  } catch {
    return FALLBACK_ZONES;
  }
}

/** A native, searchable-by-typing list of time zones, with the visitor's and the business's own at the top. */
export function TimeZoneSelect({ id, value, onChange, suggested }: { id: string; value: string; onChange: (tz: string) => void; suggested: Array<string | null | undefined> }) {
  const mounted = useMounted();
  const zones = React.useMemo(() => (mounted ? allZones() : []), [mounted]);
  const top = [...new Set([value, ...suggested].filter((z): z is string => Boolean(z)))];
  const label = (z: string) => `${zoneCity(z)} (${zoneOffset(z)})`;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Globe className="size-4 shrink-0 text-muted" aria-hidden />
      <label htmlFor={id} className="sr-only">Time zone</label>
      <div className="min-w-0 flex-1">
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="sm:h-9 sm:text-[13px]">
          {mounted ? (
            <>
              <optgroup label="Suggested">
                {top.map((z) => <option key={`s-${z}`} value={z}>{label(z)}</option>)}
              </optgroup>
              <optgroup label="All time zones">
                {zones.filter((z) => !top.includes(z)).map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")} ({zoneOffset(z)})</option>)}
              </optgroup>
            </>
          ) : (
            <option value={value}>{zoneCity(value)}</option>
          )}
        </Select>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Month grid and times
// ---------------------------------------------------------------------------

const MAX_CHUNK = 14;
const WEEKDAYS = [["Sun", "Sunday"], ["Mon", "Monday"], ["Tue", "Tuesday"], ["Wed", "Wednesday"], ["Thu", "Thursday"], ["Fri", "Friday"], ["Sat", "Saturday"]];

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m0: number, d: number) => `${y}-${pad(m0 + 1)}-${pad(d)}`;
const daysIn = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
const monthOf = (date: string) => ({ y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)) - 1 });
const shiftMonth = (v: { y: number; m: number }, by: number) => {
  const t = v.y * 12 + v.m + by;
  return { y: Math.floor(t / 12), m: ((t % 12) + 12) % 12 };
};

/** The visible month's bookable dates in windows the API accepts (at most 14 days each). */
function windowsFor(first: string, last: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let from = first; from <= last; from = addDays(from, MAX_CHUNK)) {
    const to = addDays(from, MAX_CHUNK - 1);
    out.push([from, to < last ? to : last]);
  }
  return out;
}

function slotsUrl(source: SlotSource, from: string, to: string, tz: string): string {
  const q = new URLSearchParams(source.kind === "page" ? { org: source.org, calendar: source.calendar, type: source.type } : { token: source.token });
  q.set("from", from);
  q.set("to", to);
  q.set("tz", tz);
  return `/api/public/booking/slots?${q.toString()}`;
}

type Loaded = PublicSlot[] | { error: string };

/**
 * Today and the last bookable day in a time zone, worked out from the server's render time rather than the device's clock, so the HTML
 * the server sends and the browser's first render agree even when the page is rendered just before midnight and opened just after.
 */
export function bookingWindow(renderedAt: number, timeZone: string, maxDaysAhead: number): { today: string; horizon: string } {
  const today = zonedDate(renderedAt, timeZone);
  return { today, horizon: addDays(today, Math.max(1, maxDaysAhead)) };
}

export function SlotPicker({
  idPrefix, source, timeZone, maxDaysAhead, renderedAt, selected, onSelect, capacity, currentStart, reloadKey = 0, heading = "Choose a date and time",
}: {
  idPrefix: string;
  source: SlotSource;
  timeZone: string;
  maxDaysAhead: number;
  /** When the server rendered the page (ms since the epoch): today comes from it, never from Date.now() during rendering. */
  renderedAt: number;
  selected: PublicSlot | null;
  onSelect: (slot: PublicSlot) => void;
  capacity: number;
  /** When moving a booking: its current time, shown but not selectable. */
  currentStart?: string | null;
  /** Change it to drop what was loaded (for example after a time was just taken). */
  reloadKey?: number;
  heading?: string;
}) {
  const { today, horizon } = bookingWindow(renderedAt, timeZone, maxDaysAhead);
  const [view, setView] = React.useState(() => monthOf(today));
  const [picked, setPicked] = React.useState<string | null>(null);
  const [focusDay, setFocusDay] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState<Record<string, Loaded>>({});
  const [attempt, setAttempt] = React.useState(0);
  const inflight = React.useRef(new Set<string>());
  const done = React.useRef(new Set<string>());
  const alive = React.useRef(true);
  const wantFocus = React.useRef(false);
  const dayRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const sourceKey = source.kind === "page" ? `${source.org}/${source.calendar}/${source.type}` : `m:${source.token}`;

  const minMonth = monthOf(today);
  const maxMonth = monthOf(horizon);
  const monthFirst = ymd(view.y, view.m, 1);
  const monthLast = ymd(view.y, view.m, daysIn(view.y, view.m));
  const first = monthFirst < today ? today : monthFirst;
  const last = monthLast > horizon ? horizon : monthLast;
  const keyOf = (from: string, to: string) => `${reloadKey}|${sourceKey}|${timeZone}|${from}|${to}`;
  const keys = (first <= last ? windowsFor(first, last) : []).map(([f, t]) => keyOf(f, t));

  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Each window is asked for once per time zone and reload; answers are kept, so moving between months is instant.
  React.useEffect(() => {
    if (first > last) return;
    for (const [from, to] of windowsFor(first, last)) {
      const key = `${reloadKey}|${sourceKey}|${timeZone}|${from}|${to}`;
      if (done.current.has(key) || inflight.current.has(key)) continue;
      inflight.current.add(key);
      fetch(slotsUrl(source, from, to, timeZone), { headers: { accept: "application/json" }, cache: "no-store" })
        .then(async (res): Promise<Loaded> => {
          const json = (await res.json().catch(() => null)) as { ok?: boolean; slots?: PublicSlot[]; error?: string } | null;
          return res.ok && json?.ok && Array.isArray(json.slots) ? json.slots : { error: json?.error ?? "Times couldn't be loaded." };
        })
        .catch((): Loaded => ({ error: "Times couldn't be loaded. Check your connection and try again." }))
        .then((value) => {
          inflight.current.delete(key);
          done.current.add(key);
          if (alive.current) setLoaded((prev) => ({ ...prev, [key]: value }));
        });
    }
  }, [first, last, timeZone, reloadKey, sourceKey, source, attempt]);

  const results = keys.map((k) => loaded[k]);
  const loading = results.some((r) => r === undefined);
  const failure = results.find((r): r is { error: string } => r !== undefined && !Array.isArray(r));
  const byDay = new Map<string, PublicSlot[]>();
  for (const r of results) {
    if (!Array.isArray(r)) continue;
    for (const s of r) {
      const d = zonedDate(new Date(s.start).getTime(), timeZone);
      if (d < first || d > last) continue;
      byDay.set(d, [...(byDay.get(d) ?? []), s]);
    }
  }
  const available = [...byDay.keys()].sort();
  const pickedOpen = picked !== null && picked >= monthFirst && picked <= monthLast && byDay.has(picked);
  const day = pickedOpen ? picked : !loading ? available[0] ?? null : null;
  const daySlots = day ? byDay.get(day) ?? [] : [];
  const focusTarget = focusDay && focusDay >= monthFirst && focusDay <= monthLast ? focusDay : day ?? (today >= monthFirst && today <= monthLast ? today : monthFirst);

  React.useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    dayRefs.current.get(focusTarget)?.focus();
  }, [focusTarget]);

  const canPrev = view.y * 12 + view.m > minMonth.y * 12 + minMonth.m;
  const canNext = view.y * 12 + view.m < maxMonth.y * 12 + maxMonth.m;
  const goMonth = (by: number) => {
    const next = shiftMonth(view, by);
    if (next.y * 12 + next.m < minMonth.y * 12 + minMonth.m || next.y * 12 + next.m > maxMonth.y * 12 + maxMonth.m) return;
    setView(next);
    setFocusDay(null);
  };
  const moveFocus = (to: string) => {
    if (to < ymd(minMonth.y, minMonth.m, 1) || to > ymd(maxMonth.y, maxMonth.m, daysIn(maxMonth.y, maxMonth.m))) return;
    wantFocus.current = true;
    setFocusDay(to);
    const mo = monthOf(to);
    if (mo.y !== view.y || mo.m !== view.m) setView(mo);
  };
  const onGridKey = (e: React.KeyboardEvent, date: string) => {
    const wd = weekdayOf(date);
    const step: Record<string, () => string> = {
      ArrowLeft: () => addDays(date, -1), ArrowRight: () => addDays(date, 1), ArrowUp: () => addDays(date, -7), ArrowDown: () => addDays(date, 7),
      Home: () => addDays(date, -wd), End: () => addDays(date, 6 - wd),
      PageUp: () => { const m = shiftMonth(monthOf(date), -1); return ymd(m.y, m.m, Math.min(Number(date.slice(8)), daysIn(m.y, m.m))); },
      PageDown: () => { const m = shiftMonth(monthOf(date), 1); return ymd(m.y, m.m, Math.min(Number(date.slice(8)), daysIn(m.y, m.m))); },
    };
    const f = step[e.key];
    if (!f) return;
    e.preventDefault();
    moveFocus(f());
  };
  const choose = (date: string) => {
    if (!byDay.get(date)?.length) return;
    setPicked(date);
    setFocusDay(date);
  };

  // Weeks for the grid, Sunday first.
  const cells: Array<string | null> = [...Array(weekdayOf(monthFirst)).fill(null)];
  for (let d = 1; d <= daysIn(view.y, view.m); d++) cells.push(ymd(view.y, view.m, d));
  while (cells.length % 7) cells.push(null);
  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const status = failure ? failure.error : loading ? "Loading open times…" : day ? `${daySlots.length} ${daySlots.length === 1 ? "time" : "times"} open on ${formatDayHeading(day)}.` : available.length ? "" : `No open times in ${formatMonth(view.y, view.m)}.`;
  const retry = () => {
    for (const k of keys) if (loaded[k] && !Array.isArray(loaded[k])) done.current.delete(k);
    setLoaded((prev) => Object.fromEntries(Object.entries(prev).filter(([, v]) => Array.isArray(v))));
    setAttempt((n) => n + 1);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_15rem] lg:gap-8">
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-3">
          <h2 id={`${idPrefix}-month`} className="text-[15px] font-semibold tracking-tight text-ink">
            <span className="sr-only">{heading}: </span>{formatMonth(view.y, view.m)}
          </h2>
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => goMonth(-1)} disabled={!canPrev} aria-label="Previous month"><ChevronLeft className="size-4" aria-hidden /></Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => goMonth(1)} disabled={!canNext} aria-label="Next month"><ChevronRight className="size-4" aria-hidden /></Button>
          </div>
        </div>
        <table role="grid" aria-labelledby={`${idPrefix}-month`} className="mt-3 w-full table-fixed border-separate border-spacing-y-1">
          <thead>
            <tr>
              {WEEKDAYS.map(([short, long]) => (
                <th key={short} scope="col" abbr={long} className="pb-1 text-center text-[12px] font-medium uppercase tracking-wide text-muted">{short.slice(0, 2)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week, wi) => (
              <tr key={wi}>
                {week.map((date, di) => {
                  if (!date) return <td key={`x${di}`} />;
                  const count = byDay.get(date)?.length ?? 0;
                  const inWindow = date >= first && date <= last;
                  const open = inWindow && count > 0;
                  const isSel = date === day;
                  const isToday = date === today;
                  const label = `${formatDayHeading(date)}${isToday ? ", today" : ""}. ${!inWindow ? "Not bookable." : loading && !count ? "Loading." : count ? `${count} ${count === 1 ? "time" : "times"} open.` : "No open times."}`;
                  return (
                    <td key={date} role="gridcell" aria-selected={isSel} className="p-0 text-center">
                      <button
                        ref={(el) => {
                          if (el) dayRefs.current.set(date, el);
                          else dayRefs.current.delete(date);
                        }}
                        type="button"
                        tabIndex={date === focusTarget ? 0 : -1}
                        aria-label={label}
                        aria-disabled={!open}
                        aria-current={isToday ? "date" : undefined}
                        onClick={() => choose(date)}
                        onKeyDown={(e) => onGridKey(e, date)}
                        className={cn(
                          "relative mx-auto flex size-11 flex-col items-center justify-center rounded-full text-[14px] tabular-nums outline-none transition-colors sm:size-10",
                          "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
                          isSel ? "bg-primary font-semibold text-primary-on" : open ? "bg-primary-soft font-semibold text-primary-ink hover:bg-primary/15" : "cursor-default text-faint",
                          loading && inWindow && !count && "animate-pulse",
                        )}
                      >
                        {Number(date.slice(8))}
                        {isToday && <span aria-hidden className={cn("absolute bottom-1.5 size-1 rounded-full", isSel ? "bg-white" : "bg-current")} />}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !failure && !available.length && (
          <div className="mt-3 rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13px] text-ink-2">
            {canNext ? (
              <span className="flex flex-wrap items-center justify-between gap-2">
                No open times in {formatMonth(view.y, view.m)}.
                <Button type="button" variant="secondary" size="sm" onClick={() => goMonth(1)}>Check next month</Button>
              </span>
            ) : (
              "There are no open times left in the booking window. Please check back later."
            )}
          </div>
        )}
      </div>

      <div className="min-w-0 lg:border-l lg:border-line lg:pl-8">
        <h3 className="text-[14px] font-semibold text-ink">{day ? formatDayHeading(day) : "Times"}</h3>
        <p className="mt-0.5 text-[12.5px] text-muted">{zoneCity(timeZone)} time ({zoneOffset(timeZone)})</p>
        <p role="status" aria-live="polite" className="sr-only">{status}</p>
        {failure ? (
          <div className="mt-3 rounded-xl border border-danger/20 bg-danger-soft px-3 py-3 text-[13px] text-danger-ink" role="alert">
            <p className="flex items-start gap-2"><CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{failure.error}</p>
            <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={retry}>Try again</Button>
          </div>
        ) : loading && !daySlots.length ? (
          <p className="mt-4 flex items-center gap-2 text-[13px] text-muted"><Loader2 className="size-4 animate-spin" aria-hidden />Loading open times…</p>
        ) : !day ? (
          <p className="mt-4 text-[13px] text-muted">{available.length ? "Choose a date to see its times." : "No times to show."}</p>
        ) : (
          <ul className="mt-3 grid max-h-[26rem] grid-cols-2 gap-2 overflow-y-auto pb-1 pr-1 scrollbar-thin sm:grid-cols-3 lg:grid-cols-1" aria-label={`Open times on ${formatDayHeading(day)}`}>
            {daySlots.map((s) => {
              const isSel = selected?.start === s.start;
              const isCurrent = currentStart === s.start;
              return (
                <li key={s.start}>
                  <button
                    type="button"
                    aria-pressed={isSel}
                    disabled={isCurrent}
                    onClick={() => onSelect(s)}
                    className={cn(
                      "flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border px-3 text-[14px] font-medium tabular-nums transition-colors sm:min-h-10",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                      isSel ? "border-primary bg-primary-soft text-primary-ink" : "border-line-strong bg-surface text-ink hover:border-primary/60 hover:bg-primary-soft/50",
                      isCurrent && "cursor-not-allowed border-dashed bg-surface-2 text-muted hover:bg-surface-2",
                    )}
                  >
                    {isSel && <Check className="size-4" aria-hidden />}
                    <span>{formatTime(s.start, timeZone)}</span>
                    {isCurrent && <span className="text-[12px] font-normal">· current</span>}
                    {!isCurrent && capacity > 1 && s.remaining !== null && <span className="text-[12px] font-normal text-muted">· {s.remaining} left</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
