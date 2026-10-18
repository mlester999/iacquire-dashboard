import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError, toPublicError, type ErrorCode } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { sha256 } from "@/server/security/crypto";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { automationGate, type GateDecision } from "@/server/automation/gate";
import { createApproval } from "@/server/approvals/service";
import { agentActor, type CrmActor } from "@/server/crm/actor";
import { recordActivity } from "@/server/crm/events";
import {
  AGENT_TOOLS, SCOPE_INFO, TOOL_INPUTS, effectiveScopes, isAgentToolName, permissionsForScopes, toolManifest, type AgentToolDef, type AgentToolName, type AgentToolScope,
} from "@/server/crm/agent-tools/catalog";
import { HANDLERS, type ToolContext, type ToolOutput, type WritePlan } from "@/server/crm/agent-tools/handlers";
import { verifyAgentToolToken, type VerifiedAgentToken } from "@/server/crm/agent-tools/tokens";

/**
 * One CRM tool call from a client's own AI employee, end to end:
 *
 *   bearer token → hash lookup (not expired, not revoked, run still going) → organization and employee from the token row only →
 *   agent actor whose permissions are the role allowlist ∩ the token's scopes → rate limit → strict input validation →
 *   the employee's mode, read from the database now (paused: refused; approval required: writes become a CRM update approval;
 *   autonomous: writes run, except high-impact ones, which always wait for a person) → the tool → a log entry.
 *
 * Every call is logged: an audit entry (with the employee), a tool_executions row when the token belongs to a run, and for changes
 * the CRM timeline entries the services write themselves.
 */

export type AgentCallStatus = "done" | "draft" | "pending_approval" | "unavailable";

export type AgentToolReply =
  | { ok: true; httpStatus: 200 | 202; status: AgentCallStatus; tool: AgentToolName; result: Record<string, unknown>; approvalId?: string | null; detail?: string }
  | { ok: false; httpStatus: number; code: ErrorCode | "unauthorized"; error: string; retryAfterSeconds?: number; issues?: Array<{ path: string; message: string }> };

export interface AgentToolCall {
  /** The presented bearer secret. */
  token: string | null;
  tool: string;
  /** Read only after the caller is authenticated and within its rate limit. */
  readArgs: () => Promise<unknown>;
  /**
   * The caller's own id for this call (Idempotency-Key). With one, a change already made under it is answered from the log, not repeated.
   * Without one, identical requests in one run share one approval request and a new deal or draft is not duplicated, but a task
   * created straight away is created again if the call is repeated.
   */
  callId?: string | null;
  ipHash?: string | null;
  now?: Date;
}

interface AgentRow {
  id: string;
  role_key: string;
  display_name: string;
  enabled: boolean;
  org_id: string;
  org_name: string;
  org_timezone: string;
  org_kind: string;
}

interface CallScope {
  auth: VerifiedAgentToken;
  agent: AgentRow;
  scopes: AgentToolScope[];
  actor: CrmActor;
}

const CALL_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const OUTCOME_LABELS: Record<string, string> = { done: "done", draft: "draft", pending_approval: "pending_approval", unavailable: "unavailable", refused: "refused", failed: "failed" };

