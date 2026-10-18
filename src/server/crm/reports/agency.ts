import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import type { SessionUser } from "@/server/auth/service";
import { CRM_CAPABILITIES, type CrmMode } from "@/lib/crm/types";

/**
 * One client in the agency's operational summary. Counts and flags only: no names, email addresses, phone numbers, message text or money
 * amounts from the client's records ever appear here. Opening the records behind a number still needs a support session for that client.
 */
export interface AgencyOpsRow {
  orgId: string;
  name: string;
  status: string;
  mode: CrmMode;
  /** Capabilities GoHighLevel still owns (all of them in GoHighLevel mode, the explicit ones in hybrid mode). */
  ghlCapabilities: number;
  integrations: {
    /** Recorded connection checks in an error state. */
    checks: number;
    /** Messaging channels whose latest capability test failed. */
    channels: number;
    /** Calendar connections in error or needing to be reconnected. */
    calendars: number;
    /** Voice provider connections in an error state. */
    voice: number;
    total: number;
  };
  setup: { pending: number; blocked: number };
  automation: {
    /** Workflow runs that gave up after retries, started in the last 30 days (test runs excluded). */
    deadRuns: number;
    failedRuns: number;
    /** CRM events the dispatcher gave up on in the last 30 days. */
    deadLetters: number;
    /** CRM events not yet dispatched, and how long the oldest has waited. */
    backlog: number;
    oldestPendingMinutes: number | null;
    /** Webhook deliveries given up on in the last 7 days. */
    deadWebhooks: number;
  };
  /** Form submissions that failed processing in the last 30 days (native forms and the built-in website form). */
  formFailures: number;
  billing: { lowBalance: boolean; exhausted: boolean; uncollectedEvents: number };
  support: { openEscalations: number; urgentEscalations: number; openTickets: number };
  activity: { newContacts: number; formSubmissions: number; bookings: number; dealsWon: number };
  /** True when anything above needs someone to look. */
  attention: boolean;
}

export interface AgencyOpsSummary {
  generatedAt: string;
  rows: AgencyOpsRow[];
  totals: {
    clients: number;
    byMode: Record<CrmMode, number>;
    needingAttention: number;
    failedIntegrations: number;
    setupPending: number;
    deadRuns: number;
    deadLetters: number;
    backlog: number;
    lowBalance: number;
    openEscalations: number;
  };
}

type Row = {
  id: string; name: string; status: string; mode: CrmMode | null; ghl_caps: string;
  checks: string; channels: string; calendars: string; voice: string;
  setup_pending: string; setup_blocked: string;
  dead_runs: string; failed_runs: string; dead_letters: string; backlog: string; oldest_pending: Date | null; dead_webhooks: string;
  form_failures: string;
  free_micros: string | null; low_micros: string | null; uncollected: string;
  escalations: string; urgent: string; tickets: string;
  new_contacts: string; submissions: string; bookings: string; won: string;
};

const n = (v: string | null | undefined) => Number(v ?? 0) || 0;

/**
 * The agency's cross-client operational summary: for each client the agency person may see (super admins every client, staff only the
 * clients assigned to them), which system runs the CRM, what is failing, what is waiting, and what needs support. Counts only.
 */
