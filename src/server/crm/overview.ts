import "server-only";
import { assertCan, crmRead, type CrmActor } from "@/server/crm/actor";
import { workspaceCounts } from "@/server/crm/workspace";
import { countTaskViews, listTasks, type TaskView } from "@/server/crm/tasks";

export interface CrmOverview {
  counts: Awaited<ReturnType<typeof workspaceCounts>>;
  deals: { open: number; openValue: Array<{ currency: string; value: number }>; wonThisMonth: number; wonValueThisMonth: Array<{ currency: string; value: number }> } | null;
  tasks: Record<"mine" | "team" | "overdue" | "upcoming", number>;
  myTasks: TaskView[];
  pipeline: { id: string; name: string; stages: Array<{ id: string; name: string; count: number }> } | null;
  activity: Array<{ id: string; at: string; kind: string; summary: string; actor: string | null; contact: { id: string; name: string } | null; opportunityId: string | null }>;
}

const sumByCurrency = (rows: Array<{ currency: string; total: string | null }>) =>
  rows.filter((r) => r.total !== null).map((r) => ({ currency: r.currency, value: Math.round(Number(r.total) * 100) / 100 }));

/** The CRM home page: real counts from this workspace only. Anything the person can't see is left out rather than shown as zero. */
export async function getCrmOverview(actor: CrmActor): Promise<CrmOverview> {
  assertCan(actor, "crm.view");
  const [counts, tasks, myTasks] = await Promise.all([
    workspaceCounts(actor),
    countTaskViews(actor),
    actor.userId && actor.kind === "member" ? listTasks(actor, { view: "mine", limit: 6 }) : Promise.resolve([]),
  ]);
  const rest = await crmRead(actor, async (db) => {
    let deals: CrmOverview["deals"] = null;
    let pipeline: CrmOverview["pipeline"] = null;
    if (actor.can("sales.view")) {
      const open = await db.query<{ currency: string; n: string; total: string | null }>(
        "select currency, count(*)::text as n, sum(monetary_value)::text as total from crm_opportunities where org_id = $1 and provider = 'native' and archived_at is null and status = 'open' group by 1",
        [actor.orgId],
      );
      const won = await db.query<{ currency: string; n: string; total: string | null }>(
        "select currency, count(*)::text as n, sum(monetary_value)::text as total from crm_opportunities where org_id = $1 and provider = 'native' and archived_at is null and status = 'won' and closed_at >= date_trunc('month', now() at time zone $2) at time zone $2 group by 1",
        [actor.orgId, actor.timezone],
      );
      deals = {
        open: open.rows.reduce((n, r) => n + Number(r.n), 0),
        openValue: sumByCurrency(open.rows),
        wonThisMonth: won.rows.reduce((n, r) => n + Number(r.n), 0),
        wonValueThisMonth: sumByCurrency(won.rows),
      };
      const p = await db.query<{ id: string; name: string }>("select id, name from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null order by is_default desc, position limit 1", [actor.orgId]);
      if (p.rows[0]) {
        const stages = await db.query<{ id: string; name: string; n: string }>(
          `select s.id, s.name, (select count(*) from crm_opportunities o where o.stage_ref = s.id and o.status = 'open' and o.archived_at is null)::text as n
           from crm_pipeline_stages s where s.org_id = $1 and s.pipeline_id = $2 and s.archived_at is null and s.kind = 'open' order by s.position`,
          [actor.orgId, p.rows[0].id],
        );
        pipeline = { id: p.rows[0].id, name: p.rows[0].name, stages: stages.rows.map((s) => ({ id: s.id, name: s.name, count: Number(s.n) })) };
      }
    }
    let activity: CrmOverview["activity"] = [];
    if (actor.can("contacts.view")) {
      const { rows } = await db.query<{ id: string; occurred_at: Date; kind: string; summary: string; actor_name: string | null; agent_name: string | null; actor_kind: string; contact_id: string | null; contact_name: string | null; opportunity_id: string | null }>(
        `select a.id::text, a.occurred_at, a.kind, a.summary, nullif(u.full_name, '') as actor_name, ai.display_name as agent_name, a.actor_kind, a.contact_id, c.display_name as contact_name, a.opportunity_id
         from crm_activities a left join users u on u.id = a.actor_user_id left join agent_instances ai on ai.id = a.agent_id left join contacts c on c.id = a.contact_id and c.deleted_at is null
         where a.org_id = $1 and a.kind <> 'note.added' and ($2::boolean or a.opportunity_id is null) order by a.occurred_at desc limit 12`,
        [actor.orgId, actor.can("sales.view")],
      );
      activity = rows.map((r) => ({
        id: r.id, at: new Date(r.occurred_at).toISOString(), kind: r.kind, summary: r.summary,
        actor: r.actor_name ?? r.agent_name ?? (r.actor_kind === "system" ? "iAcquire" : r.actor_kind === "contact" ? "Contact" : null),
        contact: r.contact_id && r.contact_name !== null ? { id: r.contact_id, name: r.contact_name || "Unnamed contact" } : null,
        opportunityId: r.opportunity_id,
      }));
    }
    return { deals, pipeline, activity };
  });
  return { counts, tasks, myTasks, ...rest };
}
