import "server-only";
import { withSystem, readSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { sanitizeAuditMetadata } from "@/server/audit";
import { logSafeServerDiagnostic } from "@/server/diagnostics";
import { agencyCanAccessOrg } from "@/server/tenancy/context";
import { redactValue } from "@/server/aqi/ops/redact";
import { findOpsTool } from "@/server/aqi/ops/registry";
import type { OpsContext, OpsReadOutput, OpsTool } from "@/server/aqi/ops/tool";
import type { Permission } from "@/lib/permissions";
import { opsScopeKey, type OpsCard, type OpsEvidence, type OpsScope, type OpsToolRun, type OpsToolStatus } from "@/lib/aqi/ops/types";
import type { SessionUser } from "@/server/auth/service";

/** Hard bounds that keep one question from fanning out into the database. The hosted pool is small. */
export const OPS_LIMITS = {
  toolsPerTurn: 6,
  concurrentTools: 2,
  maxCardsPerTool: 4,
  maxEvidenceChars: 2800,
} as const;

class Gate {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly size: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}
/** One gate per server process: concurrent administrators share the same small database budget. */
const gate = new Gate(OPS_LIMITS.concurrentTools);

export interface OpsAuditEntry {
  action: string;
  result: "success" | "denied" | "failure";
  orgId: string | null;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
}

export interface OpsToolOutcome {
  run: OpsToolRun;
  evidence: OpsEvidence | null;
  cards: OpsCard[];
  /** Redacted, bounded structured findings for the narrative. */
  data: unknown;
  summary: string;
  unavailable: string[];
  flagged: number;
}

export interface OpsRun {
  ctx: OpsContext;
  /** Runs one read tool through the full pipeline. Never throws: failures are returned as outcomes. */
  runTool(toolId: string, rawArgs: unknown): Promise<OpsToolOutcome>;
  /** Writes everything recorded so far in a single statement. Safe to call more than once. */
  flushAudit(): Promise<void>;
  record(entry: OpsAuditEntry): void;
}

/** Loads exactly the agency permissions the planned tools need, in one statement. */
async function loadPermissions(userId: string, wanted: readonly string[]): Promise<Set<Permission>> {
  if (!wanted.length) return new Set();
  const { rows } = await readSystem((db) => db.query<{ permission: string }>(
    `select p.permission from unnest($2::text[]) as p(permission)
     where coalesce(app.user_has_agency_permission($1, p.permission), false)`,
    [userId, [...wanted]],
  ));
  return new Set(rows.map((r) => r.permission as Permission));
}

export interface CreateOpsRunInput {
  user: SessionUser;
  scope: OpsScope;
  signal: AbortSignal;
  requestId?: string;
  /** Tools that are about to run, so their permissions are fetched together instead of one by one. */
  plannedToolIds: readonly string[];
  now?: Date;
}

export async function createOpsRun(input: CreateOpsRunInput): Promise<OpsRun> {
  const { user, scope, signal } = input;
  if (user.platformRole !== "agency_super_admin" && user.platformRole !== "agency_manager" && user.platformRole !== "agency_staff") {
    throw new AppError("forbidden", "AQi Operations is available to agency administrators only.");
  }
  const requestId = input.requestId ?? crypto.randomUUID();
  const entries: OpsAuditEntry[] = [];
  const orgChecks = new Map<string, Promise<void>>();
  const planned = input.plannedToolIds.map((id) => findOpsTool(id)).filter((t): t is OpsTool => Boolean(t));
  const wanted = [...new Set(planned.map((t) => t.permission).filter((p): p is Permission => Boolean(p)))];
  const permissions = await loadPermissions(user.id, wanted);

  const ctx: OpsContext = {
    user,
    scope,
    now: input.now ?? new Date(),
    signal,
    requestId,
    permissions,
    authorizeOrg(orgId, reason) {
      let check = orgChecks.get(orgId);
      if (!check) {
        check = (async () => {
          const allowed = await agencyCanAccessOrg(user, orgId);
          entries.push({
            action: "aqi.ops_tenant_access",
            result: allowed ? "success" : "denied",
            orgId,
            targetType: "organization",
            targetId: orgId,
            metadata: { requestId, reason, scope: opsScopeKey(scope) },
          });
          if (!allowed) throw new AppError("forbidden", "You are not assigned to this client.");
        })();
        orgChecks.set(orgId, check);
      }
      return check;
    },
  };

  // A scoped investigation of a tenant is itself an audited cross-tenant access, recorded once even
  // when no tool ends up reading anything. It is awaited: access is verified before any tool can run.
  if (scope.orgId) await ctx.authorizeOrg(scope.orgId, `scope:${scope.type}`);

  async function runTool(toolId: string, rawArgs: unknown): Promise<OpsToolOutcome> {
    const started = Date.now();
    const tool = findOpsTool(toolId);
    const base = { id: crypto.randomUUID(), toolId, title: tool?.title ?? toolId };
    const fail = (status: OpsToolStatus, note: string, audit = true, code: string = status): OpsToolOutcome => {
      if (audit) {
        entries.push({
          action: "aqi.ops_tool_run",
          result: status === "denied" ? "denied" : "failure",
          orgId: scope.orgId,
          targetType: "aqi_ops_tool",
          targetId: toolId.slice(0, 120),
          metadata: { requestId, status: code, durationMs: Date.now() - started, scope: opsScopeKey(scope) },
        });
      }
      return { run: { ...base, status, durationMs: Date.now() - started, note }, evidence: null, cards: [], data: null, summary: note, unavailable: [], flagged: 0 };
    };

    if (!tool || tool.kind !== "read") return fail("denied", "That check is not available.", true, "unknown_tool");
    if (!tool.roles.includes(user.platformRole as never)) return fail("denied", "Your role cannot run this check.", true, "role");
    if (tool.permission && !permissions.has(tool.permission)) return fail("denied", "Your permissions don't include this check.", true, "permission");
    if (!tool.scopes.includes(scope.type)) return fail("denied", "This check does not apply to the selected context.", false, "scope");
    const parsed = tool.input.safeParse(rawArgs ?? {});
    if (!parsed.success) return fail("error", "The request for this check was not valid.", true, "invalid_args");

    const timeout = AbortSignal.timeout(tool.timeoutMs);
    const toolCtx: OpsContext = { ...ctx, signal: AbortSignal.any([signal, timeout]) };
    let output: OpsReadOutput;
    try {
      output = await gate.run(async () => {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        return await Promise.race([
          tool.run(toolCtx, parsed.data),
          new Promise<never>((_, reject) => timeout.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")), { once: true })),
        ]);
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") return fail("timeout", `${tool.title} did not finish in ${Math.round(tool.timeoutMs / 1000)} seconds, so no result is shown.`);
      if (err instanceof DOMException && err.name === "AbortError") return fail("error", "The request was cancelled.", false, "cancelled");
      if (err instanceof AppError && (err.code === "forbidden" || err.code === "not_found")) return fail("denied", err.message, true, err.code);
      logSafeServerDiagnostic("aqi.ops_tool_failed", err, `aqi.ops.${toolId}`);
      return fail("error", `${tool.title} could not be completed. The data source may be temporarily unavailable.`);
    }

    const durationMs = Date.now() - started;
    const retrievedAt = new Date().toISOString();
    const evidence: OpsEvidence = { id: "", tool: tool.id, label: output.evidence.label, source: output.evidence.source, retrievedAt, href: output.evidence.href ?? null };
    const redactedData = redactValue(output.data, { maxString: 280, maxArray: 30, maxDepth: 5 });
    const redactedCards = redactValue(output.cards.slice(0, OPS_LIMITS.maxCardsPerTool), { maxString: 2000, maxArray: 40, maxDepth: 6, multilineKeys: ["body"] });
    const status: OpsToolStatus = output.partial ? "partial" : "ok";
    entries.push({
      action: "aqi.ops_tool_run",
      result: "success",
      orgId: scope.orgId,
      targetType: "aqi_ops_tool",
      targetId: tool.id,
      metadata: { requestId, status, durationMs, scope: opsScopeKey(scope), cards: output.cards.length, flagged: redactedData.flagged + redactedCards.flagged, sensitive: tool.audit.sensitive },
    });
    return {
      run: { ...base, status, durationMs, note: output.partial ? "Some sources were unavailable." : undefined },
      evidence,
      cards: redactedCards.value as OpsCard[],
      data: redactedData.value,
      summary: redactValue(output.summary, { maxString: 900 }).value,
      unavailable: output.unavailable ?? [],
      flagged: redactedData.flagged + redactedCards.flagged,
    };
  }

  return {
    ctx,
    runTool,
    record: (entry) => { entries.push(entry); },
    async flushAudit() {
      if (!entries.length) return;
      const batch = entries.splice(0, entries.length);
      // One statement per turn regardless of how many tools ran. Audit is best-effort here: a failed
      // write is logged, never allowed to hide an answer or to fail a read-only investigation.
      try {
        const values: unknown[] = [];
        const rows = batch.map((e, i) => {
          const o = i * 8;
          values.push(e.orgId, user.id, e.action, e.targetType, e.targetId, e.result, JSON.stringify(sanitizeAuditMetadata(e.metadata)), "agency");
          return `($${o + 1}::uuid, $${o + 2}::uuid, $${o + 8}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}::jsonb)`;
        });
        await withSystem((db) => db.query(
          `insert into audit_logs (org_id, actor_user_id, actor_kind, action, target_type, target_id, result, metadata) values ${rows.join(",")}`,
          values,
        ));
      } catch (err) {
        logSafeServerDiagnostic("aqi.ops_audit_failed", err, "aqi.ops.audit");
      }
    },
  };
}

/** Assigns [E1]… ids in the order evidence was produced. */
export function numberEvidence(items: Array<OpsEvidence | null>): OpsEvidence[] {
  const out: OpsEvidence[] = [];
  for (const item of items) {
    if (!item) continue;
    out.push({ ...item, id: `E${out.length + 1}` });
  }
  return out;
}
