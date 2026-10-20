import "server-only";
import { z } from "zod";
import { readSystem, withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { logSafeServerDiagnostic } from "@/server/diagnostics";
import { createOpsRun, type OpsRun } from "@/server/aqi/ops/executor";
import { findActionTool } from "@/server/aqi/ops/registry";
import { resolveOpsScope } from "@/server/aqi/ops/scope";
import { neutralizeUntrusted } from "@/server/aqi/ops/redact";
import type { OpsActionPreview, OpsActionTool } from "@/server/aqi/ops/tool";
import type { PlannedAction } from "@/server/aqi/ops/planner";
import type { OpsActionPreviewCard, OpsActionResultCard, OpsCard, OpsNoticeCard, OpsScope, OpsScopeType } from "@/lib/aqi/ops/types";
import type { SessionUser } from "@/server/auth/service";

/**
 * Propose -> preview -> confirm -> execute -> verify.
 *
 * A chat turn can create a proposal; it can never execute one. Confirmation is a separate,
 * authenticated, same-origin request from the administrator who asked, and it re-validates the
 * role, the scope, the arguments and the target's current state before anything changes. The
 * result is reported as "succeeded" only after a read-back confirms the intended end state.
 */

const STUCK_AFTER_MS = 2 * 60_000;

interface ActionRow {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  requested_by: string;
  tool_id: string;
  org_id: string | null;
  scope_type: OpsScopeType;
  scope_id: string | null;
  risk: "low" | "medium" | "high" | "critical";
  approval: "confirm" | "confirm_with_reason" | "typed_confirmation";
  status: OpsActionPreviewCard["status"];
  args: Record<string, unknown>;
  preview: OpsActionPreview & { title?: string };
  reason: string | null;
  result: Record<string, unknown>;
  verified: boolean | null;
  verification: { observed?: string[] };
  error_code: string | null;
  error_message: string | null;
  executed_at: Date | null;
  expires_at: Date;
  created_at: Date;
}

const COLUMNS = `id, conversation_id, message_id, requested_by, tool_id, org_id, scope_type, scope_id, risk, approval, status, args, preview, reason,
  result, verified, verification, error_code, error_message, executed_at, expires_at, created_at`;

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const iso = (d: Date | string) => new Date(d).toISOString();

function previewCard(row: ActionRow, title: string): OpsActionPreviewCard {
  return {
    id: `action-${row.id}`,
    kind: "action_preview",
    title,
    asOf: iso(row.created_at),
    source: "AQi Operations action proposal",
    actionId: row.id,
    toolId: row.tool_id,
    headline: row.preview.headline,
    risk: row.risk,
    approval: row.approval,
    effects: row.preview.effects,
    target: row.preview.target,
    reversible: row.preview.reversible,
    ...(row.approval === "typed_confirmation" && row.preview.confirmPhrase ? { confirmPhrase: row.preview.confirmPhrase } : {}),
    expiresAt: iso(row.expires_at),
    status: row.status,
  };
}

function resultCard(row: ActionRow, title: string): OpsActionResultCard | null {
  if (row.status !== "succeeded" && row.status !== "verification_failed" && row.status !== "failed") return null;
  const observed = row.status === "failed"
    ? [row.error_message ?? "The action did not complete."]
    : (row.verification.observed ?? []);
  const ticketId = typeof row.result.ticketId === "string" ? row.result.ticketId : null;
  return {
    id: `result-${row.id}`,
    kind: "action_result",
    title,
    asOf: iso(row.executed_at ?? row.created_at),
    source: "Re-read from the system after the action ran",
    actionId: row.id,
    status: row.status,
    headline: row.status === "succeeded"
      ? `Done and verified: ${row.preview.headline}`
      : row.status === "verification_failed"
        ? `The action ran, but the expected end state was not confirmed: ${row.preview.headline}`
        : `Not completed: ${row.preview.headline}`,
    observed,
    ...(ticketId ? { link: { label: "Open the request", href: `/admin/support/${ticketId}` } } : {}),
  };
}

function notice(title: string, body: string, tone: OpsNoticeCard["tone"] = "warning"): OpsNoticeCard {
  return { id: crypto.randomUUID().slice(0, 8), kind: "notice", title, asOf: new Date().toISOString(), source: "AQi Operations", tone, body };
}

export interface ProposeInput {
  run: OpsRun;
  scope: OpsScope;
  conversationId: string;
  messageId: string;
  action: PlannedAction;
}

/** Creates a proposal and returns the preview card, or a notice card explaining why nothing was proposed. Never executes. */
export async function proposeOpsAction(input: ProposeInput): Promise<OpsCard> {
  const { run, scope, action } = input;
  const tool = findActionTool(action.toolId);
  const user = run.ctx.user;
  if (!tool || !(tool.roles as readonly string[]).includes(user.platformRole)) return notice("Action not available", "That action is not available to your role.");
  if (tool.permission && !run.ctx.permissions.has(tool.permission)) return notice("Action not available", "Your permissions don't include that action.");
  if (!tool.scopes.includes(scope.type)) return notice("Choose a different context", "That action doesn't apply to the selected context.");
  const parsed = tool.input.safeParse(action.args);
  if (!parsed.success) return notice("Action not prepared", "The details for that action were not valid. Rephrase the request and try again.");
  let preview: OpsActionPreview;
  try {
    preview = await tool.preview(run.ctx, parsed.data);
  } catch (err) {
    if (err instanceof AppError) return notice("Nothing to change", err.message, err.code === "forbidden" ? "danger" : "warning");
    logSafeServerDiagnostic("aqi.ops_preview_failed", err, `aqi.ops.preview.${tool.id}`);
    return notice("Action not prepared", "AQi could not check the current state, so no change was prepared.", "danger");
  }
  const key = `propose:${input.messageId}:${tool.id}`;
  const { rows } = await withSystem((db) => db.query<ActionRow>(
    `insert into aqi_ops_actions (conversation_id, message_id, requested_by, tool_id, org_id, scope_type, scope_id, risk, approval, args, preview, idempotency_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
     on conflict (requested_by, idempotency_key) do update set updated_at = now()
     returning ${COLUMNS}`,
    [input.conversationId, input.messageId, user.id, tool.id, preview.orgId, scope.type, scope.id, tool.risk, tool.approval, JSON.stringify(parsed.data), JSON.stringify(preview), key],
  ));
  run.record({
    action: "aqi.ops_action_proposed", result: "success", orgId: preview.orgId, targetType: "aqi_ops_action", targetId: rows[0].id,
    metadata: { tool: tool.id, risk: tool.risk, approval: tool.approval, requestId: run.ctx.requestId },
  });
  return previewCard(rows[0], tool.title);
}

export const confirmSchema = z.object({
  phrase: z.string().trim().max(120).optional(),
  reason: z.string().trim().max(500).optional(),
}).strict();

export interface ActionOutcome {
  status: OpsActionPreviewCard["status"];
  cards: OpsCard[];
}

async function loadOwned(userId: string, actionId: string): Promise<ActionRow> {
  const { rows } = await readSystem((db) => db.query<ActionRow>(`select ${COLUMNS} from aqi_ops_actions where id = $1 and requested_by = $2`, [actionId, userId]));
  if (!rows[0]) throw new AppError("not_found", "That action was not found.");
  return rows[0];
}

function outcomeFor(row: ActionRow, tool: OpsActionTool | null): ActionOutcome {
  const title = tool?.title ?? "Action";
  const cards: OpsCard[] = [previewCard(row, title)];
  const result = resultCard(row, title);
  if (result) cards.push(result);
  return { status: row.status, cards };
}

/** Marks an abandoned `executing` row by checking the real state, never by running the action again. */
async function reconcileStuck(user: SessionUser, row: ActionRow, tool: OpsActionTool): Promise<ActionRow> {
  if (row.status !== "executing" || !row.executed_at || Date.now() - new Date(row.executed_at).getTime() < STUCK_AFTER_MS) return row;
  const scope = await resolveOpsScope(user, { type: row.scope_type, id: row.scope_id });
  const run = await createOpsRun({ user, scope, signal: new AbortController().signal, plannedToolIds: [tool.id] });
  let verified = false;
  let observed: string[] = ["The action's outcome could not be read back."];
  try {
    const v = await tool.verify(run.ctx, row.args as never, row.result);
    verified = v.verified;
    observed = v.observed;
  } catch (err) {
    logSafeServerDiagnostic("aqi.ops_reconcile_failed", err, `aqi.ops.reconcile.${tool.id}`);
  }
  const { rows } = await withSystem((db) => db.query<ActionRow>(
    `update aqi_ops_actions set status = $2, verified = $3, verification = $4::jsonb, finished_at = now(),
       error_code = case when $3 then null else 'interrupted' end, error_message = case when $3 then null else 'The request was interrupted before the result was recorded.' end
     where id = $1 and status = 'executing' returning ${COLUMNS}`,
    [row.id, verified ? "succeeded" : "verification_failed", verified, JSON.stringify({ observed })],
  ));
  return rows[0] ?? row;
}

export async function confirmOpsAction(user: SessionUser, actionId: string, rawInput: unknown): Promise<ActionOutcome> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "AQi Operations actions are available to Super Admins only.");
  const input = confirmSchema.safeParse(rawInput ?? {});
  if (!input.success) throw new AppError("invalid_input", "Check the confirmation details and try again.");
  const limit = await consumeRateLimit(RATE_LIMITS.aqiOpsActionByUser, user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "You're confirming actions very quickly. Please wait a moment.", { retryAfterSeconds: limit.retryAfterSeconds });

  let row = await loadOwned(user.id, actionId);
  const tool = findActionTool(row.tool_id);
  if (!tool) throw new AppError("not_found", "That action is no longer available.");

  // Idempotent: a repeat confirmation reports what already happened and never runs the action again.
  if (row.status !== "proposed") {
    row = await reconcileStuck(user, row, tool);
    return outcomeFor(row, tool);
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await withSystem((db) => db.query("update aqi_ops_actions set status = 'expired' where id = $1 and status = 'proposed'", [actionId]));
    throw new AppError("conflict", "This proposal expired. Ask AQi to prepare it again so you review the current state.");
  }

  const reason = (input.data.reason ?? "").trim();
  if (row.approval !== "confirm" && reason.length < 8) throw new AppError("invalid_input", "Give a short reason (at least 8 characters) for the record.");
  if (row.approval === "typed_confirmation") {
    const expected = row.preview.confirmPhrase ?? "";
    if (!expected || norm(input.data.phrase ?? "") !== norm(expected)) throw new AppError("invalid_input", `Type “${expected}” exactly to confirm.`);
  }

  // Re-validate everything against the present state before claiming the row.
  const scope = await resolveOpsScope(user, { type: row.scope_type, id: row.scope_id });
  const run = await createOpsRun({ user, scope, signal: new AbortController().signal, plannedToolIds: [tool.id] });
  if (tool.permission && !run.ctx.permissions.has(tool.permission)) throw new AppError("forbidden", "Your permissions no longer include this action.");
  const args = tool.input.parse(row.args);
  await tool.preview(run.ctx, args);

  const claimed = await withSystem((db) => db.query<ActionRow>(
    `update aqi_ops_actions set status = 'executing', confirmed_at = now(), confirmed_by = $2, reason = $3, executed_at = now()
     where id = $1 and status = 'proposed' and expires_at > now() returning ${COLUMNS}`,
    [actionId, user.id, reason || null],
  ));
  if (!claimed.rows[0]) return outcomeFor(await loadOwned(user.id, actionId), tool);
  row = claimed.rows[0];
  run.record({ action: "aqi.ops_action_confirmed", result: "success", orgId: row.org_id, targetType: "aqi_ops_action", targetId: row.id, metadata: { tool: tool.id, risk: row.risk, approval: row.approval, requestId: run.ctx.requestId } });

  let status: ActionRow["status"] = "failed";
  let executed: Record<string, unknown> = {};
  let verification: { verified: boolean; observed: string[] } = { verified: false, observed: [] };
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  try {
    executed = await tool.execute(run.ctx, args, { actionId: row.id, reason: reason || null });
    try {
      verification = await tool.verify(run.ctx, args, executed);
      status = verification.verified ? "succeeded" : "verification_failed";
    } catch (err) {
      logSafeServerDiagnostic("aqi.ops_verify_failed", err, `aqi.ops.verify.${tool.id}`);
      status = "verification_failed";
      verification = { verified: false, observed: ["The result could not be read back, so success is not confirmed."] };
    }
  } catch (err) {
    errorCode = err instanceof AppError ? err.code : "execution_failed";
    errorMessage = err instanceof AppError ? neutralizeUntrusted(err.message, 300).text : "The action could not be completed. Nothing was reported as changed.";
    if (!(err instanceof AppError)) logSafeServerDiagnostic("aqi.ops_execute_failed", err, `aqi.ops.execute.${tool.id}`);
  }

  const { rows } = await withSystem((db) => db.query<ActionRow>(
    `update aqi_ops_actions set status = $2, result = $3::jsonb, verified = $4, verification = $5::jsonb, error_code = $6, error_message = $7, finished_at = now()
     where id = $1 returning ${COLUMNS}`,
    [row.id, status, JSON.stringify(executed), status === "failed" ? null : verification.verified, JSON.stringify({ observed: verification.observed }), errorCode, errorMessage],
  ));
  run.record({
    action: status === "succeeded" ? "aqi.ops_action_verified" : "aqi.ops_action_failed",
    result: status === "succeeded" ? "success" : "failure", orgId: row.org_id, targetType: "aqi_ops_action", targetId: row.id,
    metadata: { tool: tool.id, status, verified: verification.verified, errorCode, requestId: run.ctx.requestId },
  });
  await run.flushAudit();
  await recordAudit({ orgId: row.org_id, actorUserId: user.id, actorKind: "agency", action: "aqi.ops_action_executed", targetType: "aqi_ops_action", targetId: row.id, result: status === "failed" ? "failure" : "success", metadata: { tool: tool.id, risk: row.risk, status } });
  return outcomeFor(rows[0], tool);
}