export async function agencyCrmOperations(user: Pick<SessionUser, "id" | "platformRole">, now: Date = new Date()): Promise<AgencyOpsSummary> {
  if (user.platformRole !== "agency_super_admin" && user.platformRole !== "agency_staff") throw new AppError("forbidden", "Agency access is required.");
  // Trusted, cross-tenant read: the staff scope is applied in the query itself, and only aggregates leave it.
  const rows = await withSystem(async (db) => {
    const { rows } = await db.query<Row>(
      `select o.id, o.name, o.status, w.mode,
              (case when w.mode = 'ghl' then $4::int when w.mode = 'hybrid' then (select count(*) from crm_capability_providers p where p.org_id = o.id and p.provider = 'ghl') else 0 end)::text as ghl_caps,
              (select count(*) from integration_status s where s.org_id = o.id and s.status = 'error')::text as checks,
              (select count(*) from messaging_channels mc where mc.org_id = o.id and mc.provider <> 'ghl' and mc.capability_test->>'ok' = 'false')::text as channels,
              (select count(*) from crm_calendar_connections cc where cc.org_id = o.id and cc.status in ('error', 'needs_reauth'))::text as calendars,
              (select count(*) from crm_voice_connections vc where vc.org_id = o.id and vc.status = 'error')::text as voice,
              (select count(*) from client_setup_tasks t where t.org_id = o.id and t.required and not t.hidden and not t.service_excluded and t.status <> 'completed')::text as setup_pending,
              (select count(*) from client_setup_tasks t where t.org_id = o.id and not t.hidden and not t.service_excluded and t.status = 'blocked')::text as setup_blocked,
              (select count(*) from crm_workflow_runs r where r.org_id = o.id and r.status = 'dead' and r.started_via <> 'test' and r.created_at > $3::timestamptz - interval '30 days')::text as dead_runs,
              (select count(*) from crm_workflow_runs r where r.org_id = o.id and r.status = 'failed' and r.started_via <> 'test' and r.created_at > $3::timestamptz - interval '30 days')::text as failed_runs,
              (select count(*) from crm_events e where e.org_id = o.id and e.dispatched_at is not null and e.dispatch_error is not null
                 and e.dispatched_at > $3::timestamptz - interval '30 days')::text as dead_letters,
              (select count(*) from crm_events e where e.org_id = o.id and e.dispatched_at is null)::text as backlog,
              (select min(e.occurred_at) from crm_events e where e.org_id = o.id and e.dispatched_at is null) as oldest_pending,
              (select count(*) from crm_webhook_deliveries d where d.org_id = o.id and d.status = 'dead' and d.created_at > $3::timestamptz - interval '7 days')::text as dead_webhooks,
              ((select count(*) from crm_form_submissions fs where fs.org_id = o.id and fs.status = 'failed' and fs.created_at > $3::timestamptz - interval '30 days')
                + (select count(*) from website_form_submissions ws where ws.org_id = o.id and ws.status = 'failed' and ws.created_at > $3::timestamptz - interval '30 days'))::text as form_failures,
              (select (a.balance_micros - a.reserved_micros)::text from credit_accounts a where a.org_id = o.id) as free_micros,
              (select bs.low_balance_micros::text from billing_settings bs where bs.org_id = o.id) as low_micros,
              (select count(*) from metered_usage_events m where m.org_id = o.id and m.uncollected_micros > 0 and m.occurred_at > $3::timestamptz - interval '30 days')::text as uncollected,
              (select count(*) from human_escalations h where h.org_id = o.id and h.status in ('awaiting_owner', 'open', 'claimed'))::text as escalations,
              (select count(*) from human_escalations h where h.org_id = o.id and h.status in ('awaiting_owner', 'open', 'claimed') and h.urgency = 'urgent')::text as urgent,
              (select count(*) from support_tickets st where st.org_id = o.id and st.status in ('open', 'in_progress', 'waiting_for_client'))::text as tickets,
              (select count(*) from contacts c where c.org_id = o.id and c.deleted_at is null and c.created_at > $3::timestamptz - interval '30 days')::text as new_contacts,
              ((select count(*) from crm_form_submissions fs where fs.org_id = o.id and fs.status <> 'spam' and fs.created_at > $3::timestamptz - interval '30 days')
                + (select count(*) from website_form_submissions ws where ws.org_id = o.id and ws.status <> 'spam' and ws.created_at > $3::timestamptz - interval '30 days'))::text as submissions,
              (select count(*) from appointment_refs ap where ap.org_id = o.id and ap.provider = 'native' and ap.status <> 'invalid' and ap.created_at > $3::timestamptz - interval '30 days')::text as bookings,
              (select count(*) from crm_opportunities op where op.org_id = o.id and op.provider = 'native' and op.archived_at is null and op.status = 'won'
                 and op.closed_at > $3::timestamptz - interval '30 days')::text as won
       from organizations o
       left join crm_workspaces w on w.org_id = o.id
       where o.kind = 'client' and o.status <> 'archived'
         and ($2::boolean or exists (select 1 from staff_assignments sa where sa.org_id = o.id and sa.user_id = $1))
       order by lower(o.name)`,
      [user.id, user.platformRole === "agency_super_admin", now.toISOString(), CRM_CAPABILITIES.length],
    );
    return rows;
  });

  const out: AgencyOpsRow[] = rows.map((r) => {
    const integrations = { checks: n(r.checks), channels: n(r.channels), calendars: n(r.calendars), voice: n(r.voice), total: 0 };
    integrations.total = integrations.checks + integrations.channels + integrations.calendars + integrations.voice;
    // A client with no credit account yet has no balance to run low on; that is reported by billing, not here.
    const free = r.free_micros === null ? null : n(r.free_micros);
    const billing = {
      exhausted: free !== null && free <= 0,
      lowBalance: free !== null && free <= n(r.low_micros ?? "5000000"),
      uncollectedEvents: n(r.uncollected),
    };
    const automation = {
      deadRuns: n(r.dead_runs), failedRuns: n(r.failed_runs), deadLetters: n(r.dead_letters), backlog: n(r.backlog),
      oldestPendingMinutes: r.oldest_pending ? Math.max(0, Math.floor((now.getTime() - new Date(r.oldest_pending).getTime()) / 60_000)) : null,
      deadWebhooks: n(r.dead_webhooks),
    };
    const support = { openEscalations: n(r.escalations), urgentEscalations: n(r.urgent), openTickets: n(r.tickets) };
    const setup = { pending: n(r.setup_pending), blocked: n(r.setup_blocked) };
    const formFailures = n(r.form_failures);
    // A backlog is normal for a moment after events happen; only an event waiting more than 15 minutes needs a look.
    const stuck = automation.oldestPendingMinutes !== null && automation.oldestPendingMinutes > 15;
    const attention = integrations.total > 0 || setup.blocked > 0 || automation.deadRuns > 0 || automation.deadLetters > 0 || automation.deadWebhooks > 0 || stuck || formFailures > 0
      || billing.lowBalance || billing.uncollectedEvents > 0 || support.openEscalations > 0;
    return {
      orgId: r.id, name: r.name, status: r.status, mode: r.mode ?? "native", ghlCapabilities: n(r.ghl_caps), integrations, setup, automation, formFailures, billing, support,
      activity: { newContacts: n(r.new_contacts), formSubmissions: n(r.submissions), bookings: n(r.bookings), dealsWon: n(r.won) },
      attention,
    };
  });

  const sum = (f: (r: AgencyOpsRow) => number) => out.reduce((t, r) => t + f(r), 0);
  return {
    generatedAt: now.toISOString(),
    rows: out,
    totals: {
      clients: out.length,
      byMode: { native: out.filter((r) => r.mode === "native").length, ghl: out.filter((r) => r.mode === "ghl").length, hybrid: out.filter((r) => r.mode === "hybrid").length },
      needingAttention: out.filter((r) => r.attention).length,
      failedIntegrations: sum((r) => r.integrations.total),
      setupPending: sum((r) => r.setup.pending),
      deadRuns: sum((r) => r.automation.deadRuns),
      deadLetters: sum((r) => r.automation.deadLetters),
      backlog: sum((r) => r.automation.backlog),
      lowBalance: out.filter((r) => r.billing.lowBalance).length,
      openEscalations: sum((r) => r.support.openEscalations),
    },
  };
}
