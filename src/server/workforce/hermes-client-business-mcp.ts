import "server-only";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { runtimeReadySql } from "@/lib/employee-runtime";
import { AppError } from "@/server/errors";
import { withSystem, type Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { env } from "@/server/env";
import { sha256 } from "@/server/security/crypto";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { AGENT_TOOLS, SCOPE_INFO, type AgentToolName } from "@/server/crm/agent-tools/catalog";
import { issueAgentToolToken, revokeAgentToolToken } from "@/server/crm/agent-tools/tokens";
import { callAgentTool, type AgentToolReply } from "@/server/crm/agent-tools/service";
import { loadOrgContextForUser } from "@/server/tenancy/context";
import { suggestedProfileName } from "@/server/workforce/service";
import { PROVISIONING_PAYMENT_CLEARED_SQL } from "@/server/workforce/provisioning";
import { bearer, buildBusinessMcpServer, buildRoleWorkspaceContext, refuseCredential, serveStatelessBusinessMcp, type ActiveChatRun, type InternalProfile } from "@/server/workforce/hermes-business-mcp";
import { clientBusinessMcpToolNamesForRole, clientBusinessToolsOn } from "@/server/workforce/hermes-client-business-mcp-policy";
import { clientToolGate } from "@/server/workforce/hermes-client-business-mcp-gate";
import { recordClientCredentialUse, verifyClientCredential, type ClientCredentialClaims } from "@/server/workforce/hermes-client-business-credential";

/**
 * The CLIENT tier of the business tools: what a client's own AI employee reads from its own workspace, during a Chat turn a person of that workspace started.
 *
 * It is a separate route and handler from the internal agency tier (hermes-business-mcp.ts) on the same engine: the same MCP server builder, the same CRM tool service, the same
 * "records are data" rule. What differs is who may knock and whom the answer is for:
 *
 *  1. Authentication. The credential (iamcpc1, hermes-client-business-credential.ts) carries no claims. It finds one ledger row, and then everything is read from the application's own
 *     records and must agree: the employee is enabled, its workspace is an active, non-demo client whose setup payment is confirmed, its Hermes profile is the one this code
 *     would name for that workspace and role (a "c-" profile, recomputed here, never trusted), its Hermes credential is live, its gateway is a verified client-only gateway that holds
 *     no agency profile, and the workspace's own switch is on (read in the same transaction, so a switch-off is seen by the very next request). Every refusal answers the same 401.
 *  2. The turn. Holding a credential reads nothing. Exactly one running Chat turn of that employee, in that workspace, on its active configuration, must exist, and its person must still
 *     belong to the workspace and hold agents.use. The employee's recorded health is read now; its tool-inventory proof only has to have been valid when the turn started, so a long
 *     turn is not cut short by a proof that lapsed after it began.
 *  3. The person. Every read is made for that person: their role and per-person overrides must allow what the tool needs (checked before any tool token exists), and the shared tool
 *     engine limits conversations and conversation counts to what their own row visibility allows (onBehalfOfUserId).
 *  4. The gate (hermes-client-business-mcp-gate.ts), on every call: the plan still includes the role, the employee's allowed actions, and that the part of the workspace the tool reads
 *     exists and is iAcquire's own. A workspace whose CRM is elsewhere answers "unavailable", never an empty list.
 *
 * This phase is READ ONLY. The tool list is the role's reads (clientBusinessMcpToolNamesForRole with no proposals) and nothing here can write: a tool that is not a read is refused by the
 * gate before any token exists. The proposals phase (changes as approval requests), the per-workspace and per-person rate limits and the extra audit are the next package and plug in at the
 * two marked seams below.
 */

const TURN_MESSAGE = "This employee can use business information only during its own active, authenticated Chat turn.";
const PERSON_MESSAGE = "Your iAcquire role does not have access to this business information.";

type ClientAuthentication = { ok: true; profile: InternalProfile } | { ok: false; retryAfterSeconds: number | null };

const plain = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

/**
 * A credential this server issued but cannot honour (ended, expired, re-mapped, or its employee or workspace no longer qualifies) is a signal an operator wants. It is written once per
 * refusal, to the employee's workspace, while the failure limit for the client address still has room. Only a credential id, a role and a short reason code: never a secret or a hash.
 */
async function auditClientRefusal(claims: { credentialId: string; orgId: string; agentId: string; role: AgentRoleKey }, reason: string, ipHash: string | null): Promise<void> {
  await withSystem((db) => recordAudit({
    orgId: claims.orgId, actorKind: "system", agentInstanceId: claims.agentId, action: "hermes.business_mcp.auth_denied", targetType: "agent_instance", targetId: claims.agentId,
    result: "denied", ipHash, metadata: { tier: "client", reason, role: claims.role, jti: claims.credentialId },
  }, db));
}

async function refuse(ipHash: string | null, audit?: () => Promise<void>): Promise<ClientAuthentication> {
  const refusal = await refuseCredential(ipHash, audit);
  return { ok: false, retryAfterSeconds: refusal.ok ? null : refusal.retryAfterSeconds };
}

type Checked = { ok: true; profile: InternalProfile } | { ok: false; reason: string; claims?: Omit<ClientCredentialClaims, "status"> };

/**
 * Authenticates a presented client credential and derives who it speaks for from the application's own records. One transaction, so the checks and the switch read agree. A value that
 * is malformed, unknown, wrongly keyed or not live yet is only counted (nobody can say who it was for); a genuine credential that cannot be honoured is also audited.
 */
async function authenticateClientCredential(presented: string | null, ipHash: string | null): Promise<ClientAuthentication> {
  const checked = await withSystem(async (db): Promise<Checked> => {
    const verified = await verifyClientCredential(db, presented);
    if (!verified.ok) return { ok: false, reason: verified.reason, claims: verified.claims };
    const { claims } = verified;
    const { rows } = await db.query<{ agent_id: string; org_id: string; role_key: AgentRoleKey; display_name: string; profile: string; slug: string }>(
      `select a.id as agent_id, a.org_id, a.role_key, a.display_name, a.hermes_profile as profile, o.slug
         from agent_instances a join organizations o on o.id = a.org_id
         join integration_credentials c on c.id = a.credential_id and c.org_id = a.org_id and c.provider = 'hermes' and c.revoked_at is null
         join credential_references cr on cr.id = c.credential_reference_id and cr.org_id = c.org_id and cr.provider = 'hermes' and cr.revoked_at is null
         join hermes_gateways g on g.id = a.hermes_gateway_id
        where a.id = $1 and a.org_id = $2 and a.hermes_profile = $3 and a.enabled
          and o.kind = 'client' and not o.is_demo and o.status = 'active'
          and g.status = 'connected' and g.gateway_type = 'multiplexed_profiles' and g.profile_creation_status = 'restricted_service_verified'
          and g.provisioner_isolation_verified_at is not null
          and not exists (select 1 from agent_instances ai join organizations oi on oi.id = ai.org_id where ai.hermes_gateway_id = g.id and oi.kind = 'agency')
          and ${PROVISIONING_PAYMENT_CLEARED_SQL}`,
      [claims.agentId, claims.orgId, claims.profile],
    );
    const row = rows[0];
    if (!row || row.org_id !== claims.orgId || row.agent_id !== claims.agentId || !(AGENT_ROLE_KEYS as readonly string[]).includes(row.role_key)) {
      return { ok: false, reason: "employee_not_active", claims };
    }
    // The profile is recomputed, never taken from a row or a credential: a client's profile is "c-" plus the workspace and role, exactly as the provisioner names it.
    const expected = suggestedProfileName(row.slug, row.role_key);
    if (row.profile !== expected || !row.profile.startsWith("c-")) return { ok: false, reason: "profile_mismatch", claims };
    if (!(await clientBusinessToolsOn(row.org_id, db))) return { ok: false, reason: "workspace_switch_off", claims };
    // The credential is genuine and its employee qualifies: this is a use (and the first use of a new credential ends the one it replaces).
    await recordClientCredentialUse(db, claims.orgId, claims.credentialId);
    return { ok: true, profile: { agentId: row.agent_id, orgId: row.org_id, roleKey: row.role_key, displayName: row.display_name, profile: row.profile, credentialId: claims.credentialId } };
  });
  if (checked.ok) return { ok: true, profile: checked.profile };
  const signed = checked.claims;
  return refuse(ipHash, signed ? () => auditClientRefusal(signed, checked.reason, ipHash) : undefined);
}

/**
 * The one running Chat turn this credential's employee may read for, or null. The same rules as the internal tier's turn (one running chat turn, started under twenty minutes ago, the
 * employee's active applied configuration, a runtime-ready employee with an unrevoked credential, the person still in the workspace with agents.use), with three differences that
 * belong to a client: the workspace must be an active, non-demo client; the workspace, employee and configuration are all named in the query so another workspace's turn can never
 * match; and the tool-inventory proof must have been valid when the turn STARTED (the chat itself required it then), while the employee's health is read now.
 */
async function activeClientChatRun(db: Queryable, profile: InternalProfile): Promise<ActiveChatRun | null> {
  await db.query("set local statement_timeout='8000ms'");
  const { rows } = await db.query<{
    run_id: string; user_id: string | null; org_id: string; role_key: string; display_name: string; profile: string; active_config_version_id: string | null; run_config_version_id: string | null;
  }>(
    `select r.id as run_id, r.user_id, a.org_id, a.role_key, a.display_name, a.hermes_profile as profile,
            a.active_config_version_id, r.config_version_id as run_config_version_id
       from agent_runs r join agent_instances a on a.id = r.agent_instance_id and a.org_id = r.org_id
       join organizations o on o.id = a.org_id
       join agent_config_versions v on v.id = r.config_version_id and v.agent_instance_id = a.id and v.org_id = a.org_id and v.status = 'applied'
      where r.org_id = $1 and r.agent_instance_id = $2 and r.purpose = 'chat' and r.status = 'running'
        and r.hermes_run_id is not null and r.started_at > now() - interval '20 minutes'
        and o.kind = 'client' and not o.is_demo and o.status = 'active'
        and ${runtimeReadySql("a", { credentialRevocation: true })}
        and a.tool_inventory_expires_at > r.started_at and a.hermes_profile = $3
        and a.active_config_version_id = r.config_version_id
      order by r.started_at desc limit 2`,
    [profile.orgId, profile.agentId, profile.profile],
  );
  if (rows.length !== 1) return null;
  const run = rows[0];
  if (!run.user_id || run.org_id !== profile.orgId || run.profile !== profile.profile || run.role_key !== profile.roleKey || !run.active_config_version_id
    || run.active_config_version_id !== run.run_config_version_id) return null;
  await db.query("select set_config('app.user_id', $1, true)", [run.user_id]);
  const permissions = await db.query<{ can_access_org: boolean; can_chat: boolean }>(
    `select coalesce(app.user_can_access_org($1, $2), false) as can_access_org, coalesce(app.has_permission($2, 'agents.use'), false) as can_chat`,
    [run.user_id, profile.orgId],
  );
  if (permissions.rows[0]?.can_access_org !== true || permissions.rows[0]?.can_chat !== true) return null;
  return { ...profile, runId: run.run_id, userId: run.user_id, configVersionId: run.active_config_version_id, displayName: run.display_name, orgKind: "client" };
}

async function requireClientRun(profile: InternalProfile): Promise<ActiveChatRun> {
  const run = await withSystem((db) => activeClientChatRun(db, profile));
  if (!run) throw new AppError("forbidden", TURN_MESSAGE);
  // SEAM (proposals and limits package): the per-workspace and per-person limits (RATE_LIMITS.clientBusinessMcpByOrg and ...ByUser) are consumed here, once the turn and its person are known.
  return run;
}

/** One row per client call: the run's tool log and the audit trail, in the client's workspace, naming the person. Reasons and tool names only, never a record, a name or free text. */
async function auditClientCall(run: ActiveChatRun, tool: string, result: "success" | "denied" | "failure", metadata: Record<string, unknown>): Promise<void> {
  await withSystem(async (db) => {
    await db.query(
      `insert into tool_executions (run_id, org_id, tool_name, label, status, finished_at) values ($1, $2, $3, $4, $5, now())`,
      [run.runId, run.orgId, `mcp.${tool}`.slice(0, 120), "Reading iAcquire workspace information", result === "success" ? "completed" : "failed"],
    );
    await recordAudit({
      orgId: run.orgId, actorUserId: run.userId, actorKind: "agent", agentInstanceId: run.agentId, action: "hermes.business_mcp.read",
      targetType: "agent_run", targetId: run.runId, result, metadata: { tier: "client", tool, role: run.roleKey, jti: run.credentialId, ...metadata },
    }, db);
  });
}

const unavailable = (tool: AgentToolName, detail: string): AgentToolReply => ({ ok: true, httpStatus: 200, status: "unavailable", tool, result: { available: false, detail }, detail });

/**
 * One tool call, made for the person whose Chat turn this is. Every refusal happens before a tool token exists, so a refused call creates nothing: no token, approval, run or record.
 * Order: the turn, the person's membership, the person's own permissions for what the tool needs, the call-time gate, and only then a one-minute token scoped to this one tool.
 */
async function callClientTool(profile: InternalProfile, name: AgentToolName, args: Record<string, unknown>, callId: string): Promise<AgentToolReply> {
  const run = await requireClientRun(profile);
  const def = AGENT_TOOLS[name];
  const person = await loadOrgContextForUser(run.userId, run.orgId);
  if (!person) {
    await auditClientCall(run, name, "denied", { reason: "membership" });
    throw new AppError("forbidden", "Your iAcquire role does not have access to this workspace.");
  }
  // The person's role and per-person overrides must cover everything the tool and its scope need. The shared engine checks this again, but it only sees the token that already exists.
  const needed = new Set([...SCOPE_INFO[def.scope].permissions, ...def.permissions]);
  if ([...needed].some((permission) => !person.can(permission))) {
    await auditClientCall(run, name, "denied", { reason: "person_permission" });
    return { ok: false, httpStatus: 403, code: "forbidden", error: PERSON_MESSAGE };
  }
  const gate = await withSystem((db) => clientToolGate(db, { orgId: run.orgId, agentId: run.agentId, roleKey: run.roleKey, tool: name }));
  if (!gate.ok) {
    await auditClientCall(run, name, "denied", { reason: gate.reason });
    return unavailable(name, gate.detail);
  }
  const issued = await withSystem((db) => issueAgentToolToken(db, { orgId: run.orgId, agentInstanceId: run.agentId, runId: run.runId, scopes: [def.scope], ttlMinutes: 1 }));
  try {
    // SEAM (proposals package): this phase offers and passes reads only (the gate refuses any other kind). forceApprovalWrites stays true so that, whatever is listed later, a write can
    // only ever become an approval request here and never run.
    const reply = await callAgentTool({ token: issued.token, tool: name, callId, forceApprovalWrites: true, onBehalfOfUserId: run.userId, readArgs: async () => args });
    if (!reply.ok) await auditClientCall(run, name, reply.httpStatus < 500 ? "denied" : "failure", { code: reply.code });
    return reply;
  } finally {
    await withSystem((db) => revokeAgentToolToken(db, issued.tokenId));
  }
}

async function readClientContext(profile: InternalProfile) {
  return buildRoleWorkspaceContext(await requireClientRun(profile));
}

const CONTEXT_DESCRIPTIONS: Record<AgentRoleKey, string> = {
  operations_manager: "Read the current state of your workspace that the person you are talking with is allowed to see: the AI work board, handoffs and setup status.",
  lead_hunter: "Read the saved targeting rules and researched leads that the person you are talking with is allowed to see. Research never means consent to contact.",
  appointment_setter: "Read the calendar setup, this week's appointments and booking requests that the person you are talking with is allowed to see. This does not create or confirm bookings.",
  sales_assistant: "Read the sales pipelines, stages and deals that the person you are talking with is allowed to see.",
  crm_manager: "Read the CRM setup, record counts and data quality that the person you are talking with is allowed to see. Empty counts are reported as empty.",
  performance_analyst: "Read the measured business counts that the person you are talking with is allowed to see, for the last 30 days against the 30 before.",
};

function makeClientServer(profile: InternalProfile) {
  return buildBusinessMcpServer({
    names: clientBusinessMcpToolNamesForRole(profile.roleKey),
    contextDescription: CONTEXT_DESCRIPTIONS[profile.roleKey],
    readContext: () => readClientContext(profile),
    callTool: (name, args, callId) => callClientTool(profile, name, args, callId),
  });
}

/**
 * Stateless Streamable HTTP handler for the client tier. The deployment flag is checked first and costs nothing: with it off the answer is a plain 404 before any header is read or any
 * table is touched. The client credential is the only one accepted (an internal agency credential and a Hermes profile key are both refused).
 */
export async function handleHermesClientBusinessMcp(request: Request): Promise<Response> {
  const config = env();
  if (!config.HERMES_CLIENT_BUSINESS_MCP_ENABLED) return plain(404, "Not found");
  const forwardedIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip");
  const ipHash = forwardedIp ? sha256(`hermes-client-business-mcp:${forwardedIp}`).slice(0, 32) : null;
  const auth = await authenticateClientCredential(bearer(request.headers.get("authorization")), ipHash);
  if (!auth.ok) {
    if (auth.retryAfterSeconds !== null) return plain(429, "Too many requests", { "Retry-After": String(auth.retryAfterSeconds) });
    return plain(401, "Unauthorized", { "WWW-Authenticate": 'Bearer realm="iacquire-business"' });
  }
  const profile = auth.profile;
  const rate = await consumeRateLimit(RATE_LIMITS.agentToolCallsByEmployee, profile.agentId);
  if (!rate.allowed) return plain(429, "Too many requests", { "Retry-After": String(rate.retryAfterSeconds) });
  return serveStatelessBusinessMcp(makeClientServer(profile), request, config.APP_URL);
}
