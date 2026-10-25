import { requireOrgContext } from "@/server/tenancy/context";
import { withUser } from "@/server/db";
import { EmptyState } from "@/components/ui/primitives";
import { AgentAvatar } from "@/components/brand";
import { describeAction } from "@/lib/activity";
import { AGENT_BY_KEY, isAgentRoleKey } from "@/lib/agents";
import { formatDateTime, sentenceCase } from "@/lib/utils";
import { PageHero, MetricCard } from "@/components/ui/workspace";
import { AvatarTile, InfoChip, StatusPill } from "@/components/ui/status";
import { IconTile, Panel } from "@/components/overview/panel";
import { Activity, Bot, Clock, Cog, ListChecks, Lock, ShieldCheck, Sparkles, Wrench } from "lucide-react";

export const metadata = { title: "Activity" };

export default async function ActivityPage() {
  const ctx = await requireOrgContext();
  const { audit, runs } = await withUser(ctx.user.id, async (db) => {
    const audit = ctx.can("activity.view")
      ? (
          await db.query<{ id: string; action: string; actor: string | null; actor_kind: string; target_type: string | null; result: string; created_at: Date; approval_id: string | null; agent: string | null }>(
            `select a.id::text, a.action, u.full_name as actor, a.actor_kind, a.target_type, a.result, a.created_at, a.approval_id, ro.short_name as agent
             from audit_logs a left join users u on u.id = a.actor_user_id
             left join agent_instances ai on ai.id = a.agent_instance_id left join agent_roles ro on ro.key = ai.role_key
             where a.org_id = $1 and a.action <> 'agent.health_check' order by a.created_at desc limit 150`,
            [ctx.org.orgId],
          )
        ).rows
      : [];
    // Row-level security limits members to their own runs.
    const runs = (
      await db.query<{ id: string; role_key: string; purpose: string; status: string; started_at: Date; total_tokens: number | null; tools: number; user_name: string | null }>(
        `select r.id, a.role_key, r.purpose, r.status, r.started_at, r.total_tokens, u.full_name as user_name,
                (select count(*)::int from tool_executions t where t.run_id = r.id) as tools
         from agent_runs r join agent_instances a on a.id = r.agent_instance_id left join users u on u.id = r.user_id
         where r.org_id = $1 order by r.started_at desc limit 60`,
        [ctx.org.orgId],
      )
    ).rows;
    return { audit, runs };
  });
  const failedActions = audit.filter((a) => a.result !== "success" && a.result !== "denied").length;
  const deniedActions = audit.filter((a) => a.result === "denied").length;
  const failedRuns = runs.filter((r) => ["failed", "timeout", "interrupted"].includes(r.status)).length;

  return (
    <div className="module-stack space-y-6">
      <PageHero tone="neutral" eyebrow="Workspace timeline" title="A clear record of your team's work." description="Review significant decisions and AI employee runs from your workspace. The timeline respects your access, and message contents stay out of the log." icon={<Activity />} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <MetricCard label="Actions in this view" value={audit.length} detail={ctx.can("activity.view") ? "Significant recorded events" : "Audit history requires owner or admin access"} icon={<ShieldCheck />} />
        <MetricCard label="AI runs in this view" value={runs.length} detail={ctx.can("activity.view") ? "Workspace runs" : "Runs you started"} icon={<Bot />} tone="violet" />
        <MetricCard label="Completed runs" value={runs.filter((r) => r.status === "completed").length} detail="Among the loaded runs" icon={<Activity />} tone="green" className="col-span-2 sm:col-span-1" />
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Panel
                    icon={<ListChecks />}
          title="Audit trail"
          description="Significant actions with who, what, when and the result."
          action={
            audit.length > 0 ? (
              <>
                {failedActions > 0 && <StatusPill tone="danger" size="sm">{failedActions} failed</StatusPill>}
                {deniedActions > 0 && <StatusPill tone="warning" size="sm">{deniedActions} denied</StatusPill>}
                {failedActions === 0 && deniedActions === 0 && <StatusPill tone="success" size="sm">All succeeded</StatusPill>}
              </>
            ) : undefined
          }
          bodyClassName="px-0 pb-0 pt-3"
        >
          {!ctx.can("activity.view") ? (
            <EmptyState icon={<Lock className="size-5" />} title="Owners and admins only" description="The audit trail is available to workspace owners and admins." />
          ) : audit.length === 0 ? (
            <EmptyState icon={<ListChecks className="size-5" />} title="No activity recorded yet" description="Approvals, configuration changes and other significant actions are listed here as they happen." />
          ) : (
            <ol className="scrollbar-thin max-h-[46rem] divide-y divide-line overflow-y-auto border-t border-line" tabIndex={0} aria-label="Audit trail">
              {audit.map((a) => {
                const failed = a.result !== "success";
                const isAgent = a.actor_kind === "agent" || (!a.actor && Boolean(a.agent));
                return (
                  <li key={a.id} className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-surface-2/50">
                    {a.actor ? (
                      <AvatarTile name={a.actor} size="sm" />
                    ) : isAgent ? (
                      <IconTile tone="violet" size="sm">
                        <Sparkles />
                      </IconTile>
                    ) : (
                      <IconTile tone="neutral" size="sm">
                        <Cog />
                      </IconTile>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] leading-snug text-ink-2">
                        <span className="font-semibold text-ink">{a.actor ?? (isAgent ? (a.agent ?? "AI employee") : "iAcquire system")}</span> {describeAction(a.action, a.agent)}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <InfoChip icon={<Clock />}>
                          <span suppressHydrationWarning>{formatDateTime(a.created_at, ctx.org.timezone)}</span>
                        </InfoChip>
                        {a.target_type && <InfoChip icon={<Wrench />}>{sentenceCase(a.target_type)}</InfoChip>}
                        {a.approval_id && <InfoChip icon={<ShieldCheck />}>Linked approval</InfoChip>}
                      </div>
                    </div>
                    {failed && (
                      <StatusPill tone={a.result === "denied" ? "warning" : "danger"} size="sm">
                        {a.result === "denied" ? "Denied" : sentenceCase(a.result)}
                      </StatusPill>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>

        <Panel
          icon={<Bot />}
          tone="violet"
          title="AI employee runs"
          description={ctx.can("activity.view") ? "All runs in your workspace." : "Runs you started."}
          action={runs.length > 0 && failedRuns > 0 ? <StatusPill tone="danger" size="sm">{failedRuns} need a look</StatusPill> : undefined}
          bodyClassName="px-0 pb-0 pt-3"
        >
          {runs.length === 0 ? (
            <EmptyState icon={<Bot className="size-5" />} title="No AI runs yet" description="When an AI employee works on a conversation or research request, the run is listed here." />
          ) : (
            <ul className="scrollbar-thin max-h-[46rem] divide-y divide-line overflow-y-auto border-t border-line" tabIndex={0} aria-label="AI employee runs">
              {runs.map((r) => {
                const role = isAgentRoleKey(r.role_key) ? AGENT_BY_KEY[r.role_key] : null;
                return (
                  <li key={r.id} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-2/50">
                    {role ? (
                      <AgentAvatar role={role} size="sm" />
                    ) : (
                      <IconTile tone="violet" size="sm">
                        <Bot />
                      </IconTile>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-semibold text-ink" title={role?.shortName ?? r.role_key}>
                        {role?.shortName ?? sentenceCase(r.role_key)}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <InfoChip>{r.purpose === "lead_research" ? "Research" : "Conversation"}</InfoChip>
                        <InfoChip icon={<Clock />}>
                          <span suppressHydrationWarning>{formatDateTime(r.started_at, ctx.org.timezone)}</span>
                        </InfoChip>
                        <InfoChip icon={<Wrench />}>
                          {r.tools} tool step{r.tools === 1 ? "" : "s"}
                        </InfoChip>
                        {r.user_name && <InfoChip>{r.user_name}</InfoChip>}
                      </div>
                    </div>
                    <StatusPill status={r.status} />
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
