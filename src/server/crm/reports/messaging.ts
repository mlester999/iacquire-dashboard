import "server-only";
import { crmRead } from "@/server/crm/actor";
import { num, ownerNote, pct, type ReportScope } from "@/server/crm/reports/scope";
import { BLOCK_REASON_LABELS } from "@/lib/messaging";
import type { FilterKey } from "@/components/crm/reports/spec";
import type { ChannelRow, FollowUpsReport, MessagingReport, SectionResult } from "@/components/crm/reports/types";

export const PROVIDER_LABELS: Record<string, string> = {
  ghl: "GoHighLevel", resend: "Resend", twilio: "Twilio", meta_whatsapp: "WhatsApp Cloud API", unknown: "Not recorded",
};

const BLOCK_LABELS: Record<string, string> = { ...BLOCK_REASON_LABELS, unspecified: "No reason recorded" };

export const STOP_REASON_LABELS: Record<string, string> = {
  customer_replied: "Customer replied", customer_booked: "Customer booked", customer_opted_out: "Customer opted out", consent_invalid: "Consent not valid",
  human_took_over: "A person took over", budget_exhausted: "Budget or credits ran out", automation_paused: "Automation paused", window_expired: "Messaging window closed",
  conversation_closed: "Conversation closed", contact_merged: "Contact merged", privacy_request: "Privacy request", stopped_by_team: "Stopped by the team",
  followups_turned_off: "Follow-ups turned off", offboarding: "Workspace closing", unknown: "No reason recorded",
};
const label = (map: Record<string, string>, key: string) => map[key] ?? key.replace(/_/g, " ");

/**
 * Messaging: messages received and sent in the period, what the providers reported about delivery, why messages were blocked, and
 * campaign recipients. Counted from the inbox's own records (internal notes are left out). A team member filter means conversations that
 * person owns or is assigned to; the campaign filter needs permission to see campaigns.
 */
