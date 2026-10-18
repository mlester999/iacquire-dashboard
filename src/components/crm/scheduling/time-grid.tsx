"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { addDays, zonedToInstant } from "@/lib/calendars/slots";
import { formatDay, layoutDay, minuteInDay, snapMinutes, type DaySegment } from "@/components/crm/scheduling/calendar-math";
import { colorFor, isUpcomingStatus, minuteLabel, STATUS_LABEL, timeRangeIn, zoneOffset } from "@/components/crm/scheduling/format";
import { chipStyle, StatusGlyph, useLatest } from "@/components/crm/scheduling/bits";
import type { HostOverlay, ScheduleItem } from "@/server/calendars/schedule";

const HOUR_PX = 48;
const PX = HOUR_PX / 60;
const GUTTER = 56;

interface Drag {
  item: ScheduleItem;
  pointerId: number;
  x0: number;
  y0: number;
  /** Minutes between the chip's top and where it was grabbed, so it doesn't jump under the pointer. */
  grab: number;
  moved: boolean;
}

type Band = { top: number; bottom: number };

/** Minute bands of a day covered by intervals (clipped to the day). */
function bandsFor(intervals: Array<{ start: string; end: string }>, day: string, timeZone: string): Band[] {
  const dayStart = zonedToInstant(day, 0, timeZone);
  const dayEnd = zonedToInstant(addDays(day, 1), 0, timeZone);
  return intervals
    .map((i) => ({ s: new Date(i.start).getTime(), e: new Date(i.end).getTime() }))
    .filter((i) => i.s < dayEnd && i.e > dayStart)
    .map((i) => ({ top: i.s <= dayStart ? 0 : minuteInDay(i.s, day, timeZone), bottom: i.e >= dayEnd ? 1440 : minuteInDay(i.e, day, timeZone) }))
    .filter((b) => b.bottom > b.top);
}

/** The parts of a day outside working hours. */
function offHours(working: Band[]): Band[] {
  const out: Band[] = [];
  let cursor = 0;
  for (const w of [...working].sort((a, b) => a.top - b.top)) {
    if (w.top > cursor) out.push({ top: cursor, bottom: w.top });
    cursor = Math.max(cursor, w.bottom);
  }
  if (cursor < 1440) out.push({ top: cursor, bottom: 1440 });
  return out;
}

/**
 * The week and day views: a 24-hour grid per day with appointments placed by time, overlapping ones side by side, the chosen person's
 * working hours and busy-elsewhere bands shaded, and a line at the current time. People who manage appointments can drag an upcoming
 * one with a mouse or pen to propose a new time; the keyboard way is Reschedule in the appointment's details.
 */
