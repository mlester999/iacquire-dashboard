import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { randomToken, sha256 } from "@/server/security/crypto";
import { assertCan, auditActor, type CrmActor } from "@/server/crm/actor";
import { AGENT_TOOL_SCOPES, effectiveScopes, isAgentToolScope, type AgentToolScope } from "@/server/crm/agent-tools/catalog";

/**
 * Short-lived bearer tokens for a client's own AI employee to call CRM tools during one run.
 *
 *  - The secret is random (256 bits), returned once to whoever starts the run, and never stored: crm_agent_tokens keeps its sha256.
 *  - A token is bound to one organization, one AI employee, optionally one agent run, and a set of scopes narrowed to the role's
 *    allowlist. It expires within 24 hours (the table enforces that too).
 *  - It stops working when it is revoked, when it expires, or as soon as its run is no longer queued or running: run end is a
 *    revocation even if nobody called revokeAgentToolTokensForRun.
 */

export const AGENT_TOKEN_PREFIX = "iaqat_";
export const DEFAULT_TOKEN_MINUTES = 60;
export const MAX_TOKEN_MINUTES = 24 * 60;
const TOKEN_RE = /^iaqat_[A-Za-z0-9_-]{43}$/;

export interface IssuedAgentToolToken {
  /** The bearer secret. Shown once; only its hash is stored. */
  token: string;
  tokenId: string;
  expiresAt: string;
  scopes: AgentToolScope[];
}

export interface VerifiedAgentToken {
  tokenId: string;
  orgId: string;
  agentInstanceId: string;
  runId: string | null;
  scopes: string[];
}

const LIVE_RUN = ["queued", "running"];

/**
 * Issues a token for one run. Call it with the transaction that starts the run, and hand the returned secret only to that run.
 * Scopes outside the employee's role allowlist are dropped; a request left with none is refused.
 */
export async function issueAgentToolToken(
  db: Queryable,
  input: { orgId: string; agentInstanceId: string; runId?: string | null; scopes: readonly string[]; ttlMinutes?: number },
): Promise<IssuedAgentToolToken> {
  const unknown = input.scopes.filter((s) => !isAgentToolScope(s));
  if (unknown.length) throw new AppError("invalid_input", `Unknown tool scope: ${unknown[0].slice(0, 40)}.`);
  const ttl = input.ttlMinutes ?? DEFAULT_TOKEN_MINUTES;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TOKEN_MINUTES) throw new AppError("invalid_input", "A tool token lasts between 1 minute and 24 hours.");
  const { rows } = await db.query<{ id: string; role_key: string; enabled: boolean; kind: string }>(
    `select a.id, a.role_key, a.enabled, o.kind from agent_instances a join organizations o on o.id = a.org_id where a.id = $1 and a.org_id = $2`,
    [input.agentInstanceId, input.orgId],
  );
  const agent = rows[0];
  if (!agent || agent.kind !== "client") throw new AppError("not_found", "AI employee not found.");
  if (!agent.enabled) throw new AppError("conflict", "This AI employee is not included in the workspace.");
  if (input.runId) {
    const run = await db.query<{ status: string }>("select status from agent_runs where id = $1 and org_id = $2 and agent_instance_id = $3", [input.runId, input.orgId, input.agentInstanceId]);
    if (!run.rows[0]) throw new AppError("not_found", "Run not found.");
    if (!LIVE_RUN.includes(run.rows[0].status)) throw new AppError("conflict", "That run has already finished.");
  }
  const scopes = effectiveScopes(agent.role_key, [...new Set(input.scopes)]);
  if (!scopes.length) throw new AppError("invalid_input", "None of those tool scopes are allowed for this AI employee's role.");
  const token = `${AGENT_TOKEN_PREFIX}${randomToken(32)}`;
  const ins = await db.query<{ id: string; expires_at: Date }>(
    `insert into crm_agent_tokens (org_id, agent_instance_id, run_id, token_hash, scopes, expires_at)
     values ($1, $2, $3, $4, $5::text[], now() + make_interval(mins => $6::int)) returning id, expires_at`,
    [input.orgId, input.agentInstanceId, input.runId ?? null, sha256(token), scopes, ttl],
  );
  await recordAudit({
    orgId: input.orgId, actorKind: "system", agentInstanceId: input.agentInstanceId, action: "crm.agent_tool_access_issued", targetType: "crm_agent_token", targetId: ins.rows[0].id, result: "success",
    metadata: { scopes, minutes: ttl, runId: input.runId ?? null },
  }, db);
  return { token, tokenId: ins.rows[0].id, expiresAt: new Date(ins.rows[0].expires_at).toISOString(), scopes };
}

