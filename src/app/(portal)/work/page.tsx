import { requireOrgContext } from "@/server/tenancy/context";
import { getAgentByRole } from "@/server/workforce/service";
import { listWorkBoardJobs, workBoardSummary, type WorkBoardFilter } from "@/server/workforce/work-board";
import { WorkBoard } from "@/components/work/work-board";
import { canChat } from "@/lib/agents";

export const metadata = { title: "AI Work Board" };

export default async function WorkPage({ searchParams }: { searchParams: Promise<{ status?: string; job?: string }> }) {
  const [{ status, job }, ctx] = await Promise.all([searchParams, requireOrgContext()]);
  const filter: WorkBoardFilter = status === "active" || status === "attention" || status === "completed" ? status : "all";
  const [jobs, summary, operationsManager] = await Promise.all([
    listWorkBoardJobs(ctx, filter),
    workBoardSummary(ctx),
    getAgentByRole(ctx.user.id, ctx.org.orgId, "operations_manager").catch(() => null),
  ]);
  const canStartReview = Boolean(ctx.can("agents.use") && ctx.can("activity.view"));
  const reviewBlockedReason = !ctx.can("agents.use")
    ? "Your role can't start AI work."
    : !ctx.can("activity.view")
      ? "An operations review requires workspace activity access."
      : !operationsManager
        ? "The Operations Manager isn't set up in this workspace."
        : !operationsManager.enabled
          ? "The Operations Manager is paused."
          : operationsManager.config_version === null
            ? "The Operations Manager needs an applied configuration first."
            : !canChat(operationsManager.status)
              ? `The Operations Manager is not available yet (${operationsManager.status.replaceAll("_", " ")}).`
              : null;
  return (
    <WorkBoard
      jobs={jobs}
      summary={summary}
      filter={filter}
      canStartReview={canStartReview}
      reviewBlockedReason={reviewBlockedReason}
      operationsManagerName={operationsManager?.display_name ?? "Operations Manager"}
      timeZone={ctx.org.timezone}
      focusJobId={typeof job === "string" && /^[0-9a-f-]{36}$/i.test(job) ? job : null}
    />
  );
}
