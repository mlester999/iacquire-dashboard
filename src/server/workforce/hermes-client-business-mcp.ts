import "server-only";
import { isWorkforceRoleKey, type WorkforceRoleKey } from "@/lib/agents";
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
import { clientBusinessMcpRuntimeNamesForRole, clientBusinessMcpToolNamesForRole, clientBusinessToolsOn, clientBusinessProposalsOn } from "@/server/workforce/hermes-client-business-mcp-policy";
import { HERMES_BUSINESS_MCP_SERVER, HERMES_BUSINESS_MCP_TOOLSET } from "@/server/workforce/hermes-business-mcp-policy";
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
 *     turn is not cut short by a proof that lapsed after it began. That recorded inventory must also carry exactly the role's reviewed business tools (recordedToolsMatchRole).
 *  3. The person. Every read is made for that person: their role and per-person overrides must allow what the tool needs (checked before any tool token exists), and the shared tool
 *     engine limits conversations and conversation counts to what their own row visibility allows (onBehalfOfUserId).
 *  4. The gate (hermes-client-business-mcp-gate.ts), on every call: the plan still includes the role, the employee's allowed actions, and that the part of the workspace the tool reads
 *     exists and is iAcquire's own. A workspace whose CRM is elsewhere answers "unavailable", never an empty list.
 *
 * Two phases share this handler. Reads are always on. PROPOSALS, only when the deployment's proposals flag and the workspace's own switch are both on (read in the same transaction as the
 * gate, on every call), add the role's changes to the tool list. A proposal never changes a record: the shared tool engine is always told to force approval, so a change becomes one pending
 * approval request (asked for by the person whose Chat turn it is, valid for 72 hours, one per distinct request in a turn) that a person must approve in the Approval Center, and that is
 * blocked at execution if the proposals flag or switch has gone off by then (executeApprovedAgentToolCall). A message, a booking request or a send request is never offered at all.
 *
 * Every tool call and context read is also counted per workspace and per person (RATE_LIMITS.clientBusinessMcpByOrg and ...ByUser), once the turn and its person are known, so one busy
 * workspace or person cannot use up another's allowance. The per-employee limit is counted by the engine itself and by the route; this handler does not count it a third time.
 */

const TURN_MESSAGE = "This employee can use business information only during its own active, authenticated Chat turn.";
const PERSON_MESSAGE = "Your iAcquire role does not have access to this business information.";

type ClientAuthentication = { ok: true; profile: InternalProfile } | { ok: false; retryAfterSeconds: number | null };

const plain = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

/**
 * A credential this server issued but cannot honour (ended, expired, re-mapped, or its employee or workspace no longer qualifies) is a signal an operator wants. It is written once per
 * refusal, to the employee's workspace, while the failure limit for the client address still has room. Only a credential id, a role and a short reason code: never a secret or a hash.
 */
