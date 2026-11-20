import "server-only";
import { serverMarker, systemNoticeMarker, type ServerEvidenceMarker } from "@/lib/evidence-class";
import type { WorkforceChatReadIntent, WorkforceChatReadWindow } from "@/lib/workforce-chat-read-intent";
import { addDays, zonedToInstant } from "@/lib/calendars/slots";
import { withUser } from "@/server/db";
import type { OrgContext } from "@/server/tenancy/context";
import { listApprovals } from "@/server/approvals/service";
import { listSchedule } from "@/server/calendars/schedule";
import { listCalendars } from "@/server/calendars/setup";
import { memberActor } from "@/server/crm/actor";

export interface ChatReadIntentAgent {
  id: string;
}

export interface ChatReadIntentResult {
  content: string;
  evidence: ServerEvidenceMarker;
}

interface NamedCountRow {
  id: string;
  label: string;
  total: number;
}

interface ActivityJobRow {
  id: string;
  title: string;
  capability: string;
  finished_at: Date;
  total: number;
}

interface ExecutedApprovalRow {
  id: string;
  title: string;
  risk: string;
  executed_at: Date;
  job_id: string | null;
  total: number;
}

interface ApprovalSampleRow {
  id: string;
  title: string;
  risk: string;
  created_at: Date;
  requested_by_name: string | null;
}

function localBounds(window: WorkforceChatReadWindow, timeZone: string): { from: Date; to: Date } {
  return {
    from: new Date(zonedToInstant(window.startDate, 0, timeZone)),
    to: new Date(zonedToInstant(window.endDateExclusive, 0, timeZone)),
  };
}

function localDayBounds(date: string, timeZone: string): { from: Date; to: Date } {
  return {
    from: new Date(zonedToInstant(date, 0, timeZone)),
    to: new Date(zonedToInstant(addDays(date, 1), 0, timeZone)),
  };
}

function safeText(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+.!|>]/g, "\\$&").replace(/\s+/g, " ").trim();
}

function total(rows: Array<{ total: number }>): number {
  return Number(rows[0]?.total ?? 0);
}

function dateLabel(date: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone }).format(new Date(date));
}

function periodLabel(window: WorkforceChatReadWindow): string {
  const finalDate = addDays(window.endDateExclusive, -1);
  if (finalDate === window.startDate) return window.label === window.startDate ? window.startDate : `${window.label} (${window.startDate})`;
  return `${window.label} (${window.startDate} through ${finalDate})`;
}

function namesSummary(rows: NamedCountRow[]): string {
  if (!rows.length) return "none (0)";
  const count = total(rows);
  const names = rows.map((row) => safeText(row.label)).filter(Boolean);
  const extra = Math.max(0, count - names.length);
  return `${count}${names.length ? ` — ${names.join(", ")}${extra ? `, and ${extra} more` : ""}` : ""}`;
}

function missingPermission(permission: string): string {
  return `Permission \`${permission}\` is required; no records in this section were read.`;
}

