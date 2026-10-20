import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { notifyOrgRoles } from "@/server/notifications";
import { systemActor, type CrmActor } from "@/server/crm/actor";
import type { TriggerConfig, WorkflowStep } from "@/lib/crm/workflow/spec";

/** Shared shapes and small helpers of the workflow engine (dispatcher, runner, executors, run services). */

export type RunStatus = "queued" | "running" | "waiting" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "dead";
export type StartedVia = "event" | "manual" | "schedule" | "webhook" | "test";
export const LIVE_RUN_STATUSES: readonly RunStatus[] = ["queued", "running", "waiting", "awaiting_approval"];

/** What a run remembers between steps (crm_workflow_runs.context, at most 16 KB). */
export interface RunContextData {
  trigger?: { type: string; eventId?: number | null; payload?: Record<string, unknown> };
  appointmentId?: string | null;
  taskId?: string | null;
  conversationId?: string | null;
  /** The step the run is on and how many times this run entered it (1 the first time). */
  visit?: { key: string; n: number };
  visits?: Record<string, number>;
  /** Steps executed so far. */
  executed?: number;
  /** A wait in progress. */
  wait?: { key: string; rowId: number; until: string };
  /** A step waiting for a person's approval. */
  approval?: { key: string; rowId: number; approvalId: string };
  /** An external call that was claimed; if a worker finds it still running, the outcome is unknown and it is never repeated blindly. */
  inflight?: { key: string; rowId: number };
  /** Why a run ended without running (rate_limited, quota_exceeded) or stopped early (loop_limit, step_limit). */
  outcome?: string;
  /** Schedule runs: the slot they are for. */
  slot?: string;
  /** Inbound webhook runs: the (trimmed) body, and the caller's Idempotency-Key when it sent one. */
  inbound?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface RunRow {
  id: string;
  org_id: string;
  workflow_id: string;
  version_id: string;
  trigger_event_id: string | number | null;
  started_via: StartedVia;
  contact_id: string | null;
  opportunity_id: string | null;
  status: RunStatus;
  current_step: string | null;
  next_run_at: Date;
  attempts: number;
  claimed_at: Date | null;
  depth: number;
  context: RunContextData;
  last_error: string | null;
  created_at: Date;
  finished_at: Date | null;
}

export interface VersionRow {
  id: string;
  workflow_id: string;
  version: number;
  trigger_config: TriggerConfig;
  steps: WorkflowStep[];
  effects: string[];
  /** Premium capabilities the version uses (empty: it needs no plan). Frozen with the version. */
  premium_features: string[];
  content_hash: string;
  approval_id: string | null;
  approved_hash: string | null;
  approved_at: Date | null;
  published_at: Date;
}

/** Whether a version belongs to the Automation Studio plan: it is checked against the workspace's plan and limits, and metered. */
export const isPremiumVersion = (v: { premium_features?: readonly string[] | null }) => (v.premium_features?.length ?? 0) > 0;

/** The steps of a stored (possibly unreadable or half-finished) draft, for checks that only need their kinds. Anything unreadable has none. */
export function draftSteps(raw: unknown): { steps: WorkflowStep[] } {
  const steps = raw && typeof raw === "object" ? (raw as { steps?: unknown }).steps : null;
  return { steps: Array.isArray(steps) ? (steps.filter((s) => s && typeof s === "object" && typeof (s as { kind?: unknown }).kind === "string") as WorkflowStep[]) : [] };
}

export interface WorkflowRow {
  id: string;
  org_id: string;
  key: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "paused" | "archived";
  draft: unknown;
  draft_revision: number;
  published_version_id: string | null;
  hourly_run_limit: number;
  folder_id: string | null;
  /** Where it was built: the CRM workflow screens ("crm") or Automation Studio ("studio"). */
  origin: "crm" | "studio";
  /** Set while it is paused because the plan lapsed (and only then). */
  entitlement_paused_at: Date | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

export const RUN_COLUMNS = `r.id, r.org_id, r.workflow_id, r.version_id, r.trigger_event_id, r.started_via, r.contact_id, r.opportunity_id, r.status, r.current_step,
  r.next_run_at, r.attempts, r.claimed_at, r.depth, r.context, r.last_error, r.created_at, r.finished_at`;
export const VERSION_COLUMNS = "v.id, v.workflow_id, v.version, v.trigger_config, v.steps, v.effects, v.premium_features, v.content_hash, v.approval_id, v.approved_hash, v.approved_at, v.published_at";

/**
 * Whether a version may run: it has no effects outside the CRM, or an owner approved exactly its content and that approval still stands.
 * `approvalStatus` is the status of approval_requests.id = version.approval_id.
 */
export function versionAuthorized(v: Pick<VersionRow, "effects" | "content_hash" | "approved_hash" | "approval_id">, approval: { status: string; expires_at: Date | null } | null, now = new Date()): boolean {
  if (!v.effects.length) return true;
  if (!v.approval_id || v.approved_hash !== v.content_hash || !approval) return false;
  return approval.status === "approved" && (!approval.expires_at || new Date(approval.expires_at).getTime() > now.getTime());
}

export async function loadApprovalState(db: Queryable, orgId: string, approvalId: string | null): Promise<{ status: string; expires_at: Date | null } | null> {
  if (!approvalId) return null;
  const { rows } = await db.query<{ status: string; expires_at: Date | null }>("select status, expires_at from approval_requests where id = $1 and org_id = $2", [approvalId, orgId]);
  return rows[0] ?? null;
}

/**
 * The key an external effect of one step carries (a message's dedupe key, a webhook's or an n8n call's idempotency key). Retries of the
 * same step visit reuse it, so the effect can't happen twice; a later visit of the same step (a loop through a wait) gets its own.
 */
export const effectKeyFor = (runId: string, stepKey: string, visit: number) => (visit > 1 ? `wf:${runId}:${stepKey}:${visit}` : `wf:${runId}:${stepKey}`);
/** The step row's own key: one row per attempt. */
export const attemptKeyFor = (effectKey: string, attempt: number) => `${effectKey}#${attempt}`;

export function workflowActor(org: { id: string; name: string; timezone: string }, workflowName: string): CrmActor {
  return systemActor(org, `Workflow: ${workflowName}`.slice(0, 120));
}

/** Retries wait 1, 2, 4, 8 minutes. */
export const backoffMs = (attempt: number) => Math.min(60, 2 ** Math.max(0, attempt - 1)) * 60_000;

/** Errors from the engine's own checks. `retryable` false means trying again can't help (a deleted tag, a missing approval). */
export class StepFailure extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable?: boolean } = {}) {
    super(message);
    this.retryable = opts.retryable ?? false;
  }
}