export async function messagingSection(scope: ReportScope): Promise<SectionResult<"messaging">> {
  const { actor, filters: f } = scope;
  const seeCampaigns = actor.can("campaigns.manage");
  const campaign = f.campaign && seeCampaigns ? f.campaign : null;
  const data = await crmRead(actor, async (db) => {
    // $1 org, $2 member, $3 source, $4 channel, $5 campaign, $6 start, $7 end, $8 time zone
    const p = [actor.orgId, f.member ?? null, f.source ?? null, f.channel ?? null, campaign, scope.startsAt, scope.endsAt];
    const join = `from conversation_messages m join conversations cv on cv.id = m.conversation_id and cv.org_id = m.org_id
      left join contacts c on c.id = cv.contact_id and c.org_id = cv.org_id`;
    const where = `where m.org_id = $1 and m.direction in ('inbound', 'outbound')
      and ($2::uuid is null or cv.owner_user_id = $2 or cv.assigned_user_id = $2) and ($3::text is null or c.created_via = $3) and ($4::text is null or cv.channel = $4)
      and ($5::uuid is null or m.id in (select r.message_id from crm_campaign_recipients r where r.campaign_id = $5 and r.org_id = $1 and r.message_id is not null))`;
    const counts = `count(*) filter (where m.direction = 'inbound')::text as received,
      count(*) filter (where m.direction = 'outbound' and m.status in ('sent', 'delivered', 'read'))::text as sent,
      count(*) filter (where m.direction = 'outbound' and m.status in ('delivered', 'read'))::text as delivered,
      count(*) filter (where m.direction = 'outbound' and m.status = 'failed')::text as failed,
      count(*) filter (where m.direction = 'outbound' and m.status = 'blocked')::text as blocked,
      count(*) filter (where m.direction = 'outbound' and m.status in ('draft', 'queued', 'sending'))::text as pending`;
    const period = "m.created_at >= $6 and m.created_at < $7";
    type Row = { channel: string; provider: string; received: string; sent: string; delivered: string; failed: string; blocked: string; pending: string };
    const rows = await db.query<Row>(`select cv.channel, coalesce(m.provider, 'unknown') as provider, ${counts} ${join} ${where} and ${period} group by 1, 2 order by 1, 2`, p);
    const days = await db.query<{ day: string; received: string; sent: string }>(
      `select to_char((m.created_at at time zone $8)::date, 'YYYY-MM-DD') as day,
              count(*) filter (where m.direction = 'inbound')::text as received,
              count(*) filter (where m.direction = 'outbound' and m.status in ('sent', 'delivered', 'read'))::text as sent
       ${join} ${where} and ${period} group by 1 order by 1`,
      [...p, scope.timezone],
    );
    const failures = await db.query<{ provider: string; status: string; n: string }>(
      `select e.provider, e.status, count(*)::text as n from message_delivery_events e
       join conversation_messages m on m.id = e.message_id and m.org_id = e.org_id
       join conversations cv on cv.id = m.conversation_id and cv.org_id = m.org_id
       left join contacts c on c.id = cv.contact_id and c.org_id = cv.org_id
       ${where.replace("where m.org_id = $1", "where e.org_id = $1 and m.org_id = $1")} and e.status in ('failed', 'undelivered') and e.occurred_at >= $6 and e.occurred_at < $7
       group by 1, 2 order by count(*) desc`,
      p,
    );
    const blocked = await db.query<{ reason: string; n: string }>(
      `select coalesce(nullif(m.blocked_reason, ''), 'unspecified') as reason, count(*)::text as n ${join} ${where} and ${period} and m.direction = 'outbound' and m.status = 'blocked'
       group by 1 order by count(*) desc limit 10`,
      p,
    );
    let campaigns: MessagingReport["campaigns"] = null;
    if (seeCampaigns) {
      const cr = await db.query<{ id: string; name: string; channel: string; status: string; rstatus: string | null; n: string }>(
        `with picked as (
           select cp.id, cp.name, cp.channel, cp.status, coalesce(cp.started_at, cp.created_at) as at from crm_campaigns cp
           where cp.org_id = $1 and ($2::uuid is null or cp.id = $2) and ($3::text is null or cp.channel = $3)
             and ($2::uuid is not null or (coalesce(cp.started_at, cp.created_at) >= $4 and coalesce(cp.started_at, cp.created_at) < $5))
           order by at desc limit 20)
         select k.id, k.name, k.channel, k.status, r.status as rstatus, count(r.contact_id)::text as n
         from picked k left join crm_campaign_recipients r on r.campaign_id = k.id and r.org_id = $1
         group by k.id, k.name, k.channel, k.status, k.at, r.status order by k.at desc`,
        [actor.orgId, campaign, f.channel ?? null, scope.startsAt, scope.endsAt],
      );
      const byId = new Map<string, NonNullable<MessagingReport["campaigns"]>[number]>();
      for (const r of cr.rows) {
        const c = byId.get(r.id) ?? { id: r.id, name: r.name, channel: r.channel, status: r.status, recipients: 0, byStatus: {} };
        if (r.rstatus) {
          c.byStatus[r.rstatus] = num(r.n);
          c.recipients += num(r.n);
        }
        byId.set(r.id, c);
      }
      campaigns = [...byId.values()];
    }
    const byChannel: ChannelRow[] = rows.rows.map((r) => ({
      channel: r.channel, provider: r.provider, received: num(r.received), sent: num(r.sent), delivered: num(r.delivered), failed: num(r.failed), blocked: num(r.blocked), pending: num(r.pending),
    }));
    const sum = (k: keyof Omit<ChannelRow, "channel" | "provider">) => byChannel.reduce((n, r) => n + r[k], 0);
    return {
      received: sum("received"),
      sent: sum("sent"),
      delivered: sum("delivered"),
      failed: sum("failed"),
      blocked: sum("blocked"),
      pending: sum("pending"),
      byChannel,
      deliveryFailures: failures.rows.map((r) => ({ provider: r.provider, status: r.status, count: num(r.n) })),
      blockedReasons: blocked.rows.map((r) => ({ key: r.reason, label: label(BLOCK_LABELS, r.reason), count: num(r.n) })),
      byDay: days.rows.map((r) => ({ day: r.day, received: num(r.received), sent: num(r.sent) })),
      campaigns,
    } satisfies MessagingReport;
  });
  const ignored: FilterKey[] = f.campaign && !seeCampaigns ? ["campaign"] : [];
  const notes = ownerNote(scope, "conversations", "conversations");
  if (f.campaign && !seeCampaigns) notes.push("The campaign filter needs permission to see campaigns, so it wasn't applied.");
  return {
    section: "messaging",
    data,
    empty: data.byChannel.length === 0 && data.deliveryFailures.length === 0 && !(data.campaigns ?? []).some((c) => c.recipients > 0),
    ignored,
    notes,
  };
}