async function readNewLeads(ctx: OrgContext, window: WorkforceChatReadWindow): Promise<ChatReadIntentResult> {
  const { from, to } = localBounds(window, ctx.org.timezone);
  const result = await withUser(ctx.user.id, async (db) => {
    const leads = ctx.can("leads.view")
      ? (await db.query<NamedCountRow>(
        `select id, business_name as label, count(*) over()::int as total
           from leads where org_id = $1 and created_at >= $2 and created_at < $3
          order by created_at desc, id limit 5`,
        [ctx.org.orgId, from, to],
      )).rows
      : null;
    const contacts = ctx.can("contacts.view")
      ? (await db.query<NamedCountRow>(
        `select id, coalesce(nullif(display_name, ''), 'Unnamed contact') as label, count(*) over()::int as total
           from contacts where org_id = $1 and deleted_at is null and created_at >= $2 and created_at < $3
          order by created_at desc, id limit 5`,
        [ctx.org.orgId, from, to],
      )).rows
      : null;
    let conversations: NamedCountRow[] | null = null;
    if (ctx.can("inbox.view") && ctx.can("contacts.view")) {
      const label = ctx.can("contacts.view")
        ? "coalesce(nullif(c.display_name, ''), 'Unnamed contact')"
        : "'Inbound conversation'";
      const contactJoin = ctx.can("contacts.view")
        ? "join contacts c on c.id = v.contact_id and c.org_id = v.org_id and c.deleted_at is null"
        : "";
      conversations = (await db.query<NamedCountRow>(
        `select v.id, ${label} as label, count(*) over()::int as total
           from conversations v ${contactJoin}
          where v.org_id = $1 and v.created_at >= $2 and v.created_at < $3
            and exists (select 1 from conversation_messages m where m.org_id = v.org_id and m.conversation_id = v.id and m.direction = 'inbound')
          order by v.created_at desc, v.id limit 5`,
        [ctx.org.orgId, from, to],
      )).rows;
    }
    return { leads, contacts, conversations };
  });

  const day = periodLabel(window);
  const leadLine = result.leads === null
    ? `- Researched leads: ${missingPermission("leads.view")}`
    : `- Researched leads: ${namesSummary(result.leads)}. [Open leads](/leads).`;
  const contactLine = result.contacts === null
    ? `- CRM contacts: ${missingPermission("contacts.view")}`
    : `- CRM contacts: ${namesSummary(result.contacts)}. [Open contacts](/crm/contacts).`;
  const conversationLine = result.conversations === null
    ? `- Inbound conversations: ${missingPermission(ctx.can("inbox.view") ? "contacts.view" : "inbox.view")}`
    : `- Inbound conversations: ${namesSummary(result.conversations)}. [Open inbox](/inbox).`;
  return {
    content: `New records for ${day}, in the workspace time zone:\n${leadLine}\n${contactLine}\n${conversationLine}`,
    evidence: result.leads === null && result.contacts === null && result.conversations === null
      ? systemNoticeMarker()
      : serverMarker("record_retrieval"),
  };
}

interface FollowupRow {
  id: string;
  name: string;
  priority_label: string | null;
  priority_score: number | null;
  last_contact_at: Date | null;
  open_deals: number;
  total: number;
}

function relativeContact(value: Date | null, now: Date, timeZone: string): string {
  if (!value) return "no recorded contact";
  const contactDate = dateLabel(value, timeZone);
  const today = dateLabel(now, timeZone);
  if (contactDate === today) return "last recorded contact today";
  return `last recorded contact ${contactDate}`;
}

