import "server-only";
import { z } from "zod";
import { readSystem } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { crmDeliveryHealth } from "@/server/admin/health";
import { defineReadTool } from "@/server/aqi/ops/tool";
import { clean, iso, metric, newCardId, num, plural } from "@/server/aqi/ops/tools/helpers";
import type { OpsMetricsCard, OpsTableCard, OpsTimelineCard, OpsTimelineEvent } from "@/lib/aqi/ops/types";

const SUPER = ["agency_super_admin"] as const;

const PROVIDER_LABEL: Record<string, string> = {
  ghl: "GoHighLevel", hermes: "Hermes", n8n: "n8n", google_calendar: "Google Calendar", email: "Email", domain: "Domain", supabase: "Supabase", external: "External service", llm: "AI provider",
};

export const integrationsStatus = defineReadTool({
  id: "integrations.status",
  title: "Integration and delivery status",
  description: "Connections that are in error or need attention, plus message, workflow and webhook delivery failures from recorded evidence.",
  group: "integrations",
  roles: SUPER,
  permission: "agency.integrations.health",
  scopes: ["platform", "tenant", "employee", "workflow", "ticket"],
  input: z.object({ limit: z.number().int().min(1).max(15).default(10) }).strict(),
  idempotent: true,
  audit: { action: "aqi.ops_tool_run", sensitive: false },
  timeoutMs: 12_000,
  async run(ctx, args) {
    const orgId = ctx.scope.type === "platform" ? null : ctx.scope.orgId;
    if (orgId) await ctx.authorizeOrg(orgId, "integrations.status");
    const { rows: connections } = await readSystem((db) => db.query<{ provider: string; status: string; last_error: string | null; last_failure_at: Date | null; last_success_at: Date | null; org: string | null; org_id: string | null; total: string; bad: string }>(
      `select c.provider, c.status, c.last_error, c.last_failure_at, c.last_success_at, o.name as org, c.org_id,
              count(*) over ()::text as total, (count(*) filter (where c.status in ('error', 'needs_attention', 'disconnected')) over ())::text as bad
         from integration_connections c left join organizations o on o.id = c.org_id
        where ($1::uuid is null or c.org_id = $1) and (c.org_id is null or app.user_can_access_org($2, c.org_id))
          and c.status in ('error', 'needs_attention', 'disconnected')
        order by (c.status = 'error') desc, c.last_failure_at desc nulls last limit $3`,
      [orgId, ctx.user.id, args.limit],
    ));
    const total = connections[0] ? Number(connections[0].total) : 0;
    const bad = connections[0] ? Number(connections[0].bad) : 0;

    let delivery: { label: string; value: number; detail?: string }[];
    const notes: string[] = [];
    if (orgId) {
      const { rows } = await readSystem((db) => db.query<{ msg_failed: number; msg_blocked: number; msg_stuck: number; wf_failed: number; hooks_failed: number; reminders_blocked: number }>(
        `select
           (select count(*) from conversation_messages where org_id = $1 and direction = 'outbound' and status = 'failed' and created_at > now() - interval '1 day')::int as msg_failed,
           (select count(*) from conversation_messages where org_id = $1 and direction = 'outbound' and status = 'blocked' and created_at > now() - interval '1 day')::int as msg_blocked,
           (select count(*) from conversation_messages where org_id = $1 and direction = 'outbound' and status = 'queued' and send_after < now() - interval '15 minutes')::int as msg_stuck,
           (select count(*) from crm_workflow_runs where org_id = $1 and status in ('failed', 'dead') and created_at > now() - interval '1 day')::int as wf_failed,
           (select count(*) from crm_webhook_deliveries where org_id = $1 and status in ('failed', 'dead') and created_at > now() - interval '1 day')::int as hooks_failed,
           (select count(*) from appointment_reminders where org_id = $1 and status = 'blocked' and updated_at > now() - interval '1 day')::int as reminders_blocked`,
        [orgId],
      ));
      const r = rows[0];
      delivery = [
        { label: "Outbound messages failed (24 h)", value: r.msg_failed }, { label: "Outbound messages blocked (24 h)", value: r.msg_blocked },
        { label: "Queued messages overdue by 15+ min", value: r.msg_stuck }, { label: "Workflow runs failed (24 h)", value: r.wf_failed },
        { label: "Webhook deliveries failed (24 h)", value: r.hooks_failed }, { label: "Appointment reminders blocked (24 h)", value: r.reminders_blocked },
      ];
    } else {
      const [crm, email] = await Promise.all([
        readSystem((db) => crmDeliveryHealth(db, ctx.now)),
        readSystem((db) => db.query<{ queued: number; failed: number }>("select count(*) filter (where status = 'queued')::int as queued, count(*) filter (where status = 'failed' and created_at > now() - interval '1 day')::int as failed from email_outbox")),
      ]);
      delivery = [
        { label: "CRM events waiting", value: crm.events.backlog, detail: crm.events.oldestPendingMinutes !== null ? `oldest ${crm.events.oldestPendingMinutes} min` : undefined },
        { label: "Event dead letters (24 h)", value: crm.events.deadLetters24h }, { label: "Workflow runs failed or dead (24 h)", value: crm.workflows.failed24h + crm.workflows.dead24h },
        { label: "Webhook deliveries failed or dead (24 h)", value: crm.webhooks.failed24h + crm.webhooks.dead24h }, { label: "Form submissions failed (24 h)", value: crm.forms.failed24h },
        { label: "Calendar connections needing attention", value: crm.calendarSync.connectionsNeedingAttention }, { label: "Appointment reminders blocked (24 h)", value: crm.bookings.remindersBlocked24h },
        { label: "Platform emails failed (24 h)", value: email.rows[0].failed, detail: env().EMAIL_PROVIDER === "resend" ? undefined : "email provider is in capture mode" },
      ];
      notes.push("Per-message delivery is read from a client's own workspace: select a client to trace one.");
    }

    const metrics: OpsMetricsCard = {
      id: newCardId(), kind: "metrics", title: "Delivery evidence", asOf: new Date().toISOString(), source: "Messaging, CRM automation, webhook and email delivery tables",
      refresh: { toolId: "integrations.status", args }, metrics: delivery.map((d) => metric(d.label, d.value, d.detail, d.value > 0 ? "degraded" : undefined)),
    };
    const table: OpsTableCard = {
      id: newCardId(), kind: "table", title: "Connections that need attention", asOf: new Date().toISOString(), source: "Integration connections (integration_connections)",
      caption: bad ? `${connections.length} of ${bad}` : "No connection is in error or needs attention.",
      columns: [{ key: "provider", label: "Service" }, { key: "client", label: "Client" }, { key: "status", label: "Status" }, { key: "error", label: "Last error" }, { key: "since", label: "Last failure" }],
      rows: connections.map((c) => ({ provider: PROVIDER_LABEL[c.provider] ?? c.provider, client: c.org ? clean(c.org, 50) : "Platform", status: c.status.replace(/_/g, " "), error: clean(c.last_error, 120) || "—", since: iso(c.last_failure_at)?.slice(0, 16).replace("T", " ") ?? "—", ...(c.org_id ? { _href: `/admin/clients/${c.org_id}/integrations` } : { _href: "/admin/integrations" }) })),
      truncated: bad > connections.length,
    };
    const failing = delivery.filter((d) => d.value > 0);
    return {
      summary: `${bad ? `${plural(bad, "connection")} in error, needing attention or disconnected${connections[0] ? `, e.g. ${PROVIDER_LABEL[connections[0].provider] ?? connections[0].provider} (${connections[0].org ? clean(connections[0].org, 40) : "platform"}): ${clean(connections[0].last_error, 120) || "no error recorded"}` : ""}.` : "No connection is recorded as in error."} ${failing.length ? `Delivery problems recorded: ${failing.map((d) => `${d.label} ${d.value}`).join("; ")}.` : "No delivery failures are recorded in the last 24 hours."}`,
      data: { connections: connections.map((c) => ({ service: c.provider, client: c.org, status: c.status, lastError: c.last_error, lastFailureAt: iso(c.last_failure_at), lastSuccessAt: iso(c.last_success_at) })), totalConnectionsInTrouble: bad, totalMatched: total, delivery, notes },
      cards: [metrics, table],
      evidence: { label: "Integration and delivery status", source: "integration_connections, conversation_messages, crm_workflow_runs, crm_webhook_deliveries, appointment_reminders, email_outbox", href: "/admin/integrations" },
      unavailable: ["Provider-side delivery receipts beyond those the providers posted back to this platform are not available. n8n execution logs are not read by AQi."],
    };
  },
});

