import { WorkforceCalendar } from "@/components/work/workforce-calendar";
import { calendarDateKeyAt, getWorkforceCalendarRange } from "@/lib/workforce-calendar-view";
import { AI_GROWTH_PARTNER_ROLE_KEY, type WorkforceRoleKey } from "@/lib/agents";
import { requireWorkforceContext } from "@/server/workforce/workspace-access";
import { getGrowthPartnerControlState } from "@/server/ai-growth-partner/service";
import { getWorkforceCalendarData } from "@/server/workforce/calendar";
import { listAgents } from "@/server/workforce/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Schedules & Calendar" };

export default async function WorkforceCalendarPage() {
  const ctx = await requireWorkforceContext();
  const now = new Date();
  const initialDateKey = calendarDateKeyAt(now, ctx.org.timezone);
  const range = getWorkforceCalendarRange(initialDateKey, "month");
  const [initialData, legacyAgents, partner] = await Promise.all([
    getWorkforceCalendarData(ctx, { from: range.from, to: range.to }),
    listAgents(ctx.user.id, ctx.org.orgId).catch(() => []),
    ctx.can("agents.use") ? getGrowthPartnerControlState(ctx).catch(() => null) : Promise.resolve(null),
  ]);
  const employeeNames = Object.fromEntries([
    ...legacyAgents.map((agent) => [agent.role_key, agent.display_name] as const),
    ...(partner?.runtimeAgentInstanceId ? [[AI_GROWTH_PARTNER_ROLE_KEY, partner.name] as const] : []),
  ]) as Partial<Record<WorkforceRoleKey, string>>;

  return <WorkforceCalendar initialData={initialData} initialDateKey={initialDateKey} referenceTime={now.toISOString()} canManageSchedules={ctx.can("agents.configure")} employeeNames={employeeNames} />;
}