async function readFollowupRanking(ctx: OrgContext): Promise<ChatReadIntentResult> {
  if (!ctx.can("contacts.view") || !ctx.can("sales.view") || !ctx.can("inbox.view") || !ctx.can("calls.view")) {
    const missing = [!ctx.can("contacts.view") ? "contacts.view" : null, !ctx.can("sales.view") ? "sales.view" : null,
      !ctx.can("inbox.view") ? "inbox.view" : null, !ctx.can("calls.view") ? "calls.view" : null].filter(Boolean).join(" and ");
    return {
      content: `I need ${missing} to rank follow-ups using saved priorities, last contact and open deals. No contact, conversation, call or deal records were read.`,
      evidence: systemNoticeMarker(),
    };
  }

  const rows = await withUser(ctx.user.id, async (db) => (await db.query<FollowupRow>(
    `with ranked as (
       select c.id, coalesce(nullif(c.display_name, ''), 'Unnamed contact') as name,
              c.priority_label, c.priority_score,
              greatest(
                (select max(m.created_at)
                   from conversations v join conversation_messages m on m.conversation_id = v.id and m.org_id = v.org_id
                  where v.org_id = c.org_id and v.contact_id = c.id
                    and ((m.direction = 'inbound' and m.status = 'received') or (m.direction = 'outbound' and m.status in ('sent', 'delivered', 'read')))
                ),
                (select max(coalesce(r.started_at, r.created_at)) from crm_call_records r
                  where r.org_id = c.org_id and r.contact_id = c.id and r.direction in ('inbound', 'outbound'))
              ) as last_contact_at,
              (select count(*)::int from crm_opportunities o
                where o.org_id = c.org_id and o.contact_id = c.id and o.provider = 'native' and o.archived_at is null and o.status = 'open') as open_deals,
              count(*) over()::int as total
         from contacts c
        where c.org_id = $1 and c.deleted_at is null
          and coalesce(c.lead_status, '') not in ('customer', 'unqualified', 'inactive')
        order by case c.priority_label when 'hot' then 4 when 'warm' then 3 when 'cold' then 2 when 'insufficient_data' then 1 else 0 end desc,
                 greatest(
                   (select max(m.created_at) from conversations v join conversation_messages m on m.conversation_id = v.id and m.org_id = v.org_id
                     where v.org_id = c.org_id and v.contact_id = c.id
                       and ((m.direction = 'inbound' and m.status = 'received') or (m.direction = 'outbound' and m.status in ('sent', 'delivered', 'read')))
                   ),
                   (select max(coalesce(r.started_at, r.created_at)) from crm_call_records r
                     where r.org_id = c.org_id and r.contact_id = c.id and r.direction in ('inbound', 'outbound'))
                 ) asc nulls first,
                 (select count(*) from crm_opportunities o where o.org_id = c.org_id and o.contact_id = c.id and o.provider = 'native' and o.archived_at is null and o.status = 'open') desc,
                 c.priority_score desc nulls last, c.created_at asc
        limit 5
     ) select * from ranked`,
    [ctx.org.orgId],
  )).rows);

  const count = total(rows);
  if (!count) return {
    content: "There are no active lead contacts to rank for follow-up right now (0). [Open contacts](/crm/contacts).",
    evidence: serverMarker("record_retrieval"),
  };

  const now = new Date();
  const entries = rows.map((row, index) => {
    const priority = row.priority_label ? row.priority_label.replaceAll("_", " ") : "unscored";
    const score = row.priority_score === null ? "" : `, score ${row.priority_score}`;
    const dealText = `${row.open_deals} open deal${row.open_deals === 1 ? "" : "s"}`;
    const reason = `${priority} priority${score}; ${relativeContact(row.last_contact_at, now, ctx.org.timezone)}; ${dealText}`;
    const suggestion = row.open_deals > 0
      ? "Check the open deal before choosing the next step."
      : !row.last_contact_at
        ? "Confirm whether anyone has contacted them; the CRM has no recorded contact."
        : "Review the conversation history and choose a relevant next step.";
    return `${index + 1}. ${safeText(row.name)} — ${reason}. Suggested next step: ${suggestion}`;
  });
  const extra = count > rows.length ? `\nShowing the first ${rows.length} of ${count}.` : "";
  return {
    content: `Follow-up ranking: ${count} active lead contact${count === 1 ? "" : "s"} found, ordered by saved priority, oldest recorded contact, then open deals.\n${entries.join("\n")}\n[Open contacts](/crm/contacts).${extra}`,
    evidence: serverMarker("record_retrieval"),
  };
}

async function readAppointments(ctx: OrgContext, date: string): Promise<ChatReadIntentResult> {
  if (!ctx.can("appointments.view")) {
    return { content: `Permission \`appointments.view\` is required; no appointment records were read.`, evidence: systemNoticeMarker() };
  }
  const actor = memberActor(ctx);
  const { from, to } = localDayBounds(date, ctx.org.timezone);
  const [calendars, items] = await Promise.all([
    listCalendars(actor),
    listSchedule(actor, { from, to }),
  ]);
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: ctx.org.timezone, hour: "numeric", minute: "2-digit" });
  const rows = items.slice(0, 5).map((item) => {
    const contact = item.contact ? ` — ${safeText(item.contact.name)}` : "";
    return `- ${formatter.format(new Date(item.startAt))}: ${safeText(item.title)}${contact} (${item.status})`;
  });
  const count = items.length;
  const setup = calendars.length ? "" : "No calendar is set up for this workspace. ";
  const summary = count ? `${count} found.` : "none (0).";
  const details = count ? `\n${rows.join("\n")}${count > rows.length ? `\nShowing the first ${rows.length} of ${count}.` : ""}` : "";
  return {
    content: `${setup}Appointments on ${date} (workspace local time): ${summary}${details}\n[Open Appointments](/appointments).`,
    evidence: serverMarker("record_retrieval", items[0] ? { kind: "schedule", id: items[0].id } : undefined),
  };
}

