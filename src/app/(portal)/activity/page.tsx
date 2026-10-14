import { requireOrgContext } from "@/server/tenancy/context";
import { withUser } from "@/server/db";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { AgentAvatar } from "@/components/brand";
import { describeAction } from "@/lib/activity";
import { AGENT_BY_KEY, isAgentRoleKey } from "@/lib/agents";
import { formatDateTime, sentenceCase } from "@/lib/utils";
import { PageHero, MetricCard } from "@/components/ui/workspace";
import { Activity, Bot, ShieldCheck } from "lucide-react";

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

  return (
    <div className="module-stack space-y-6">
      <PageHero tone="neutral" eyebrow="Workspace timeline" title="A clear record of your team's work." description="Review significant decisions and AI employee runs from your workspace. The timeline respects your access, and message contents stay out of the log." icon={<Activity />} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3"><MetricCard label="Actions in this view" value={audit.length} detail={ctx.can("activity.view") ? "Significant recorded events" : "Audit history requires owner or admin access"} icon={<ShieldCheck />} /><MetricCard label="AI runs in this view" value={runs.length} detail={ctx.can("activity.view") ? "Workspace runs" : "Runs you started"} icon={<Bot />} tone="violet" /><MetricCard label="Completed runs" value={runs.filter((r) => r.status === "completed").length} detail="Among the loaded runs" icon={<Activity />} tone="green" /></div>
      <div className="grid gap-6 xl:grid-cols-5">
        <Card className="xl:col-span-3">
          <CardHeader>
            <div>
              <CardTitle>Audit trail</CardTitle>
              <CardDescription>Significant actions with who, what, when and the result.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {!ctx.can("activity.view") ? (
              <p className="py-8 text-center text-[13px] text-muted">The audit trail is available to workspace owners and admins.</p>
            ) : audit.length === 0 ? (
              <p className="py-8 text-center text-[13px] text-muted">No activity recorded yet.</p>
            ) : (
              <ol className="relative space-y-4 border-l border-line pl-5">
                {audit.map((a) => (
                  <li key={a.id} className="relative">
                    <span className={`absolute -left-[25px] top-1.5 size-2.5 rounded-full ring-4 ring-surface ${a.result === "success" ? "bg-primary" : a.result === "denied" ? "bg-warning" : "bg-danger"}`} />
                    <p className="text-[13.5px]">
                      <span className="font-medium">{a.actor ?? sentenceCase(a.actor_kind)}</span> {describeAction(a.action, a.agent)}
                      {a.result !== "success" && (
                        <Badge tone={a.result === "denied" ? "warning" : "danger"} className="ml-2 h-5 text-[11px]">
                          {a.result}
                        </Badge>
                      )}
                    </p>
                    <p className="text-[12px] text-faint">
                      {formatDateTime(a.created_at, ctx.org.timezone)}
                      {a.target_type ? ` · ${a.target_type.replace(/_/g, " ")}` : ""}
                      {a.approval_id ? " · linked approval" : ""}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>AI employee runs</CardTitle>
              <CardDescription>{ctx.can("activity.view") ? "All runs in your workspace." : "Runs you started."}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {runs.length === 0 ? (
              <p className="py-8 text-center text-[13px] text-muted">No AI runs yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {runs.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 py-2.5">
                    {isAgentRoleKey(r.role_key) && <AgentAvatar role={AGENT_BY_KEY[r.role_key]} size="sm" />}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">
                        {isAgentRoleKey(r.role_key) ? AGENT_BY_KEY[r.role_key].shortName : r.role_key} · {r.purpose === "lead_research" ? "Research" : "Conversation"}
                      </p>
                      <p className="text-[11.5px] text-faint">
                        {formatDateTime(r.started_at, ctx.org.timezone)} · {r.tools} tool step{r.tools === 1 ? "" : "s"}
                        {r.user_name ? ` · ${r.user_name}` : ""}
                      </p>
                    </div>
                    <Badge tone={r.status === "completed" ? "success" : r.status === "running" || r.status === "queued" ? "primary" : r.status === "cancelled" ? "neutral" : "danger"}>{sentenceCase(r.status)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