export async function cancelOpsAction(user: SessionUser, actionId: string): Promise<ActionOutcome> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "AQi Operations actions are available to Super Admins only.");
  const row = await loadOwned(user.id, actionId);
  const tool = findActionTool(row.tool_id);
  if (row.status !== "proposed") return outcomeFor(row, tool);
  const { rows } = await withSystem((db) => db.query<ActionRow>(
    `update aqi_ops_actions set status = 'cancelled', finished_at = now() where id = $1 and status = 'proposed' returning ${COLUMNS}`, [actionId],
  ));
  await recordAudit({ orgId: row.org_id, actorUserId: user.id, actorKind: "agency", action: "aqi.ops_action_cancelled", targetType: "aqi_ops_action", targetId: row.id, result: "success", metadata: { tool: row.tool_id } });
  return outcomeFor(rows[0] ?? (await loadOwned(user.id, actionId)), tool);
}

export async function getOpsAction(user: SessionUser, actionId: string): Promise<ActionOutcome> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "AQi Operations actions are available to Super Admins only.");
  let row = await loadOwned(user.id, actionId);
  const tool = findActionTool(row.tool_id);
  if (tool) row = await reconcileStuck(user, row, tool);
  if (row.status === "proposed" && new Date(row.expires_at).getTime() <= Date.now()) {
    await withSystem((db) => db.query("update aqi_ops_actions set status = 'expired' where id = $1 and status = 'proposed'", [actionId]));
    row = await loadOwned(user.id, actionId);
  }
  return outcomeFor(row, tool);
}

/** Recent actions for the model's operational memory. Metadata only, never arguments. */
export async function recentOpsActions(userId: string, orgId: string | null, limit = 5): Promise<Array<{ tool: string; status: string; target: string; at: string }>> {
  const { rows } = await readSystem((db) => db.query<{ tool_id: string; status: string; preview: { target?: string }; created_at: Date }>(
    `select tool_id, status, preview, created_at from aqi_ops_actions
      where requested_by = $1 and ($2::uuid is null or org_id = $2) order by created_at desc limit $3`, [userId, orgId, limit],
  ));
  return rows.map((r) => ({ tool: r.tool_id, status: r.status, target: neutralizeUntrusted(r.preview?.target ?? "", 80).text, at: iso(r.created_at) }));
}