/**
 * Follow-up performance: sequences started in the period, how the ones that ended in it ended (completed, or stopped and why: a reply, a
 * booking, an opt-out, a person taking over…), and the follow-up messages actually sent.
 */
export async function followUpsSection(scope: ReportScope): Promise<SectionResult<"followups">> {
  const { actor, filters: f } = scope;
  const data = await crmRead(actor, async (db) => {
    // $1 org, $2 member, $3 source, $4 channel, $5 start, $6 end
    const base = [actor.orgId, f.member ?? null, f.source ?? null, f.channel ?? null];
    const p = [...base, scope.startsAt, scope.endsAt];
    const join = `from follow_up_plans fp join conversations cv on cv.id = fp.conversation_id and cv.org_id = fp.org_id
      left join contacts c on c.id = fp.contact_id and c.org_id = fp.org_id`;
    const where = `where fp.org_id = $1 and ($2::uuid is null or cv.owner_user_id = $2 or cv.assigned_user_id = $2)
      and ($3::text is null or c.created_via = $3) and ($4::text is null or cv.channel = $4)`;
    const started = await db.query<{ n: string }>(`select count(*)::text as n ${join} ${where} and fp.created_at >= $5 and fp.created_at < $6`, p);
    const active = await db.query<{ n: string }>(`select count(*)::text as n ${join} ${where} and fp.status = 'active'`, base);
    const closed = await db.query<{ status: string; reason: string; n: string }>(
      `select fp.status, coalesce(nullif(fp.cancel_reason, ''), 'unknown') as reason, count(*)::text as n ${join} ${where}
       and fp.status <> 'active' and fp.closed_at >= $5 and fp.closed_at < $6 group by 1, 2 order by count(*) desc`,
      p,
    );
    const sent = await db.query<{ n: string }>(
      `select count(*)::text as n from conversation_messages m join follow_up_steps st on st.id = m.followup_step_id and st.org_id = m.org_id
       join follow_up_plans fp on fp.id = st.plan_id and fp.org_id = st.org_id
       join conversations cv on cv.id = fp.conversation_id and cv.org_id = fp.org_id left join contacts c on c.id = fp.contact_id and c.org_id = fp.org_id
       ${where} and m.status in ('sent', 'delivered', 'read') and coalesce(m.sent_at, m.created_at) >= $5 and coalesce(m.sent_at, m.created_at) < $6`,
      p,
    );
    const blockedSteps = await db.query<{ n: string }>(
      `select count(*)::text as n from follow_up_steps st join follow_up_plans fp on fp.id = st.plan_id and fp.org_id = st.org_id
       join conversations cv on cv.id = fp.conversation_id and cv.org_id = fp.org_id left join contacts c on c.id = fp.contact_id and c.org_id = fp.org_id
       ${where} and st.status = 'blocked' and st.updated_at >= $5 and st.updated_at < $6`,
      p,
    );
    const completed = closed.rows.filter((r) => r.status === "completed").reduce((n, r) => n + num(r.n), 0);
    const stoppedRows = closed.rows.filter((r) => r.status === "cancelled");
    const stopped = stoppedRows.reduce((n, r) => n + num(r.n), 0);
    const replied = stoppedRows.filter((r) => r.reason === "customer_replied").reduce((n, r) => n + num(r.n), 0);
    const booked = stoppedRows.filter((r) => r.reason === "customer_booked").reduce((n, r) => n + num(r.n), 0);
    return {
      started: num(started.rows[0]?.n),
      activeNow: num(active.rows[0]?.n),
      completed,
      stopped,
      replied,
      booked,
      stoppedBy: stoppedRows.map((r) => ({ key: r.reason, label: label(STOP_REASON_LABELS, r.reason), count: num(r.n) })),
      messagesSent: num(sent.rows[0]?.n),
      stepsBlocked: num(blockedSteps.rows[0]?.n),
      replyRate: pct(replied, completed + stopped),
    } satisfies FollowUpsReport;
  });
  return {
    section: "followups",
    data,
    empty: data.started === 0 && data.completed === 0 && data.stopped === 0 && data.messagesSent === 0 && data.activeNow === 0,
    ignored: [],
    notes: [],
  };
}