/** JSON with sorted keys, so the same arguments always hash the same. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export const inputHash = (tool: string, input: unknown) => sha256(`${tool}\n${stableStringify(input)}`);

async function loadAgent(db: Queryable, auth: VerifiedAgentToken): Promise<AgentRow | null> {
  const { rows } = await db.query<AgentRow>(
    `select a.id, a.role_key, a.display_name, a.enabled, o.id as org_id, o.name as org_name, o.timezone as org_timezone, o.kind as org_kind
     from agent_instances a join organizations o on o.id = a.org_id where a.id = $1 and a.org_id = $2`,
    [auth.agentInstanceId, auth.orgId],
  );
  return rows[0] ?? null;
}

function scopeFor(auth: VerifiedAgentToken, agent: AgentRow): CallScope {
  const scopes = effectiveScopes(agent.role_key, auth.scopes);
  const actor = agentActor({ id: agent.org_id, name: agent.org_name, timezone: agent.org_timezone }, { id: agent.id, displayName: agent.display_name }, permissionsForScopes(scopes));
  return { auth, agent, scopes, actor };
}

function allowsTool(scope: CallScope, def: AgentToolDef): boolean {
  return scope.scopes.includes(def.scope) && def.permissions.every((p) => scope.actor.can(p));
}

const refuse = (httpStatus: number, code: ErrorCode | "unauthorized", error: string, extra: Partial<Extract<AgentToolReply, { ok: false }>> = {}): AgentToolReply => ({ ok: false, httpStatus, code, error, ...extra });

/**
 * A missing, unknown, expired or revoked credential. Failures are counted per hashed client address, so guessing is slowed down; a valid
 * credential is never affected by someone else's failures.
 */
async function unauthorized(ipHash: string | null | undefined): Promise<AgentToolReply> {
  const rl = await consumeRateLimit(RATE_LIMITS.agentToolAuthFailureByIp, ipHash || "unknown");
  if (!rl.allowed) return refuse(429, "rate_limited", "Too many requests with an invalid tool credential. Wait and try again.", { retryAfterSeconds: rl.retryAfterSeconds });
  return refuse(401, "unauthorized", "The tool credential is missing, expired or revoked.");
}

/** The audit entry (always) and the run's tool_executions row (when the token belongs to a run), in the caller's transaction. */
async function logCall(
  db: Queryable,
  s: CallScope,
  e: { tool: string; outcome: string; result: "success" | "denied" | "failure"; detail?: string; targetType?: string; targetId?: string; approvalId?: string | null; callRef?: string; startedAt: number; ipHash?: string | null; approved?: boolean },
) {
  const durationMs = Math.max(0, Date.now() - e.startedAt);
  if (s.auth.runId) {
    const label = `${AGENT_TOOLS[e.tool as AgentToolName]?.label ?? e.tool}${e.outcome === "pending_approval" ? " (waiting for approval)" : e.approved ? " (approved)" : e.outcome === "refused" ? " (refused)" : ""}`.slice(0, 120);
    await db.query(
      `insert into tool_executions (run_id, org_id, tool_name, label, status, duration_ms, finished_at)
       select $1, $2, $3, $4, $5, $6, now() where exists (select 1 from agent_runs where id = $1 and org_id = $2)`,
      [s.auth.runId, s.agent.org_id, `crm.${e.tool}`.slice(0, 120), label, e.result === "success" ? "completed" : "failed", durationMs],
    );
  }
  await recordAudit({
    orgId: s.agent.org_id, actorKind: "agent", agentInstanceId: s.agent.id, action: `crm.agent_tool.${/^[a-z_]+$/.test(e.tool) ? e.tool : "unknown"}`,
    targetType: e.targetType, targetId: e.targetId?.slice(0, 120), result: e.result, approvalId: e.approvalId ?? null, ipHash: e.ipHash ?? null,
    metadata: { tool: e.tool.slice(0, 60), outcome: OUTCOME_LABELS[e.outcome] ?? "failed", detail: e.detail?.slice(0, 200), runId: s.auth.runId, accessId: s.auth.tokenId, callRef: e.callRef, durationMs, approved: e.approved || undefined },
  }, db);
}

async function safeLog(s: CallScope, e: Parameters<typeof logCall>[2]) {
  try {
    await withSystem((db) => logCall(db, s, e));
  } catch (err) {
    if (process.env.NODE_ENV !== "test") console.error("[iacquire] agent tool log failed", { type: err instanceof Error ? err.name : "unknown" });
  }
}

