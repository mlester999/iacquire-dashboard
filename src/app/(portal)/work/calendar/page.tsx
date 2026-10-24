import { WorkforceCalendar } from "@/components/work/workforce-calendar";
import { calendarDateKeyAt, getWorkforceCalendarRange } from "@/lib/workforce-calendar-view";
import type { AgentRoleKey } from "@/lib/agents";
import { requireOrgContext } from "@/server/tenancy/context";
import { getWorkforceCalendarData } from "@/server/workforce/calendar";
import { listAgents } from "@/server/workforce/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Schedules & Calendar" };

export default async function WorkforceCalendarPage() {
  const ctx = await requireOrgContext();
  const now = new Date();
  const initialDateKey = calendarDateKeyAt(now, ctx.org.timezone);
  const range = getWorkforceCalendarRange(initialDateKey, "month");
  const [initialData, agents] = await Promise.all([
    getWorkforceCalendarData(ctx, { from: range.from, to: range.to }),
    listAgents(ctx.user.id, ctx.org.orgId).catch(() => []),
  ]);
  const employeeNames = Object.fromEntries(agents.map((agent) => [agent.role_key, agent.display_name])) as Partial<Record<AgentRoleKey, string>>;

  return <WorkforceCalendar initialData={initialData} initialDateKey={initialDateKey} referenceTime={now.toISOString()} canManageSchedules={ctx.can("agents.configure")} employeeNames={employeeNames} />;
}

