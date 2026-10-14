import "server-only";
import { withSystem, type Queryable } from "@/server/db";

export interface AuditEvent {
  orgId?: string | null;
  actorUserId?: string | null;
  actorKind: "user" | "agency" | "agent" | "system";
  agentInstanceId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  result: "success" | "denied" | "failure";
  approvalId?: string | null;
  ipHash?: string | null;
  metadata?: Record<string, unknown>;
}

const SECRET_KEY_RE = /(password|secret|token|api[_-]?key|authorization|cookie|credential|signature)/i;
const MAX_STRING = 300;

/** Removes secret-looking keys and truncates long values. Message bodies are never logged. */
export function sanitizeAuditMetadata(input: Record<string, unknown> | undefined, depth = 0): Record<string, unknown> {
  if (!input || depth > 3) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (typeof value === "string") out[key] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    else if (typeof value === "number" || typeof value === "boolean" || value === null) out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 20).map((v) => (typeof v === "string" ? v.slice(0, 120) : v));
    else if (typeof value === "object") out[key] = sanitizeAuditMetadata(value as Record<string, unknown>, depth + 1);
  }
  return out;
}

export async function recordAudit(event: AuditEvent, db?: Queryable): Promise<void> {
  const write = (q: Queryable) =>
    q.query(
      `insert into audit_logs (org_id, actor_user_id, actor_kind, agent_instance_id, action, target_type,
         target_id, result, approval_id, ip_hash, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        event.orgId ?? null,
        event.actorUserId ?? null,
        event.actorKind,
        event.agentInstanceId ?? null,
        event.action,
        event.targetType ?? null,
        event.targetId ?? null,
        event.result,
        event.approvalId ?? null,
        event.ipHash ?? null,
        JSON.stringify(sanitizeAuditMetadata(event.metadata)),
      ],
    );
  if (db) await write(db);
  else await withSystem(write);
}
