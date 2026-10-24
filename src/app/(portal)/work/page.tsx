import { requireOrgContext } from "@/server/tenancy/context";
import { listAgents } from "@/server/workforce/service";
import { listWorkBoardJobs, workBoardSummary, type WorkBoardFilter } from "@/server/workforce/work-board";
import { listSchedules, schedulesOperatorEnabled } from "@/server/workforce/schedules";
import { listTriggers, triggersOperatorEnabled } from "@/server/workforce/triggers";
import { getProactiveMonitoringStatus, listProactiveReports } from "@/server/workforce/reports";
import { WorkBoard } from "@/components/work/work-board";
import { AGENT_BY_KEY, canChat, type AgentRoleKey } from "@/lib/agents";
import { CAPABILITY_KEYS, WORKFORCE_CAPABILITIES, type WorkBoardCapabilityAction } from "@/lib/workforce-capabilities";

export const metadata = { title: "AI Work Board" };

const UUID = /^[0-9a-f-]{36}$/i;

export default async function WorkPage({ searchParams }: { searchParams: Promise<{ status?: string; job?: string; report?: string; schedule?: string }> }) {
  const [{ status, job, report, schedule }, ctx] = await Promise.all([searchParams, requireOrgContext()]);
  const referenceTime = new Date().toISOString();
  const filter: WorkBoardFilter = status === "active" || status === "attention" || status === "completed" ? status : "all";
  const [jobs, summary, agents, schedules, triggers, reports, monitoring] = await Promise.all([
    listWorkBoardJobs(ctx, filter),
    workBoardSummary(ctx),
    listAgents(ctx.user.id, ctx.org.orgId).catch(() => []),
    listSchedules(ctx).catch(() => []),
    listTriggers(ctx).catch(() => []),
    listProactiveReports(ctx, { limit: 24 }).catch(() => []),
    getProactiveMonitoringStatus(ctx).catch(() => null),
  ]);
  const employeeNames = Object.fromEntries(agents.map((agent) => [agent.role_key, agent.display_name])) as Partial<Record<AgentRoleKey, string>>;

  const capabilityActions: WorkBoardCapabilityAction[] = CAPABILITY_KEYS
    .map((key) => WORKFORCE_CAPABILITIES[key])
    .map((definition) => {
      const role = definition.allowedRoles[0];
      const meta = AGENT_BY_KEY[role];
      const agent = agents.find((row) => row.role_key === role) ?? null;
      const employeeName = agent?.display_name ?? meta.shortName;
      const permission = ctx.can(definition.requiredPermission);
      const reason = !permission
        ? "Your role can't start this work."
        : !agent
          ? `${employeeName} isn't set up in this workspace.`
          : !agent.enabled
            ? `${employeeName} is paused.`
            : agent.config_version === null
              ? `${employeeName} needs an applied configuration first.`
              : !canChat(agent.status)
                ? `${employeeName} is not available yet (${agent.status.replaceAll("_", " ")}).`
                : null;
      return {
        capability: definition.key,
        label: definition.label,
        description: definition.description,
        employeeName,
        available: reason === null,
        reason,
      };
    });
  const reviewActions = capabilityActions.filter((action) => WORKFORCE_CAPABILITIES[action.capability].workBoardAction);
  const scheduleActions = capabilityActions.filter((action) => {
    const definition = WORKFORCE_CAPABILITIES[action.capability];
    return definition.workBoardAction || definition.key === "lead_research";
  });

  return (
    <WorkBoard
      jobs={jobs}
      summary={summary}
      filter={filter}
      reviewActions={reviewActions}
      scheduleActions={scheduleActions}
      schedules={schedules}
      canManageSchedules={ctx.can("agents.configure")}
      scheduleOperatorEnabled={schedulesOperatorEnabled()}
      triggers={triggers}
      canManageTriggers={ctx.can("agents.configure")}
      triggerOperatorEnabled={triggersOperatorEnabled()}
      timeZone={ctx.org.timezone}
      focusJobId={typeof job === "string" && UUID.test(job) ? job : null}
      reports={reports}
      monitoring={monitoring}
      focusReportId={typeof report === "string" && UUID.test(report) ? report : null}
      employeeNames={employeeNames}
      referenceTime={referenceTime}
      focusScheduleId={typeof schedule === "string" && UUID.test(schedule) ? schedule : null}
    />
  );
}
