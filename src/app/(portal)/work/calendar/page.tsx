import { WorkforceCalendar } from "@/components/work/workforce-calendar";
import { calendarDateKeyAt, getWorkforceCalendarRange } from "@/lib/workforce-calendar-view";
import { requireWorkforceContext } from "@/server/workforce/workspace-access";
import { getWorkforceCalendarData } from "@/server/workforce/calendar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Schedules & Calendar" };

export default async function WorkforceCalendarPage() {
  const ctx = await requireWorkforceContext();
  const now = new Date();
  const initialDateKey = calendarDateKeyAt(now, ctx.org.timezone);
  const range = getWorkforceCalendarRange(initialDateKey, "month");
  const initialData = await getWorkforceCalendarData(ctx, { from: range.from, to: range.to });
  return <WorkforceCalendar initialData={initialData} initialDateKey={initialDateKey} referenceTime={now.toISOString()} canManageSchedules={ctx.can("agents.configure")} />;
}
