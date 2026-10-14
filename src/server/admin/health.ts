import "server-only";
import { pendingMigrations, pingDb, withSystem } from "@/server/db";
import { env } from "@/server/env";
import { getN8nStatus, type N8nStatus } from "@/server/integrations/n8n";
import { helpAiAvailable } from "@/server/help/service";

export interface SystemHealth {
  checkedAt: string;
  database: { ok: boolean; latencyMs: number; driver: string; pendingMigrations: string[] };
  hermes: { total: number; online: number; setupRequired: number; offline: number; error: number; lastCheckAt: string | null };
  ghl: { mapped: number; connected: number; errors: number; writesEnabled: boolean };
  n8n: N8nStatus;
  email: { provider: string; queued: number; failed24h: number };
  slack: { configured: boolean };
  helpAi: { configured: boolean };
  recentErrors: Array<{ at: string; source: string; detail: string; org: string | null }>;
  runs24h: { total: number; failed: number; cancelled: number; tokens: number };
  pendingProvisioning: number;
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const e = env();
  const [db, n8n] = await Promise.all([pingDb(), getN8nStatus()]);
  const pending = db.ok ? await pendingMigrations().catch(() => ["unknown"]) : ["unknown"];
  const data = db.ok
    ? await withSystem(async (q) => {
        const agents = await q.query<{ status: string; n: number; last: Date | null }>(
          "select a.status, count(*)::int as n, max(a.last_health_check_at) as last from agent_instances a join organizations o on o.id = a.org_id where a.enabled and o.status <> 'archived' group by a.status",
        );
        const ghl = await q.query<{ status: string; n: number }>("select status, count(*)::int as n from ghl_location_mappings group by status");
        const email = await q.query<{ queued: number; failed: number }>(
          "select count(*) filter (where status = 'queued')::int as queued, count(*) filter (where status = 'failed' and created_at > now() - interval '1 day')::int as failed from email_outbox",
        );
        const runs = await q.query<{ total: number; failed: number; cancelled: number; tokens: number }>(
          `select count(*)::int as total, count(*) filter (where status in ('failed', 'timeout', 'interrupted'))::int as failed,
                  count(*) filter (where status = 'cancelled')::int as cancelled, coalesce(sum(total_tokens), 0)::int as tokens
           from agent_runs where started_at > now() - interval '1 day'`,
        );
        const errors = await q.query<{ at: Date; source: string; detail: string; org: string | null }>(
          `(select r.finished_at as at, 'agent_run' as source, coalesce(r.error_message, r.error_code, 'failed') as detail, o.name as org
            from agent_runs r join organizations o on o.id = r.org_id
            where r.status in ('failed', 'timeout', 'interrupted') and r.finished_at > now() - interval '7 days')
           union all
           (select a.updated_at, 'approval_execution', coalesce(a.execution_detail, 'failed'), o.name
            from approval_requests a join organizations o on o.id = a.org_id
            where a.execution_status = 'failed' and a.updated_at > now() - interval '7 days')
           union all
           (select s.last_checked_at, 'integration:' || s.provider, coalesce(s.detail, s.status), o.name
            from integration_status s left join organizations o on o.id = s.org_id
            where s.status = 'error' and s.last_checked_at > now() - interval '7 days')
           order by at desc nulls last limit 15`,
        );
        const provisioning = await q.query<{ n: number }>(
          "select count(*)::int as n from agent_provisioning_jobs where status in ('requested', 'in_progress', 'awaiting_health_check')",
        );
        return { agents: agents.rows, ghl: ghl.rows, email: email.rows[0], runs: runs.rows[0], errors: errors.rows, provisioning: provisioning.rows[0].n };
      })
    : null;

  const count = (status: string) => data?.agents.filter((a) => a.status === status).reduce((s, a) => s + a.n, 0) ?? 0;
  const lastCheck = data?.agents.map((a) => a.last).filter(Boolean).sort((a, b) => new Date(b!).getTime() - new Date(a!).getTime())[0];
  return {
    checkedAt: new Date().toISOString(),
    database: { ok: db.ok, latencyMs: db.latencyMs, driver: e.DATABASE_DRIVER, pendingMigrations: pending },
    hermes: {
      total: data?.agents.reduce((s, a) => s + a.n, 0) ?? 0,
      online: count("online") + count("busy"),
      setupRequired: count("setup_required") + count("provisioning"),
      offline: count("offline"),
      error: count("error"),
      lastCheckAt: lastCheck ? new Date(lastCheck).toISOString() : null,
    },
    ghl: {
      mapped: data?.ghl.reduce((s, g) => s + g.n, 0) ?? 0,
      connected: data?.ghl.find((g) => g.status === "connected")?.n ?? 0,
      errors: data?.ghl.find((g) => g.status === "error")?.n ?? 0,
      writesEnabled: e.GHL_WRITES_ENABLED,
    },
    n8n,
    email: { provider: e.EMAIL_PROVIDER, queued: data?.email.queued ?? 0, failed24h: data?.email.failed ?? 0 },
    slack: { configured: Boolean(e.SLACK_SUPPORT_WEBHOOK_URL) },
    helpAi: { configured: await helpAiAvailable() },
    recentErrors: (data?.errors ?? []).map((r) => ({ at: r.at ? new Date(r.at).toISOString() : "", source: r.source, detail: r.detail, org: r.org })),
    runs24h: data?.runs ?? { total: 0, failed: 0, cancelled: 0, tokens: 0 },
    pendingProvisioning: data?.provisioning ?? 0,
  };
}