/** Whether an error from a step can go away by trying again. A service's plain refusal (AppError) can't; a database hiccup can. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof StepFailure) return err.retryable;
  if (err instanceof AppError) return err.code === "rate_limited" || err.code === "upstream_error" || err.code === "integration_unavailable" || err.code === "agent_unavailable";
  const code = (err as { code?: string })?.code;
  // Serialization failures and deadlocks clear on a retry; constraint violations don't.
  if (code === "40001" || code === "40P01" || code === "55P03") return true;
  if (typeof code === "string" && /^2[23]/.test(code)) return false;
  return true;
}

export function publicMessage(err: unknown): string {
  if (err instanceof StepFailure || err instanceof AppError) return err.message.slice(0, 480);
  return "The step failed unexpectedly. It is retried automatically; if it keeps failing, check the step's settings.";
}

/** Owners and managers hear about a workflow that stopped, at most once an hour per workflow. */
export async function notifyWorkflowProblem(db: Queryable, input: { orgId: string; workflowId: string; workflowName: string; runId: string; title: string; body: string; now?: Date }) {
  const hour = (input.now ?? new Date()).toISOString().slice(0, 13);
  await notifyOrgRoles(db, input.orgId, ["owner", "admin"], {
    kind: "crm_workflow_failed",
    severity: "warning",
    title: input.title.slice(0, 200),
    body: input.body.slice(0, 900),
    link: `/crm/workflows/${input.workflowId}/runs/${input.runId}`,
    dedupeKey: `crm-wf-failed:${input.workflowId}:${hour}`,
  });
}

/** Keeps a JSON object under a byte budget by dropping the largest values first (for run context and outbound payloads). */
export function trimJson(value: Record<string, unknown> | null | undefined, maxBytes: number): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(value ?? {}) };
  let size = JSON.stringify(out).length;
  if (size <= maxBytes) return out;
  const keys = Object.keys(out).sort((a, b) => JSON.stringify(out[b]).length - JSON.stringify(out[a]).length);
  for (const k of keys) {
    if (size <= maxBytes) break;
    delete out[k];
    out._trimmed = true;
    size = JSON.stringify(out).length;
  }
  return out;
}

export const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
