import "server-only";
import { z } from "zod";
import { readSystem } from "@/server/db";
import { defineReadTool } from "@/server/aqi/ops/tool";
import { clean, iso, metric, newCardId, plural } from "@/server/aqi/ops/tools/helpers";
import type { OpsMetricsCard, OpsTableCard } from "@/lib/aqi/ops/types";

const SUPER = ["agency_super_admin"] as const;

/**
 * Exact audit actions, not prefixes: the audit table is only indexed by (action, created_at), so a
 * bounded scan needs an explicit list. Anything not recorded under one of these names is not
 * visible to this tool, and the answer says so.
 */
export const AUDIT_GROUPS = {
  sign_in: ["auth.login"],
  account: ["auth.password_change", "auth.password_reset", "auth.password_reset_requested", "auth.account_linked", "auth.invitation_accepted"],
  permissions: ["team.role_changed", "team.permissions_updated", "team.permissions_copied", "team.access_updated", "team.access_revoked", "team.invited", "workforce.tool_policy_updated", "workforce.tool_policy_reset", "workforce.full_capabilities_acknowledged"],
  sensitive: [
    "crm.support_session_started", "crm.support_session_ended", "crm.support_view", "data.exported", "offboarding.requested", "offboarding.deleted", "offboarding.shutdown",
    "billing.credits_adjusted", "billing.refund_recorded", "billing.settings_changed", "billing.unit_rate_published", "finance.settings_changed", "tenant.billing_updated", "tenant.usage_limits_updated",
    "automation.agency_paused", "automation.agency_resumed", "agent.hermes_connected", "integration.ghl_verified", "tenant.created",
  ],
  aqi: ["aqi.ops_tenant_access", "aqi.ops_action_proposed", "aqi.ops_action_confirmed", "aqi.ops_action_executed", "aqi.ops_action_verified", "aqi.ops_action_failed", "aqi.ops_action_cancelled"],
} as const;

const ALL_ACTIONS: string[] = Object.values(AUDIT_GROUPS).flat();
const LABEL: Record<string, string> = {
  "auth.login": "Sign-in", "team.role_changed": "Role changed", "team.permissions_updated": "Permissions updated", "team.access_revoked": "Access revoked", "team.access_updated": "Access updated",
  "crm.support_session_started": "Support session to a client's CRM started", "data.exported": "Data export", "automation.agency_paused": "Agency pause applied", "aqi.ops_tenant_access": "AQi read a client workspace",
  "aqi.ops_action_executed": "AQi action executed", "billing.credits_adjusted": "Credits adjusted", "billing.refund_recorded": "Refund recorded",
};
const labelOf = (action: string) => LABEL[action] ?? action.replace(/[._]/g, " ");

