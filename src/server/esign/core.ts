import "server-only";
import type { Queryable } from "@/server/db";
import type { NotAppliedReason, RequestStatus, SigningMode } from "@/lib/esign/state";
import type { CreateState } from "@/server/esign/providers/types";
import type { FailureKind } from "@/lib/esign/errors";

// What every signing service needs: reading a request and its connection, the history log, and the rule for when a workspace may have signing work done. No permission checks
// live here: the callers make them.

export interface RequestRow {
  id: string;
  org_id: string;
  proposal_id: string;
  proposal_version: number;
  version_hash: string;
  pdf_file_id: string | null;
  pdf_sha256: string;
  connection_id: string;
  provider: "pandadoc" | "simulated";
  mode: SigningMode;
  status: RequestStatus;
  signer_name: string;
  signer_email: string;
  signer_contact_id: string | null;
  provider_document_id: string | null;
  provider_state: CreateState;
  idempotency_key: string;
  run_at: Date;
  attempt: number;
  max_attempts: number;
  lease_until: Date | null;
  claimed_by: string | null;
  last_error: string | null;
  last_error_kind: FailureKind | null;
  sent_at: Date | null;
  completed_at: Date | null;
  finished_at: Date | null;
  applied_at: Date | null;
  not_applied_reason: NotAppliedReason | null;
  signed_file_id: string | null;
  signed_sha256: string | null;
  certificate_file_id: string | null;
  certificate_sha256: string | null;
  copy_attempts: number;
  copy_next_at: Date | null;
  copy_gave_up_at: Date | null;
  void_reason: string | null;
  cancel_state: "none" | "wanted" | "done" | "manual";
  cancel_attempts: number;
  last_polled_at: Date | null;
  created_by: string | null;
  created_at: Date;
}

export const REQUEST_COLUMNS =
  "id, org_id, proposal_id, proposal_version, version_hash, pdf_file_id, pdf_sha256, connection_id, provider, mode, status, signer_name, signer_email::text as signer_email, signer_contact_id, "
  + "provider_document_id, provider_state, idempotency_key, run_at, attempt, max_attempts, lease_until, claimed_by, last_error, last_error_kind, sent_at, completed_at, finished_at, applied_at, "
  + "not_applied_reason, signed_file_id, signed_sha256, certificate_file_id, certificate_sha256, copy_attempts, copy_next_at, copy_gave_up_at, void_reason, cancel_state, cancel_attempts, "
  + "last_polled_at, created_by, created_at";

/** The same columns qualified with a table alias, for a query that joins. */
export const requestColumns = (alias: string): string => REQUEST_COLUMNS.split(", ").map((c) => `${alias}.${c}`).join(", ");

export async function loadRequest(db: Queryable, orgId: string, id: string, lock = false): Promise<RequestRow | null> {
  const { rows } = await db.query<RequestRow>(`select ${REQUEST_COLUMNS} from signature_requests where id = $1 and org_id = $2${lock ? " for update" : ""}`, [id, orgId]);
  return rows[0] ?? null;
}

export interface ConnectionRow {
  id: string;
  org_id: string;
  provider: "pandadoc" | "simulated";
  mode: SigningMode;
  label: string;
  credentials: string | null;
  webhook_token_hash: string;
  account_label: string | null;
  status: "connected" | "needs_attention" | "error" | "revoked" | "disconnected";
  status_detail: string | null;
  last_checked_at: Date | null;
  last_success_at: Date | null;
  connected_by: string | null;
  connected_at: Date;
  disconnected_at: Date | null;
}

export const CONNECTION_COLUMNS = "id, org_id, provider, mode, label, credentials, webhook_token_hash, account_label, status, status_detail, last_checked_at, last_success_at, connected_by, connected_at, disconnected_at";

/** The workspace's live connection (not revoked or disconnected), or null. Reads the sealed credentials, so it runs only as trusted code. */
export async function liveConnection(db: Queryable, orgId: string, lock = false): Promise<ConnectionRow | null> {
  const { rows } = await db.query<ConnectionRow>(`select ${CONNECTION_COLUMNS} from esign_connections where org_id = $1 and status not in ('revoked', 'disconnected')${lock ? " for update" : ""}`, [orgId]);
  return rows[0] ?? null;
}

export async function loadConnection(db: Queryable, orgId: string, id: string): Promise<ConnectionRow | null> {
  const { rows } = await db.query<ConnectionRow>(`select ${CONNECTION_COLUMNS} from esign_connections where id = $1 and org_id = $2`, [id, orgId]);
  return rows[0] ?? null;
}

export type EventSource = "user" | "system" | "provider_webhook" | "provider_poll";

/**
 * Writes a line on a request's history. With a provider event id, a second write of the same id finds the row that is already there and returns false: that is how a replayed
 * delivery is recognised. Returns whether a new row was written.
 */
export async function addSigEvent(db: Queryable, orgId: string, requestId: string, kind: string, source: EventSource, detail: Record<string, unknown> = {}, providerEventId: string | null = null): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `insert into signature_events (org_id, request_id, kind, source, provider_event_id, detail) values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (request_id, provider_event_id) where provider_event_id is not null do nothing returning id`,
    [orgId, requestId, kind.slice(0, 40), source, providerEventId, JSON.stringify(detail)],
  );
  return rows.length === 1;
}

/**
 * Whether a workspace may have signing work done for it right now. A request asks a customer to sign, so the rule is the platform's own for outbound automation
 * (src/server/automation/gate.ts): a suspended or archived workspace, an iAcquire agency pause and the workspace's outbound pause all stop it, and a shut-down client has all three.
 * The same predicate as src/server/social/org-gate.ts, kept here so the two modules do not depend on each other. `orgIdExpr` is spliced into the text, so it must be a column
 * reference written in this code, never user input.
 */
export function orgRunnableSql(orgIdExpr: string): string {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(orgIdExpr)) throw new Error("orgRunnableSql takes a column reference");
  return `(exists (select 1 from organizations gate_o where gate_o.id = ${orgIdExpr} and gate_o.status not in ('suspended', 'archived'))
    and not exists (select 1 from automation_pauses gate_p join organizations gate_po on gate_po.id = gate_p.org_id
      where gate_p.active and ((gate_p.org_id = ${orgIdExpr} and gate_p.scope in ('agency', 'outbound')) or (gate_po.kind = 'agency' and gate_p.scope = 'agency'))))`;
}

/** The workspace has signing switched on by a Super Admin (an org_features row), as a SQL predicate for a job that scans many workspaces. */
export function esignOnSql(orgIdExpr: string): string {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(orgIdExpr)) throw new Error("esignOnSql takes a column reference");
  return `exists (select 1 from org_features gate_f where gate_f.org_id = ${orgIdExpr} and gate_f.feature = 'esign' and gate_f.enabled)
    and exists (select 1 from org_features gate_g where gate_g.org_id = ${orgIdExpr} and gate_g.feature = 'proposals' and gate_g.enabled)`;
}

/** A workspace that takes no customer answers right now: suspended, archived, or paused by iAcquire (a shut-down client is). The same reading as the customer's proposal page. */
export async function orgTakesNoAnswers(db: Queryable, orgId: string): Promise<boolean> {
  const { rows } = await db.query<{ stopped: boolean }>(
    `select (o.status in ('suspended', 'archived') or exists (select 1 from automation_pauses ap join organizations apo on apo.id = ap.org_id
        where ap.active and ap.scope = 'agency' and (ap.org_id = o.id or apo.kind = 'agency'))) as stopped from organizations o where o.id = $1`,
    [orgId],
  );
  return rows[0]?.stopped ?? true;
}
