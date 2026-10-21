import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, type CrmActor } from "@/server/crm/actor";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { encryptSecret } from "@/server/security/crypto";
import { isPublicAddress } from "@/server/onboarding/website";
import { hostResolver } from "@/server/calendars/adapters/http";
import { assertStudioEntitled } from "@/server/automation-studio/entitlement";
import { performOutbound, slackText, type OutboundDeps, type OutboundResult } from "@/server/automation-studio/outbound";
import { OutboundPolicyError } from "@/server/security/outbound-http";
import {
  MAX_LIVE_CONNECTIONS, createConnectionSchema, httpSettingsFrom, secretHintOf, slackWebhookProblem, type ConnectionKind, type ConnectionStatus, type ConnectionView, type CreateConnectionInput,
  type HttpSettings, type SlackSettings,
} from "@/lib/automation-studio/connections";

/**
 * A workspace's connections to outside systems: set up, verified with a confirmed test, rotated and revoked. Each is the workspace's own; the secret is
 * encrypted (AES-GCM, the application database role cannot read the column) and is only ever shown, once, to the person who typed it.
 *
 * Who can do what: seeing needs "See automations"; setting up, testing and rotating need "Build and change automations" and the Automation Studio plan;
 * revoking needs the permission only (a workspace whose plan lapsed must still be able to cut off a credential).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEW_COLUMNS = "id, kind, name, settings, secret_hint, secret_version, status, status_detail, verified_at, last_used_at, consecutive_failures, rotated_at, revoked_at, created_at";

interface Row {
  id: string;
  kind: ConnectionKind;
  name: string;
  settings: HttpSettings | SlackSettings;
  secret_hint: string | null;
  secret_version: number;
  status: ConnectionStatus;
  status_detail: string | null;
  verified_at: Date | null;
  last_used_at: Date | null;
  consecutive_failures: number;
  rotated_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export function toView(r: Row): ConnectionView {
  return {
    id: r.id, kind: r.kind, name: r.name, status: r.status, statusDetail: r.status_detail, secretHint: r.secret_hint, secretVersion: r.secret_version, settings: r.settings,
    host: r.kind === "slack_webhook" ? "hooks.slack.com" : (r.settings as HttpSettings).host,
    verifiedAt: iso(r.verified_at), lastUsedAt: iso(r.last_used_at), consecutiveFailures: r.consecutive_failures, rotatedAt: iso(r.rotated_at), revokedAt: iso(r.revoked_at), createdAt: new Date(r.created_at).toISOString(),
  };
}

const tableExists = async (db: Queryable) => (await db.query<{ ok: boolean }>("select to_regclass('public.automation_connections') is not null as ok")).rows[0]?.ok === true;

export async function listConnections(actor: CrmActor, opts: { includeRevoked?: boolean } = {}): Promise<ConnectionView[]> {
  assertCan(actor, "workflows.view");
  return withSystem(async (db) => {
    if (!(await tableExists(db))) return [];
    const { rows } = await db.query<Row>(`select ${VIEW_COLUMNS} from automation_connections where org_id = $1 ${opts.includeRevoked ? "" : "and status <> 'revoked'"} order by status = 'revoked', lower(name)`, [actor.orgId]);
    return rows.map(toView);
  });
}

export async function getConnection(db: Queryable, orgId: string, id: string): Promise<ConnectionView | null> {
  if (!UUID.test(id)) return null;
  const row = (await db.query<Row>(`select ${VIEW_COLUMNS} from automation_connections where id = $1 and org_id = $2`, [id, orgId])).rows[0];
  return row ? toView(row) : null;
}

/** The address must resolve, and only to public addresses, when it is saved: an early, readable refusal (every call checks again when it connects). */
async function assertResolvesPublicly(host: string): Promise<void> {
  let addresses: string[];
  try {
    addresses = await hostResolver.lookup(host);
  } catch {
    throw new AppError("invalid_input", `The host ${host} couldn't be found. Check the address.`);
  }
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a))) throw new AppError("invalid_input", `The host ${host} points to a private or local network, so it can't be called.`);
}

const cleanInput = (input: unknown): CreateConnectionInput => {
  const parsed = createConnectionSchema.safeParse(input);
  if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Check the connection's details.");
  return parsed.data;
};