export const securityEvents = defineReadTool({
  id: "security.events",
  title: "Security and administrative activity",
  description: "Sign-in outcomes, role and permission changes, sensitive administrative actions, cross-tenant access and AQi's own tool and action audit trail from the append-only audit log, with factual flags for unusual volume.",
  group: "security",
  roles: SUPER,
  permission: "agency.audit.view",
  scopes: ["platform", "tenant", "employee", "workflow", "ticket", "incident"],
  input: z.object({ days: z.number().int().min(1).max(30).default(7), limit: z.number().int().min(1).max(15).default(10) }).strict(),
  idempotent: true,
  audit: { action: "aqi.ops_tool_run", sensitive: true },
  timeoutMs: 15_000,
  async run(ctx, args) {
    const orgId = ctx.scope.type === "platform" || ctx.scope.type === "incident" ? null : ctx.scope.orgId;
    if (orgId) await ctx.authorizeOrg(orgId, "security.events");
    const since = new Date(ctx.now.getTime() - args.days * 86_400_000).toISOString();

    const { rows: counts } = await readSystem((db) => db.query<{ action: string; result: string; n: number; actors: number; last: Date }>(
      `select action, result, count(*)::int as n, count(distinct actor_user_id)::int as actors, max(created_at) as last
         from audit_logs where action = any($1::text[]) and created_at >= $2 and ($3::uuid is null or org_id = $3)
        group by action, result order by n desc limit 60`,
      [ALL_ACTIONS, since, orgId],
    ));
    const notable = [...AUDIT_GROUPS.permissions, ...AUDIT_GROUPS.sensitive, ...AUDIT_GROUPS.aqi.filter((a) => a !== "aqi.ops_tenant_access")];
    const { rows: recent } = await readSystem((db) => db.query<{ id: string; created_at: Date; action: string; result: string; org: string | null; actor: string | null; role: string | null; target_type: string | null; meta: Record<string, unknown> }>(
      `select a.id::text, a.created_at, a.action, a.result, o.name as org, nullif(u.full_name, '') as actor, u.platform_role as role, a.target_type, a.metadata as meta
         from audit_logs a left join organizations o on o.id = a.org_id left join users u on u.id = a.actor_user_id
        where a.action = any($1::text[]) and a.created_at >= $2 and ($3::uuid is null or a.org_id = $3)
        order by a.created_at desc limit $4`,
      [notable, since, orgId, args.limit],
    ));
    // Volume flags are arithmetic, not accusations: many failed sign-ins from one hashed source, or one actor with many sensitive actions in an hour.
    const { rows: flags } = await readSystem((db) => db.query<{ kind: string; subject: string | null; n: number; first: Date; last: Date }>(
      `select q.kind, q.subject, q.n, q.first, q.last from (
       (select 'failed_sign_ins' as kind, ip_hash as subject, count(*)::int as n, min(created_at) as first, max(created_at) as last
          from audit_logs where action = 'auth.login' and result in ('failure', 'denied') and created_at >= $1 and ($2::uuid is null or org_id = $2) and ip_hash is not null
         group by ip_hash having count(*) >= 5 order by count(*) desc limit 5)
       union all
       (select 'sensitive_burst', coalesce(u.full_name, 'unknown actor') || ' (' || coalesce(u.platform_role, 'unknown') || ')', count(*)::int, min(a.created_at), max(a.created_at)
          from audit_logs a left join users u on u.id = a.actor_user_id
         where a.action = any($3::text[]) and a.created_at >= $1 and ($2::uuid is null or a.org_id = $2)
         group by a.actor_user_id, u.full_name, u.platform_role, date_trunc('hour', a.created_at) having count(*) >= 10 order by count(*) desc limit 5)
       ) q`,
      [since, orgId, AUDIT_GROUPS.sensitive as unknown as string[]],
    ));

    const sum = (actions: readonly string[], result?: string) => counts.filter((c) => actions.includes(c.action) && (!result || c.result === result)).reduce((n, c) => n + c.n, 0);
    const signIns = sum(AUDIT_GROUPS.sign_in);
    const failedSignIns = sum(AUDIT_GROUPS.sign_in, "failure") + sum(AUDIT_GROUPS.sign_in, "denied");
    const permissionChanges = sum(AUDIT_GROUPS.permissions);
    const sensitive = sum(AUDIT_GROUPS.sensitive);
    const crossTenant = sum(["aqi.ops_tenant_access"]);
    const denied = counts.filter((c) => c.result === "denied").reduce((n, c) => n + c.n, 0);

    const metrics: OpsMetricsCard = {
      id: newCardId(), kind: "metrics", title: `Audit activity, last ${args.days} days`, asOf: new Date().toISOString(), source: "Audit log (audit_logs)", refresh: { toolId: "security.events", args },
      period: `Last ${args.days} days to ${ctx.now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
      metrics: [
        metric("Sign-in events", signIns), metric("Failed or denied sign-ins", failedSignIns, undefined, failedSignIns ? "degraded" : undefined),
        metric("Role and permission changes", permissionChanges), metric("Sensitive administrative actions", sensitive),
        metric("AQi cross-client reads", crossTenant), metric("Denied authorizations", denied, undefined, denied ? "degraded" : undefined),
      ],
      caveats: ["Only actions recorded under known audit names are counted. Identity-provider logs, IP addresses and device details are not in this audit log."],
    };
    const table: OpsTableCard = {
      id: newCardId(), kind: "table", title: "Notable administrative events", asOf: new Date().toISOString(), source: "Audit log (audit_logs)",
      caption: recent.length ? `${recent.length} most recent role, permission, sensitive and AQi events.` : "No role, permission or sensitive events were recorded in this window.",
      columns: [{ key: "when", label: "Time (UTC)" }, { key: "event", label: "Event" }, { key: "actor", label: "Actor" }, { key: "client", label: "Client" }, { key: "result", label: "Result" }, { key: "ref", label: "Audit ref" }],
      rows: recent.map((r) => ({
        when: iso(r.created_at)!.slice(0, 16).replace("T", " "), event: labelOf(r.action), actor: r.actor ? `${clean(r.actor, 40)} (${(r.role ?? "").replace("agency_", "")})` : "System", client: r.org ? clean(r.org, 40) : "Platform", result: r.result, ref: `AUD-${r.id}`,
      })),
    };
    const flagText = flags.map((f) => f.kind === "failed_sign_ins" ? `${f.n} failed sign-ins from one hashed source between ${iso(f.first)} and ${iso(f.last)}` : `${f.subject} recorded ${f.n} sensitive actions within one hour (${iso(f.first)})`);
    return {
      summary: `Last ${args.days} days: ${plural(signIns, "sign-in event")} (${failedSignIns} failed or denied), ${plural(permissionChanges, "role or permission change")}, ${plural(sensitive, "sensitive administrative action")}, ${crossTenant} AQi cross-client reads. ${flagText.length ? `Unusual volume (not a finding of wrongdoing): ${flagText.join("; ")}.` : "No unusual volume thresholds were crossed."}`,
      data: {
        windowDays: args.days, totals: { signIns, failedSignIns, permissionChanges, sensitive, crossTenantReads: crossTenant, denied },
        byAction: counts.slice(0, 20).map((c) => ({ action: c.action, result: c.result, count: c.n, distinctActors: c.actors, last: iso(c.last) })),
        notable: recent.map((r) => ({ ref: `AUD-${r.id}`, at: iso(r.created_at), event: r.action, result: r.result, actor: r.actor, actorRole: r.role, client: r.org, targetType: r.target_type, detail: r.meta && typeof r.meta === "object" ? Object.fromEntries(Object.entries(r.meta).filter(([k]) => ["from", "to", "role", "reason", "tool", "status", "scope", "permission"].includes(k)).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 80) : v])) : {} })),
        volumeFlags: flags.map((f) => ({ kind: f.kind, subject: f.kind === "sensitive_burst" ? f.subject : "hashed source", count: f.n, first: iso(f.first), last: iso(f.last) })),
        interpretation: "Counts and flags are arithmetic over recorded events. They do not establish intent; verify the actor and context before concluding anything.",
      },
      cards: [metrics, table],
      evidence: { label: "Audit log review", source: "audit_logs (append-only), indexed by action and time", href: "/admin/audit" },
      unavailable: ["Identity-provider sign-in logs, IP geolocation, device fingerprints and failed-authorization attempts that were never written to the audit log are not available."],
    };
  },
});

export const SECURITY_TOOLS = [securityEvents];