/**
 * Looks a presented secret up by its hash. Returns null for anything that is malformed, unknown, expired, revoked, or whose run has
 * ended (and revokes it then). The organization and employee returned here are the only ones a tool call may act for.
 */
export async function verifyAgentToolToken(db: Queryable, presented: string | null | undefined): Promise<VerifiedAgentToken | null> {
  if (!presented || !TOKEN_RE.test(presented)) return null;
  const { rows } = await db.query<{ id: string; org_id: string; agent_instance_id: string; run_id: string | null; scopes: string[]; expired: boolean; revoked: boolean; run_status: string | null }>(
    `select t.id, t.org_id, t.agent_instance_id, t.run_id, t.scopes, t.expires_at <= now() as expired, t.revoked_at is not null as revoked, r.status as run_status
     from crm_agent_tokens t left join agent_runs r on r.id = t.run_id where t.token_hash = $1`,
    [sha256(presented)],
  );
  const t = rows[0];
  if (!t || t.expired || t.revoked) return null;
  if (t.run_id && !LIVE_RUN.includes(t.run_status ?? "")) {
    await db.query("update crm_agent_tokens set revoked_at = now() where id = $1 and revoked_at is null", [t.id]);
    return null;
  }
  await db.query("update crm_agent_tokens set last_used_at = now(), use_count = use_count + 1 where id = $1", [t.id]);
  return { tokenId: t.id, orgId: t.org_id, agentInstanceId: t.agent_instance_id, runId: t.run_id, scopes: t.scopes.filter((s) => (AGENT_TOOL_SCOPES as readonly string[]).includes(s)) };
}

/** Ends every token of a run. Call it wherever a run finishes, fails, times out or is cancelled. */
export async function revokeAgentToolTokensForRun(db: Queryable, runId: string): Promise<number> {
  const res = await db.query("update crm_agent_tokens set revoked_at = now() where run_id = $1 and revoked_at is null", [runId]);
  return res.rowCount ?? 0;
}

/** Revokes tokens whose run is no longer queued or running, and forgets nothing else. Safe to run on any schedule. */
export async function revokeEndedRunTokens(db: Queryable): Promise<number> {
  const res = await db.query(
    `update crm_agent_tokens t set revoked_at = now() from agent_runs r
     where r.id = t.run_id and t.revoked_at is null and t.expires_at > now() and r.status not in ('queued', 'running')`,
  );
  return res.rowCount ?? 0;
}

/**
 * A person's emergency control: ends every live tool token of one AI employee in their workspace at once. Any call in flight with
 * one of them is refused from the next request on. Needs the pause permission (owners and managers).
 */
export async function revokeAgentToolAccess(actor: CrmActor, agentInstanceId: string): Promise<{ revoked: number }> {
  assertCan(actor, "automation.pause", "Only owners and managers can stop an AI employee's tool access.");
  return withSystem(async (db) => {
    const agent = await db.query<{ display_name: string }>("select display_name from agent_instances where id = $1 and org_id = $2", [agentInstanceId, actor.orgId]);
    if (!agent.rows[0]) throw new AppError("not_found", "AI employee not found.");
    const res = await db.query(
      "update crm_agent_tokens set revoked_at = now() where org_id = $1 and agent_instance_id = $2 and revoked_at is null and expires_at > now()",
      [actor.orgId, agentInstanceId],
    );
    const revoked = res.rowCount ?? 0;
    await recordAudit({
      orgId: actor.orgId, ...auditActor(actor), agentInstanceId, action: "crm.agent_tool_access_revoked", targetType: "agent_instance", targetId: agentInstanceId, result: "success",
      metadata: { revoked },
    }, db);
    return { revoked };
  });
}

/** Live (unexpired, unrevoked, run still going) token counts per employee, for the settings screen. Never returns hashes. */
export async function liveTokenCounts(db: Queryable, orgId: string): Promise<Map<string, number>> {
  const { rows } = await db.query<{ agent_instance_id: string; n: string }>(
    `select t.agent_instance_id, count(*)::text as n from crm_agent_tokens t left join agent_runs r on r.id = t.run_id
     where t.org_id = $1 and t.revoked_at is null and t.expires_at > now() and (t.run_id is null or r.status in ('queued', 'running'))
     group by t.agent_instance_id`,
    [orgId],
  );
  return new Map(rows.map((r) => [r.agent_instance_id, Number(r.n)]));
}
