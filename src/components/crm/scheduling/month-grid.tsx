"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { zonedDate } from "@/lib/calendars/slots";
import { formatDay } from "@/components/crm/scheduling/calendar-math";
import { colorFor, STATUS_LABEL, timeIn } from "@/components/crm/scheduling/format";
import { StatusGlyph } from "@/components/crm/scheduling/bits";
import type { ScheduleItem } from "@/server/calendars/schedule";

const SHOWN = 3;

/** The month view: whole weeks, up to three appointments a day with "more" opening the day; on phones each day shows coloured dots. */
export function MonthGrid({
  days, month, today, timeZone, items, onOpen, onOpenDay,
}: {
  days: string[];
  /** "YYYY-MM" of the month being shown. */
  month: string;
  today: string;
  timeZone: string;
  items: ScheduleItem[];
  onOpen: (id: string) => void;
  onOpenDay: (day: string) => void;
}) {
  const byDay = React.useMemo(() => {
    const m = new Map<string, ScheduleItem[]>();
    for (const a of items) {
      const k = zonedDate(new Date(a.startAt).getTime(), timeZone);
      m.set(k, [...(m.get(k) ?? []), a]);
    }
    return m;
  }, [items, timeZone]);
  return (
    <div>
      <div className="grid grid-cols-7 border-b border-line" aria-hidden>
        {days.slice(0, 7).map((d) => (
          <p key={d} className="py-2 text-center text-[12px] font-semibold uppercase tracking-wide text-muted">
            <span className="hidden sm:inline">{formatDay(d, { weekday: "short" })}</span>
            <span className="sm:hidden">{formatDay(d, { weekday: "narrow" })}</span>
          </p>
        ))}
      </div>
      <ol className="grid grid-cols-7" aria-label={`${formatDay(`${month}-01`, { month: "long", year: "numeric" })}, by day`}>
        {days.map((d, i) => {
          const list = byDay.get(d) ?? [];
          const inMonth = d.startsWith(month);
          const isToday = d === today;
          const dayLabel = `${formatDay(d, { weekday: "long", month: "long", day: "numeric" })}${isToday ? ", today" : ""}: ${list.length ? `${list.length} ${list.length === 1 ? "appointment" : "appointments"}` : "nothing booked"}`;
          return (
            <li key={d} className={cn("relative min-h-[76px] border-b border-line p-1 sm:min-h-[118px] sm:p-1.5", i % 7 !== 0 && "border-l", !inMonth && "bg-surface-2/50")}>
              {/* Phones: the whole day is one target that opens it. */}
              <button type="button" onClick={() => onOpenDay(d)} aria-label={`${dayLabel}. Open this day.`} className="absolute inset-0 z-0 rounded-none sm:hidden" />
              <div className="pointer-events-none relative flex items-center justify-between sm:pointer-events-auto">
                <button
                  type="button"
                  onClick={() => onOpenDay(d)}
                  aria-label={`${dayLabel}. Open this day.`}
                  className={cn("hidden size-7 items-center justify-center rounded-full text-[12.5px] font-semibold tabular-nums hover:bg-surface-2 sm:inline-flex", isToday ? "bg-primary text-primary-on hover:bg-primary" : inMonth ? "text-ink" : "text-faint")}
                >
                  {formatDay(d, { day: "numeric" })}
                </button>
              <span aria-hidden className={cn("inline-flex size-6 items-center justify-center rounded-full text-[12px] font-semibold tabular-nums sm:hidden", isToday ? "bg-primary text-primary-on" : inMonth ? "text-ink" : "text-faint")}>{formatDay(d, { day: "numeric" })}</span>
              </div>
              <div className="pointer-events-none relative mt-1 flex flex-wrap gap-0.5 sm:hidden" aria-hidden>
                {list.slice(0, 4).map((a) => <i key={a.id} className={cn("size-1.5 rounded-full", a.status === "cancelled" && "opacity-40")} style={{ background: colorFor(a) }} />)}
                {list.length > 4 && <span className="text-[12px] leading-none text-muted">+{list.length - 4}</span>}
              </div>
              <ul className="relative mt-1 hidden space-y-0.5 sm:block">
                {list.slice(0, SHOWN).map((a) => {
                  const color = colorFor(a);
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(a.id)}
                        aria-label={`${timeIn(a.startAt, timeZone)}, ${a.contact?.name ?? a.title}, ${STATUS_LABEL[a.status] ?? a.status}`}
                        className={cn("flex w-full min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-left text-[12px] hover:bg-surface-2", a.status === "cancelled" && "text-muted line-through opacity-70", a.status === "new" && "italic")}
                      >
                        <i aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
                        <span className="shrink-0 tabular-nums text-muted">{timeIn(a.startAt, timeZone)}</span>
                        <StatusGlyph status={a.status} className="text-muted" />
                        <span className="truncate font-medium text-ink-2">{a.contact?.name ?? a.title}</span>
                      </button>
                    </li>
                  );
                })}
                {list.length > SHOWN && (
                  <li>
                    <button type="button" onClick={() => onOpenDay(d)} className="w-full rounded-md px-1 py-0.5 text-left text-[12px] font-medium text-primary hover:bg-surface-2">
                      {list.length - SHOWN} more<span className="sr-only"> on {formatDay(d, { month: "long", day: "numeric" })}</span>
                    </button>
                  </li>
                )}
              </ul>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
