import { CalendarDays } from "lucide-react";

export default function WorkforceCalendarLoading() {
  return (
    <div className="space-y-4" role="status" aria-busy="true" aria-label="Loading schedules and calendar">
      <div className="rounded-3xl border border-line bg-surface p-6 shadow-soft sm:p-8">
        <p className="inline-flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[.12em] text-primary"><CalendarDays className="size-4" aria-hidden />AI Workforce</p>
        <div className="skeleton mt-4 h-8 w-64 rounded-lg" />
        <div className="skeleton mt-3 h-4 max-w-xl rounded-md" />
      </div>
      <div className="skeleton h-11 rounded-xl" />
      <div className="skeleton h-24 rounded-2xl" />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="skeleton min-h-[640px] rounded-2xl" />
        <div className="space-y-3"><div className="skeleton h-72 rounded-2xl" /><div className="skeleton h-56 rounded-2xl" /></div>
      </div>
    </div>
  );
}