const publicIssues = (err: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
  err.issues.slice(0, 10).map((i) => ({ path: i.path.map(String).join(".").slice(0, 80) || "(arguments)", message: i.message.slice(0, 200) }));

function gateRefusal(gate: Extract<GateDecision, { decision: "blocked" }>): AgentToolReply {
  return refuse(403, "forbidden", `${gate.detail} Nothing was done.`);
}

/** A tool call already carried out with the same explicit Idempotency-Key in this run is answered from the log, not repeated. */
async function priorSuccess(db: Queryable, s: CallScope, tool: string, callRef: string) {
  const { rows } = await db.query<{ target_type: string | null; target_id: string | null; approval_id: string | null; outcome: string | null }>(
    `select target_type, target_id, approval_id, metadata->>'outcome' as outcome from audit_logs
     where org_id = $1 and agent_instance_id = $2 and action = $3 and result = 'success' and metadata->>'callRef' = $4 and metadata->>'accessId' = $5
       and created_at > now() - interval '24 hours' order by id desc limit 1`,
    [s.agent.org_id, s.agent.id, `crm.agent_tool.${tool}`, callRef, s.auth.tokenId],
  );
  return rows[0] ?? null;
}

interface CallApproval {
  id: string;
  status: string;
  executionStatus: string;
  expired: boolean;
  created: boolean;
}

/** A repeated request whose approval was already decided (or ran out): what to tell the employee instead of "pending". */
function settledApproval(a: CallApproval): { status: Exclude<AgentCallStatus, "draft" | "pending_approval">; detail: string } | null {
  if (a.status === "pending" && !a.expired) return null;
  if (a.status === "approved") {
    if (a.executionStatus === "succeeded") return { status: "done", detail: "A person already approved this exact request and it was carried out. It was not repeated." };
    if (a.executionStatus === "queued" || a.executionStatus === "running") return { status: "unavailable", detail: "A person approved this exact request and it is being carried out now. It was not repeated." };
    return { status: "unavailable", detail: "A person approved this exact request, but it couldn't be carried out. It was not repeated; a person can see why in the Approval Center." };
  }
  if (a.status === "rejected") return { status: "unavailable", detail: "A person declined this exact request. Nothing was changed; don't ask again without new information." };
  if (a.status === "changes_requested") return { status: "unavailable", detail: "A person asked for changes to this request. Nothing was changed; make a new request with different details if it still applies." };
  return { status: "unavailable", detail: "This exact request expired or was withdrawn before anyone approved it. Nothing was changed." };
}

/**
 * One approval request per run (or token), tool, arguments and call. The tool and the arguments' hash are part of the key, so a call id
 * the employee reuses for another tool (or other arguments) is a different request, never bound to an earlier tool's approval.
 */
const approvalKey = (s: CallScope, tool: AgentToolName, input: Record<string, unknown>, callRef: string) =>
  `agent-tool:${s.auth.runId ?? s.auth.tokenId}:${tool}:${inputHash(tool, input).slice(0, 16)}:${callRef}`;

/** The approval request already recorded for this exact call (same tool and arguments), if any. */
async function findCallApproval(db: Queryable, s: CallScope, tool: AgentToolName, input: Record<string, unknown>, callRef: string): Promise<CallApproval | null> {
  const { rows } = await db.query<{ id: string; status: string; execution_status: string; expired: boolean; tool: string | null }>(
    "select id, status, execution_status, (expires_at is not null and expires_at <= now()) as expired, action->>'tool' as tool from approval_requests where idempotency_key = $1 and org_id = $2",
    [approvalKey(s, tool, input, callRef), s.agent.org_id],
  );
  const e = rows[0];
  if (!e || e.tool !== tool) return null;
  return { id: e.id, status: e.status, executionStatus: e.execution_status, expired: e.expired, created: false };
}

/** Records a CRM update approval for a write the employee may not (or may never) make on its own. Idempotent per run, tool, arguments and call. */
async function requestApprovalForCall(db: Queryable, s: CallScope, tool: AgentToolName, input: Record<string, unknown>, plan: WritePlan, callRef: string): Promise<CallApproval> {
  const key = approvalKey(s, tool, input, callRef);
  const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : `${s.agent.display_name} asked to ${plan.summary}.`;
  const why = plan.highImpact ? ` This always needs a person: ${plan.highImpact.charAt(0).toLowerCase()}${plan.highImpact.slice(1)}` : "";
  const id = await createApproval(db, {
    orgId: s.agent.org_id, agentId: s.agent.id, kind: "crm_update", title: `${s.agent.display_name}: ${plan.summary}`.slice(0, 200),
    action: { source: "agent_tool", v: 1, tool, input, inputHash: inputHash(tool, input), runId: s.auth.runId, accessId: s.auth.tokenId, callRef, scopes: s.scopes },
    targetType: plan.targetType, targetId: plan.targetId.slice(0, 120), targetLabel: plan.targetLabel.slice(0, 200),
    reason: `${reason}${why}`.slice(0, 2000), expectedEffect: `${plan.expectedEffect} Nothing changes unless this is approved.`.slice(0, 2000),
    risk: plan.highImpact ? "high" : "medium", expiresInHours: 72, idempotencyKey: key, actorKind: "agent",
  });
  if (!id) {
    const existing = await findCallApproval(db, s, tool, input, callRef);
    if (!existing) throw new AppError("conflict", "The approval couldn't be recorded. Try again.");
    return existing;
  }
  await notifyOrgRoles(db, s.agent.org_id, ["owner", "admin"], {
    kind: "approval_requested", severity: plan.highImpact ? "warning" : "info", title: `${s.agent.display_name} asks to ${plan.summary}`.slice(0, 200),
    body: "Review it in the Approval Center.", link: "/approvals", dedupeKey: `agent-tool-approval:${id}`,
  });
  if (plan.contactId || plan.opportunityId) {
    await recordActivity(db, s.actor, {
      kind: "agent.approval_requested", summary: `${s.agent.display_name} asked for approval to ${plan.summary}`.slice(0, 300), contactId: plan.contactId, opportunityId: plan.opportunityId,
      refType: "approval", refId: id,
    });
  }
  return { id, status: "pending", executionStatus: "not_started", expired: false, created: true };
}

/** Runs the tool: inside one transaction with a fresh mode check for in-transaction writes, or through the CRM service's own transaction. */
async function execute(s: CallScope, def: AgentToolDef, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const handler = HANDLERS[def.name] as { inTx: boolean; run: (c: ToolContext, i: unknown, db: Queryable | null) => Promise<ToolOutput> };
  const recheck = async (db: Queryable) => {
    if (def.kind !== "write") return;
    // The mode is read again right before the change: a pause or mode change since the first check wins.
    const gate = await automationGate(db, { orgId: s.agent.org_id, agentId: s.agent.id, scope: "job", approvalId: ctx.approvalId });
    if (gate.decision !== "allow") throw new AppError("conflict", gate.decision === "blocked" ? gate.detail : "This AI employee now needs approval for changes. Try the call again.");
  };
  if (handler.inTx) {
    return withSystem(async (db) => {
      await recheck(db);
      return handler.run(ctx, input, db);
    });
  }
  await withSystem(recheck);
  return handler.run(ctx, input, null);
}

export interface AgentToolCatalogReply {
  ok: true;
  httpStatus: 200;
  tools: ReturnType<typeof toolManifest>;
  agent: { name: string; role: string };
  scopes: Array<{ scope: AgentToolScope; label: string }>;
}

/** Lists the tools this token can call, with argument schemas. Authenticated like a call. */
export async function describeAgentTools(token: string | null, opts: { ipHash?: string | null } = {}): Promise<AgentToolReply | AgentToolCatalogReply> {
  const auth = await withSystem((db) => verifyAgentToolToken(db, token));
  if (!auth) return unauthorized(opts.ipHash);
  const agent = await withSystem((db) => loadAgent(db, auth));
  if (!agent || agent.org_kind !== "client" || !agent.enabled) return refuse(403, "forbidden", "This AI employee can't use CRM tools.");
  const limit = await consumeRateLimit(RATE_LIMITS.agentToolCallsByEmployee, agent.id);
  if (!limit.allowed) return refuse(429, "rate_limited", "Too many CRM tool calls from this AI employee. Wait a moment and try again.", { retryAfterSeconds: limit.retryAfterSeconds });
  const s = scopeFor(auth, agent);
  const names = (Object.keys(AGENT_TOOLS) as AgentToolName[]).filter((n) => allowsTool(s, AGENT_TOOLS[n]));
  return { ok: true, httpStatus: 200, tools: toolManifest(names), agent: { name: agent.display_name, role: agent.role_key }, scopes: s.scopes.map((x) => ({ scope: x, label: SCOPE_INFO[x].label })) };
}

export async function callAgentTool(call: AgentToolCall): Promise<AgentToolReply> {
  const startedAt = Date.now();
  const now = call.now ?? new Date();
  const auth = await withSystem((db) => verifyAgentToolToken(db, call.token));
  if (!auth) return unauthorized(call.ipHash);
  const agent = await withSystem((db) => loadAgent(db, auth));
  if (!agent || agent.org_kind !== "client") return unauthorized(call.ipHash);
  const s = scopeFor(auth, agent);
  const toolName = call.tool.slice(0, 60);
  const known = isAgentToolName(toolName);
  const base = { tool: known ? toolName : "unknown", startedAt, ipHash: call.ipHash };

  // Counted before anything else is looked at, so a stream of refused or unknown calls is bounded (and so is its log).
  const limit = await consumeRateLimit(RATE_LIMITS.agentToolCallsByEmployee, agent.id);
  if (!limit.allowed) {
    await safeLog(s, { ...base, outcome: "refused", result: "denied", detail: "Rate limited" });
    return refuse(429, "rate_limited", "Too many CRM tool calls from this AI employee. Wait a moment and try again.", { retryAfterSeconds: limit.retryAfterSeconds });
  }

  if (!known) {
    await safeLog(s, { ...base, outcome: "refused", result: "denied", detail: `Unknown tool ${toolName.replace(/[^a-z_]/gi, "").slice(0, 40)}` });
    return refuse(404, "not_found", "There is no CRM tool with that name.");
  }
  const def = AGENT_TOOLS[toolName];
  if (!agent.enabled) {
    await safeLog(s, { ...base, outcome: "refused", result: "denied", detail: "Employee not included in the workspace" });
    return refuse(403, "forbidden", "This AI employee is not included in the workspace.");
  }
  if (!allowsTool(s, def)) {
    await safeLog(s, { ...base, outcome: "refused", result: "denied", detail: "Not allowed for this role or credential" });
    return refuse(403, "forbidden", `${agent.display_name} isn't allowed to use ${def.label.toLowerCase()} with this credential.`);
  }

  let raw: unknown;
  try {
    raw = await call.readArgs();
  } catch (err) {
    const e = toPublicError(err);
    const message = e.status === 500 ? "The arguments couldn't be read as JSON." : e.message;
    await safeLog(s, { ...base, outcome: "refused", result: "denied", detail: message });
    return refuse(e.status === 500 ? 400 : e.status, "invalid_input", message);
  }
  const parsed = TOOL_INPUTS[toolName].safeParse(raw ?? {});
  if (!parsed.success) {
    await safeLog(s, { ...base, outcome: "refused", result: "denied", detail: "Invalid arguments" });
    return refuse(400, "invalid_input", "Some arguments are missing or invalid. Nothing was changed.", { issues: publicIssues(parsed.error) });
  }
  const input = parsed.data as Record<string, unknown>;
  const explicitCallId = call.callId && CALL_ID_RE.test(call.callId) ? call.callId : null;
  const callRef = explicitCallId ?? inputHash(toolName, input).slice(0, 32);
  const ctx: ToolContext = { actor: s.actor, agent: { id: agent.id, roleKey: agent.role_key, displayName: agent.display_name }, runId: auth.runId, approvalId: null, callKey: `${auth.runId ?? auth.tokenId}:${callRef}`, now };

  try {
    const gate = await withSystem((db) => automationGate(db, { orgId: agent.org_id, agentId: agent.id, scope: "job" }));
    if (gate.decision === "blocked") {
      await safeLog(s, { ...base, outcome: "refused", result: "denied", detail: gate.detail, callRef });
      return gateRefusal(gate);
    }

    if (def.kind !== "read" && explicitCallId) {
      const prior = await withSystem((db) => priorSuccess(db, s, toolName, callRef));
      // A write that only became an approval request is answered below from that request's current state, not from the old log line.
      if (prior && !(def.kind === "write" && prior.approval_id)) {
        const status = (prior.outcome === "pending_approval" || prior.outcome === "draft" || prior.outcome === "unavailable" ? prior.outcome : "done") as AgentCallStatus;
        return { ok: true, httpStatus: status === "pending_approval" ? 202 : 200, status, tool: toolName, approvalId: prior.approval_id, result: { replayed: true, targetType: prior.target_type, targetId: prior.target_id }, detail: "This call was already handled; it was not repeated." };
      }
    }

    if (def.kind === "write") {
      const handler = HANDLERS[toolName] as unknown as { plan: (db: Queryable, c: ToolContext, i: unknown) => Promise<WritePlan> };
      const plan = await withSystem((db) => handler.plan(db, ctx, input));
      // Once this exact call became an approval request, it is only ever carried out through that request: an employee switched to
      // autonomous since, repeating the call, must not do it a second time beside the approval.
      const asked = await withSystem((db) => findCallApproval(db, s, toolName, input, callRef));
      if (asked || gate.decision !== "allow" || plan.highImpact || def.alwaysApproval) {
        const approval = await withSystem(async (db) => {
          const a = await requestApprovalForCall(db, s, toolName, input, plan, callRef);
          const settled = settledApproval(a);
          await logCall(db, s, {
            ...base, outcome: settled ? settled.status : "pending_approval", result: "success", detail: settled ? settled.detail : plan.summary, targetType: plan.targetType, targetId: plan.targetId,
            approvalId: a.id, callRef,
          });
          return { ...a, settled };
        });
        if (approval.settled) {
          // The same request (same run, same call) was already decided: say what happened instead of pretending it is still waiting.
          return { ok: true, httpStatus: 200, status: approval.settled.status, tool: toolName, approvalId: approval.id, result: { approvalId: approval.id, approvalStatus: approval.status, executionStatus: approval.executionStatus }, detail: approval.settled.detail };
        }
        return {
          ok: true, httpStatus: 202, status: "pending_approval", tool: toolName, approvalId: approval.id, result: { approvalId: approval.id, approvalStatus: approval.status },
          detail: "A person must approve this in the Approval Center before it happens. Nothing has changed yet.",
        };
      }
    }

    const out = await execute(s, def, input, ctx);
    await safeLog(s, { ...base, outcome: out.outcome, result: "success", detail: out.summary, targetType: out.targetType, targetId: out.targetId, approvalId: out.approvalId ?? null, callRef });
    return {
      ok: true, httpStatus: out.outcome === "pending_approval" ? 202 : 200, status: out.outcome, tool: toolName, result: out.result, approvalId: out.approvalId ?? undefined,
      detail: out.outcome === "pending_approval" ? "A person must approve this before it happens." : undefined,
    };
  } catch (err) {
    const e = toPublicError(err);
    const denied = e.code === "forbidden" || e.code === "not_found" || e.code === "invalid_input";
    await safeLog(s, { ...base, outcome: denied ? "refused" : "failed", result: denied ? "denied" : "failure", detail: e.message, callRef });
    return refuse(e.status, e.code, e.message);
  }
}

// ---------------------------------------------------------------------------
// Approved calls (the crm_update executor in the Approval Center)
// ---------------------------------------------------------------------------

export type ApprovedCallOutcome = { status: "succeeded" | "failed" | "blocked"; detail: string };

/** Whether a crm_update approval was requested through the agent tools (and so has an executor here). */
export const isAgentToolApproval = (action: Record<string, unknown>) => action.source === "agent_tool";

/**
 * Carries out a CRM change a person approved. The approval service has already claimed it exactly once. Everything is checked again
 * now, against current state: the arguments (and that they are the ones the person saw), the employee and its role, its mode and every
 * pause (the approval satisfies "approval required" but never overrides a pause), and the records themselves.
 */
export async function executeApprovedAgentToolCall(input: { orgId: string; approvalId: string; agentInstanceId: string | null; action: Record<string, unknown> }): Promise<ApprovedCallOutcome> {
  const startedAt = Date.now();
  const a = input.action;
  const tool = typeof a.tool === "string" ? a.tool : "";
  if (!isAgentToolName(tool) || AGENT_TOOLS[tool].kind !== "write") return { status: "failed", detail: "This request names a tool that can't be run. Nothing was changed." };
  const parsed = TOOL_INPUTS[tool].safeParse(a.input);
  if (!parsed.success || typeof a.inputHash !== "string" || inputHash(tool, parsed.data) !== a.inputHash) {
    return { status: "failed", detail: "The request's details are no longer valid, so it was not run. Nothing was changed." };
  }
  if (!input.agentInstanceId) return { status: "failed", detail: "The AI employee that asked for this no longer exists. Nothing was changed." };
  const agentId = input.agentInstanceId;
  const runId = typeof a.runId === "string" ? a.runId : null;
  const accessId = typeof a.accessId === "string" ? a.accessId : "approval";
  const scopes = Array.isArray(a.scopes) ? a.scopes.filter((x): x is string => typeof x === "string") : [];
  const agent = await withSystem((db) => loadAgent(db, { tokenId: accessId, orgId: input.orgId, agentInstanceId: agentId, runId, scopes }));
  if (!agent || agent.org_kind !== "client") return { status: "failed", detail: "The AI employee that asked for this no longer exists. Nothing was changed." };
  const s = scopeFor({ tokenId: accessId, orgId: input.orgId, agentInstanceId: agent.id, runId, scopes }, agent);
  const def = AGENT_TOOLS[tool];
  if (!agent.enabled || !allowsTool(s, def)) return { status: "blocked", detail: `${agent.display_name} is no longer allowed to ${def.label.toLowerCase()}, so nothing was changed.` };
  const callRef = typeof a.callRef === "string" ? a.callRef.slice(0, 100) : input.approvalId;
  const base = { tool, startedAt, approvalId: input.approvalId, callRef, approved: true };

  const gate = await withSystem((db) => automationGate(db, { orgId: input.orgId, agentId: agent.id, scope: "job", approvalId: input.approvalId }));
  if (gate.decision !== "allow") {
    const detail = gate.decision === "blocked" ? `Approved, but not run: ${gate.detail}` : "Approved, but the approval no longer covers this change. Nothing was changed.";
    await safeLog(s, { ...base, outcome: "refused", result: "denied", detail });
    return { status: "blocked", detail };
  }
  const ctx: ToolContext = { actor: s.actor, agent: { id: agent.id, roleKey: agent.role_key, displayName: agent.display_name }, runId, approvalId: input.approvalId, callKey: `approval:${input.approvalId}`, now: new Date() };
  try {
    const handler = HANDLERS[tool] as unknown as { plan: (db: Queryable, c: ToolContext, i: unknown) => Promise<WritePlan> };
    // The records are checked again: a contact deleted or a deal closed since the request means the change no longer applies.
    await withSystem((db) => handler.plan(db, ctx, parsed.data));
    const out = await execute(s, def, parsed.data as Record<string, unknown>, ctx);
    await safeLog(s, { ...base, outcome: "done", result: "success", detail: out.summary, targetType: out.targetType, targetId: out.targetId });
    return { status: "succeeded", detail: `Done: ${out.summary}.` };
  } catch (err) {
    const e = toPublicError(err);
    await safeLog(s, { ...base, outcome: "failed", result: "failure", detail: e.message });
    return { status: e.code === "conflict" || e.code === "forbidden" ? "blocked" : "failed", detail: `Approved, but it couldn't be done: ${e.message}` };
  }
}