export async function createConnection(actor: CrmActor, rawInput: unknown): Promise<ConnectionView> {
  assertCan(actor, "workflows.manage", "Setting up connections needs the automations permission.");
  const input = cleanInput(rawInput);
  const limit = await consumeRateLimit(RATE_LIMITS.studioConnectionByOrg, actor.orgId);
  if (!limit.allowed) throw new AppError("rate_limited", "That's a lot of connection changes. Try again in a few minutes.", { retryAfterSeconds: limit.retryAfterSeconds });

  let settings: HttpSettings | SlackSettings;
  let secret: string | null = null;
  let host: string;
  if (input.kind === "http") {
    try {
      settings = httpSettingsFrom(input);
    } catch (err) {
      if (err instanceof OutboundPolicyError) throw new AppError("invalid_input", err.message);
      throw err;
    }
    if (input.auth.type !== "none" && !input.secret) throw new AppError("invalid_input", input.auth.type === "basic" ? "Enter the password." : "Enter the token or key to send.");
    if (input.auth.type === "none" && input.secret) throw new AppError("invalid_input", "This connection sends no credentials. Remove the secret, or choose how to send it.");
    secret = input.secret ?? null;
    host = settings.host;
    await assertResolvesPublicly(host);
  } else {
    const problem = slackWebhookProblem(input.webhookUrl);
    if (problem) throw new AppError("invalid_input", problem);
    secret = input.webhookUrl.trim();
    settings = { channelLabel: input.channelLabel ?? "" };
    host = "hooks.slack.com";
  }

  return withSystem(async (db) => {
    await assertStudioEntitled(db, actor.orgId, "Connections");
    const live = (await db.query<{ n: number }>("select count(*)::int as n from automation_connections where org_id = $1 and status <> 'revoked'", [actor.orgId])).rows[0]?.n ?? 0;
    if (live >= MAX_LIVE_CONNECTIONS) throw new AppError("conflict", `A workspace can have up to ${MAX_LIVE_CONNECTIONS} connections. Revoke one you no longer use first.`);
    const taken = (await db.query("select 1 from automation_connections where org_id = $1 and lower(name) = lower($2) and status <> 'revoked'", [actor.orgId, input.name])).rows.length;
    if (taken) throw new AppError("conflict", "A connection with that name already exists. Choose another name.");
    const row = (await db.query<Row>(
      `insert into automation_connections (org_id, kind, name, settings, secret_ciphertext, secret_hint, created_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning ${VIEW_COLUMNS}`,
      [actor.orgId, input.kind, input.name, JSON.stringify(settings), secret ? encryptSecret(secret) : null, secret ? secretHintOf(secret) : null, actor.userId],
    )).rows[0];
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "automation_studio.connection_created", targetType: "automation_connection", targetId: row.id, result: "success", metadata: { kind: input.kind, host } }, db);
    return toView(row);
  });
}

async function loadLive(db: Queryable, actor: CrmActor, id: string, forUpdate = false): Promise<Row & { kind: ConnectionKind }> {
  if (!UUID.test(id)) throw new AppError("not_found", "Connection not found.");
  const row = (await db.query<Row>(`select ${VIEW_COLUMNS} from automation_connections where id = $1 and org_id = $2${forUpdate ? " for update" : ""}`, [id, actor.orgId])).rows[0];
  if (!row) throw new AppError("not_found", "Connection not found.");
  if (row.status === "revoked") throw new AppError("conflict", "That connection was revoked. Set up a new one.");
  return row;
}

/** Replaces the secret. The connection must be verified again before a workflow can use it. The old secret is gone for good. */
export async function rotateConnectionSecret(actor: CrmActor, id: string, newSecret: string): Promise<ConnectionView> {
  assertCan(actor, "workflows.manage", "Changing connections needs the automations permission.");
  const secret = String(newSecret ?? "").trim();
  return withSystem(async (db) => {
    await assertStudioEntitled(db, actor.orgId, "Connections");
    const current = await loadLive(db, actor, id, true);
    if (current.kind === "slack_webhook") {
      const problem = slackWebhookProblem(secret);
      if (problem) throw new AppError("invalid_input", problem);
    } else {
      if ((current.settings as HttpSettings).auth.type === "none") throw new AppError("invalid_input", "This connection sends no credentials, so there is no secret to change.");
      if (secret.length < 8 || secret.length > 2000 || /[\r\n\u0000]/.test(secret)) throw new AppError("invalid_input", "That secret isn't valid. It needs at least 8 characters and no line breaks.");
    }
    const row = (await db.query<Row>(
      `update automation_connections set secret_ciphertext = $3, secret_hint = $4, secret_version = secret_version + 1, status = 'unverified', status_detail = null, verified_at = null, verified_by = null,
         consecutive_failures = 0, rotated_at = now(), rotated_by = $5 where id = $1 and org_id = $2 returning ${VIEW_COLUMNS}`,
      [id, actor.orgId, encryptSecret(secret), secretHintOf(secret), actor.userId],
    )).rows[0];
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "automation_studio.connection_rotated", targetType: "automation_connection", targetId: id, result: "success", metadata: { version: row.secret_version } }, db);
    return toView(row);
  });
}

/**
 * Cuts a connection off for good: its secret is erased, and a workflow that uses it can't run (its steps say the connection was revoked). Allowed
 * without the plan. Returns how many workflows (working copies and published versions) still refer to it.
 */
