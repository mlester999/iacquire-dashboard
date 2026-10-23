import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { randomToken } from "@/server/security/crypto";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { connectionNotice, ESIGN_NOT_ENABLED_MESSAGE, PROVIDER_LABELS, type ConnectionStatus, type SigningMode, type SigningProvider } from "@/lib/esign/state";
import { assertProposalsEnabled, ESIGN_FEATURE, featureOn } from "@/server/proposals/features";
import { memberUserId } from "@/server/proposals/core";
import { sealCredentials, openCredentials } from "@/server/esign/credentials";
import { liveEsignWritesEnabled, providerFor, simulatedAllowed } from "@/server/esign/providers";
import { EsignProviderError, type EsignCredentials, type ProviderHealth } from "@/server/esign/providers/types";
import { hashWebhookToken, tokenForStoredConnection, webhookTokenFor, webhookUrl } from "@/server/esign/webhook-token";
import { liveConnection, type ConnectionRow } from "@/server/esign/core";
import { voidLiveRequestsInTx } from "@/server/esign/apply";

// Connecting a client's own signing account. The account is the CLIENT's (so what it costs is theirs, and iAcquire never signs for anyone): only the workspace's owner or a
// manager connects or disconnects it. The keys are stored sealed and are never returned to a browser, a server-action result, an audit row or a log. A connection is saved only
// after the service itself has said the key works: a key that cannot be checked is not shown as connected. The status is a fact read from the service, or a decision a person made.

export interface ConnectionView {
  id: string;
  provider: SigningProvider;
  providerLabel: string;
  mode: SigningMode;
  label: string;
  accountLabel: string | null;
  status: ConnectionStatus;
  statusDetail: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  connectedAt: string;
  /** Something a person should know before trusting what it does (simulated, sandbox, real signing switched off here). */
  notice: string | null;
  /** Requests can be made through it right now. */
  usable: boolean;
}

interface ViewRow {
  id: string; provider: SigningProvider; mode: SigningMode; label: string; account_label: string | null; status: ConnectionStatus; status_detail: string | null;
  last_checked_at: Date | null; last_success_at: Date | null; connected_at: Date;
}

/** The columns a member may read: never the sealed keys and never the hash of the webhook secret. */
export const VIEW_COLUMNS = "id, provider, mode, label, account_label, status, status_detail, last_checked_at, last_success_at, connected_at";
const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

export function toConnectionView(r: ViewRow): ConnectionView {
  const writesEnabled = liveEsignWritesEnabled();
  return {
    id: r.id, provider: r.provider, providerLabel: PROVIDER_LABELS[r.provider], mode: r.mode, label: r.label, accountLabel: r.account_label, status: r.status, statusDetail: r.status_detail,
    lastCheckedAt: iso(r.last_checked_at), lastSuccessAt: iso(r.last_success_at), connectedAt: new Date(r.connected_at).toISOString(),
    notice: connectionNotice({ mode: r.mode, writesEnabled }), usable: r.status === "connected" && (r.mode === "simulated" || writesEnabled),
  };
}

/** The workspace's live connection as the person may see it, or null. */
export async function connectionViewIn(db: Queryable, orgId: string): Promise<ConnectionView | null> {
  const { rows } = await db.query<ViewRow>(`select ${VIEW_COLUMNS} from esign_connections where org_id = $1 and status not in ('revoked', 'disconnected') order by connected_at desc limit 1`, [orgId]);
  return rows[0] ? toConnectionView(rows[0]) : null;
}

export async function getConnection(actor: CrmActor): Promise<ConnectionView | null> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.view", "Your role can't see proposals.");
  return crmRead(actor, (db) => connectionViewIn(db, actor.orgId));
}

