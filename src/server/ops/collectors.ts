import "server-only";
import type { Queryable } from "@/server/db";
import { env } from "@/server/env";
import { applyCollector, type CollectorResult, type Observation } from "@/server/ops/incidents";
import { sanitizeErrorText } from "@/lib/ops";

// Each collector reads recorded evidence only (never calls a provider) and returns the conditions that are unhealthy right now.
// The incident engine opens what is new and closes what a later run no longer finds. Keys start with the collector's prefix, and no
// prefix is the start of another, so one check can never close another's incidents.

export const THRESHOLDS = {
  /** A queued message this long past its send time means the dispatcher is not draining the queue. */
  queuedMessageMinutes: 15,
  /** A follow-up step this long past due means the follow-up job is not running. */
  followUpMinutes: 30,
  /** A website enquiry that is still unprocessed after this long. */
  enquiryMinutes: 15,
  /** Failed outbound messages in the last hour for one workspace. */
  failedMessages: 3,
  /** Failed AI runs in the last hour for one workspace. */
  failedRuns: 5,
  /** A credit reservation held this long after its expiry means the expiry job is not running. */
  staleReservationMinutes: 60,
  /** A payment event that arrived and was never processed. */
  stuckPaymentMinutes: 10,
  /** A scheduled job failing this many runs in a row. */
  jobFailures: 3,
} as const;

const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000).toISOString();

async function schedulerJobs(db: Queryable): Promise<Observation[]> {
  const { rows } = await db.query<{ job_name: string; consecutive_failures: number; last_error: string | null; last_failure_at: Date | null }>(
    "select job_name, consecutive_failures, last_error, last_failure_at from worker_job_runs where consecutive_failures >= $1",
    [THRESHOLDS.jobFailures],
  );
  return rows.map((r) => ({
    key: `scheduler:job:${r.job_name}`,
    source: "scheduler" as const,
    orgId: null,
    subject: r.job_name,
    severity: r.consecutive_failures >= 10 ? ("critical" as const) : ("warning" as const),
    title: `The scheduled job "${r.job_name}" keeps failing`,
    detail: `It has failed ${r.consecutive_failures} runs in a row. Last error: ${r.last_error ?? "not recorded"}`,
    evidence: { consecutiveFailures: r.consecutive_failures },
    guidance: "Check the server logs for this job. Other jobs keep running.",
  }));
}

async function queues(db: Queryable, now: Date): Promise<Observation[]> {
  const out: Observation[] = [];
  const messages = await db.query<{ org_id: string; n: number; oldest: Date; name: string }>(
    `select m.org_id, count(*)::int as n, min(m.send_after) as oldest, o.name from conversation_messages m join organizations o on o.id = m.org_id
     where m.status = 'queued' and m.send_after < $1 group by m.org_id, o.name`,
    [minutesAgo(now, THRESHOLDS.queuedMessageMinutes)],
  );
  for (const r of messages.rows) {
    out.push({
      key: `queue:messages:${r.org_id}`, source: "queue", orgId: r.org_id, subject: "outbound messages", severity: "warning",
      title: `${r.n} outbound message${r.n === 1 ? " is" : "s are"} waiting past ${THRESHOLDS.queuedMessageMinutes} minutes (${r.name})`,
      detail: "Queued messages are not being sent on time. The dispatcher may be stopped or failing.",
      evidence: { queued: r.n, oldest: new Date(r.oldest).toISOString() },
      guidance: "Confirm the scheduler is running and the messaging connection is healthy.",
    });
  }
  const steps = await db.query<{ org_id: string; n: number; name: string }>(
    `select s.org_id, count(*)::int as n, o.name from follow_up_steps s join organizations o on o.id = s.org_id
     where s.status = 'scheduled' and s.due_at < $1 group by s.org_id, o.name`,
    [minutesAgo(now, THRESHOLDS.followUpMinutes)],
  );
  for (const r of steps.rows) {
    out.push({
      key: `queue:followups:${r.org_id}`, source: "queue", orgId: r.org_id, subject: "follow-ups", severity: "warning",
      title: `${r.n} follow-up${r.n === 1 ? " is" : "s are"} overdue (${r.name})`,
      detail: "Follow-ups are due but have not been prepared. The follow-up job may be stopped.",
      evidence: { overdue: r.n },
    });
  }
  const enquiries = await db.query<{ org_id: string; n: number; name: string }>(
    `select f.org_id, count(*)::int as n, o.name from website_form_submissions f join organizations o on o.id = f.org_id
     where f.status = 'received' and f.created_at < $1 group by f.org_id, o.name`,
    [minutesAgo(now, THRESHOLDS.enquiryMinutes)],
  );
  for (const r of enquiries.rows) {
    out.push({
      key: `queue:enquiries:${r.org_id}`, source: "queue", orgId: r.org_id, subject: "website enquiries", severity: "warning",
      title: `${r.n} website enquir${r.n === 1 ? "y has" : "ies have"} not been turned into leads (${r.name})`,
      detail: "Enquiries are saved but not yet processed into contacts.",
      evidence: { unprocessed: r.n },
      guidance: "The saved enquiries are safe and appear under Website → Enquiries.",
    });
  }
  return out;
}