async function auditClientRefusal(claims: { credentialId: string; orgId: string; agentId: string; role: WorkforceRoleKey }, reason: string, ipHash: string | null): Promise<void> {
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
    const { rows } = await db.query<{ agent_id: string; org_id: string; role_key: string; display_name: string; profile: string; slug: string }>(
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
    if (!row || row.org_id !== claims.orgId || row.agent_id !== claims.agentId || !isWorkforceRoleKey(row.role_key)) {
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
 * Whether the inventory recorded by the employee's last health check carries exactly the business tools its role is reviewed for: its reads, or its reads and its change proposals (the two
 * lists the inventory verifier accepts), all from the one reviewed server and toolset, and no other MCP tool. A profile verified before its workspace joined the tier, or one that carries a
 * tool nobody reviewed, cannot take a turn here even though its credential is genuine.
 */
function recordedToolsMatchRole(recorded: unknown, role: WorkforceRoleKey): boolean {
  if (!Array.isArray(recorded)) return false;
  const rows = recorded.filter((tool): tool is Record<string, unknown> => typeof tool === "object" && tool !== null);
  const mcp = rows.filter((tool) => tool.source === "mcp" || typeof tool.sourceServer === "string"
    || (typeof tool.name === "string" && tool.name.startsWith("mcp__")) || (typeof tool.toolset === "string" && tool.toolset.startsWith("mcp-")));
  if (mcp.some((tool) => tool.source !== "mcp" || tool.sourceServer !== HERMES_BUSINESS_MCP_SERVER || tool.toolset !== HERMES_BUSINESS_MCP_TOOLSET || typeof tool.name !== "string")) return false;
  const names = mcp.map((tool) => String(tool.name)).sort();
  return [false, true].some((proposals) => {
    const reviewed = clientBusinessMcpRuntimeNamesForRole(role, { proposals });
    return reviewed.length === names.length && reviewed.every((name, index) => name === names[index]);
  });
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
    recorded_tools: unknown;
  }>(
    `select r.id as run_id, r.user_id, a.org_id, a.role_key, a.display_name, a.hermes_profile as profile,
            a.active_config_version_id, r.config_version_id as run_config_version_id, a.tool_inventory_snapshot -> 'tools' as recorded_tools
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
  if (!recordedToolsMatchRole(run.recorded_tools, profile.roleKey)) return null;
  await db.query("select set_config('app.user_id', $1, true)", [run.user_id]);
  const permissions = await db.query<{ can_access_org: boolean; can_chat: boolean }>(
    `select coalesce(app.user_can_access_org($1, $2), false) as can_access_org, coalesce(app.has_permission($2, 'agents.use'), false) as can_chat`,
    [run.user_id, profile.orgId],
  );
  if (permissions.rows[0]?.can_access_org !== true || permissions.rows[0]?.can_chat !== true) return null;
  return { ...profile, runId: run.run_id, userId: run.user_id, configVersionId: run.active_config_version_id, displayName: run.display_name, orgKind: "client" };
}

/**
 * The turn, then the two limits. The person's limit is counted first, so a person who is over theirs does not also use up the workspace's allowance; both keys name the workspace, so a
 * person who belongs to two workspaces has a separate allowance in each. A refusal here is written to the audit trail with the reason only, and creates nothing else.
 */
async function requireClientRun(profile: InternalProfile, tool: string): Promise<ActiveChatRun> {
  const run = await withSystem((db) => activeClientChatRun(db, profile));
  if (!run) throw new AppError("forbidden", TURN_MESSAGE);
  const limits = [
    { scope: "person", rule: RATE_LIMITS.clientBusinessMcpByUser, key: `${run.orgId}:${run.userId}` },
    { scope: "workspace", rule: RATE_LIMITS.clientBusinessMcpByOrg, key: run.orgId },
  ] as const;
  for (const limit of limits) {
    const result = await consumeRateLimit(limit.rule, limit.key);
    if (result.allowed) continue;
    await auditClientCall(run, tool, "denied", { reason: "rate_limited", scope: limit.scope });
    throw new AppError("rate_limited", `Too many business tool requests for this ${limit.scope} just now. Wait ${result.retryAfterSeconds} seconds and try again.`, { retryAfterSeconds: result.retryAfterSeconds });
  }
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

/**
 * One row for a change that became an approval request: the workspace, the employee, the person who asked and the approval, plus the tool and role. The request itself (what would change)
 * lives in the approval and is not copied here. Written only when the engine really recorded or found a request, so a refused proposal leaves no such row.
 */
async function auditClientProposal(run: ActiveChatRun, tool: AgentToolName, reply: Extract<AgentToolReply, { ok: true }>): Promise<void> {
  if (!reply.approvalId) return;
  const approvalId = reply.approvalId;
  await withSystem((db) => recordAudit({
    orgId: run.orgId, actorUserId: run.userId, actorKind: "agent", agentInstanceId: run.agentId, action: "hermes.client_business_mcp.proposal_requested",
    targetType: "approval", targetId: approvalId, approvalId, result: "success", metadata: { tier: "client", tool, role: run.roleKey, jti: run.credentialId, runId: run.runId, outcome: reply.status },
  }, db));
}

const unavailable = (tool: AgentToolName, detail: string): AgentToolReply => ({ ok: true, httpStatus: 200, status: "unavailable", tool, result: { available: false, detail }, detail });

/**
 * One tool call, made for the person whose Chat turn this is. Every refusal happens before a tool token exists, so a refused call creates nothing: no token, approval, run or record.
 * Order: the turn and the limits, the person's membership, the person's own permissions for what the tool needs (a viewer who may not edit contacts is refused here, before any approval
 * request could exist), the call-time gate, and only then a one-minute token scoped to this one tool.
 */
async function callClientTool(profile: InternalProfile, name: AgentToolName, args: Record<string, unknown>, callId: string): Promise<AgentToolReply> {
  const run = await requireClientRun(profile, name);
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
    // forceApprovalWrites is always true: whatever the employee's own mode, a change asked for here can only become an approval request and never runs. A change is called without the
    // gateway's request id, so the engine keys its approval by the arguments: the same request twice in one turn (a retry, a replay) is one approval, not two for a person to answer.
    const reply = await callAgentTool({
      token: issued.token, tool: name, callId: def.kind === "write" ? null : callId, forceApprovalWrites: true, onBehalfOfUserId: run.userId, readArgs: async () => args,
    });
    if (!reply.ok) await auditClientCall(run, name, reply.httpStatus < 500 ? "denied" : "failure", { code: reply.code });
    else if (def.kind === "write") await auditClientProposal(run, name, reply);
    return reply;
  } finally {
    await withSystem((db) => revokeAgentToolToken(db, issued.tokenId));
  }
}

async function readClientContext(profile: InternalProfile) {
  const run = await requireClientRun(profile, "get_role_workspace_context");
  // The read is for the person whose turn this is, so the audit row names them (the internal tier's rows carry no person).
  return buildRoleWorkspaceContext(run, { actingUserId: run.userId });
}

const CONTEXT_DESCRIPTIONS: Record<WorkforceRoleKey, string> = {
  operations_manager: "Read the current state of your workspace that the person you are talking with is allowed to see: the AI work board, handoffs and setup status.",
  lead_hunter: "Read the saved targeting rules and researched leads that the person you are talking with is allowed to see. Research never means consent to contact.",
  appointment_setter: "Read the calendar setup, this week's appointments and booking requests that the person you are talking with is allowed to see. This does not create or confirm bookings.",
  sales_assistant: "Read the sales pipelines, stages and deals that the person you are talking with is allowed to see.",
  crm_manager: "Read the CRM setup, record counts and data quality that the person you are talking with is allowed to see. Empty counts are reported as empty.",
  performance_analyst: "Read the measured business counts that the person you are talking with is allowed to see, for the last 30 days against the 30 before.",
  growth_partner: "Read and prepare approved changes across your workspace's CRM, calendar and inbox capabilities, always limited by the signed-in person's permissions and required approvals.",
};

/** The tool list is the policy module's and nothing else's: the role's reads, plus its changes when this workspace is in the proposals phase. */
function makeClientServer(profile: InternalProfile, proposals: boolean) {
  return buildBusinessMcpServer({
    names: clientBusinessMcpToolNamesForRole(profile.roleKey, { proposals }),
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
  // With the deployment's proposals flag off this reads nothing. A read that fails offers the reads alone: a smaller list is the safe way to be wrong, and the gate decides again per call.
  const proposals = config.HERMES_CLIENT_BUSINESS_MCP_PROPOSALS_ENABLED
    ? await withSystem((db) => clientBusinessProposalsOn(profile.orgId, db)).catch(() => false)
    : false;
  return serveStatelessBusinessMcp(makeClientServer(profile, proposals), request, config.APP_URL);
}
