"use client";

import * as React from "react";
import { CalendarDays, MapPin, Video } from "lucide-react";
import { EmptyState } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { zonedDate } from "@/lib/calendars/slots";
import { formatDay } from "@/components/crm/scheduling/calendar-math";
import { colorFor, timeRangeIn } from "@/components/crm/scheduling/format";
import { StatusBadge } from "@/components/crm/scheduling/bits";
import type { ScheduleItem } from "@/server/calendars/schedule";

/** The agenda: the days that have appointments, in order, each appointment one row. */
export function AgendaList({
  days, today, timeZone, items, onOpen, emptyAction,
}: {
  days: string[];
  today: string;
  timeZone: string;
  items: ScheduleItem[];
  onOpen: (id: string) => void;
  emptyAction?: React.ReactNode;
}) {
  const groups = React.useMemo(() => {
    const m = new Map<string, ScheduleItem[]>();
    for (const a of items) {
      const k = zonedDate(new Date(a.startAt).getTime(), timeZone);
      if (!days.includes(k)) continue;
      m.set(k, [...(m.get(k) ?? []), a]);
    }
    return days.filter((d) => m.has(d)).map((d) => ({ day: d, items: m.get(d) ?? [] }));
  }, [days, items, timeZone]);

  if (!groups.length) {
    return (
      <EmptyState
        compact
        icon={<CalendarDays className="size-5" />}
        title="Nothing booked"
        description={`No appointments between ${formatDay(days[0], { month: "long", day: "numeric" })} and ${formatDay(days[days.length - 1], { month: "long", day: "numeric" })} with these filters.`}
        action={emptyAction}
      />
    );
  }
  return (
    <div className="divide-y divide-line">
      {groups.map((g) => (
        <section key={g.day} aria-labelledby={`agenda-${g.day}`} className="px-3 py-3 sm:px-4">
          <h3 id={`agenda-${g.day}`} className={cn("mb-2 text-[13px] font-semibold", g.day === today ? "text-primary" : "text-ink-2")}>
            {g.day === today ? "Today · " : ""}{formatDay(g.day, { weekday: "long", month: "long", day: "numeric" })}
          </h3>
          <ul className="space-y-1.5">
            {g.items.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => onOpen(a.id)}
                  className={cn("flex w-full min-w-0 items-start gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:bg-surface-2", a.status === "cancelled" && "opacity-70")}
                >
                  <span aria-hidden className="mt-0.5 h-9 w-1 shrink-0 rounded-full" style={{ background: colorFor(a) }} />
                  <span className="w-[7.5rem] shrink-0 text-[13px] font-medium tabular-nums text-ink-2">{timeRangeIn(a.startAt, a.endAt, timeZone)}</span>
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-[14px] font-medium text-ink", a.status === "cancelled" && "line-through")}>{a.contact?.name ?? a.title}</span>
                    <span className="block truncate text-[12px] text-muted">
                      {a.type?.name ?? "Appointment"}{a.hosts.length ? ` · ${a.hosts.map((h) => h.name).join(", ")}` : ""}
                    </span>
                    <StatusBadge status={a.status} className="mt-1 h-5 text-[12px] sm:hidden" />
                    {(a.location || a.meetingLink) && (
                      <span className="mt-0.5 flex items-center gap-1 truncate text-[12px] text-faint">
                        {a.meetingLink ? <Video className="size-3 shrink-0" aria-hidden /> : <MapPin className="size-3 shrink-0" aria-hidden />}
                        <span className="truncate">{a.location ?? "Video call"}</span>
                      </span>
                    )}
                  </span>
                  <StatusBadge status={a.status} className="hidden sm:inline-flex" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