async function failedMessages(db: Queryable, now: Date): Promise<Observation[]> {
  const { rows } = await db.query<{ org_id: string; n: number; name: string }>(
    `select m.org_id, count(*)::int as n, o.name from conversation_messages m join organizations o on o.id = m.org_id
     where m.direction = 'outbound' and m.status = 'failed' and m.failed_at > $1 group by m.org_id, o.name having count(*) >= $2`,
    [minutesAgo(now, 60), THRESHOLDS.failedMessages],
  );
  return rows.map((r) => ({
    key: `messaging:failed:${r.org_id}`, source: "messaging" as const, orgId: r.org_id, subject: "failed sends", severity: "warning" as const,
    title: `${r.n} messages could not be sent in the last hour`,
    detail: "Several outbound messages failed. The messaging connection may need attention.",
    evidence: { failedLastHour: r.n },
    clientVisible: true,
    guidance: "Open Settings → Connected services to check your messaging connection. Failed messages are never resent automatically.",
  }));
}

async function credits(db: Queryable, now: Date): Promise<Observation[]> {
  const out: Observation[] = [];
  const stale = await db.query<{ n: number }>(
    "select count(*)::int as n from usage_reservations where status = 'held' and expires_at < $1",
    [minutesAgo(now, THRESHOLDS.staleReservationMinutes)],
  );
  if (stale.rows[0].n > 0) {
    out.push({
      key: "credits:reservations", source: "credits", orgId: null, subject: "reservations", severity: "warning",
      title: `${stale.rows[0].n} credit reservation${stale.rows[0].n === 1 ? " is" : "s are"} past expiry and still held`,
      detail: "Held credit is not being released on time, so clients may see less available credit than they have.",
      evidence: { stale: stale.rows[0].n },
      guidance: "Confirm the scheduler is running; the expiry job releases these.",
    });
  }
  const bad = await db.query<{ org_id: string; name: string }>(
    `select o.id as org_id, o.name from organizations o cross join lateral app.credit_reconciliation(o.id) r where o.kind = 'client' and not r.consistent`,
  );
  for (const r of bad.rows) {
    out.push({
      key: `credits:reconcile:${r.org_id}`, source: "credits", orgId: r.org_id, subject: "ledger", severity: "critical",
      title: `The credit ledger does not add up (${r.name})`,
      detail: "The stored balance differs from the sum of the ledger. Chargeable work for this workspace should be reviewed.",
      guidance: "Open the client's billing page, compare the ledger, and post an audited adjustment.",
    });
  }
  return out;
}

async function payments(db: Queryable, now: Date): Promise<Observation[]> {
  const out: Observation[] = [];
  const errors = await db.query<{ n: number }>("select count(*)::int as n from payment_webhook_events where outcome = 'error' and received_at > $1", [minutesAgo(now, 24 * 60)]);
  if (errors.rows[0].n > 0) {
    out.push({
      key: "payments:webhook-errors", source: "payments", orgId: null, subject: "payment webhooks", severity: "critical",
      title: `${errors.rows[0].n} payment notification${errors.rows[0].n === 1 ? "" : "s"} failed to process in the last 24 hours`,
      detail: "A paying client may not have received credits. Check each event against the payment provider before retrying.",
      evidence: { failed: errors.rows[0].n },
      guidance: "Open the payments list, find the affected checkout in PayMongo, and reconcile it by hand.",
    });
  }
  const stuck = await db.query<{ n: number }>("select count(*)::int as n from payment_webhook_events where outcome = 'received' and received_at < $1", [minutesAgo(now, THRESHOLDS.stuckPaymentMinutes)]);
  if (stuck.rows[0].n > 0) {
    out.push({
      key: "payments:webhook-stuck", source: "payments", orgId: null, subject: "payment webhooks", severity: "critical",
      title: `${stuck.rows[0].n} payment notification${stuck.rows[0].n === 1 ? " was" : "s were"} received but never processed`,
      detail: "Events arrived and were not completed. Credits for those payments have not been granted.",
      evidence: { stuck: stuck.rows[0].n },
    });
  }
  return out;
}