export function TimeGrid({
  days, timeZone, today, now, items, overlay, canDrag, onOpen, onMove, onOpenDay,
}: {
  days: string[];
  timeZone: string;
  today: string;
  now: number;
  items: ScheduleItem[];
  overlay: HostOverlay | null;
  canDrag: boolean;
  onOpen: (id: string) => void;
  onMove: (item: ScheduleItem, start: Date, day: string) => void;
  onOpenDay: (day: string) => void;
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const gridRef = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<Drag | null>(null);
  const suppressClick = React.useRef(false);
  const [ghost, setGhost] = React.useState<{ id: string; day: number; minute: number; duration: number } | null>(null);

  const segments = React.useMemo(() => days.map((d) => layoutDay(items, d, timeZone)), [days, items, timeZone]);
  const working = React.useMemo(() => (overlay ? days.map((d) => bandsFor(overlay.working, d, timeZone)) : null), [overlay, days, timeZone]);
  const busy = React.useMemo(() => (overlay ? days.map((d) => bandsFor(overlay.busy, d, timeZone)) : null), [overlay, days, timeZone]);

  // Open on the morning (or the first appointment / working hour, if earlier), not at midnight.
  const firstMinute = React.useMemo(() => {
    const candidates = [8 * 60, ...segments.flat().map((s) => s.top), ...(working ?? []).flat().map((b) => b.top)];
    return Math.max(0, Math.min(...candidates) - 30);
  }, [segments, working]);
  const scrollKey = `${days[0]}:${days.length}`;
  const first = useLatest(firstMinute);
  // Only when the days change, not on every refresh, so a person's own scrolling is kept.
  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = first.current * PX;
  }, [scrollKey, first]);

  const locate = (clientX: number, clientY: number, grab: number) => {
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const colW = (rect.width - GUTTER) / days.length;
    const day = Math.max(0, Math.min(days.length - 1, Math.floor((clientX - rect.left - GUTTER) / colW)));
    const minute = snapMinutes((clientY - rect.top) / PX - grab);
    return { day, minute };
  };

  const movable = (item: ScheduleItem) => canDrag && isUpcomingStatus(item.status);
  const duration = (item: ScheduleItem) => Math.max(15, (new Date(item.endAt).getTime() - new Date(item.startAt).getTime()) / 60_000);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>, seg: DaySegment<ScheduleItem>) => {
    if (!movable(seg.item) || e.button !== 0 || e.pointerType === "touch" || seg.startsBefore) return;
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = { item: seg.item, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, grab: (e.clientY - rect.top) / PX - seg.top, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
    d.moved = true;
    const at = locate(e.clientX, e.clientY, d.grab);
    if (at) setGhost((g) => (g && g.id === d.item.id && g.day === at.day && g.minute === at.minute ? g : { id: d.item.id, ...at, duration: duration(d.item) }));
  };
  const endDrag = (e: React.PointerEvent<HTMLButtonElement>, commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    setGhost(null);
    if (!d || !d.moved) return;
    // The click that follows the drag's pointerup must not open the appointment; reset afterwards in case no click comes.
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    if (!commit) return;
    const at = locate(e.clientX, e.clientY, d.grab);
    if (!at) return;
    const start = zonedToInstant(days[at.day], at.minute, timeZone);
    if (start !== new Date(d.item.startAt).getTime()) onMove(d.item, new Date(start), days[at.day]);
  };

  const cols = `${GUTTER}px repeat(${days.length}, minmax(0, 1fr))`;
  const nowDay = days.indexOf(today);
  const nowMinute = now && nowDay >= 0 ? minuteInDay(now, today, timeZone) : null;

  return (
    <div className="scrollbar-thin overflow-x-auto">
      <div className={cn(days.length > 1 && "min-w-[680px]")}>
        <div className="grid border-b border-line" style={{ gridTemplateColumns: cols }}>
          <div className="flex items-end justify-center pb-2 text-[10px] font-medium text-faint" aria-hidden>{zoneOffset(timeZone, zonedToInstant(days[0], 720, timeZone))}</div>
          {days.map((d) => {
            const isToday = d === today;
            return (
              <div key={d} className="border-l border-line px-1 py-2 text-center">
                {days.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => onOpenDay(d)}
                    aria-label={`${formatDay(d, { weekday: "short" })} ${formatDay(d, { day: "numeric" })}, ${formatDay(d, { weekday: "long", month: "long", day: "numeric" })}${isToday ? ", today" : ""}. Open this day.`}
                    className="inline-flex min-h-11 flex-col items-center justify-center rounded-xl px-2 hover:bg-surface-2 sm:min-h-0 sm:py-1"
                  >
                    <span className={cn("text-[11px] font-medium uppercase tracking-wide", isToday ? "text-primary" : "text-muted")}>{formatDay(d, { weekday: "short" })}</span>{" "}
                    <span className={cn("mt-0.5 inline-flex size-7 items-center justify-center rounded-full text-[14px] font-semibold tabular-nums", isToday ? "bg-primary text-primary-on" : "text-ink")}>{formatDay(d, { day: "numeric" })}</span>
                  </button>
                ) : (
                  <p className={cn("text-[12.5px] font-medium", isToday ? "text-primary" : "text-ink-2")}>{formatDay(d, { weekday: "long", month: "long", day: "numeric" })}{isToday ? " · Today" : ""}</p>
                )}
              </div>
            );
          })}
        </div>
        <div ref={scrollRef} tabIndex={0} role="region" aria-label="Schedule by time" className="scrollbar-thin relative max-h-[min(68vh,760px)] overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
          <div ref={gridRef} className="relative grid" style={{ gridTemplateColumns: cols, height: 24 * HOUR_PX }}>
            <div className="relative" aria-hidden>
              {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
                <span key={h} className="absolute right-2 -translate-y-1/2 text-[10.5px] tabular-nums text-faint" style={{ top: h * HOUR_PX }}>{minuteLabel(h * 60)}</span>
              ))}
            </div>
            {days.map((d, di) => {
              const segs = segments[di];
              const isToday = d === today;
              return (
                <div key={d} role="group" aria-label={`${formatDay(d, { weekday: "long", month: "long", day: "numeric" })}: ${segs.length ? `${segs.length} ${segs.length === 1 ? "appointment" : "appointments"}` : "nothing booked"}`} className={cn("relative border-l border-line", isToday && "bg-primary-soft/20")}>
                  <div aria-hidden className="pointer-events-none absolute inset-0">
                    {Array.from({ length: 24 }, (_, h) => (
                      <div key={h} className="absolute inset-x-0 border-t border-line/70" style={{ top: h * HOUR_PX }}>
                        <div className="absolute inset-x-0 border-t border-dashed border-line/40" style={{ top: HOUR_PX / 2 }} />
                      </div>
                    ))}
                    {working && offHours(working[di]).map((b) => (
                      <div key={`off-${b.top}`} className="absolute inset-x-0 bg-surface-2/80" style={{ top: b.top * PX, height: (b.bottom - b.top) * PX }} />
                    ))}
                    {busy?.[di].map((b) => (
                      <div key={`busy-${b.top}`} className="absolute inset-x-1 rounded-md border border-line-strong/60 bg-[repeating-linear-gradient(135deg,transparent_0_6px,var(--color-line-strong)_6px_8px)]" style={{ top: b.top * PX, height: Math.max(6, (b.bottom - b.top) * PX) }}>
                        {(b.bottom - b.top) >= 30 && <span className="absolute left-1.5 top-1 rounded bg-surface/90 px-1 text-[10px] font-medium text-muted">Busy elsewhere</span>}
                      </div>
                    ))}
                  </div>
                  {busy && busy[di].length > 0 && (
                    <p className="sr-only">{overlay?.name} is busy elsewhere {busy[di].map((b) => `${minuteLabel(b.top)} to ${minuteLabel(b.bottom % 1440)}`).join(", ")}.</p>
                  )}
                  {segs.map((seg) => {
                    const item = seg.item;
                    const color = colorFor(item);
                    const st = chipStyle(color, item.status);
                    const h = Math.max(20, (seg.bottom - seg.top) * PX - 2);
                    const name = item.contact?.name ?? item.title;
                    const dragging = ghost?.id === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-appointment={item.id}
                        onClick={() => {
                          if (suppressClick.current) {
                            suppressClick.current = false;
                            return;
                          }
                          onOpen(item.id);
                        }}
                        onPointerDown={(e) => onPointerDown(e, seg)}
                        onPointerMove={onPointerMove}
                        onPointerUp={(e) => endDrag(e, true)}
                        onPointerCancel={(e) => endDrag(e, false)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape" && drag.current) {
                            drag.current = null;
                            setGhost(null);
                          }
                        }}
                        aria-label={[name, timeRangeIn(item.startAt, item.endAt, timeZone), item.type?.name ?? "appointment", STATUS_LABEL[item.status] ?? item.status, item.hosts.length ? `with ${item.hosts.map((x) => x.name).join(" and ")}` : ""].filter(Boolean).join(" ")}
                        className={cn(
                          "absolute overflow-hidden rounded-lg px-1.5 py-1 text-left shadow-soft transition-[opacity,box-shadow] hover:shadow-card focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
                          st.className,
                          movable(item) && "sm:cursor-grab",
                          dragging && "opacity-40",
                        )}
                        style={{ ...st.style, top: seg.top * PX + 1, height: h, left: `calc(${(seg.col / seg.cols) * 100}% + 2px)`, width: `calc(${100 / seg.cols}% - 4px)` }}
                      >
                        <span className="flex items-center gap-1 text-[11px] font-semibold leading-tight">
                          <StatusGlyph status={item.status} />
                          <span className="truncate">{name}</span>
                        </span>
                        {h >= 34 && <>{" "}<span className="block truncate text-[10.5px] leading-tight text-ink-2/90 tabular-nums">{timeRangeIn(item.startAt, item.endAt, timeZone)}</span></>}
                        {h >= 50 && item.type && <>{" "}<span className="block truncate text-[10.5px] leading-tight text-muted">{item.type.name}</span></>}
                      </button>
                    );
                  })}
                  {ghost && ghost.day === di && (
                    <div aria-hidden className="pointer-events-none absolute inset-x-1 z-10 rounded-lg border-2 border-dashed border-primary bg-primary-soft/60 px-1.5 py-1 text-[11px] font-semibold text-primary-ink" style={{ top: ghost.minute * PX, height: Math.max(20, ghost.duration * PX) }}>
                      {minuteLabel(ghost.minute)}
                    </div>
                  )}
                  {nowMinute !== null && di === nowDay && (
                    <div aria-hidden className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger" style={{ top: nowMinute * PX }}>
                      <span className="absolute -left-1 -top-[5px] size-2 rounded-full bg-danger" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