// ---------------------------------------------------------------------------

type Evidence = { at: Date | string; source: string; detail: string; tone: OpsTimelineEvent["tone"] };

export const integrationsTrace = defineReadTool({
  id: "integrations.trace",
  title: "Delivery and workflow trace",
  description: "Traces what happened to outbound messages, appointment reminders, workflow runs and webhooks for the selected client (or workflow) in a time window, from recorded delivery evidence. Read-only; nothing is retried.",
  group: "integrations",
  roles: SUPER,
  permission: "agency.integrations.health",
  scopes: ["tenant", "employee", "workflow", "ticket"],
  input: z.object({ hours: z.number().int().min(1).max(168).default(48) }).strict(),
  idempotent: true,
  audit: { action: "aqi.ops_tool_run", sensitive: true },
  timeoutMs: 15_000,
  async run(ctx, args) {
    const orgId = ctx.scope.orgId;
    if (!orgId) throw new AppError("invalid_input", "Select a client workspace to trace its deliveries.");
    await ctx.authorizeOrg(orgId, "integrations.trace");
    const workflowId = ctx.scope.type === "workflow" ? ctx.scope.id : null;
    const since = new Date(ctx.now.getTime() - args.hours * 3_600_000).toISOString();

    const { rows } = await readSystem((db) => db.query<{ section: string; payload: Record<string, unknown> }>(
      `select u.section, u.payload from (
       (select 'message' as section, to_jsonb(x) as payload from (
          select m.id, m.status, m.status_detail, m.blocked_reason, m.scope, m.provider, m.attempt_count, m.created_at, m.failed_at, m.sent_at,
                 (m.dedupe_key is not null) as has_dedupe_key, (m.approval_id is not null) as needed_approval,
                 (select e.status || ': ' || coalesce(left(e.detail, 100), '') from message_delivery_events e where e.message_id = m.id order by e.occurred_at desc limit 1) as last_event
            from conversation_messages m
           where m.org_id = $1 and m.direction = 'outbound' and m.created_at >= $2
             and (m.status in ('failed', 'blocked') or (m.status = 'queued' and m.send_after < now() - interval '15 minutes'))
           order by m.created_at desc limit 8) x)
       union all
       (select 'reminder', to_jsonb(x) from (
          select r.status, r.reason, r.offset_minutes, r.due_at, r.updated_at from appointment_reminders r
           where r.org_id = $1 and r.updated_at >= $2 and r.status in ('blocked', 'skipped') order by r.updated_at desc limit 6) x)
       union all
       (select 'workflow', to_jsonb(x) from (
          select w.name as workflow, r.status, r.current_step, r.attempts, left(r.last_error, 200) as last_error, coalesce(r.finished_at, r.created_at) as at
            from crm_workflow_runs r join crm_workflows w on w.id = r.workflow_id and w.org_id = r.org_id
           where r.org_id = $1 and r.created_at >= $2 and r.status in ('failed', 'dead') and ($3::uuid is null or r.workflow_id = $3)
           order by r.created_at desc limit 6) x)
       union all
       (select 'webhook', to_jsonb(x) from (
          select d.status, d.attempts, d.response_status, left(d.last_error, 160) as last_error, d.created_at as at from crm_webhook_deliveries d
           where d.org_id = $1 and d.created_at >= $2 and d.status in ('failed', 'dead') order by d.created_at desc limit 5) x)
       union all
       (select 'totals', to_jsonb(x) from (
          select count(*) filter (where status in ('sent', 'delivered', 'read'))::int as ok, count(*) filter (where status = 'failed')::int as failed,
                 count(*) filter (where status = 'blocked')::int as blocked, count(*) filter (where status in ('queued', 'sending'))::int as in_flight
            from conversation_messages where org_id = $1 and direction = 'outbound' and created_at >= $2) x)
       ) u`,
      [orgId, since, workflowId],
    ));
    const by = (s: string) => rows.filter((r) => r.section === s).map((r) => r.payload);
    const totals = (by("totals")[0] ?? {}) as { ok?: number; failed?: number; blocked?: number; in_flight?: number };
    const events: Evidence[] = [];
    for (const m of by("message") as Array<Record<string, unknown>>) {
      events.push({
        at: String(m.failed_at ?? m.created_at), source: `Outbound ${String(m.scope ?? "message")}`, tone: m.status === "failed" ? "danger" : "warning",
        detail: `${String(m.status)}${m.blocked_reason ? ` (${clean(m.blocked_reason, 60)})` : ""}${m.status_detail ? `: ${clean(m.status_detail, 140)}` : ""}${m.last_event ? ` · provider event ${clean(m.last_event, 120)}` : ""} · ${num(m.attempt_count)} attempt${num(m.attempt_count) === 1 ? "" : "s"}${m.has_dedupe_key ? " · duplicate guard present" : ""}`,
      });
    }
    for (const r of by("reminder") as Array<Record<string, unknown>>) events.push({ at: String(r.updated_at), source: "Appointment reminder", tone: "warning", detail: `${String(r.status)} ${num(r.offset_minutes)} minutes before the appointment${r.reason ? `: ${clean(r.reason, 140)}` : ""}` });
    for (const w of by("workflow") as Array<Record<string, unknown>>) events.push({ at: String(w.at), source: `Workflow “${clean(w.workflow, 50)}”`, tone: "danger", detail: `${String(w.status)} at step ${clean(w.current_step, 40) || "unknown"} after ${num(w.attempts)} attempt${num(w.attempts) === 1 ? "" : "s"}${w.last_error ? `: ${clean(w.last_error, 160)}` : ""}` });
    for (const h of by("webhook") as Array<Record<string, unknown>>) events.push({ at: String(h.at), source: "Outbound webhook", tone: "danger", detail: `${String(h.status)}${h.response_status ? ` (HTTP ${num(h.response_status)})` : ""} after ${num(h.attempts)} attempt${num(h.attempts) === 1 ? "" : "s"}${h.last_error ? `: ${clean(h.last_error, 140)}` : ""}` });
    events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    const shown = events.slice(0, 14);

    const total = num(totals.ok) + num(totals.failed) + num(totals.blocked) + num(totals.in_flight);
    const card: OpsTimelineCard = {
      id: newCardId(), kind: "timeline", title: workflowId ? "Workflow trace" : "Delivery trace", asOf: new Date().toISOString(), source: "Messaging, reminders, workflow runs, webhook deliveries",
      refresh: { toolId: "integrations.trace", args }, verdict: shown.length
        ? `${shown.length} problem event${shown.length === 1 ? "" : "s"} in the last ${args.hours} hours; ${num(totals.ok)} of ${total} outbound messages were sent or delivered, ${num(totals.failed)} failed, ${num(totals.blocked)} blocked.`
        : `No failures, blocks or stuck deliveries were recorded in the last ${args.hours} hours${total ? ` (${num(totals.ok)} of ${total} outbound messages sent or delivered)` : " (no outbound messages in this window)"}.`,
      events: shown.slice().reverse().map((e) => ({ at: iso(e.at)!, label: e.source, detail: e.detail, tone: e.tone })),
    };
    const lastMessageIssue = (by("message") as Array<Record<string, unknown>>)[0];
    return {
      summary: `${card.verdict}${lastMessageIssue ? ` Most recent message problem: ${String(lastMessageIssue.status)}${lastMessageIssue.blocked_reason ? ` (${clean(lastMessageIssue.blocked_reason, 60)})` : ""} at ${iso(String(lastMessageIssue.failed_at ?? lastMessageIssue.created_at))}.` : ""} AQi does not resend messages or retry runs; a retry would need to go through the owning module with its own idempotency and approval rules.`,
      data: { windowHours: args.hours, outboundMessages: totals, problems: shown.map((e) => ({ at: iso(e.at), source: e.source, detail: e.detail })), retryPolicy: "Retries are not performed by AQi. Messages carry duplicate guards (dedupe keys); workflow and webhook retries follow their own module rules." },
      cards: [card],
      evidence: { label: "Delivery and workflow trace", source: "conversation_messages, message_delivery_events, appointment_reminders, crm_workflow_runs, crm_webhook_deliveries (metadata only, no message content)", href: `/admin/clients/${orgId}` },
      unavailable: ["Message bodies and contact details are deliberately not read. Provider receipts that were never posted back to this platform cannot be seen.", "No retry is performed: resending could duplicate a customer-visible message."],
    };
  },
});

export const INTEGRATION_TOOLS = [integrationsStatus, integrationsTrace];