async function websites(db: Queryable): Promise<Observation[]> {
  const pubs = await db.query<{ id: string; org_id: string; number: number; health_detail: string | null }>(
    "select id, org_id, number, health_detail from website_publications where status = 'live' and health = 'unhealthy'",
  );
  return pubs.rows.map((p) => ({
    key: `website:publication:${p.id}`, source: "website" as const, orgId: p.org_id, subject: `publication ${p.number}`, severity: "critical" as const,
    title: "Your live website is not being served correctly",
    detail: p.health_detail ?? "The last check could not confirm the published version is being served.",
    clientVisible: true,
    safeActions: ["The last healthy published version is restored automatically when a new publish fails its check."],
    guidance: "Open Website → History and restore an earlier published version, or contact support.",
  }));
}

async function domains(db: Queryable, now: Date): Promise<Observation[]> {
  const out: Observation[] = [];
  const rows = await db.query<{ id: string; org_id: string; hostname: string; status: string; ssl_status: string; live_ok: boolean | null; ssl_detail: string | null; dns_detail: string | null; renews_at: Date | null }>(
    `select id, org_id, hostname, status, ssl_status, live_ok, ssl_detail, dns_detail, renews_at from website_domains
     where removed_at is null and kind = 'custom' and (status = 'error' or ssl_status = 'error' or (status = 'active' and live_ok = false) or (renews_at is not null and renews_at < $1))`,
    [now.toISOString()],
  );
  for (const d of rows.rows) {
    const overdue = d.renews_at && new Date(d.renews_at) < now;
    const why = overdue ? "its renewal date has passed" : d.ssl_status === "error" ? (d.ssl_detail ?? "its security certificate has a problem") : d.status === "error" ? (d.dns_detail ?? "its DNS check failed") : "it stopped responding";
    out.push({
      key: `domain:${d.id}`, source: "domain", orgId: d.org_id, subject: d.hostname, severity: overdue ? "critical" : "warning",
      title: `${d.hostname} needs attention`,
      detail: `This address has a problem: ${why}.`,
      clientVisible: true,
      guidance: "Open Website → Domains to re-check it or follow the DNS instructions again. Your included address keeps working in the meantime.",
    });
  }
  return out;
}

const PROVIDER_LABEL: Record<string, string> = { ghl: "GoHighLevel", hermes: "AI employee service", n8n: "n8n automation", google_calendar: "Google Calendar", email: "Email", domain: "Domain", supabase: "Supabase", external: "External service" };

async function integrations(db: Queryable): Promise<Observation[]> {
  const { rows } = await db.query<{ id: string; org_id: string | null; provider: string; status: string; last_error: string | null; name: string | null }>(
    `select c.id, c.org_id, c.provider, c.status, c.last_error, o.name from integration_connections c left join organizations o on o.id = c.org_id
     where c.status in ('error', 'needs_attention')`,
  );
  return rows.map((c) => {
    const label = PROVIDER_LABEL[c.provider] ?? c.provider;
    const tenant = Boolean(c.org_id);
    return {
      key: `integration:${c.provider}:${c.org_id ?? "platform"}`, source: (c.provider === "ghl" ? "ghl" : c.provider === "hermes" ? "hermes" : c.provider === "n8n" ? "n8n" : "integration") as Observation["source"],
      orgId: c.org_id, subject: label, severity: c.status === "error" ? ("critical" as const) : ("warning" as const),
      title: `${label} connection ${c.status === "error" ? "has failed" : "needs attention"}${c.name ? ` (${c.name})` : ""}`,
      detail: c.last_error ?? "The last check did not succeed.",
      clientVisible: tenant && ["ghl", "google_calendar", "email", "domain"].includes(c.provider),
      safeActions: tenant ? ["Anything that needs this connection will not go out until a check succeeds again."] : [],
      guidance: tenant ? "Open Settings → Connected services and reconnect. Nothing is lost while it is disconnected." : "Open Admin → Integrations, re-run the connection test and rotate the credential if it was revoked.",
    };
  });
}

