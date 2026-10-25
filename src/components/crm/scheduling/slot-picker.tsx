"use client";

import * as React from "react";
import { CalendarSearch, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { addDays, zonedDate, zonedToInstant } from "@/lib/calendars/slots";
import { formatDay, isDateKey } from "@/components/crm/scheduling/calendar-math";
import { timeIn, zoneCity, zoneOffset } from "@/components/crm/scheduling/format";
import { useLatest } from "@/components/crm/scheduling/bits";
import type { ActionResult } from "@/components/crm/ui";

export interface PickerSlot {
  start: string;
  end: string;
  hostIds: string[];
  remaining: number | null;
  keepsHost?: boolean;
}

const WINDOW_DAYS = 7;

/**
 * Picks a real free time: it loads a week of the times the server would actually accept (computeSlots), shows the days that have any,
 * and lists that day's start times as a radio group. Nothing here invents availability; when a week has none it says so.
 */
export function SlotPicker({
  id, timeZone, initialDate, today, load, loadKey, value, onChange, hostNames, currentStart, showHost,
}: {
  id: string;
  timeZone: string;
  initialDate: string;
  today: string;
  load: (from: string, to: string) => Promise<ActionResult<PickerSlot[]>>;
  /** Changes when what the times depend on changes (the type, the chosen host); the picker reloads and clears the choice. */
  loadKey: string;
  value: string | null;
  onChange: (slot: PickerSlot | null) => void;
  hostNames: Record<string, string>;
  /** A rescheduled appointment's current start, marked in the list. */
  currentStart?: string | null;
  /** Show who the time is with (round robin). */
  showHost?: boolean;
}) {
  const [start, setStart] = React.useState(() => (initialDate < today ? today : initialDate));
  const [day, setDay] = React.useState<string | null>(initialDate < today ? today : initialDate);
  const [result, setResult] = React.useState<{ key: string; slots?: PickerSlot[]; error?: string } | null>(null);
  const loader = useLatest(load);
  const reqKey = `${loadKey}|${start}|${timeZone}`;

  React.useEffect(() => {
    let live = true;
    const from = new Date(zonedToInstant(start, 0, timeZone)).toISOString();
    const to = new Date(zonedToInstant(addDays(start, WINDOW_DAYS), 0, timeZone)).toISOString();
    loader.current(from, to).then(
      (r) => live && setResult(r.ok ? { key: reqKey, slots: r.data } : { key: reqKey, error: r.error }),
      () => live && setResult({ key: reqKey, error: "Free times couldn't be loaded. Check your connection and try again." }),
    );
    return () => {
      live = false;
    };
  }, [reqKey, start, timeZone, loader]);

  const loading = result?.key !== reqKey;
  const slots = React.useMemo(() => (!loading && result?.slots) || [], [loading, result]);
  const days = Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(start, i));
  const byDay = React.useMemo(() => {
    const m = new Map<string, PickerSlot[]>();
    for (const s of slots) {
      const k = zonedDate(new Date(s.start).getTime(), timeZone);
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return m;
  }, [slots, timeZone]);
  const firstOpen = days.find((d) => byDay.has(d)) ?? null;
  const shownDay = day && byDay.has(day) ? day : firstOpen;
  const times = shownDay ? byDay.get(shownDay) ?? [] : [];
  const selectedVisible = value && slots.some((s) => s.start === value);

  const move = (to: string) => {
    setStart(to < today ? today : to);
    setDay(null);
    onChange(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Previous week" disabled={start <= today} onClick={() => move(addDays(start, -WINDOW_DAYS))}>
            <ChevronLeft className="size-4" />
          </Button>
          <p className="min-w-[9.5rem] text-center text-[13px] font-medium text-ink" aria-live="polite">
            {formatDay(days[0], { month: "short", day: "numeric" })} – {formatDay(days[days.length - 1], { month: "short", day: "numeric", year: "numeric" })}
          </p>
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Next week" onClick={() => move(addDays(start, WINDOW_DAYS))}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <label className="flex items-center gap-2 text-[12.5px] text-muted">
          <CalendarSearch className="size-4" aria-hidden />
          <span className="sr-only">Jump to a date</span>
          <Input type="date" className="h-11 w-[10.5rem] sm:h-9" min={today} value={start} onChange={(e) => isDateKey(e.target.value) && move(e.target.value)} />
        </label>
      </div>

      <div role="group" aria-label="Days" className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const n = byDay.get(d)?.length ?? 0;
          const active = d === shownDay;
          return (
            <button
              key={d}
              type="button"
              disabled={loading || n === 0}
              aria-pressed={active}
              aria-label={`${formatDay(d, { weekday: "long", month: "long", day: "numeric" })}: ${loading ? "loading" : n === 0 ? "no free times" : `${n} free ${n === 1 ? "time" : "times"}`}`}
              onClick={() => {
                setDay(d);
                onChange(null);
              }}
              className={cn(
                "flex min-h-14 flex-col items-center justify-center rounded-xl border text-center transition-colors disabled:cursor-not-allowed",
                active ? "border-primary/40 bg-primary-soft text-primary-ink" : "border-line bg-surface hover:bg-surface-2 disabled:opacity-45",
              )}
            >
              <span className="text-[12px] font-medium uppercase tracking-wide text-muted">{formatDay(d, { weekday: "short" })}</span>
              <span className="text-[15px] font-semibold tabular-nums">{formatDay(d, { day: "numeric" })}</span>
              <span className="text-[12px] tabular-nums text-faint" aria-hidden>{loading ? "…" : n || "–"}</span>
            </button>
          );
        })}
      </div>

      <div className="min-h-[96px]">
        {loading ? (
          <p className="flex items-center gap-2 py-6 text-[13px] text-muted" role="status"><Loader2 className="size-4 animate-spin" aria-hidden />Finding free times…</p>
        ) : result?.error ? (
          <p className="rounded-xl border border-danger/25 bg-danger-soft px-3 py-2.5 text-[13px] text-danger-ink" role="alert">{result.error}</p>
        ) : !shownDay ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-[13px] text-muted" role="status">
            No free times this week.
            <Button type="button" variant="secondary" size="sm" className="ml-2" onClick={() => move(addDays(start, WINDOW_DAYS))}>Try next week</Button>
          </div>
        ) : (
          <fieldset>
            <legend className="mb-2 text-[12.5px] font-medium text-ink-2">{formatDay(shownDay, { weekday: "long", month: "long", day: "numeric" })}</legend>
            <div role="radiogroup" aria-label="Free start times" className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
              {times.map((s) => {
                const checked = value === s.start;
                const host = showHost && s.hostIds.length === 1 ? hostNames[s.hostIds[0]] : null;
                const current = currentStart === s.start;
                return (
                  <label
                    key={s.start}
                    className={cn(
                      "relative flex min-h-11 cursor-pointer flex-col items-center justify-center rounded-xl border px-2 py-1.5 text-center transition-colors",
                      "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary",
                      checked ? "border-ink bg-ink text-surface" : "border-line bg-surface hover:border-line-strong hover:bg-surface-2",
                    )}
                  >
                    <input type="radio" name={`${id}-slot`} value={s.start} checked={checked} onChange={() => onChange(s)} className="sr-only" />
                    <span className="text-[13.5px] font-semibold tabular-nums">{timeIn(s.start, timeZone)}</span>
                    {(current || host || s.remaining !== null || s.keepsHost === false) && (
                      <span className={cn("max-w-full truncate text-[12px]", checked ? "text-surface/80" : "text-muted")}>
                        {current ? "Current time" : s.keepsHost === false ? "Another host" : host ?? (s.remaining !== null ? `${s.remaining} ${s.remaining === 1 ? "place" : "places"} left` : "")}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}
      </div>
      <p className="text-[12px] text-faint">
        Times are shown in {zoneCity(timeZone)} time ({zoneOffset(timeZone, new Date(zonedToInstant(start, 720, timeZone)).getTime())}).
        {value && !selectedVisible && !loading ? " Your earlier choice is outside these days." : ""}
      </p>
    </div>
  );
}