function mayDecide(ctx: OrgContext, row: { risk: string }): boolean {
  return ctx.can("approvals.decide") && (!(row.risk === "high" || row.risk === "critical") || ctx.can("approvals.decide_high"));
}

function ageLabel(createdAt: Date, now: Date, timeZone: string): string {
  const created = dateLabel(createdAt, timeZone);
  const current = dateLabel(now, timeZone);
  if (created === current) return "today";
  const days = Math.max(1, Math.floor((Date.parse(`${current}T12:00:00Z`) - Date.parse(`${created}T12:00:00Z`)) / 86_400_000));
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

async function readApprovalsWaiting(ctx: OrgContext): Promise<ChatReadIntentResult> {
  if (!ctx.can("approvals.view")) {
    return { content: `Permission \`approvals.view\` is required; no approval records were read.`, evidence: systemNoticeMarker() };
  }
  if (!ctx.can("approvals.decide")) {
    return { content: `Permission \`approvals.decide\` is required to see requests you can decide. No approval records were read.`, evidence: systemNoticeMarker() };
  }
  let pending: ApprovalSampleRow[] = (await listApprovals(ctx, "pending"))
    .filter((row) => mayDecide(ctx, row));
  const eligibleCount = await withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ count: number }>(
      `select count(*)::int as count from approval_requests
        where org_id = $1 and status = 'pending' and ($2::boolean or risk not in ('high', 'critical'))`,
      [ctx.org.orgId, ctx.can("approvals.decide_high")],
    );
    return Number(rows[0]?.count ?? 0);
  });
  // listApprovals is the canonical reader, but it deliberately caps its list at 200. If risk
  // filtering leaves too few examples, fetch only the missing eligible samples under the same
  // member session so an older low-risk request is not hidden behind un-decidable high-risk rows.
  if (pending.length < Math.min(eligibleCount, 5)) {
    pending = await withUser(ctx.user.id, async (db) => (await db.query<ApprovalSampleRow>(
      `select a.id, a.title, a.risk, a.created_at,
              coalesce(nullif(u.full_name, ''), u.email::text) as requested_by_name
         from approval_requests a left join users u on u.id = a.requested_by
        where a.org_id = $1 and a.status = 'pending' and ($2::boolean or a.risk not in ('high', 'critical'))
        order by a.created_at desc, a.id limit 5`,
      [ctx.org.orgId, ctx.can("approvals.decide_high")],
    )).rows);
  }
  const items = pending.slice(0, 5).map((row) => {
    const title = safeText(row.title);
    const requester = safeText(row.requested_by_name ?? "Unknown requester");
    return `- ${title} — ${row.risk} risk, requested by ${requester}, ${ageLabel(new Date(row.created_at), new Date(), ctx.org.timezone)}. [Open approvals](/approvals).`;
  });
  const count = eligibleCount;
  const detail = count ? `\n${items.join("\n")}${count > items.length ? `\nShowing the first ${items.length} of ${count}.` : ""}` : "\nNone (0) are waiting for a decision you can make.";
  return {
    content: `${count} approval${count === 1 ? "" : "s"} waiting for your decision.${detail}\n[Open approvals](/approvals).`,
    evidence: serverMarker("record_retrieval", pending[0] ? { kind: "approval", id: pending[0].id } : undefined),
  };
}