async function assertConnect(actor: CrmActor): Promise<string> {
  await assertProposalsEnabled(actor.orgId);
  if (!(await featureOn(actor.orgId, ESIGN_FEATURE))) throw new AppError("not_enabled", ESIGN_NOT_ENABLED_MESSAGE);
  assertCan(actor, "proposals.connect", "Only the business owner or a manager can connect a signing service.");
  return memberUserId(actor);
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

interface SaveInput {
  provider: SigningProvider;
  mode: SigningMode;
  label: string;
  creds: EsignCredentials;
  health: ProviderHealth;
}

const LIVE_REQUEST_SQL = "select 1 from signature_requests where connection_id = $1 and org_id = $2 and status in ('queued', 'sending', 'sent', 'viewed', 'unknown') limit 1";

/** Writes the connection: a new one, or the keys of the one that is there (a key rotated, or a connection that needed attention). One live connection per workspace. */
async function saveConnection(actor: CrmActor, userId: string, input: SaveInput): Promise<ConnectionView> {
  const id = await crmWrite(actor, async (db) => {
    const existing = await liveConnection(db, actor.orgId, true);
    const sealed = sealCredentials(input.creds);
    let connectionId: string;
    if (existing) {
      // Requests that are out were made through this account; their documents live there. Switching to a different kind of account would leave them unreadable.
      if (existing.provider !== input.provider || existing.mode !== input.mode) {
        if ((await db.query(LIVE_REQUEST_SQL, [existing.id, actor.orgId])).rows[0]) {
          throw new AppError("conflict", "Signing requests are still out through the current connection. Wait for them to finish, or withdraw them, before switching to a different account.");
        }
        await db.query("update esign_connections set status = 'disconnected', credentials = null, disconnected_at = now(), status_detail = 'Replaced by another connection.' where id = $1", [existing.id]);
        connectionId = await insertConnection(db, actor.orgId, userId, input, sealed);
      } else {
        connectionId = existing.id;
        await db.query(
          "update esign_connections set credentials = $2, label = $3, account_label = $4, status = 'connected', status_detail = null, last_checked_at = now(), last_success_at = now(), connected_by = $5 where id = $1",
          [existing.id, sealed, input.label, input.health.accountLabel, userId],
        );
      }
    } else {
      connectionId = await insertConnection(db, actor.orgId, userId, input, sealed);
    }
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.esign_connected", targetType: "esign_connection", targetId: connectionId, result: "success", metadata: { provider: input.provider, mode: input.mode, reconnected: Boolean(existing) } }, db);
    return connectionId;
  });
  const view = await crmRead(actor, (db) => connectionViewIn(db, actor.orgId));
  if (!view || view.id !== id) throw new AppError("internal", "The connection was saved but could not be read back.");
  return view;
}

async function insertConnection(db: Queryable, orgId: string, userId: string, input: SaveInput, sealed: string): Promise<string> {
  const id = crypto.randomUUID();
  const { rows } = await db.query<{ id: string }>(
    `insert into esign_connections (id, org_id, provider, mode, label, credentials, webhook_token_hash, account_label, status, last_checked_at, last_success_at, connected_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'connected', now(), now(), $9)
     on conflict (org_id) where status not in ('revoked', 'disconnected') do nothing returning id`,
    [id, orgId, input.provider, input.mode, input.label, sealed, hashWebhookToken(webhookTokenFor(id)), input.health.accountLabel, userId],
  );
  if (!rows[0]) throw new AppError("conflict", "A connection was just made by someone else. Reload to see it.");
  return id;
}

const KEY_RE = /^\S{16,200}$/;
const WEBHOOK_KEY_RE = /^\S{8,200}$/;

export interface PandaDocConnectInput {
  apiKey: string;
  /** The shared key PandaDoc shows when the webhook is set up; the webhook is refused without it. */
  webhookKey: string;
  mode: "sandbox" | "live";
  label?: string;
}

/**
 * Connects the client's own PandaDoc account. The key is checked with PandaDoc first (a read; nothing is created) and saved only if PandaDoc accepts it. Nothing is
 * sent to anyone by connecting. Whether real requests may then be made is a separate switch (ESIGN_WRITES_ENABLED) that stays off until the founder approves a sandbox test.
 */
export async function connectPandaDoc(actor: CrmActor, input: PandaDocConnectInput): Promise<ConnectionView> {
  const userId = await assertConnect(actor);
  if (input.mode !== "sandbox" && input.mode !== "live") throw new AppError("invalid_input", "Say whether this is a sandbox (test) key or a live one.");
  const apiKey = (input.apiKey ?? "").trim();
  const webhookKey = (input.webhookKey ?? "").trim();
  if (!KEY_RE.test(apiKey)) throw new AppError("invalid_input", "Paste the whole API key from PandaDoc, with no spaces.");
  if (!WEBHOOK_KEY_RE.test(webhookKey)) throw new AppError("invalid_input", "Paste the webhook shared key from PandaDoc, with no spaces. Without it iAcquire cannot tell a real notice from a forged one.");
  const label = (input.label ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!(await consumeRateLimit(RATE_LIMITS.esignConnectByOrg, actor.orgId)).allowed) throw new AppError("rate_limited", "Too many attempts to connect. Try again in a little while.");
  const creds = { apiKey, webhookKey };
  const health = await checkWith("pandadoc", creds);
  if (health.status !== "connected") throw new AppError("invalid_input", `PandaDoc did not accept this key. ${health.detail}`);
  return saveConnection(actor, userId, { provider: "pandadoc", mode: input.mode, label, creds, health });
}

/** A stand-in connection for tests and browser QA. It signs nothing for anyone and is refused in production. */
export async function connectSimulated(actor: CrmActor, input: { label?: string } = {}): Promise<ConnectionView> {
  const userId = await assertConnect(actor);
  if (!simulatedAllowed()) throw new AppError("forbidden", "The simulated signing service is not available in production.");
  const creds = { apiKey: `sim_${randomToken(12)}`, webhookKey: randomToken(24) };
  const health = await checkWith("simulated", creds);
  return saveConnection(actor, userId, { provider: "simulated", mode: "simulated", label: (input.label ?? "").replace(/\s+/g, " ").trim().slice(0, 80), creds, health });
}

/** Asks the service whether the key works. A service that cannot be reached is an error that saves and changes nothing. */
async function checkWith(provider: SigningProvider, creds: EsignCredentials): Promise<ProviderHealth> {
  try {
    return await providerFor(provider).health(creds);
  } catch (e) {
    if (e instanceof EsignProviderError) throw new AppError("upstream_error", `${PROVIDER_LABELS[provider]} could not be reached to check the key, so nothing was saved. ${e.message}`);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Checking, showing the webhook address, disconnecting
// ---------------------------------------------------------------------------

/** Tests the key now. A change for the worse is recorded and announced; a service that cannot be reached leaves the status as it was and says so. */
export async function checkConnection(actor: CrmActor): Promise<ConnectionView> {
  await assertConnect(actor);
  const row = await withSystem((db) => liveConnection(db, actor.orgId));
  if (!row) throw new AppError("not_found", "No signing service is connected.");
  const creds = openCredentials(row.credentials);
  const now = new Date();
  if (!creds) {
    await withSystem((db) => flagConnectionAttention(db, row.id, actor.orgId, "The saved keys can no longer be used. Connect the signing service again.", now));
  } else {
    let health: ProviderHealth;
    try {
      health = await providerFor(row.provider).health(creds);
    } catch (e) {
      throw new AppError("upstream_error", `${PROVIDER_LABELS[row.provider]} could not be reached just now, so the connection could not be checked. Nothing about it has changed. ${e instanceof EsignProviderError ? e.message : ""}`.trim());
    }
    await withSystem((db) => recordHealth(db, row, health, now));
  }
  const view = await crmRead(actor, (db) => connectionViewIn(db, actor.orgId));
  if (!view) throw new AppError("not_found", "No signing service is connected.");
  return view;
}

/** Records what the service said about the key. */
export async function recordHealth(db: Queryable, row: Pick<ConnectionRow, "id" | "org_id" | "status">, health: ProviderHealth, now: Date): Promise<void> {
  if (health.status === "connected") {
    await db.query(
      "update esign_connections set status = 'connected', status_detail = null, last_checked_at = $2::timestamptz, last_success_at = $2::timestamptz, account_label = coalesce($3, account_label) where id = $1 and status in ('connected', 'needs_attention', 'error')",
      [row.id, now.toISOString(), health.accountLabel],
    );
    return;
  }
  if (health.status === "needs_attention") {
    await flagConnectionAttention(db, row.id, row.org_id, health.detail, now);
    return;
  }
  await db.query("update esign_connections set status = 'error', status_detail = $2, last_checked_at = $3::timestamptz where id = $1 and status in ('connected', 'needs_attention', 'error')", [row.id, health.detail.slice(0, 400), now.toISOString()]);
}

/** The service refused the saved key (or it cannot be opened): the connection is shown as needing attention, nothing waiting on it is lost, and the owner and managers are told once a day. */
export async function flagConnectionAttention(db: Queryable, connectionId: string, orgId: string, detail: string, now: Date): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    "update esign_connections set status = 'needs_attention', status_detail = $3, last_checked_at = $4::timestamptz where id = $1 and org_id = $2 and status in ('connected', 'error', 'needs_attention') returning id",
    [connectionId, orgId, detail.slice(0, 400), now.toISOString()],
  );
  if (!rows[0]) return;
  await notifyOrgRoles(db, orgId, ["owner", "admin"], {
    kind: "signature_failed", severity: "warning", title: "Your signing service needs to be connected again",
    body: `${detail.slice(0, 200)} Requests waiting to be sent are on hold until it is connected again.`, link: "/proposals/settings", dedupeKey: `esign-attention:${connectionId}:${now.toISOString().slice(0, 10)}`,
  });
}

/** The address to give the signing service for its notices, for the owner or a manager. It is a secret address: shown on request, never stored, never put in a log. */
export async function getWebhookUrl(actor: CrmActor): Promise<{ url: string; provider: SigningProvider }> {
  await assertConnect(actor);
  const row = await withSystem((db) => liveConnection(db, actor.orgId));
  if (!row) throw new AppError("not_found", "No signing service is connected.");
  const token = tokenForStoredConnection(row.id, row.webhook_token_hash);
  if (!token) throw new AppError("conflict", "This address can't be shown again. Connect the signing service again to get a new one.");
  return { url: webhookUrl(token), provider: row.provider };
}

/**
 * Disconnects the signing service: the keys are deleted. Requests that are out are ended (a request that reached the service is marked for the business to withdraw there,
 * because iAcquire can no longer reach it), and a signature that arrives later is no longer accepted. The proposals themselves are untouched.
 */
export async function disconnect(actor: CrmActor): Promise<{ ended: number }> {
  const userId = await assertConnect(actor);
  return crmWrite(actor, async (db) => {
    const row = await liveConnection(db, actor.orgId, true);
    if (!row) throw new AppError("not_found", "No signing service is connected.");
    const ended = await disconnectRow(db, row, "Disconnected by a person.", userId);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.esign_disconnected", targetType: "esign_connection", targetId: row.id, result: "success", metadata: { provider: row.provider, ended } }, db);
    return { ended };
  });
}

async function disconnectRow(db: Queryable, row: ConnectionRow, detail: string, userId: string | null): Promise<number> {
  // Proposals first, in a fixed order, then their requests: the order every writer uses.
  const proposals = (await db.query<{ proposal_id: string }>(
    "select distinct proposal_id from signature_requests where connection_id = $1 and org_id = $2 and status in ('queued', 'sending', 'sent', 'viewed', 'unknown') order by proposal_id", [row.id, row.org_id],
  )).rows;
  let ended = 0;
  for (const p of proposals) {
    await db.query("select 1 from proposals where id = $1 and org_id = $2 for update", [p.proposal_id, row.org_id]);
    ended += await voidLiveRequestsInTx(db, row.org_id, p.proposal_id, "voided", "The signing service was disconnected.", { userId });
  }
  // The keys are gone, so nothing can be withdrawn at the service from here.
  await db.query("update signature_requests set cancel_state = 'manual' where connection_id = $1 and org_id = $2 and cancel_state = 'wanted'", [row.id, row.org_id]);
  await db.query("update esign_connections set status = 'disconnected', credentials = null, disconnected_at = now(), status_detail = $2 where id = $1", [row.id, detail]);
  return ended;
}

/**
 * Disconnects the signing service of a workspace that is being closed (offboarding): no signed-in member is involved, and the connection ends exactly as if its owner had
 * disconnected it. Returns how many requests were ended; a failure is returned by name so it is reported, not hidden.
 */
export async function disconnectWorkspaceEsign(orgId: string, actorUserId: string): Promise<{ disconnected: number; ended: number; failed: boolean }> {
  try {
    return await withSystem(async (db) => {
      const row = await liveConnection(db, orgId, true);
      if (!row) return { disconnected: 0, ended: 0, failed: false };
      const ended = await disconnectRow(db, row, "The workspace was closed.", null);
      await recordAudit({ orgId, actorUserId, actorKind: "agency", action: "proposals.esign_disconnected", targetType: "esign_connection", targetId: row.id, result: "success", metadata: { provider: row.provider, ended, why: "workspace_closed" } }, db);
      return { disconnected: 1, ended, failed: false };
    });
  } catch {
    return { disconnected: 0, ended: 0, failed: true };
  }
}
