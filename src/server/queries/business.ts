import "server-only";
import { withUser } from "@/server/db";
import { sourceAvailability } from "@/server/queries/dashboard";
import type { OrgContext } from "@/server/tenancy/context";

export async function getAppointments(ctx: OrgContext) {
  return withUser(ctx.user.id, async (db) => {
    const sources = await sourceAvailability(db, ctx.org.orgId, ctx.org.isDemo);
    const { rows } = await db.query<{
      id: string;
      title: string;
      status: string;
      start_at: Date;
      end_at: Date;
      timezone: string | null;
      meeting_type: string | null;
      meeting_link: string | null;
      contact_label: string | null;
      synced_at: Date;
      late_cancellation: boolean;
      reschedule_count: number;
      previous_start_at: Date | null;
      conflict: boolean;
      origin: "sync" | "webhook" | "portal_ai" | "portal_staff";
      cancelled_at: Date | null;
    }>(
      `select a.id, a.title, a.status, a.start_at, a.end_at, a.timezone, a.meeting_type, a.meeting_link, coalesce(nullif(c.display_name, ''), a.contact_label) as contact_label, a.synced_at,
         a.late_cancellation, a.reschedule_count, a.previous_start_at, a.conflict, a.origin, a.cancelled_at
       from appointment_refs a left join contacts c on c.id = a.contact_id and c.org_id = a.org_id
       where a.org_id = $1 and a.start_at > now() - interval '90 days' order by a.start_at`,
      [ctx.org.orgId],
    );
    const integ = await db.query<{ status: string; detail: string | null; last_checked_at: Date | null }>(
      "select status, detail, last_checked_at from integration_status where org_id = $1 and provider = 'ghl_calendar'",
      [ctx.org.orgId],
    );
    return { connected: sources.calendar, appointments: rows, integration: integ.rows[0] ?? null };
  });
}

export async function getSalesPipeline(ctx: OrgContext) {
  return withUser(ctx.user.id, async (db) => {
    const sources = await sourceAvailability(db, ctx.org.orgId, ctx.org.isDemo);
    const pipelines = await db.query<{ ghl_pipeline_id: string; name: string; stages: Array<{ id: string; name: string; position: number }>; synced_at: Date }>(
      "select ghl_pipeline_id, name, stages, synced_at from crm_pipelines where org_id = $1 and provider = 'ghl' order by name",
      [ctx.org.orgId],
    );
    const opps = await db.query<{
      id: string;
      ghl_opportunity_id: string;
      ghl_pipeline_id: string | null;
      stage_id: string | null;
      stage_name: string | null;
      name: string;
      status: string;
      monetary_value: string | null;
      contact_label: string | null;
      assigned_to: string | null;
      source: string | null;
      remote_updated_at: Date | null;
      synced_at: Date;
      notes: number;
    }>(
      `select o.id, o.ghl_opportunity_id, o.ghl_pipeline_id, o.stage_id, o.stage_name, o.name, o.status, o.monetary_value::text,
              o.contact_label, o.assigned_to, o.source, o.remote_updated_at, o.synced_at,
              (select count(*)::int from record_notes n where n.org_id = o.org_id and n.record_type = 'opportunity' and n.record_id = o.id::text) as notes
       from crm_opportunities o where o.org_id = $1 and o.provider = 'ghl' order by o.remote_updated_at desc nulls last`,
      [ctx.org.orgId],
    );
    const tasks = await db.query<{ id: string; title: string; due_at: Date | null; status: string; related_id: string | null }>(
      "select id, title, due_at, status, related_id from tasks where org_id = $1 and category in ('sales', 'follow_up') and status in ('open', 'in_progress') order by due_at nulls last limit 20",
      [ctx.org.orgId],
    );
    const proposals = await db.query<{ n: number }>(
      "select count(*)::int as n from approval_requests where org_id = $1 and kind in ('follow_up_message', 'crm_update') and status = 'pending'",
      [ctx.org.orgId],
    );
    return {
      connected: sources.crm,
      detail: sources.crmDetail,
      pipelines: pipelines.rows,
      opportunities: opps.rows.map((o) => ({ ...o, monetary_value: o.monetary_value === null ? null : Number(o.monetary_value) })),
      tasks: tasks.rows,
      pendingSalesApprovals: proposals.rows[0]?.n ?? 0,
    };
  });
}

export async function getRetention(ctx: OrgContext) {
  return withUser(ctx.user.id, async (db) => {
    const accounts = await db.query<{
      id: string;
      customer_name: string;
      status: string;
      health: string;
      onboarding_progress: number | null;
      renewal_date: string | null;
      last_contact_at: Date | null;
      open_issues: number;
      repeat_opportunity: string | null;
      source: string;
      created_at: Date;
    }>(
      `select id, customer_name, status, health, onboarding_progress, to_char(renewal_date, 'YYYY-MM-DD') as renewal_date, last_contact_at,
              open_issues, repeat_opportunity, source, created_at
       from retention_accounts where org_id = $1 order by case status when 'at_risk' then 0 when 'onboarding' then 1 when 'active' then 2 else 3 end, customer_name`,
      [ctx.org.orgId],
    );
    const feedback = await db.query<{ id: string; account_id: string | null; customer_name: string | null; rating: number | null; comment: string | null; received_at: Date }>(
      `select f.id, f.account_id, a.customer_name, f.rating, f.comment, f.received_at
       from customer_feedback f left join retention_accounts a on a.id = f.account_id
       where f.org_id = $1 order by f.received_at desc limit 20`,
      [ctx.org.orgId],
    );
    const history = await db.query<{ id: string; account_id: string; event: string; occurred_at: Date }>(
      "select id, account_id, event, occurred_at from service_history where org_id = $1 order by occurred_at desc limit 100",
      [ctx.org.orgId],
    );
    const tasks = await db.query<{ id: string; title: string; due_at: Date | null; related_id: string | null }>(
      "select id, title, due_at, related_id from tasks where org_id = $1 and category = 'retention' and status in ('open', 'in_progress') order by due_at nulls last",
      [ctx.org.orgId],
    );
    const tickets = await db.query<{ n: number }>(
      "select coalesce(sum(open_issues), 0)::int as n from retention_accounts where org_id = $1",
      [ctx.org.orgId],
    );
    return { accounts: accounts.rows, feedback: feedback.rows, history: history.rows, tasks: tasks.rows, openIssues: tickets.rows[0]?.n ?? 0 };
  });
}
