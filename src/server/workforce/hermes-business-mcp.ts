import "server-only";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { AGENT_ROLE_KEYS, AGENCY_HERMES_PROFILE_IDS, type AgentRoleKey } from "@/lib/agents";
import { runtimeReadySql } from "@/lib/employee-runtime";
import { hasExplicitTargeting, targetingSchema } from "@/lib/leads-targeting";
import { AppError } from "@/server/errors";
import { withSystem, type Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { env } from "@/server/env";
import { secretFingerprint, sha256 } from "@/server/security/crypto";
import { resolveCredential } from "@/server/security/credentials";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { AGENT_TOOLS, ROLE_SCOPES, SCOPE_INFO, TOOL_INPUTS, type AgentToolName, type AgentToolScope } from "@/server/crm/agent-tools/catalog";
import { issueAgentToolToken, revokeAgentToolToken } from "@/server/crm/agent-tools/tokens";
import { callAgentTool, type AgentToolReply } from "@/server/crm/agent-tools/service";
import { buildRunInstructions } from "@/server/workforce/service";
import { prepareInternalEmployeeContext } from "@/server/workforce/internal-capability-context";
import { sanitizeQualificationSummary } from "@/server/leads/research-contract";
import { businessMcpToolNamesForRole, HERMES_BUSINESS_CONTEXT_TOOL } from "@/server/workforce/hermes-business-mcp-policy";

const TOKEN_RE = /^[A-Za-z0-9_-]{24,200}$/;
const MCP_BODY_LIMIT = 64 * 1024;
const contextInput = z.object({
  periodDays: z.number().int().min(1).max(90).optional(),
  lookaheadDays: z.number().int().min(1).max(90).optional(),
}).strict();

interface InternalProfile {
  agentId: string;
  orgId: string;
  roleKey: AgentRoleKey;
  displayName: string;
  profile: string;
}

interface ActiveChatRun extends InternalProfile {
  runId: string;
  userId: string;
  configVersionId: string;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(value: string | null): string | null {
  const found = /^Bearer\s+(\S+)\s*$/i.exec(value ?? "");
  return found?.[1] ?? null;
}

async function recordInvalidCredential(ipHash: string | null): Promise<void> {
  await consumeRateLimit(RATE_LIMITS.agentToolAuthFailureByIp, ipHash || "unknown");
}

/** Resolves a profile key against its truncated fingerprint, then compares the vault value in constant time. */
async function authenticateProfileKey(rawKey: string | null, ipHash: string | null): Promise<InternalProfile | null> {
  if (!rawKey || !TOKEN_RE.test(rawKey)) {
    await recordInvalidCredential(ipHash);
    return null;
  }
  const candidates = await withSystem(async (db) => {
    const { rows } = await db.query<{
      agent_id: string; org_id: string; role_key: string; display_name: string; profile: string; credential_id: string;
    }>(
      `select a.id as agent_id,a.org_id,a.role_key,a.display_name,a.hermes_profile as profile,c.id as credential_id
         from agent_instances a join organizations o on o.id=a.org_id
         join integration_credentials c on c.id=a.credential_id and c.org_id=a.org_id
             and c.provider='hermes' and c.revoked_at is null and c.fingerprint=$1
         join credential_references cr on cr.id=c.credential_reference_id and cr.org_id=c.org_id
             and cr.provider='hermes' and cr.revoked_at is null
         where o.kind='agency' and o.id=(select id from organizations where kind='agency' order by created_at asc limit 1)
           and o.status='active' and a.enabled and a.role_key=any($2::text[])
          and a.hermes_profile is not null` ,
      [secretFingerprint(rawKey), AGENT_ROLE_KEYS],
    );
    const matched: InternalProfile[] = [];
    for (const row of rows) {
      if (!AGENT_ROLE_KEYS.includes(row.role_key as AgentRoleKey)) continue;
      const role = row.role_key as AgentRoleKey;
      if (row.profile !== AGENCY_HERMES_PROFILE_IDS[role]) continue;
      const stored = await resolveCredential(db, row.credential_id, row.org_id, "hermes").catch(() => null);
      if (stored && constantTimeEqual(stored, rawKey)) {
        matched.push({ agentId: row.agent_id, orgId: row.org_id, roleKey: role, displayName: row.display_name, profile: row.profile });
      }
    }
    return matched;
  });
  if (candidates.length !== 1) {
    await recordInvalidCredential(ipHash);
    return null;
  }
  return candidates[0];
}

async function activeChatRun(db: Queryable, profile: InternalProfile): Promise<ActiveChatRun | null> {
  await db.query("set local statement_timeout='8000ms'");
  const { rows } = await db.query<{
    run_id: string; user_id: string | null; org_id: string; role_key: string; display_name: string; profile: string;
    active_config_version_id: string | null; run_config_version_id: string | null; org_active: boolean;
  }>(
    `select r.id as run_id,r.user_id,a.org_id,a.role_key,a.display_name,a.hermes_profile as profile,
            a.active_config_version_id,r.config_version_id as run_config_version_id,
            (o.status='active') as org_active
       from agent_runs r join agent_instances a on a.id=r.agent_instance_id and a.org_id=r.org_id
       join organizations o on o.id=a.org_id
       join agent_config_versions v on v.id=r.config_version_id and v.agent_instance_id=a.id and v.org_id=a.org_id and v.status='applied'
      where r.org_id=$1 and r.agent_instance_id=$2 and r.purpose='chat' and r.status='running'
        and r.hermes_run_id is not null and r.started_at > now() - interval '20 minutes'
        and ${runtimeReadySql("a", { credentialRevocation: true })}
        and a.tool_inventory_expires_at > now() and a.hermes_profile=$3
        and a.active_config_version_id=r.config_version_id
      order by r.started_at desc limit 2`,
    [profile.orgId, profile.agentId, profile.profile],
  );
  if (rows.length !== 1) return null;
  const run = rows[0];
  if (!run.user_id || !run.org_active || run.profile !== profile.profile
    || run.role_key !== profile.roleKey || run.active_config_version_id !== run.run_config_version_id) return null;
  await db.query("select set_config('app.user_id',$1,true)", [run.user_id]);
  const permissions = await db.query<{ can_access_org: boolean; can_chat: boolean }>(
    `select coalesce(app.user_can_access_org($1,$2),false) as can_access_org,
            coalesce(app.has_permission($2,'agents.use'),false) as can_chat`,
    [run.user_id, profile.orgId],
  );
  if (permissions.rows[0]?.can_access_org !== true || permissions.rows[0]?.can_chat !== true) return null;
  return {
    ...profile,
    runId: run.run_id,
    userId: run.user_id,
    configVersionId: run.active_config_version_id!,
    displayName: run.display_name,
  };
}

async function currentUserPermissions(db: Queryable, run: ActiveChatRun): Promise<Set<string>> {
  await db.query("select set_config('app.user_id',$1,true)", [run.userId]);
  const permissions = [...new Set(Object.values(SCOPE_INFO).flatMap((scope) => scope.permissions))];
  const { rows } = await db.query<{ permission: string; allowed: boolean }>(
    `select p.permission,coalesce(app.has_permission($1,p.permission),false) as allowed
       from unnest($2::text[]) as p(permission)`,
    [run.orgId, permissions],
  );
  return new Set(rows.filter((row) => row.allowed).map((row) => row.permission));
}

function scopesForUser(role: AgentRoleKey, permissions: ReadonlySet<string>): AgentToolScope[] {
  return ROLE_SCOPES[role].filter((scope) => SCOPE_INFO[scope].permissions.every((permission) => permissions.has(permission)));
}

async function requireRun(profile: InternalProfile): Promise<ActiveChatRun> {
  return withSystem(async (db) => {
    const run = await activeChatRun(db, profile);
    if (!run) throw new AppError("forbidden", "This employee can use business information only during its own active, authenticated Chat turn.");
    return run;
  });
}

async function userHasPermissions(db: Queryable, run: ActiveChatRun, required: readonly string[]): Promise<boolean> {
  await db.query("select set_config('app.user_id',$1,true)", [run.userId]);
  const { rows } = await db.query<{ can_access: boolean; permissions: boolean }>(
    `select coalesce(app.user_can_access_org($1,$2),false) as can_access,
            coalesce(bool_and(app.has_permission($2,p.permission)),false) as permissions
       from unnest($3::text[]) as p(permission)`,
    [run.userId, run.orgId, required],
  );
  return rows[0]?.can_access === true && rows[0]?.permissions === true;
}

async function readRoleWorkspaceContext(profile: InternalProfile, input: z.infer<typeof contextInput>) {
  const run = await requireRun(profile);
  return withSystem(async (db) => {
    await db.query("set local statement_timeout='10000ms'");
    const requiredByRole: Record<AgentRoleKey, string[]> = {
      operations_manager: ["agency.workforce.view", "approvals.view", "activity.view"],
      lead_hunter: ["leads.view"],
      appointment_setter: ["appointments.view"],
      sales_assistant: ["sales.view"],
      crm_manager: ["crm.view", "contacts.view", "sales.view"],
      performance_analyst: ["analytics.view", "leads.view", "sales.view", "appointments.view"],
    };
    if (!(await userHasPermissions(db, run, requiredByRole[run.roleKey]))) {
      await auditMcpRead(db, run, HERMES_BUSINESS_CONTEXT_TOOL, "denied", { reason: "user_permission" });
      throw new AppError("forbidden", "Your iAcquire role does not have access to the information this employee needs for this answer.");
    }

    let result: Record<string, unknown>;
    switch (run.roleKey) {
      case "operations_manager": {
        const instructions = await buildRunInstructions(db, run.orgId, run.agentId);
        const snapshot = await prepareInternalEmployeeContext(db, {
          orgId: run.orgId, agentId: run.agentId, userId: run.userId, roleKey: run.roleKey,
          configVersionId: run.configVersionId, instructions: instructions.instructions,
        });
        if (!snapshot.allowed) throw new AppError("forbidden", "The operations summary could not be verified for this employee.");
        result = { status: "available", fetchedAt: snapshot.snapshot.fetchedAt, operations: snapshot.snapshot };
        break;
      }
      case "lead_hunter": {
        const [targetingRow, leadRows, count] = await Promise.all([
          db.query<{ criteria: unknown; updated_at: Date }>("select criteria,updated_at from lead_targeting_profiles where org_id=$1", [run.orgId]),
          db.query<Record<string, unknown>>(
            `select business_name,domain,industry,location,score,qualification_summary,buying_signals,
                    duplicate_status,review_status,crm_sync_status,created_at
               from leads where org_id=$1 order by created_at desc limit 10`, [run.orgId]),
          db.query<{ total: number }>("select count(*)::int as total from leads where org_id=$1", [run.orgId]),
        ]);
        const targeting = targetingSchema.safeParse(targetingRow.rows[0]?.criteria ?? {});
        const targetingIsExplicit = targeting.success && targetingRow.rows.length > 0 && hasExplicitTargeting(targeting.data);
        result = {
          status: targetingIsExplicit ? "available" : targeting.success ? "targeting_not_configured" : "targeting_needs_review",
          targeting: targeting.success ? targeting.data : null,
          targetingConfigured: targetingIsExplicit,
          targetingUpdatedAt: targetingRow.rows[0]?.updated_at ?? null,
          leadsTotal: Number(count.rows[0]?.total ?? 0),
          leads: leadRows.rows.map((row) => ({
            businessName: row.business_name, domain: row.domain, industry: row.industry, location: row.location,
            score: row.score, qualificationSummary: sanitizeQualificationSummary(String(row.qualification_summary ?? "")),
            buyingSignals: row.buying_signals, duplicateStatus: row.duplicate_status, reviewStatus: row.review_status,
            crmSyncStatus: row.crm_sync_status, createdAt: row.created_at,
          })),
          emptyState: Number(count.rows[0]?.total ?? 0) === 0 ? "No researched leads are saved in the iAcquire workspace." : null,
        };
        break;
      }
      case "appointment_setter": {
        const workspace = await db.query<{ mode: string; default_currency: string }>("select mode,default_currency from crm_workspaces where org_id=$1", [run.orgId]);
        const calendars = await db.query<Record<string, unknown>>(
          `select c.id,c.name,c.assignment,c.is_default,c.public,c.status,
                  count(distinct m.user_id) filter (where m.active and om.status='active' and u.status='active')::int as active_hosts,
                  count(distinct m.user_id) filter (where m.active and om.status='active' and u.status='active'
                    and coalesce(h.accepting,true) and exists(select 1 from crm_availability_rules r where r.org_id=c.org_id and r.user_id=m.user_id))::int as hosts_with_hours,
                  count(distinct t.id) filter (where t.archived_at is null)::int as active_appointment_types
             from crm_calendars c left join crm_calendar_members m on m.calendar_id=c.id and m.org_id=c.org_id
             left join organization_memberships om on om.org_id=m.org_id and om.user_id=m.user_id
             left join users u on u.id=m.user_id
             left join crm_host_settings h on h.org_id=m.org_id and h.user_id=m.user_id
             left join crm_appointment_types t on t.calendar_id=c.id and t.org_id=c.org_id
            where c.org_id=$1 and c.archived_at is null group by c.id order by c.is_default desc,c.name limit 20`, [run.orgId]);
        const connections = await db.query<{ provider: string; status: string; count: number }>(
          `select provider,status,count(*)::int as count from crm_calendar_connections where org_id=$1 and status<>'disconnected' group by provider,status order by provider,status`, [run.orgId]);
        const appointments = await db.query<Record<string, unknown>>(
          `select a.start_at,a.end_at,a.timezone,a.status,a.provider,
                  c.name as calendar_name,t.name as appointment_type
             from appointment_refs a
             left join crm_calendars c on c.id=a.calendar_ref and c.org_id=a.org_id and c.archived_at is null
             left join crm_appointment_types t on t.id=a.appointment_type_id and t.org_id=a.org_id and t.archived_at is null
            where a.org_id=$1 and a.provider='native' and a.status in ('new','confirmed')
              and a.start_at>=now() and a.start_at<now()+make_interval(days=>$2::int)
            order by a.start_at limit 25`, [run.orgId, input.lookaheadDays ?? 30]);
        const bookableCalendarExists = calendars.rows.some((calendar) =>
          calendar.status === "active" && Number(calendar.hosts_with_hours ?? 0) > 0 && Number(calendar.active_appointment_types ?? 0) > 0,
        );
        result = {
          status: workspace.rows[0]?.mode === "native"
            ? calendars.rows.length ? bookableCalendarExists ? "configured" : "calendar_needs_setup" : "not_configured"
            : workspace.rows[0] ? "native_calendar_not_selected" : "crm_workspace_not_configured",
          crmProvider: workspace.rows[0]?.mode ?? null,
          calendars: calendars.rows,
          connections: connections.rows,
          upcomingAppointments: appointments.rows,
          availability: "Use the calendar availability lookup for actual free times. This summary does not infer anyone's schedule.",
          emptyState: !calendars.rows.length ? "No native calendars are configured in the iAcquire workspace." : null,
          calendarSetupNote: calendars.rows.length && !bookableCalendarExists
            ? "A calendar exists, but none has an active host with saved working hours and an appointment type. Actual free times are not available until setup is complete."
            : null,
          appointmentsEmptyState: !appointments.rows.length ? "There are no upcoming native iAcquire appointments in that date range." : null,
        };
        break;
      }
      case "sales_assistant": {
        const workspace = await db.query<{ mode: string }>("select mode from crm_workspaces where org_id=$1", [run.orgId]);
        const pipelines = await db.query<Record<string, unknown>>(
          `select p.id,p.name,p.is_default,p.position,
                  coalesce(jsonb_agg(jsonb_build_object('name',s.name,'kind',s.kind,'position',s.position) order by s.position)
                    filter (where s.id is not null),'[]'::jsonb) as stages
             from crm_pipelines p left join crm_pipeline_stages s on s.pipeline_id=p.id and s.org_id=p.org_id and s.archived_at is null
            where p.org_id=$1 and p.provider='native' and p.archived_at is null
            group by p.id order by p.is_default desc,p.position,p.name limit 20`, [run.orgId]);
        const deals = await db.query<Record<string, unknown>>(
          `select o.name,o.status,o.stage_name,o.monetary_value::text as value,o.currency,o.expected_close_date,o.created_at
             from crm_opportunities o where o.org_id=$1 and o.provider='native' and o.archived_at is null
            order by o.updated_at desc limit 20`, [run.orgId]);
        result = {
          status: workspace.rows[0]?.mode === "native" ? (pipelines.rows.length ? "available" : "pipeline_not_configured") : "native_crm_not_selected",
          crmProvider: workspace.rows[0]?.mode ?? null,
          pipelines: pipelines.rows,
          recentOpportunities: deals.rows,
          emptyState: !deals.rows.length ? "No native sales opportunities are recorded in the iAcquire workspace." : null,
        };
        break;
      }
      case "crm_manager": {
        const { rows } = await db.query<Record<string, unknown>>(
          `select w.mode,w.initialized_at,
             (select count(*)::int from contacts c where c.org_id=$1 and c.deleted_at is null and c.archived_at is null) as contacts,
             (select count(*)::int from contacts c where c.org_id=$1 and c.deleted_at is null and c.archived_at is null and (nullif(trim(c.first_name),'') is null and nullif(trim(c.last_name),'') is null)) as contacts_missing_name,
             (select count(*)::int from contacts c where c.org_id=$1 and c.deleted_at is null and c.archived_at is null and nullif(trim(c.email),'') is null and nullif(trim(c.phone),'') is null) as contacts_without_email_or_phone,
             (select count(*)::int from crm_companies x where x.org_id=$1 and x.archived_at is null) as companies,
             (select count(*)::int from crm_pipelines p where p.org_id=$1 and p.provider='native' and p.archived_at is null) as native_pipelines,
             (select count(*)::int from crm_opportunities o where o.org_id=$1 and o.provider='native' and o.archived_at is null) as native_opportunities,
             (select count(*)::int from tasks t where t.org_id=$1 and t.status in ('open','in_progress')) as open_tasks
           from crm_workspaces w where w.org_id=$1`, [run.orgId]);
        result = {
          status: rows[0]?.mode === "native" ? "connected" : rows[0] ? "external_provider_selected" : "not_configured",
          crmProvider: rows[0]?.mode ?? null,
          completeness: rows[0] ?? null,
          emptyState: rows[0] && Number(rows[0].contacts ?? 0) === 0 && Number(rows[0].native_opportunities ?? 0) === 0
            ? "The native CRM is configured, but it currently contains no contacts or sales opportunities." : null,
        };
        break;
      }
      case "performance_analyst": {
        const days = input.periodDays ?? 30;
        const { rows } = await db.query<Record<string, unknown>>(
          `select $2::int as period_days,
             (select count(*)::int from leads l where l.org_id=$1 and l.created_at>=now()-make_interval(days=>$2::int)) as leads_created,
             (select count(*)::int from leads l where l.org_id=$1 and l.review_status='approved' and l.reviewed_at>=now()-make_interval(days=>$2::int)) as leads_approved,
             (select count(*)::int from contacts c where c.org_id=$1 and c.deleted_at is null and c.created_at>=now()-make_interval(days=>$2::int)) as contacts_created,
             (select count(*)::int from crm_opportunities o where o.org_id=$1 and o.provider='native' and o.archived_at is null and o.status='open') as open_opportunities,
             (select count(*)::int from crm_opportunities o where o.org_id=$1 and o.provider='native' and o.archived_at is null and o.status='won' and o.closed_at>=now()-make_interval(days=>$2::int)) as won_opportunities,
             (select count(*)::int from crm_opportunities o where o.org_id=$1 and o.provider='native' and o.archived_at is null and o.status='lost' and o.closed_at>=now()-make_interval(days=>$2::int)) as lost_opportunities,
              (select count(*)::int from appointment_refs a where a.org_id=$1 and a.provider='native' and a.status in ('new','confirmed','showed') and a.created_at>=now()-make_interval(days=>$2::int)) as appointments_booked,
             (select count(*)::int from agent_runs r where r.org_id=$1 and r.started_at>=now()-make_interval(days=>$2::int) and r.purpose<>'health_check') as employee_runs,
             (select count(*)::int from agent_runs r where r.org_id=$1 and r.started_at>=now()-make_interval(days=>$2::int) and r.status in ('failed','timeout','interrupted')) as employee_runs_failed`,
          [run.orgId, days]);
        result = {
          status: "measured",
          periodDays: days,
          source: "iAcquire native CRM and employee run records",
          definitions: {
            leadsCreated: `Lead records created in the last ${days} days.`,
            contactsCreated: `Contact records created in the last ${days} days.`,
            opportunities: "Native pipeline records; won/lost are limited to the selected period.",
            appointmentsBooked: `Bookings marked booked in the last ${days} days.`,
            employeeRuns: `All non-health-check employee runs started in the last ${days} days.`,
          },
          metrics: rows[0] ?? {},
          note: "Counts are read from saved records. Zero means no matching records were found; it is not an estimate.",
        };
        break;
      }
    }
    await auditMcpRead(db, run, HERMES_BUSINESS_CONTEXT_TOOL, "success", { role: run.roleKey });
    return result;
  });
}

async function auditMcpRead(db: Queryable, run: ActiveChatRun, tool: string, result: "success" | "denied" | "failure", metadata: Record<string, unknown>) {
  await db.query(
    `insert into tool_executions (run_id,org_id,tool_name,label,status,finished_at)
     values ($1,$2,$3,$4,$5,now())`,
    [run.runId, run.orgId, `mcp.${tool}`.slice(0, 120), "Reading iAcquire workspace information", result === "success" ? "completed" : "failed"],
  );
  await recordAudit({
    orgId: run.orgId, actorKind: "agent", agentInstanceId: run.agentId, action: "hermes.business_mcp.read",
    targetType: "agent_run", targetId: run.runId, result, metadata: { tool, role: run.roleKey, ...metadata },
  }, db);
}

async function issueCallToken(profile: InternalProfile, toolName: AgentToolName) {
  return withSystem(async (db) => {
    await db.query("set local statement_timeout='8000ms'");
    const run = await activeChatRun(db, profile);
    if (!run) throw new AppError("forbidden", "This employee can use business information only during its own active, authenticated Chat turn.");
    const permissions = await currentUserPermissions(db, run);
    const scopes = scopesForUser(run.roleKey, permissions);
    const def = AGENT_TOOLS[toolName];
    if (!scopes.includes(def.scope) || !def.permissions.every((permission) => permissions.has(permission))) {
      throw new AppError("forbidden", "Your iAcquire role does not have access to this business information.");
    }
    const issued = await issueAgentToolToken(db, {
      orgId: run.orgId, agentInstanceId: run.agentId, runId: run.runId, scopes: [def.scope], ttlMinutes: 1,
    });
    return { run, issued };
  });
}

async function callCrmTool(profile: InternalProfile, name: AgentToolName, args: unknown, callId: string) {
  const { run, issued } = await issueCallToken(profile, name);
  try {
    const def = AGENT_TOOLS[name];
    const reply = await callAgentTool({
      token: issued.token,
      tool: name,
      callId,
      forceApprovalWrites: def.kind === "write",
      readArgs: async () => args,
    });
    await auditMcpToolResult(run, name, reply);
    return reply;
  } finally {
    await withSystem((db) => revokeAgentToolToken(db, issued.tokenId));
  }
}

async function auditMcpToolResult(run: ActiveChatRun, name: AgentToolName, reply: AgentToolReply) {
  if (reply.ok) return;
  await withSystem((db) => auditMcpRead(db, run, name, reply.httpStatus < 500 ? "denied" : "failure", { code: reply.code }));
}

function asMcpResult(value: unknown, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text" as const, text: text.slice(0, 24_000) }], ...(isError ? { isError: true } : {}) };
}

function makeServer(profile: InternalProfile) {
  const server = new McpServer({ name: "iacquire-business", version: "1.0.0" }, { maxToolInputElements: 40 });
  const names = businessMcpToolNamesForRole(profile.roleKey, env().HERMES_BUSINESS_MCP_WRITES_ENABLED);
  const descriptions: Record<AgentRoleKey, string> = {
    operations_manager: "Read iAcquire operational tasks, approvals, and workforce activity that your current iAcquire user is allowed to see.",
    lead_hunter: "Read iAcquire's approved targeting rules and saved researched business leads. Research never means consent to contact.",
    appointment_setter: "Read iAcquire's calendar setup and upcoming appointments. Use the availability lookup for actual free times. This does not create or confirm bookings.",
    sales_assistant: "Read iAcquire's native sales pipelines, stages, and saved opportunities.",
    crm_manager: "Read iAcquire's native CRM setup, record counts, and data completeness. Empty counts are reported as empty.",
    performance_analyst: "Read measured iAcquire operating and native CRM counts for a bounded reporting period.",
  };
  server.registerTool(HERMES_BUSINESS_CONTEXT_TOOL, {
    title: "Read my iAcquire workspace information",
    description: descriptions[profile.roleKey],
    inputSchema: contextInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    try {
      return asMcpResult(await readRoleWorkspaceContext(profile, args));
    } catch (error) {
      const message = error instanceof AppError ? error.message : "The workspace information could not be read right now.";
      return asMcpResult({ status: "unavailable", message }, true);
    }
  });

  for (const name of names.filter((item): item is AgentToolName => item !== HERMES_BUSINESS_CONTEXT_TOOL) as AgentToolName[]) {
    const def = AGENT_TOOLS[name];
    server.registerTool(name, {
      title: def.label,
      description: def.description,
      inputSchema: TOOL_INPUTS[name],
      annotations: {
        readOnlyHint: def.kind === "read",
        destructiveHint: false,
        idempotentHint: def.kind === "read",
        openWorldHint: false,
      },
    }, async (args: Record<string, unknown>, extra: { requestId?: string | number }) => {
      try {
        const requestId = String(extra.requestId ?? "call").replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 48) || "call";
        const reply = await callCrmTool(profile, name, args, `mcp-${requestId}`);
        return asMcpResult(reply, !reply.ok);
      } catch (error) {
        const message = error instanceof AppError ? error.message : "This business information is unavailable right now.";
        return asMcpResult({ status: "unavailable", message }, true);
      }
    });
  }
  return server;
}

/** Stateless Streamable HTTP handler; the profile key is the only credential accepted. */
export async function handleHermesBusinessMcp(request: Request): Promise<Response> {
  const config = env();
  if (!config.HERMES_BUSINESS_MCP_ENABLED) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const forwardedIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip");
  const ipHash = forwardedIp ? sha256(`hermes-business-mcp:${forwardedIp}`).slice(0, 32) : null;
  const apiKey = bearer(request.headers.get("authorization"));
  const profile = await authenticateProfileKey(apiKey, ipHash);
  if (!profile) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="iacquire-business"', "Cache-Control": "no-store" } });
  const rate = await consumeRateLimit(RATE_LIMITS.agentToolCallsByEmployee, profile.agentId);
  if (!rate.allowed) return new Response("Too many requests", { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds), "Cache-Control": "no-store" } });
  const server = makeServer(profile);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MCP_BODY_LIMIT,
    allowedOrigins: [new URL(config.APP_URL).origin],
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Robots-Tag", "noindex, nofollow");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return Response.json({ error: "The employee business service could not complete this request." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