async function readCompletedActivity(ctx: OrgContext, window: WorkforceChatReadWindow): Promise<ChatReadIntentResult> {
  if (!ctx.can("activity.view")) {
    return { content: `Permission \`activity.view\` is required to read completed activity. No activity records were read.`, evidence: systemNoticeMarker() };
  }
  const { from, to } = localBounds(window, ctx.org.timezone);
  const result = await withUser(ctx.user.id, async (db) => {
    const jobs = (await db.query<ActivityJobRow>(
      `select id, title, capability, finished_at, count(*) over()::int as total from ai_work_jobs
        where org_id = $1 and status = 'completed' and finished_at >= $2 and finished_at < $3
        order by finished_at desc, id limit 5`,
      [ctx.org.orgId, from, to],
    )).rows;
    const approvals = (await db.query<ExecutedApprovalRow>(
      `select a.id, a.title, a.risk, a.executed_at, j.id as job_id, count(*) over()::int as total
         from approval_requests a
         left join ai_work_jobs j on j.id::text = (a.action ->> 'workJobId') and j.org_id = a.org_id
        where a.org_id = $1 and a.status = 'approved' and a.execution_status = 'succeeded'
          and a.executed_at >= $2 and a.executed_at < $3
        order by a.executed_at desc, a.id limit 5`,
      [ctx.org.orgId, from, to],
    )).rows;
    return { jobs, approvals };
  });

  const jobItems = result.jobs.map((job) => `- ${safeText(job.title)} — ${dateLabel(job.finished_at, ctx.org.timezone)}. [Open work item](/work?job=${encodeURIComponent(job.id)}).`);
  const approvalItems = result.approvals.map((row) => {
    const link = row.job_id
      ? `[Open work item](/work?job=${encodeURIComponent(row.job_id)})`
      : "[Open approvals](/approvals)";
    return `- ${safeText(row.title)} — ${row.risk} risk, executed ${dateLabel(row.executed_at, ctx.org.timezone)}. ${link}.`;
  });
  const jobCount = Number(result.jobs[0]?.total ?? 0);
  const approvalCount = Number(result.approvals[0]?.total ?? 0);
  const jobCountText = jobCount ? String(jobCount) : "none (0)";
  const approvalCountText = approvalCount ? String(approvalCount) : "none (0)";
  const jobSection = `Completed work items: ${jobCountText}.${jobItems.length ? `\n${jobItems.join("\n")}` : ""}${jobCount > jobItems.length ? `\nShowing the first ${jobItems.length} of ${jobCount}.` : ""}`;
  const approvalSection = `Approved and executed writes: ${approvalCountText}.${approvalItems.length ? `\n${approvalItems.join("\n")}` : ""}${approvalCount > approvalItems.length ? `\nShowing the first ${approvalItems.length} of ${approvalCount}.` : ""}`;
  const marker = result.jobs[0]
    ? serverMarker("record_retrieval", { kind: "work_job", id: result.jobs[0].id })
    : result.approvals[0]
      ? serverMarker("record_retrieval", { kind: "approval", id: result.approvals[0].id })
      : serverMarker("record_retrieval");
  return {
    content: `Completed activity for ${periodLabel(window)} (workspace local time):\n${jobSection}\n${approvalSection}`,
    evidence: marker,
  };
}

/** Reads tenant data as the requesting member, using each domain service's permission checks. */
export async function runChatReadIntent(
  ctx: OrgContext,
  _agent: ChatReadIntentAgent,
  intent: Exclude<WorkforceChatReadIntent, { kind: "none" }>,
): Promise<ChatReadIntentResult> {
  switch (intent.kind) {
    case "clarify":
      return { content: intent.question, evidence: systemNoticeMarker() };
    case "new_leads":
      return readNewLeads(ctx, intent.window);
    case "followup_ranking":
      return readFollowupRanking(ctx);
    case "appointments_on":
      return readAppointments(ctx, intent.date);
    case "approvals_waiting":
      return readApprovalsWaiting(ctx);
    case "completed_activity":
      return readCompletedActivity(ctx, intent.window);
  }
}
