import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { randomToken } from "@/server/security/crypto";
import type { OrgContext } from "@/server/tenancy/context";
import {
  checkoutBlock, CONNECTION_STATUS_EXPLAIN, CONNECTION_STATUS_LABELS, liveConfirmBlock, paymongoKeyProblem, paypalCredentialsProblem, paypalWebhookIdProblem, PROVIDER_LABELS, PROVIDER_STATE, webhookSecretProblem,
  type CheckoutBlock, type ConnectionMode, type ConnectionStatus, type PaymentProviderId, type PaypalEnvironment,
} from "@/lib/invoices/connection-rules";
import { connectSchema, replaceCredentialsSchema, webhookSecretSchema } from "@/lib/invoices/connection-schemas";
import { INVOICES_CLIENT_ONLY_MESSAGE, assertInvoicesAvailable } from "@/server/invoices/feature";
import { credentialVault, type ProviderCredentials } from "@/server/customer-payments/credentials";
import { newPublicKey } from "@/server/customer-payments/ids";
import { webhookUrlFor } from "@/server/customer-payments/links";
import { paymentSwitches } from "@/server/customer-payments/switches";
import { providerFor } from "@/server/customer-payments/providers";
import type { CredentialCheck, PaymentProviderAdapter } from "@/server/customer-payments/providers/types";

// The business's own payment account: connecting it, checking it, pausing it, confirming going live, disconnecting it. Only the owner does any of it
// (invoices.connect_payments), after accepting recorded wording, and the keys they paste go straight into the sealed column (credentials.ts): they are not echoed
// back, logged, audited, notified or shown again. iAcquire never holds the money; these keys are the business's own.
//
// What "connected" means is narrow on purpose. The provider accepted the key in a read-only call, and the webhook signing secret is saved. It does not mean the
// provider can reach this product or that a payment has ever worked: a test payment shows that, and a live connection stays closed to customers until the owner has
// seen one succeed and confirmed going live (and the service-wide live switch is on).

const NOT_OWNER = "Only the business owner can manage the payment connection.";
export const PROVIDER_CALLS_OFF = "Calls to real payment providers are switched off on this server, so nothing was saved or sent. Ask your iAcquire team to turn them on once that has been approved.";