async function ghlMappings(db: Queryable): Promise<Observation[]> {
  const { rows } = await db.query<{ org_id: string; location_name: string | null; name: string }>(
    "select m.org_id, m.location_name, o.name from ghl_location_mappings m join organizations o on o.id = m.org_id where m.status = 'error'",
  );
  return rows.map((m) => ({
    key: `ghl:mapping:${m.org_id}`, source: "ghl" as const, orgId: m.org_id, subject: m.location_name ?? "location", severity: "critical" as const,
    title: `The CRM location mapping is failing (${m.name})`,
    detail: "The last read of this client's GoHighLevel location failed, so CRM sync and message sending for it cannot be trusted.",
    clientVisible: true,
    safeActions: ["CRM updates and message sends for this workspace are not attempted while the mapping is in an error state."],
    guidance: "Your CRM connection needs attention. Your records stay safe; iAcquire will help you reconnect.",
  }));
}

async function agents(db: Queryable): Promise<Observation[]> {
  const { rows } = await db.query<{ org_id: string; n: number; name: string }>(
    `select a.org_id, count(*)::int as n, o.name from agent_instances a join organizations o on o.id = a.org_id
     where a.enabled and a.status in ('error', 'offline') and o.status = 'active' group by a.org_id, o.name`,
  );
  return rows.map((a) => ({
    key: `hermes:agents:${a.org_id}`, source: "hermes" as const, orgId: a.org_id, subject: "AI employees", severity: "warning" as const,
    title: `${a.n} AI employee${a.n === 1 ? " is" : "s are"} unavailable (${a.name})`,
    detail: "The last health check could not reach the employee's profile.",
    clientVisible: true,
    safeActions: ["An employee that is not ready does not start new work."],
    guidance: "Your AI employees are being checked. Work resumes automatically once they respond.",
  }));
}

async function failedRuns(db: Queryable, now: Date): Promise<Observation[]> {
  const { rows } = await db.query<{ org_id: string; n: number; name: string }>(
    `select r.org_id, count(*)::int as n, o.name from agent_runs r join organizations o on o.id = r.org_id
     where r.status in ('failed', 'timeout', 'interrupted') and r.finished_at > $1 group by r.org_id, o.name having count(*) >= $2`,
    [minutesAgo(now, 60), THRESHOLDS.failedRuns],
  );
  return rows.map((r) => ({
    key: `automation:runs:${r.org_id}`, source: "automation" as const, orgId: r.org_id, subject: "AI runs", severity: "warning" as const,
    title: `${r.n} AI runs failed in the last hour (${r.name})`,
    detail: "Repeated failures usually mean the AI service or a tool is unavailable.",
    evidence: { failedLastHour: r.n },
  }));
}

export interface Collector {
  prefix: string;
  collect: (db: Queryable, now: Date) => Promise<Observation[]>;
}

export const COLLECTORS: Collector[] = [
  { prefix: "scheduler:", collect: (db) => schedulerJobs(db) },
  { prefix: "queue:", collect: queues },
  { prefix: "messaging:", collect: failedMessages },
  { prefix: "credits:", collect: credits },
  { prefix: "payments:", collect: payments },
  { prefix: "website:", collect: (db) => websites(db) },
  { prefix: "domain:", collect: domains },
  { prefix: "integration:", collect: (db) => integrations(db) },
  { prefix: "ghl:", collect: (db) => ghlMappings(db) },
  { prefix: "hermes:", collect: (db) => agents(db) },
  { prefix: "automation:", collect: failedRuns },
];

export type CollectorOutcome = CollectorResult | { prefix: string; error: string };

/** Runs every collector independently: one that cannot run changes nothing and never stops the others. */
export async function runAllCollectors(now = new Date(), only?: string[]): Promise<CollectorOutcome[]> {
  const out: CollectorOutcome[] = [];
  for (const c of COLLECTORS) {
    if (only && !only.includes(c.prefix)) continue;
    try {
      out.push(await applyCollector(c.prefix, c.collect, now));
    } catch (err) {
      out.push({ prefix: c.prefix, error: sanitizeErrorText(err) });
    }
  }
  return out;
}

export const schedulerStaleMinutes = () => env().SCHEDULER_STALE_MINUTES;