export async function revokeConnection(actor: CrmActor, id: string): Promise<{ connection: ConnectionView; workflowsUsingIt: number }> {
  assertCan(actor, "workflows.manage", "Changing connections needs the automations permission.");
  return withSystem(async (db) => {
    await loadLive(db, actor, id, true);
    const row = (await db.query<Row>(
      `update automation_connections set status = 'revoked', secret_ciphertext = null, secret_hint = null, status_detail = null, revoked_at = now(), revoked_by = $3 where id = $1 and org_id = $2 returning ${VIEW_COLUMNS}`,
      [id, actor.orgId, actor.userId],
    )).rows[0];
    const using = (await db.query<{ n: number }>(
      `select count(distinct w.id)::int as n from crm_workflows w left join crm_workflow_versions v on v.workflow_id = w.id and v.org_id = w.org_id
       where w.org_id = $1 and w.status <> 'archived' and (w.draft::text like $2 or v.steps::text like $2)`,
      [actor.orgId, `%${id}%`],
    )).rows[0]?.n ?? 0;
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "automation_studio.connection_revoked", targetType: "automation_connection", targetId: id, result: "success", metadata: { workflows: using } }, db);
    return { connection: toView(row), workflowsUsingIt: using };
  });
}

export interface TestOutcome {
  ok: boolean;
  detail: string;
  connection: ConnectionView;
}

/**
 * Sends one test through a connection, only after the person has confirmed it (`confirmed` must be true: it is the answer to a question that says exactly
 * what will be sent and where). A Slack connection posts a message that says it is a test; an HTTP connection makes a GET to its test path. Success
 * verifies the connection; a failure says why and marks it as needing attention. Limited to a few tests an hour per connection.
 */
export async function testConnection(actor: CrmActor, id: string, input: { confirmed: boolean }, deps?: OutboundDeps): Promise<TestOutcome> {
  assertCan(actor, "workflows.manage", "Testing connections needs the automations permission.");
  if (input?.confirmed !== true) throw new AppError("invalid_input", "Confirm that you want to send the test first.");
  const { conn } = await withSystem(async (db) => {
    await assertStudioEntitled(db, actor.orgId, "Connections");
    return { conn: await loadLive(db, actor, id) };
  });
  const limit = await consumeRateLimit(RATE_LIMITS.studioTestByConnection, id);
  if (!limit.allowed) throw new AppError("rate_limited", "That connection was tested several times in the last hour. Try again later.", { retryAfterSeconds: limit.retryAfterSeconds });

  const stamp = `test:${id}:${Date.now()}`;
  const result: OutboundResult = conn.kind === "slack_webhook"
    ? await performOutbound({ kind: "slack", orgId: actor.orgId, connectionId: id, origin: "test", idempotencyKey: stamp, text: slackText(`Test message from iAcquire Automation Studio, sent by ${actor.label}. Nothing else is needed: this just checks the connection.`) }, deps)
    : await performOutbound({ kind: "http", orgId: actor.orgId, connectionId: id, origin: "test", idempotencyKey: stamp, method: "GET", path: (conn.settings as HttpSettings).testPath || "/", timeoutSeconds: 10 }, deps);
  const ok = result.status === "sent";
  const connection = await withSystem(async (db) => {
    if (ok) await db.query("update automation_connections set verified_by = $3 where id = $1 and org_id = $2", [id, actor.orgId, actor.userId]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "automation_studio.connection_tested", targetType: "automation_connection", targetId: id, result: ok ? "success" : "failure", metadata: { kind: conn.kind, httpStatus: result.httpStatus, outcome: result.record.outcome } }, db);
    return (await getConnection(db, actor.orgId, id))!;
  });
  return { ok, detail: ok ? "The test went through. The connection is verified." : result.detail, connection };
}

/** The recent calls of one connection, for its page: what was sent where and how it went (never what it contained). */
export async function listConnectionCalls(actor: CrmActor, id: string, limit = 20): Promise<Array<{ at: string; origin: string; method: string; host: string; path: string; outcome: string; httpStatus: number | null; durationMs: number | null; detail: string | null }>> {
  assertCan(actor, "workflows.view");
  if (!UUID.test(id)) return [];
  const { rows } = await withSystem((db) => db.query<{ created_at: Date; origin: string; method: string; host: string; path: string; outcome: string; http_status: number | null; duration_ms: number | null; detail: string | null }>(
    "select created_at, origin, method, host, path, outcome, http_status, duration_ms, detail from automation_connection_calls where org_id = $1 and connection_id = $2 order by id desc limit $3",
    [actor.orgId, id, Math.min(100, limit)],
  ));
  return rows.map((r) => ({ at: new Date(r.created_at).toISOString(), origin: r.origin, method: r.method, host: r.host, path: r.path, outcome: r.outcome, httpStatus: r.http_status, durationMs: r.duration_ms, detail: r.detail }));
}

/** The connections the workflow validator and the pickers know about (not revoked), without anything secret. */
export async function connectionsForOptions(db: Queryable, orgId: string): Promise<Array<{ id: string; name: string; kind: ConnectionKind; status: ConnectionStatus; host: string; methods: string[] }>> {
  if (!(await tableExists(db))) return [];
  const { rows } = await db.query<Row>(`select ${VIEW_COLUMNS} from automation_connections where org_id = $1 and status <> 'revoked' order by lower(name)`, [orgId]);
  return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, status: r.status, host: r.kind === "slack_webhook" ? "hooks.slack.com" : (r.settings as HttpSettings).host, methods: r.kind === "http" ? (r.settings as HttpSettings).methods : [] }));
}