interface ConnectionRow {
  id: string;
  org_id: string;
  provider: PaymentProviderId;
  mode: ConnectionMode;
  public_key: string;
  account_label: string | null;
  credentials: string | null;
  supported_currencies: string[];
  status: ConnectionStatus;
  authorized_by: string | null;
  authorized_at: Date | null;
  authorization_text_version: string | null;
  live_confirmed_at: Date | null;
  live_confirmed_by: string | null;
  last_event_at: Date | null;
  last_checked_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

const COLUMNS = `id, org_id, provider, mode, public_key, account_label, credentials, supported_currencies, status, authorized_by, authorized_at, authorization_text_version, live_confirmed_at,
  live_confirmed_by, last_event_at, last_checked_at, last_error, created_at`;

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export interface ConnectionView {
  id: string;
  provider: PaymentProviderId;
  providerLabel: string;
  providerNote: string;
  mode: ConnectionMode;
  status: ConnectionStatus;
  statusLabel: string;
  statusExplain: string;
  accountLabel: string | null;
  supportedCurrencies: string[];
  webhookUrl: string;
  /** PayPal only: whether the saved app is a sandbox or a live one. Null for every other provider, and when the keys cannot be read. */
  environment: PaypalEnvironment | null;
  /** The signing secret (PayPal: the webhook's id) is saved. */
  webhookSecretSaved: boolean;
  /** False when the saved keys can no longer be opened (the encryption key changed): they must be pasted again. */
  credentialsReadable: boolean;
  authorizedAt: string | null;
  authorizationVersion: string | null;
  liveConfirmedAt: string | null;
  lastEventAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  hasConfirmedTestPayment: boolean;
  /** Why the team cannot start a checkout through this connection, or null when they can. */
  teamCheckoutBlock: CheckoutBlock | null;
  /** Why a customer cannot be sent to it, or null. */
  customerCheckoutBlock: CheckoutBlock | null;
  /** Why the owner cannot confirm going live yet, or null when they can. */
  liveConfirmBlock: string | null;
}

async function hasConfirmedTestPayment(db: Queryable, orgId: string, provider: PaymentProviderId): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from customer_payments where org_id = $1 and provider = $2 and livemode = false and verification = 'provider_confirmed'
       and status in ('succeeded', 'partially_refunded', 'refunded', 'disputed') limit 1`,
    [orgId, provider],
  );
  return rows.length > 0;
}

async function viewOf(db: Queryable, r: ConnectionRow): Promise<ConnectionView> {
  const creds = credentialVault.open(r.credentials);
  const test = await hasConfirmedTestPayment(db, r.org_id, r.provider);
  const sw = paymentSwitches();
  const facts = { provider: r.provider, mode: r.mode, status: r.status, supportedCurrencies: r.supported_currencies, authorizedAt: r.authorized_at, liveConfirmedAt: r.live_confirmed_at };
  const currency = r.supported_currencies[0] ?? "PHP";
  return {
    id: r.id, provider: r.provider, providerLabel: PROVIDER_LABELS[r.provider], providerNote: PROVIDER_STATE[r.provider].note, mode: r.mode, status: r.status,
    statusLabel: CONNECTION_STATUS_LABELS[r.status], statusExplain: CONNECTION_STATUS_EXPLAIN[r.status], accountLabel: r.account_label, supportedCurrencies: r.supported_currencies,
    webhookUrl: webhookUrlFor(r.provider, r.public_key), environment: r.provider === "paypal" ? creds?.settings?.environment ?? null : null, webhookSecretSaved: Boolean(creds?.webhookSecret), credentialsReadable: r.status === "revoked" ? true : creds !== null,
    authorizedAt: iso(r.authorized_at), authorizationVersion: r.authorization_text_version, liveConfirmedAt: iso(r.live_confirmed_at), lastEventAt: iso(r.last_event_at), lastCheckedAt: iso(r.last_checked_at),
    lastError: r.last_error, createdAt: iso(r.created_at)!, hasConfirmedTestPayment: test,
    teamCheckoutBlock: checkoutBlock(facts, currency, sw, "member"), customerCheckoutBlock: checkoutBlock(facts, currency, sw, "public"),
    liveConfirmBlock: liveConfirmBlock({ connection: facts, hasConfirmedTestPayment: test }, sw),
  };
}

/** The workspace is a client's, and (unless `anyway`) invoicing is switched on for it; then the person is the owner. The reason given is the true one, in that order. */
async function authorize(db: Queryable, ctx: OrgContext, opts: { ignoreSwitch?: boolean } = {}): Promise<void> {
  if (opts.ignoreSwitch) {
    if (ctx.org.kind !== "client") throw new AppError("forbidden", INVOICES_CLIENT_ONLY_MESSAGE);
  } else {
    await assertInvoicesAvailable(db, ctx);
  }
  if (!ctx.can("invoices.connect_payments")) throw new AppError("forbidden", NOT_OWNER);
}

async function loadOwn(db: Queryable, ctx: OrgContext, id: string, lock = false): Promise<ConnectionRow> {
  const { rows } = await db.query<ConnectionRow>(`select ${COLUMNS} from customer_payment_connections where id = $1 and org_id = $2${lock ? " for update" : ""}`, [id, ctx.org.orgId]);
  if (!rows[0] || rows[0].status === "revoked") throw new AppError("not_found", "That payment connection was not found.");
  return rows[0];
}

/** A check that did not pass becomes the sentence the person is shown. */
function refuse(check: Extract<CredentialCheck, { ok: false }>): never {
  throw new AppError(check.reason === "rejected" ? "invalid_input" : "upstream_error", `${check.message} Nothing was saved.`);
}

function adapterFor(provider: PaymentProviderId): PaymentProviderAdapter {
  // providerFor refuses the simulated provider in production and PayPal (not built), each with its own sentence.
  return providerFor(provider);
}

/** Real providers are called only when the environment's switch is on; the simulated one reaches nothing and is open outside production. */
function assertCallsAllowed(provider: PaymentProviderId): void {
  if (provider !== "simulated" && !paymentSwitches().writesEnabled) throw new AppError("unavailable", PROVIDER_CALLS_OFF);
}

function cleanLabel(label: string | null | undefined): string | null {
  const t = (label ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  return t || null;
}

/** What the person typed, checked, as credentials for this provider. The simulated provider needs nothing typed: it makes its own. */
function credentialsFrom(
  provider: PaymentProviderId, typed: { apiKey?: string; apiSecret?: string; environment?: PaypalEnvironment; webhookSecret?: string | null }, adapter: PaymentProviderAdapter,
): { creds: ProviderCredentials; mode: ConnectionMode } {
  if (provider === "simulated") {
    const creds: ProviderCredentials = { apiKey: `sim_${randomToken(12)}`, webhookSecret: randomToken(24) };
    return { creds, mode: "test" };
  }
  const webhook = (typed.webhookSecret ?? "").trim();
  if (provider === "paypal") {
    const problem = paypalCredentialsProblem({ clientId: typed.apiKey ?? "", clientSecret: typed.apiSecret ?? "", environment: typed.environment });
    if (problem) throw new AppError("invalid_input", problem);
    if (webhook) {
      const idProblem = paypalWebhookIdProblem(webhook);
      if (idProblem) throw new AppError("invalid_input", idProblem);
    }
    const creds: ProviderCredentials = { apiKey: (typed.apiKey ?? "").trim(), apiSecret: (typed.apiSecret ?? "").trim(), webhookSecret: webhook || null, settings: { environment: typed.environment } };
    const mode = adapter.modeOf(creds);
    if (!mode) throw new AppError("invalid_input", "Say whether this is a sandbox (testing) app or a live one.");
    return { creds, mode };
  }
  const key = (typed.apiKey ?? "").trim();
  const keyProblem = paymongoKeyProblem(key);
  if (keyProblem) throw new AppError("invalid_input", keyProblem);
  if (webhook) {
    const problem = webhookSecretProblem(webhook);
    if (problem) throw new AppError("invalid_input", problem);
  }
  const creds: ProviderCredentials = { apiKey: key, webhookSecret: webhook || null };
  const mode = adapter.modeOf(creds);
  if (!mode) throw new AppError("invalid_input", "That does not look like a key for this provider.");
  return { creds, mode };
}

/** The connections of the workspace that are not disconnected. Owner only. */
export async function listConnections(ctx: OrgContext): Promise<ConnectionView[]> {
  return withSystem(async (db) => {
    await authorize(db, ctx);
    const { rows } = await db.query<ConnectionRow>(`select ${COLUMNS} from customer_payment_connections where org_id = $1 and status <> 'revoked' order by created_at`, [ctx.org.orgId]);
    return Promise.all(rows.map((r) => viewOf(db, r)));
  });
}

/**
 * Connects the business's own payment account. The key is checked with a read-only call to the provider BEFORE anything is saved, so a row that exists is a key the
 * provider accepted; the webhook secret may be added afterwards (the connection's address, which the provider needs to be given, exists only once the row does).
 */
export async function connectProvider(ctx: OrgContext, rawInput: unknown): Promise<ConnectionView> {
  const input = connectSchema.parse(rawInput);
  await withSystem(async (db) => {
    await authorize(db, ctx);
    const open = await db.query("select 1 from customer_payment_connections where org_id = $1 and provider = $2 and status <> 'revoked'", [ctx.org.orgId, input.provider]);
    if (open.rows[0]) throw new AppError("conflict", `A ${PROVIDER_LABELS[input.provider]} account is already connected. Replace its keys, or disconnect it first.`);
  });
  const adapter = adapterFor(input.provider);
  assertCallsAllowed(input.provider);
  const { creds, mode } = credentialsFrom(input.provider, input, adapter);
  const publicKey = newPublicKey();
  const check = await adapter.verifyCredentials(creds, { webhookUrl: webhookUrlFor(input.provider, publicKey) });
  if (!check.ok) refuse(check);
  const label = cleanLabel(input.accountLabel) ?? check.accountLabel;

  return withSystem(async (db) => {
    await authorize(db, ctx);
    let id: string;
    try {
      const { rows } = await db.query<{ id: string }>(
        `insert into customer_payment_connections (org_id, provider, mode, public_key, account_label, credentials, supported_currencies, status, authorized_by, authorized_at,
           authorization_text_version, last_checked_at, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, now(), $9) returning id`,
        [ctx.org.orgId, input.provider, mode, publicKey, label, credentialVault.seal(creds), adapter.supportedCurrencies, creds.webhookSecret ? "connected" : "pending_verification", ctx.user.id, input.authorization.version],
      );
      id = rows[0].id;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new AppError("conflict", `A ${PROVIDER_LABELS[input.provider]} account is already connected. Replace its keys, or disconnect it first.`);
      throw e;
    }
    await recordAudit({
      orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "payments.connection_created", targetType: "customer_payment_connection", targetId: id, result: "success",
      // (Named so the audit sanitizer, which blanks anything called a secret or an authorization, keeps the facts: no key or secret is in here.)
      metadata: { provider: input.provider, mode, wordingVersion: input.authorization.version, webhookReady: Boolean(creds.webhookSecret), webhookSeenAtProvider: check.webhookFound },
    }, db);
    return viewOf(db, await loadOwn(db, ctx, id));
  });
}

/** Saves the signing secret of the webhook the owner created at the provider. Until it is saved, deliveries from the provider are refused. */
export async function saveWebhookSecret(ctx: OrgContext, id: string, rawInput: unknown): Promise<ConnectionView> {
  const secret = webhookSecretSchema.parse(rawInput).webhookSecret.trim();
  return withSystem(async (db) => {
    await authorize(db, ctx);
    const row = await loadOwn(db, ctx, id, true);
    const problem = row.provider === "paypal" ? paypalWebhookIdProblem(secret) : webhookSecretProblem(secret);
    if (problem) throw new AppError("invalid_input", problem);
    const creds = credentialVault.open(row.credentials);
    if (!creds) throw new AppError("conflict", "The saved keys can no longer be read. Paste the secret key again with Replace keys.");
    await db.query("update customer_payment_connections set credentials = $3, status = case when status = 'pending_verification' then 'connected' else status end where id = $1 and org_id = $2", [id, ctx.org.orgId, credentialVault.seal({ ...creds, webhookSecret: secret })]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "payments.webhook_secret_saved", targetType: "customer_payment_connection", targetId: id, result: "success", metadata: { provider: row.provider } }, db);
    return viewOf(db, await loadOwn(db, ctx, id));
  });
}

/**
 * Replaces the keys (a rotated key, or test keys exchanged for live ones). The new key is checked before anything changes. A replaced key is a new relationship with
 * the provider, possibly another account, so a live confirmation never carries over: the owner confirms again. The webhook's signing secret is carried over only when the
 * mode stays the same (a rotated key): the test webhook and the live webhook (for PayPal, the sandbox app's and the live app's) are different webhooks with secrets of their
 * own, so exchanging test keys for live ones, or the reverse, waits for the other mode's secret instead of reading as connected while no delivery could be believed.
 */
export async function replaceCredentials(ctx: OrgContext, id: string, rawInput: unknown): Promise<ConnectionView> {
  const input = replaceCredentialsSchema.parse(rawInput);
  const row = await withSystem(async (db) => {
    await authorize(db, ctx);
    return loadOwn(db, ctx, id);
  });
  if (row.provider === "simulated") throw new AppError("invalid_input", "The simulated provider makes its own keys.");
  const adapter = adapterFor(row.provider);
  assertCallsAllowed(row.provider);
  const kept = credentialVault.open(row.credentials);
  const typed = credentialsFrom(row.provider, { apiKey: input.apiKey, apiSecret: input.apiSecret, environment: input.environment ?? kept?.settings?.environment, webhookSecret: input.webhookSecret ?? null }, adapter);
  const { mode } = typed;
  const creds: ProviderCredentials = typed.creds.webhookSecret || mode !== row.mode ? typed.creds : { ...typed.creds, webhookSecret: kept?.webhookSecret ?? null };
  const check = await adapter.verifyCredentials(creds, { webhookUrl: webhookUrlFor(row.provider, row.public_key) });
  if (!check.ok) refuse(check);

  return withSystem(async (db) => {
    await authorize(db, ctx);
    const locked = await loadOwn(db, ctx, id, true);
    // (In the update, `mode` on the right of an assignment is the mode before it: what the other mode's webhook last said is not shown as this connection's last message.)
    await db.query(
      `update customer_payment_connections set credentials = $3, mode = $4, status = $5, live_confirmed_at = null, live_confirmed_by = null, authorized_by = $6, authorized_at = now(),
         authorization_text_version = $7, last_checked_at = now(), last_error = null, last_event_at = case when mode <> $4 then null else last_event_at end where id = $1 and org_id = $2`,
      [id, ctx.org.orgId, credentialVault.seal(creds), mode, creds.webhookSecret ? "connected" : "pending_verification", ctx.user.id, input.authorization.version],
    );
    await recordAudit({
      orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "payments.credentials_replaced", targetType: "customer_payment_connection", targetId: id, result: "success",
      metadata: { provider: locked.provider, from: locked.mode, to: mode, wordingVersion: input.authorization.version, webhookSeenAtProvider: check.webhookFound },
    }, db);
    return viewOf(db, await loadOwn(db, ctx, id));
  });
}

/** Asks the provider, read-only, whether it still accepts the saved key. A rejected key stops new payments; an unreachable provider changes nothing but the note. */
export async function recheckConnection(ctx: OrgContext, id: string): Promise<ConnectionView> {
  const row = await withSystem(async (db) => {
    await authorize(db, ctx);
    return loadOwn(db, ctx, id);
  });
  const adapter = adapterFor(row.provider);
  assertCallsAllowed(row.provider);
  const creds = credentialVault.open(row.credentials);
  const check: CredentialCheck = creds
    ? await adapter.verifyCredentials(creds, { webhookUrl: webhookUrlFor(row.provider, row.public_key) })
    : { ok: false, reason: "rejected", message: "The saved keys can no longer be read. Paste the secret key again with Replace keys." };
  return withSystem(async (db) => {
    await authorize(db, ctx);
    await loadOwn(db, ctx, id, true);
    if (check.ok) {
      await db.query(
        "update customer_payment_connections set last_checked_at = now(), last_error = null, status = case when status in ('needs_attention', 'pending_verification') and $3::boolean then 'connected' when status = 'needs_attention' then 'pending_verification' else status end where id = $1 and org_id = $2",
        [id, ctx.org.orgId, Boolean(creds?.webhookSecret)],
      );
    } else if (check.reason === "rejected") {
      await db.query("update customer_payment_connections set last_checked_at = now(), last_error = $3, status = case when status in ('connected', 'pending_verification') then 'needs_attention' else status end where id = $1 and org_id = $2", [id, ctx.org.orgId, check.message.slice(0, 400)]);
    } else {
      await db.query("update customer_payment_connections set last_checked_at = now(), last_error = $3 where id = $1 and org_id = $2", [id, ctx.org.orgId, check.message.slice(0, 400)]);
    }
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "payments.connection_checked", targetType: "customer_payment_connection", targetId: id, result: check.ok ? "success" : "failure", metadata: { provider: row.provider, outcome: check.ok ? "accepted" : check.reason } }, db);
    return viewOf(db, await loadOwn(db, ctx, id));
  });
}

/**
 * The owner's decision to let real customers pay with real money. It needs: live keys, a connected account, the owner's recorded authorization, a test payment the
 * provider confirmed earlier, the environment's calls switch and the service-wide live switch. Nothing else turns live on.
 */
export async function confirmLive(ctx: OrgContext, id: string): Promise<ConnectionView> {
  return withSystem(async (db) => {
    await authorize(db, ctx);
    const row = await loadOwn(db, ctx, id, true);
    const view = await viewOf(db, row);
    if (view.liveConfirmBlock) throw new AppError("conflict", view.liveConfirmBlock);
    await db.query("update customer_payment_connections set live_confirmed_at = now(), live_confirmed_by = $3 where id = $1 and org_id = $2", [id, ctx.org.orgId, ctx.user.id]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "payments.live_confirmed", targetType: "customer_payment_connection", targetId: id, result: "success", metadata: { provider: row.provider } }, db);
    return viewOf(db, await loadOwn(db, ctx, id));
  });
}

/**
 * Stops new online payments without disconnecting. Payments already in progress are still recorded when the provider confirms them. An account that needs attention is not
 * paused (the pause would hide that the provider refused its key): the owner checks or replaces the keys. Resuming never trusts what was true before the pause: the provider
 * is asked about the saved key again, and the account comes back as connected only if it accepts it.
 */
export async function setConnectionPaused(ctx: OrgContext, id: string, paused: boolean): Promise<ConnectionView> {
  if (paused) {
    return withSystem(async (db) => {
      await authorize(db, ctx);
      const row = await loadOwn(db, ctx, id, true);
      if (row.status === "disabled") return viewOf(db, row);
      if (row.status === "needs_attention") throw new AppError("conflict", "This payment account needs attention: the provider did not accept its key, so it is not taking new payments already. Use Check the keys now, or replace the keys, instead of pausing it.");
      await db.query("update customer_payment_connections set status = 'disabled' where id = $1 and org_id = $2", [id, ctx.org.orgId]);
      await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "payments.connection_paused", targetType: "customer_payment_connection", targetId: id, result: "success", metadata: { provider: row.provider } }, db);
      return viewOf(db, await loadOwn(db, ctx, id));
    });
  }

  const row = await withSystem(async (db) => {
    await authorize(db, ctx);
    return loadOwn(db, ctx, id);
  });
  if (row.status !== "disabled") return withSystem(async (db) => viewOf(db, row));
  const adapter = adapterFor(row.provider);
  assertCallsAllowed(row.provider);
  const creds = credentialVault.open(row.credentials);
  const check: CredentialCheck = creds
    ? await adapter.verifyCredentials(creds, { webhookUrl: webhookUrlFor(row.provider, row.public_key) })
    : { ok: false, reason: "rejected", message: "The saved keys can no longer be read. Paste the secret key again with Replace keys." };
  // Not known whether the provider accepts the key: it stays paused, and the person is told why, rather than going live on a guess.
  if (!check.ok && check.reason === "unreachable") throw new AppError("upstream_error", `The account stays paused: the provider could not be asked about its key just now. ${check.message}`);

  return withSystem(async (db) => {
    await authorize(db, ctx);
    const locked = await loadOwn(db, ctx, id, true);
    if (locked.status !== "disabled") return viewOf(db, locked);
    const status: ConnectionStatus = !check.ok ? "needs_attention" : creds?.webhookSecret ? "connected" : "pending_verification";
    await db.query("update customer_payment_connections set status = $3, last_checked_at = now(), last_error = $4 where id = $1 and org_id = $2", [id, ctx.org.orgId, status, check.ok ? null : check.message.slice(0, 400)]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "payments.connection_resumed", targetType: "customer_payment_connection", targetId: id, result: check.ok ? "success" : "failure", metadata: { provider: row.provider, status } }, db);
    return viewOf(db, await loadOwn(db, ctx, id));
  });
}

/**
 * What disconnecting does, whoever asks: the saved keys are deleted, the live confirmation is cleared, and the checkouts waiting to be paid are cancelled on our side.
 * A customer who already has a provider checkout page open can still pay there, but this product can no longer verify the delivery, so that payment is not recorded here:
 * the business records it by hand.
 */
async function revokeRow(db: Queryable, orgId: string, id: string): Promise<number> {
  await db.query("update customer_payment_connections set status = 'revoked', credentials = null, live_confirmed_at = null, live_confirmed_by = null, last_error = null where id = $1 and org_id = $2", [id, orgId]);
  const cancelled = await db.query("update customer_payment_attempts set status = 'cancelled' where connection_id = $1 and org_id = $2 and status in ('created', 'redirected')", [id, orgId]);
  return cancelled.rowCount;
}

export async function revokeConnection(ctx: OrgContext, id: string): Promise<{ cancelledCheckouts: number }> {
  return withSystem(async (db) => {
    // Disconnecting is allowed even when invoicing was switched off for the workspace afterwards: the keys are the owner's to take back.
    await authorize(db, ctx, { ignoreSwitch: true });
    const row = await loadOwn(db, ctx, id, true);
    const cancelledCheckouts = await revokeRow(db, ctx.org.orgId, id);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "payments.connection_revoked", targetType: "customer_payment_connection", targetId: id, result: "success", metadata: { provider: row.provider, cancelledCheckouts } }, db);
    return { cancelledCheckouts };
  });
}

export interface DeliveryView {
  id: string;
  at: string;
  type: string;
  outcome: string;
  /** What happened to it, in the product's words. Never the body of the delivery (none is kept). */
  note: string | null;
  attempts: number;
}

/** The last deliveries a connection received, for the owner to see that the provider is reaching this product and what became of each. Owner only. */
export async function listRecentDeliveries(ctx: OrgContext, connectionId: string, limit = 10): Promise<DeliveryView[]> {
  return withSystem(async (db) => {
    await authorize(db, ctx);
    await loadOwn(db, ctx, connectionId);
    const { rows } = await db.query<{ id: string; received_at: Date; event_type: string; outcome: string; detail: { note?: string; error?: string }; attempts: number }>(
      "select id, received_at, event_type, outcome, detail, attempts from customer_payment_events where connection_id = $1 and org_id = $2 order by received_at desc, id desc limit $3", [connectionId, ctx.org.orgId, Math.min(Math.max(limit, 1), 50)],
    );
    return rows.map((r) => ({ id: r.id, at: new Date(r.received_at).toISOString(), type: r.event_type, outcome: r.outcome, note: r.detail?.note ?? r.detail?.error ?? null, attempts: r.attempts }));
  });
}

/** Disconnects every payment account of a workspace that is being closed (offboarding): no signed-in member is involved, and each ends exactly as if the owner had done it. */
export async function revokeWorkspaceConnections(orgId: string, actorUserId: string): Promise<{ revoked: number; cancelledCheckouts: number; failed: string[] }> {
  const ids = (await withSystem((db) => db.query<{ id: string; provider: string }>("select id, provider from customer_payment_connections where org_id = $1 and status <> 'revoked' order by created_at", [orgId]))).rows;
  let revoked = 0;
  let cancelledCheckouts = 0;
  const failed: string[] = [];
  for (const c of ids) {
    try {
      cancelledCheckouts += await withSystem(async (db) => {
        const n = await revokeRow(db, orgId, c.id);
        await recordAudit({ orgId, actorUserId, actorKind: "agency", action: "payments.connection_revoked", targetType: "customer_payment_connection", targetId: c.id, result: "success", metadata: { provider: c.provider, cancelledCheckouts: n, reason: "offboarding" } }, db);
        return n;
      });
      revoked += 1;
    } catch {
      failed.push(PROVIDER_LABELS[c.provider as PaymentProviderId] ?? c.provider);
    }
  }
  return { revoked, cancelledCheckouts, failed };
}
