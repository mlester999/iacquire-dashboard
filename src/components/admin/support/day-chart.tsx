"use client";

import { AreaChart } from "@/components/charts";

/** Formats a `YYYY-MM-DD` bucket as "Oct 20". Lives here because a server component cannot hand a formatter function to a chart. */
function dayLabel(x: string): string {
  return new Date(`${x}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function DayAreaChart({ data, unit, label }: { data: Array<{ x: string; y: number }>; unit: string; label: string }) {
  return <AreaChart data={data} formatX={dayLabel} unit={unit} label={label} />;
}
