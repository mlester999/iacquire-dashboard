import "server-only";
import { z } from "zod";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { isValidTimeZone } from "@/lib/calendars/slots";
import { todayIn } from "@/lib/invoices/state";
import { checkManualPayment, MAX_MANUAL_PAYMENT_CENTS } from "@/lib/billing-clearance";
import { createClientTenant } from "@/server/admin/tenants";
import { recordManualPayment } from "@/server/billing/manual";
import { recordProviderSetupPayment, type AdoptedCheckout } from "@/server/billing/provider-setup-payment";
import { checkoutAvailability } from "@/server/purchase-intents/availability";
import type { SessionUser } from "@/server/auth/service";
import {
  canBuyerStart, canCancel, canProvision, canReleaseHold, canRotateLink, canVerifyPayment, effectiveStatus, formatUsdCents, HELD_BUYER_TEXT, provisionHoldText, PURCHASE_LINK_DAYS, PURCHASE_STATUS_TEXT, PURCHASE_STATUS_TONE,
  priceSnapshot, setupFeeMicros, type CheckoutStatus, type PriceSnapshot, type PurchaseStatus,
} from "@/lib/purchase-intents/rules";
import { hashPurchaseToken, looksLikePurchaseToken, newPurchaseReference, newPurchaseToken } from "@/server/purchase-intents/tokens";

// Purchase intents: the one commercial path from an invited prospect to a client workspace. A row freezes the approved offer, the public link is a bearer credential of
// which only a hash is stored, the buyer confirms, a Super Admin records the verified payment with its reference, and only then can the existing client-creation and
// billing services make a workspace. Nothing here sends a real email or charges a card; the invite URL is returned to the person who created it, to send through their
// own channel until an email provider is approved. Every write is server-side (withSystem); the application role can only read.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

export const createPurchaseIntentSchema = z.object({
  buyerName: z.string().trim().min(2, "Enter the buyer's name.").max(120),
  buyerEmail: z.string().trim().toLowerCase().email("Enter a valid email address.").max(254),
  company: z.string().trim().min(2, "Enter the company name.").max(120),
  industry: z.string().trim().max(120).optional().default(""),
  website: z.string().trim().max(300).optional().default(""),
  timezone: z.string().trim().max(64).optional().default("America/Chicago"),
  maintenanceSelected: z.boolean().optional().default(false),
  // The Super Admin who invites the buyer may allow the workspace to be created the moment the payment provider confirms the payment. Off unless chosen.
  autoProvision: z.boolean().optional().default(false),
});
export type CreatePurchaseIntentInput = z.input<typeof createPurchaseIntentSchema>;

export const purchasePaymentSchema = z.object({
  amount: z.string().trim().min(1, "Enter the amount."),
  method: z.string().trim().max(40),
  externalReference: z.string().trim().max(120),
  paidOn: z.string().trim().max(10),
  note: z.string().trim().max(1000),
});
export type PurchasePaymentInput = z.input<typeof purchasePaymentSchema>;

export interface IntentRow {
  id: string;
  agency_org_id: string;
  reference: string;
  buyer_name: string;
  buyer_email: string;
  company: string;
  industry: string;
  website: string;
  timezone: string;
  maintenance_selected: boolean;
  setup_fee_cents: number;
  maintenance_monthly_cents: number;
  currency: string;
  product_version: string;
  status: string;
  expires_at: Date;
  started_at: Date | null;
  payment_at: Date | null;
  provisioned_at: Date | null;
  cancelled_at: Date | null;
  expired_at: Date | null;
  payment_method: string | null;
  payment_reference: string | null;
  payment_paid_on: string | null;
  payment_note: string | null;
  payment_amount_cents: number | null;
  payment_id: string | null;
  client_org_id: string | null;
  auto_provision: boolean;
  payment_source: "manual" | "provider";
  payment_checkout_id: string | null;
  payment_hold: "refunded" | "disputed" | "mismatch" | null;
  provision_attempts: number;
  last_provision_error: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface PurchaseIntentView {
  id: string;
  reference: string;
  buyerName: string;
  buyerEmail: string;
  company: string;
  industry: string;
  website: string;
  timezone: string;
  maintenanceSelected: boolean;
  setupFeeCents: number;
  maintenanceMonthlyCents: number;
  currency: string;
  productVersion: string;
  status: PurchaseStatus;
  storedStatus: PurchaseStatus;
  statusText: string;
  statusTone: "neutral" | "primary" | "warning" | "success" | "danger";
  expiresAt: string;
  startedAt: string | null;
  paymentAt: string | null;
  provisionedAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  paymentPaidOn: string | null;
  paymentNote: string | null;
  paymentAmountCents: number | null;
  clientOrgId: string | null;
  autoProvision: boolean;
  paymentSource: "manual" | "provider";
  paymentHold: "refunded" | "disputed" | "mismatch" | null;
  holdText: string | null;
  provisionAttempts: number;
  lastProvisionError: string | null;
  createdAt: string;
  can: { start: boolean; verify: boolean; provision: boolean; cancel: boolean; rotate: boolean; release: boolean };
}

export interface PublicPurchaseView {
  reference: string;
  buyerName: string;
  buyerEmail: string;
  company: string;
  industry: string;
  setupFeeCents: number;
  maintenanceMonthlyCents: number;
  maintenanceSelected: boolean;
  currency: string;
  status: PurchaseStatus;
  statusText: string;
  expiresAt: string;
  canConfirm: boolean;
  problem: string | null;
  /** Online checkout: whether a Pay button is offered, and what the last attempt came to (never a link: the link is only handed out by starting a checkout). */
  checkout: { offered: boolean; status: CheckoutStatus | null; reference: string | null };
}

interface Actor {
  id: string;
  platformRole: string;
  view: boolean;
  manage: boolean;
  billingManage: boolean;
  clientsCreate: boolean;
  agencyOrgId: string | null;
}

async function actorFor(db: Queryable, user: SessionUser): Promise<Actor> {
  const { rows } = await db.query<{ active: boolean; role: string; view: boolean; manage: boolean; billing: boolean; clients: boolean; agency_org: string | null }>(
    `select u.status = 'active' as active, u.platform_role as role,
            coalesce(app.user_has_agency_permission(u.id, 'agency.prospects.view'), false) as view,
            coalesce(app.user_has_agency_permission(u.id, 'agency.prospects.manage'), false) as manage,
            coalesce(app.user_has_agency_permission(u.id, 'billing.agency_manage'), false) as billing,
            coalesce(app.user_has_agency_permission(u.id, 'agency.clients.create'), false) as clients,
            (select o.id from organizations o where o.kind = 'agency') as agency_org
       from users u where u.id = $1`,
    [user.id],
  );
  const row = rows[0];
  if (!row?.active || row.role !== user.platformRole || row.role === "none") throw new AppError("forbidden", "Agency access is required; authorization has changed.");
  return { id: user.id, platformRole: row.role, view: row.view, manage: row.manage, billingManage: row.billing, clientsCreate: row.clients, agencyOrgId: row.agency_org };
}

function requireView(actor: Actor): string {
  if (!actor.view || !actor.agencyOrgId) throw new AppError("forbidden", "Your agency role does not allow purchase intents.");
  return actor.agencyOrgId;
}

function requireManage(actor: Actor): string {
  const agency = requireView(actor);
  if (!actor.manage) throw new AppError("forbidden", "Only a Super Admin can manage purchase intents.");
  return agency;
}

function requireProvision(actor: Actor): string {
  const agency = requireManage(actor);
  if (!actor.billingManage || !actor.clientsCreate) throw new AppError("forbidden", "Creating a workspace from a purchase needs the billing and client-creation permissions.");
  return agency;
}

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());
export const statusOf = (row: IntentRow, now: Date): PurchaseStatus => effectiveStatus({ status: row.status as PurchaseStatus, expiresAt: new Date(row.expires_at).toISOString() }, now);

function toView(row: IntentRow, now: Date): PurchaseIntentView {
  const state = { status: row.status as PurchaseStatus, expiresAt: new Date(row.expires_at).toISOString() };
  const status = statusOf(row, now);
  return {
    id: row.id,
    reference: row.reference,
    buyerName: row.buyer_name,
    buyerEmail: row.buyer_email,
    company: row.company,
    industry: row.industry,
    website: row.website,
    timezone: row.timezone,
    maintenanceSelected: row.maintenance_selected,
    setupFeeCents: row.setup_fee_cents,
    maintenanceMonthlyCents: row.maintenance_monthly_cents,
    currency: row.currency,
    productVersion: row.product_version,
    status,
    storedStatus: row.status as PurchaseStatus,
    // A purchase closed after its payment was verified (refunded or disputed) is not an ordinary cancellation: the money record is still on it.
    statusText: status === "cancelled" && row.payment_reference ? "Closed after payment" : PURCHASE_STATUS_TEXT[status],
    statusTone: PURCHASE_STATUS_TONE[status],
    expiresAt: new Date(row.expires_at).toISOString(),
    startedAt: iso(row.started_at),
    paymentAt: iso(row.payment_at),
    provisionedAt: iso(row.provisioned_at),
    cancelledAt: iso(row.cancelled_at),
    expiredAt: iso(row.expired_at),
    paymentMethod: row.payment_method,
    paymentReference: row.payment_reference,
    paymentPaidOn: row.payment_paid_on,
    paymentNote: row.payment_note,
    paymentAmountCents: row.payment_amount_cents,
    clientOrgId: row.client_org_id,
    autoProvision: row.auto_provision,
    paymentSource: row.payment_source,
    paymentHold: row.payment_hold,
    holdText: provisionHoldText(row.payment_hold),
    provisionAttempts: row.provision_attempts,
    lastProvisionError: row.last_provision_error,
    createdAt: new Date(row.created_at).toISOString(),
    can: {
      start: canBuyerStart(state, now).ok,
      verify: canVerifyPayment(state, now).ok,
      provision: canProvision(state, row.client_org_id, now, row.payment_hold).ok,
      cancel: canCancel(state, now, row.payment_hold).ok,
      rotate: canRotateLink(state, now).ok,
      release: canReleaseHold(state, row.payment_hold, now).ok,
    },
  };
}

const publicProblem = (status: PurchaseStatus, payOnline = false, held = false): string | null =>
  status === "expired" ? "This purchase link has expired. Ask iAcquire for a new one."
    : status === "cancelled" ? "This purchase was cancelled."
      : held && (status === "started" || status === "payment_verified") ? HELD_BUYER_TEXT
      : status === "started" ? (payOnline ? null : "Your purchase is confirmed. iAcquire will verify the payment and send your workspace invitation.")
        : status === "payment_verified" ? "Your payment is confirmed. iAcquire is creating your workspace and will email your invitation."
          : status === "provisioned" ? "Your workspace is ready. Check the email address on this purchase for your invitation."
          : null;

function toPublic(row: IntentRow, now: Date, checkout: PublicPurchaseView["checkout"] = { offered: false, status: null, reference: null }): PublicPurchaseView {
  const status = statusOf(row, now);
  return {
    reference: row.reference,
    buyerName: row.buyer_name,
    buyerEmail: row.buyer_email,
    company: row.company,
    industry: row.industry,
    setupFeeCents: row.setup_fee_cents,
    maintenanceMonthlyCents: row.maintenance_monthly_cents,
    maintenanceSelected: row.maintenance_selected,
    currency: row.currency,
    status,
    statusText: PURCHASE_STATUS_TEXT[status],
    expiresAt: new Date(row.expires_at).toISOString(),
    canConfirm: status === "invited",
    problem: publicProblem(status, checkout.offered, row.payment_hold !== null),
    checkout,
  };
}

export const SELECT = `select id, agency_org_id, reference, buyer_name, buyer_email, company, industry, website, timezone, maintenance_selected, setup_fee_cents,
  maintenance_monthly_cents, currency, product_version, status, expires_at, started_at, payment_at, provisioned_at, cancelled_at, expired_at,
  payment_method, payment_reference, to_char(payment_paid_on, 'YYYY-MM-DD') as payment_paid_on, payment_note, payment_amount_cents, payment_id, client_org_id,
  auto_provision, payment_source, payment_checkout_id, payment_hold, provision_attempts, last_provision_error, created_by, created_at, updated_at
  from purchase_intents`;

export async function addEvent(db: Queryable, intentId: string, agencyOrgId: string, kind: string, detail: Record<string, unknown> = {}, actorId: string | null = null, actorKind: "user" | "system" | "buyer" = "system") {
  await db.query(
    "insert into purchase_intent_events (intent_id, agency_org_id, kind, detail, actor_id, actor_kind) values ($1, $2, $3, $4::jsonb, $5, $6)",
    [intentId, agencyOrgId, kind, JSON.stringify(detail), actorId, actorKind],
  );
}

/** Marks open links that have run out, so the list and the buyer both read the same state. Returns how many changed. */
async function expireDue(db: Queryable, now: Date): Promise<number> {
  const { rows } = await db.query<{ id: string; agency_org_id: string }>(
    `update purchase_intents set status = 'expired', expired_at = $1
      where status in ('invited', 'started') and expires_at <= $1::timestamptz returning id, agency_org_id`, [now.toISOString()],
  );
  for (const row of rows) await addEvent(db, row.id, row.agency_org_id, "expired", { at: now.toISOString() });
  return rows.length;
}

export interface CreatedPurchaseIntent {
  id: string;
  reference: string;
  /** The only copy of the raw link token; it is never stored and cannot be recovered after this answer. */
  token: string;
  expiresAt: string;
}

/** Creates one invitation and freezes the approved price. A buyer with an open intent cannot be invited twice; cancel or reuse the first link. */
export async function createPurchaseIntent(user: SessionUser, input: CreatePurchaseIntentInput, opts: { now?: Date } = {}): Promise<CreatedPurchaseIntent> {
  const data = createPurchaseIntentSchema.parse(input);
  if (!isValidTimeZone(data.timezone)) throw new AppError("invalid_input", "Choose a valid time zone.");
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    const actor = await actorFor(db, user);
    // Letting a payment create a workspace by itself is a decision about billing and client creation as well as about the buyer: the person who allows it must hold both.
    const agency = data.autoProvision ? requireProvision(actor) : requireManage(actor);
    await expireDue(db, now);
    const existing = await db.query<{ id: string; reference: string }>(
      "select id, reference from purchase_intents where agency_org_id = $1 and buyer_email = $2 and status in ('invited', 'started', 'payment_verified') limit 1",
      [agency, data.buyerEmail],
    );
    if (existing.rows[0]) throw new AppError("conflict", `That buyer already has an open purchase (${existing.rows[0].reference}). Use its existing link or cancel it first.`);
    const snapshot: PriceSnapshot = priceSnapshot(data.maintenanceSelected);
    const token = newPurchaseToken();
    const reference = newPurchaseReference();
    const expiresAt = new Date(now.getTime() + PURCHASE_LINK_DAYS * 86_400_000);
    const { rows } = await db.query<{ id: string }>(
      `insert into purchase_intents (agency_org_id, token_hash, reference, buyer_name, buyer_email, company, industry, website, timezone, maintenance_selected,
         setup_fee_cents, maintenance_monthly_cents, currency, product_version, status, expires_at, created_by, auto_provision)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'invited', $15, $16, $17) returning id`,
      [agency, hashPurchaseToken(token), reference, data.buyerName, data.buyerEmail, data.company, data.industry, data.website, data.timezone, data.maintenanceSelected,
        snapshot.setupFeeCents, snapshot.maintenanceMonthlyCents, snapshot.currency, snapshot.productVersion, expiresAt.toISOString(), user.id, data.autoProvision],
    );
    const id = rows[0].id;
    await addEvent(db, id, agency, "created", { reference, setupFeeCents: snapshot.setupFeeCents, maintenanceSelected: data.maintenanceSelected, autoProvision: data.autoProvision, expiresAt: expiresAt.toISOString() }, user.id, "user");
    await recordAudit({ orgId: agency, actorUserId: user.id, actorKind: "agency", action: "purchase_intent.created", targetType: "purchase_intent", targetId: id, result: "success",
      metadata: { reference, setupFeeCents: snapshot.setupFeeCents, maintenanceSelected: data.maintenanceSelected, autoProvision: data.autoProvision, expiresAt: expiresAt.toISOString() } }, db);
    return { id, reference, token, expiresAt: expiresAt.toISOString() };
  });
}

export async function listPurchaseIntents(user: SessionUser, opts: { now?: Date } = {}): Promise<PurchaseIntentView[]> {
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    const actor = await actorFor(db, user);
    const agency = requireView(actor);
    await expireDue(db, now);
    const { rows } = await db.query<IntentRow>(`${SELECT} where agency_org_id = $1 order by created_at desc, id desc limit 200`, [agency]);
    return rows.map((row) => toView(row, now));
  });
}

export async function getPurchaseIntent(user: SessionUser, id: unknown, opts: { now?: Date } = {}): Promise<PurchaseIntentView> {
  if (!isId(id)) throw new AppError("not_found", "That purchase was not found.");
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    const actor = await actorFor(db, user);
    const agency = requireView(actor);
    await expireDue(db, now);
    const row = (await db.query<IntentRow>(`${SELECT} where id = $1 and agency_org_id = $2`, [id, agency])).rows[0];
    if (!row) throw new AppError("not_found", "That purchase was not found.");
    return toView(row, now);
  });
}

export async function byToken(db: Queryable, token: unknown, now: Date): Promise<IntentRow | null> {
  if (!looksLikePurchaseToken(token)) return null;
  const row = (await db.query<IntentRow>(`${SELECT} where token_hash = $1`, [hashPurchaseToken(token)])).rows[0];
  if (!row) return null;
  if (statusOf(row, now) === "expired" && row.status !== "expired") {
    await db.query("update purchase_intents set status = 'expired', expired_at = $2 where id = $1 and status in ('invited', 'started')", [row.id, now.toISOString()]);
    await addEvent(db, row.id, row.agency_org_id, "expired", { at: now.toISOString() });
    row.status = "expired";
    row.expired_at = now;
  }
  return row;
}

/** What the holder of a link sees. An invalid, cancelled or expired link is a plain, safe answer; no id, buyer list or payment note is exposed. */
export async function getPublicPurchase(token: unknown, opts: { now?: Date } = {}): Promise<PublicPurchaseView | null> {
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    const row = await byToken(db, token, now);
    if (!row) return null;
    const latest = (await db.query<{ status: CheckoutStatus; reference_number: string }>(
      "select status, reference_number from purchase_intent_checkouts where intent_id = $1 order by created_at desc, id desc limit 1", [row.id],
    )).rows[0];
    const availability = await checkoutAvailability(db);
    // The button is offered only when a checkout could actually be opened, and never once a payment is already on this purchase.
    const offered = availability.available && statusOf(row, now) === "started" && !row.payment_hold && latest?.status !== "paid";
    return toPublic(row, now, { offered, status: latest?.status ?? null, reference: latest?.reference_number ?? null });
  });
}

/** The buyer confirms the invitation. Idempotent; the status and the timeline change once. No account is created and no payment is taken. */
export async function startPurchase(token: unknown, opts: { now?: Date } = {}): Promise<PublicPurchaseView> {
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    const row = await byToken(db, token, now);
    if (!row) throw new AppError("not_found", "That purchase link is not valid.");
    const state = { status: row.status as PurchaseStatus, expiresAt: new Date(row.expires_at).toISOString() };
    const allowed = canBuyerStart(state, now);
    if (!allowed.ok) throw new AppError("conflict", allowed.reason ?? "This purchase cannot be confirmed.");
    if (statusOf(row, now) === "invited") {
      const changed = await db.query("update purchase_intents set status = 'started', started_at = $2 where id = $1 and status = 'invited'", [row.id, now.toISOString()]);
      if (changed.rowCount) {
        await addEvent(db, row.id, row.agency_org_id, "started", { reference: row.reference }, null, "buyer");
        await recordAudit({ orgId: row.agency_org_id, actorKind: "system", action: "purchase_intent.started", targetType: "purchase_intent", targetId: row.id, result: "success", metadata: { reference: row.reference } }, db);
      }
      row.status = "started";
      row.started_at = now;
    }
    return toPublic(row, now);
  });
}

/** A Super Admin records the payment they checked: the amount must be the frozen setup fee, and the reference is required. No workspace exists yet. */
export async function verifyPurchasePayment(user: SessionUser, id: unknown, input: PurchasePaymentInput, opts: { now?: Date } = {}): Promise<PurchaseIntentView> {
  if (!isId(id)) throw new AppError("not_found", "That purchase was not found.");
  const now = opts.now ?? new Date();
  const data = purchasePaymentSchema.parse(input);
  return withSystem(async (db) => {
    const actor = await actorFor(db, user);
    const agency = requireProvision(actor);
    const row = (await db.query<IntentRow>(`${SELECT} where id = $1 and agency_org_id = $2 for update`, [id, agency])).rows[0];
    if (!row) throw new AppError("not_found", "That purchase was not found.");
    const allowed = canVerifyPayment({ status: row.status as PurchaseStatus, expiresAt: new Date(row.expires_at).toISOString() }, now);
    if (!allowed.ok) throw new AppError("conflict", allowed.reason ?? "This payment cannot be verified now.");
    const tz = (await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [agency])).rows[0]?.timezone ?? "UTC";
    const checked = checkManualPayment({ kind: "setup_fee", ...data }, { today: todayIn(now, tz), now, agreedSetupFeeCents: row.setup_fee_cents });
    if (!checked.ok) throw new AppError("invalid_input", checked.error);
    if (checked.value.amountCents > MAX_MANUAL_PAYMENT_CENTS) throw new AppError("invalid_input", "That amount is above the most one payment can be.");
    if (row.payment_hold) throw new AppError("conflict", provisionHoldText(row.payment_hold) ?? "This purchase is on hold.");
    // A payment recorded by hand closes any online checkout that is still open, so the buyer cannot pay twice. If the provider's notice for it arrives anyway it is recorded
    // as a duplicate payment for a person to refund (applyCheckoutPaid).
    await db.query("update purchase_intent_checkouts set status = 'cancelled', failure_reason = 'A payment was recorded by hand' where intent_id = $1 and status in ('creating', 'pending')", [row.id]);
    const updated = await db.query<IntentRow>(
      `update purchase_intents set status = 'payment_verified', payment_at = $2, payment_method = $3, payment_reference = $4, payment_paid_on = $5,
         payment_note = $6, payment_amount_cents = $7, verified_by = $8 where id = $1 returning id`,
      [row.id, now.toISOString(), checked.value.method, checked.value.externalReference, checked.value.paidOn, checked.value.note, checked.value.amountCents, user.id],
    );
    if (!updated.rowCount) throw new AppError("conflict", "This purchase changed while the payment was being recorded. Reload and try again.");
    await addEvent(db, row.id, agency, "payment_verified", { amountCents: checked.value.amountCents, method: checked.value.method, paidOn: checked.value.paidOn }, user.id, "user");
    await recordAudit({ orgId: agency, actorUserId: user.id, actorKind: "agency", action: "purchase_intent.payment_verified", targetType: "purchase_intent", targetId: row.id, result: "success",
      metadata: { reference: row.reference, amountCents: checked.value.amountCents, method: checked.value.method, paidOn: checked.value.paidOn } }, db);
    const fresh = (await db.query<IntentRow>(`${SELECT} where id = $1`, [row.id])).rows[0];
    return toView(fresh, now);
  });
}

export interface ProvisionResult {
  intent: PurchaseIntentView;
  clientOrgId: string;
  paymentId: string;
  inviteLink: string | null;
  emailDelivery: unknown;
  duplicate: boolean;
}

/**
 * Creates the client workspace after the payment is verified, then records the canonical iAcquire payment through the existing billing service (which clears the setup
 * fee and opens AI provisioning). Sequential calls are idempotent: the stored client org and payment are returned instead of making another. The tenant row is written
 * before the payment row so a failure is safe (no setup clearance, no provisioning); the retry finishes the same intent.
 */
export async function provisionPurchaseIntent(user: SessionUser, id: unknown, opts: { now?: Date; automatic?: boolean } = {}): Promise<ProvisionResult> {
  if (!isId(id)) throw new AppError("not_found", "That purchase was not found.");
  const now = opts.now ?? new Date();
  const current = await withSystem(async (db) => {
    const actor = await actorFor(db, user);
    const agency = requireProvision(actor);
    const row = (await db.query<IntentRow>(`${SELECT} where id = $1 and agency_org_id = $2`, [id, agency])).rows[0];
    if (!row) throw new AppError("not_found", "That purchase was not found.");
    const allowed = canProvision({ status: row.status as PurchaseStatus, expiresAt: new Date(row.expires_at).toISOString() }, row.client_org_id, now, row.payment_hold);
    if (!allowed.ok) throw new AppError("conflict", allowed.reason ?? "This purchase cannot be provisioned now.");
    return row;
  });

  if (current.client_org_id && current.payment_id) {
    return { intent: toView(current, now), clientOrgId: current.client_org_id, paymentId: current.payment_id, inviteLink: null, emailDelivery: null, duplicate: true };
  }

  let clientOrgId = current.client_org_id;
  let inviteLink: string | null = null;
  let emailDelivery: unknown = null;
  if (!clientOrgId) {
    const created = await createClientTenant(user, {
      name: current.company,
      ownerEmail: current.buyer_email,
      industry: current.industry,
      website: current.website,
      timezone: current.timezone,
      crmMode: "native",
      blueprint: null,
    });
    clientOrgId = created.orgId;
    inviteLink = created.inviteLink;
    emailDelivery = created.emailDelivery;
    const claimed = await withSystem((db) =>
      db.query<{ client_org_id: string | null }>("update purchase_intents set client_org_id = $2 where id = $1 and client_org_id is null returning client_org_id", [id, clientOrgId]),
    );
    if (!claimed.rows[0]?.client_org_id) {
      // A concurrent provision created a workspace first. Do not create a second one; use the stored one and complete its payment.
      const winner = await withSystem((db) => db.query<IntentRow>(`${SELECT} where id = $1`, [id]));
      if (winner.rows[0]?.client_org_id) clientOrgId = winner.rows[0].client_org_id;
    }
    await withSystem((db) => addEvent(db, current.id, current.agency_org_id, "workspace_created", { clientOrgId }, user.id, "user"));
  }

  // The canonical payment of the new workspace: the one the provider's signed notice produced, or the one a Super Admin recorded by hand. Either way it is the existing billing
  // path that clears the setup fee and opens the AI employees' provisioning requests; repeating it returns the same payment.
  const payment = current.payment_source === "provider"
    ? await withSystem(async (db) => {
        const checkout = (await db.query<AdoptedCheckout>(
          `select id, provider, reference_number, usd_amount_cents, charged_currency, charged_amount_minor, fx_rate, fx_source, fx_at, livemode, provider_checkout_id, provider_payment_id, fee_minor, paid_at, status
             from purchase_intent_checkouts where id = $1 and intent_id = $2 for update`, [current.payment_checkout_id, current.id],
        )).rows[0];
        if (!checkout) throw new AppError("conflict", "The checkout that paid this purchase could not be found.");
        return recordProviderSetupPayment(db, { orgId: clientOrgId as string, checkout, actorUserId: user.id });
      })
    : await recordManualPayment(user, clientOrgId, {
        kind: "setup_fee",
        amount: (current.setup_fee_cents / 100).toFixed(2),
        method: current.payment_method as never,
        externalReference: current.payment_reference as string,
        paidOn: current.payment_paid_on as string,
        note: current.payment_note as string,
      }, { now });

  const finalized = await withSystem(async (db) => {
    await db.query(
      "update purchase_intents set status = 'provisioned', payment_id = $2, provisioned_at = $3, provisioned_by = $4, last_provision_error = null where id = $1 and status = 'payment_verified'",
      [id, payment.paymentId, now.toISOString(), user.id],
    );
    await addEvent(db, current.id, current.agency_org_id, "provisioned", { clientOrgId, paymentId: payment.paymentId, duplicate: payment.duplicate, source: current.payment_source, maintenanceSelected: current.maintenance_selected, automatic: opts.automatic === true }, user.id, opts.automatic ? "system" : "user");
    await recordAudit({ orgId: current.agency_org_id, actorUserId: user.id, actorKind: "agency", action: "purchase_intent.provisioned", targetType: "purchase_intent", targetId: id, result: "success",
      metadata: { reference: current.reference, clientOrgId, paymentId: payment.paymentId, amountCents: current.payment_amount_cents, duplicate: payment.duplicate } }, db);
    const fresh = (await db.query<IntentRow>(`${SELECT} where id = $1`, [id])).rows[0];
    return fresh;
  });
  return { intent: toView(finalized, now), clientOrgId, paymentId: payment.paymentId, inviteLink, emailDelivery, duplicate: payment.duplicate };
}

export interface CheckoutSwitchView {
  /** The Super Admin's own switch. */
  enabled: boolean;
  /** Whether a buyer could be sent to a checkout right now: the switch plus the provider connection, the rate and the live review. */
  available: boolean;
  /** Why not, in words for the team. */
  reason: string | null;
  livemode: boolean | null;
}

/** Whether online checkout is open for buyers, and why not when it is not. Readable by anyone who may see purchases. */
export async function getCheckoutSwitch(user: SessionUser): Promise<CheckoutSwitchView> {
  return withSystem(async (db) => {
    requireView(await actorFor(db, user));
    const a = await checkoutAvailability(db);
    return { enabled: a.settings.enabled, available: a.available, reason: a.reason, livemode: a.livemode };
  });
}

/** The Super Admin opens or closes online checkout for purchases. Closing it never touches a checkout that is already open (a payment on it is still recorded). Audited with who. */
export async function setPurchaseCheckoutEnabled(user: SessionUser, enabled: boolean): Promise<CheckoutSwitchView> {
  return withSystem(async (db) => {
    const actor = await actorFor(db, user);
    const agency = requireProvision(actor);
    const changed = await db.query("update agency_billing_settings set purchase_checkout_enabled = $1 where purchase_checkout_enabled is distinct from $1", [enabled]);
    if (changed.rowCount) {
      await recordAudit({ orgId: agency, actorUserId: user.id, actorKind: "agency", action: enabled ? "purchase_checkout.enabled" : "purchase_checkout.disabled", targetType: "agency_billing_settings", result: "success", metadata: { enabled } }, db);
    }
    const a = await checkoutAvailability(db);
    return { enabled: a.settings.enabled, available: a.available, reason: a.reason, livemode: a.livemode };
  });
}

/**
 * Withdraws an unpaid invitation, or closes a verified payment WITHOUT a workspace while the provider's refund, dispute or mismatch report holds it. A verified payment with no hold
 * must go through the refund path instead, never a quiet cancel. Closing keeps the payment record on the purchase and any open online checkout is closed so the buyer cannot pay it.
 */
export async function cancelPurchaseIntent(user: SessionUser, id: unknown, reason: string, opts: { now?: Date } = {}): Promise<PurchaseIntentView> {
  if (!isId(id)) throw new AppError("not_found", "That purchase was not found.");
  const why = reason.trim();
  if (why.length < 10) throw new AppError("invalid_input", "Say why the purchase is being cancelled.");
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    const actor = await actorFor(db, user);
    const agency = requireManage(actor);
    const row = (await db.query<IntentRow>(`${SELECT} where id = $1 and agency_org_id = $2 for update`, [id, agency])).rows[0];
    if (!row) throw new AppError("not_found", "That purchase was not found.");
    const allowed = canCancel({ status: row.status as PurchaseStatus, expiresAt: new Date(row.expires_at).toISOString() }, now, row.payment_hold);
    if (!allowed.ok) throw new AppError("conflict", allowed.reason ?? "This purchase cannot be cancelled.");
    const afterPayment = row.status === "payment_verified";
    // An online checkout that is still open is closed here. The provider's own page stays payable until it expires (this application cannot withdraw it), so a payment that still
    // arrives is recorded as one to refund (applyCheckoutPaid), exactly as for a purchase cancelled before payment.
    await db.query("update purchase_intent_checkouts set status = 'cancelled', failure_reason = 'The purchase was cancelled' where intent_id = $1 and status in ('creating', 'pending')", [id]);
    await db.query("update purchase_intents set status = 'cancelled', cancelled_at = $2 where id = $1", [id, now.toISOString()]);
    await addEvent(db, row.id, agency, "cancelled", { reason: why, afterPayment, hold: row.payment_hold }, user.id, "user");
    await recordAudit({ orgId: agency, actorUserId: user.id, actorKind: "agency", action: afterPayment ? "purchase_intent.closed_after_payment" : "purchase_intent.cancelled", targetType: "purchase_intent", targetId: id, result: "success", metadata: { reference: row.reference, afterPayment, hold: row.payment_hold } }, db);
    const fresh = (await db.query<IntentRow>(`${SELECT} where id = $1`, [id])).rows[0];
    return toView(fresh, now);
  });
}

/**
 * A Super Admin who checked with the provider releases a hold the provider's report put on a purchase: a mismatch or refund on a purchase that was never verified lets the buyer
 * try again; a verified payment may then become a workspace (by a person, or by itself when the inviting Super Admin allowed it). It needs the same permissions as creating the
 * workspace, because it re-enables that. The note is the person's own words about what they checked; the timeline records only that the hold was released and which hold it was.
 */
export async function releasePurchaseHold(user: SessionUser, id: unknown, note: string, opts: { now?: Date } = {}): Promise<PurchaseIntentView> {
  if (!isId(id)) throw new AppError("not_found", "That purchase was not found.");
  const checked = note.trim();
  if (checked.length < 10) throw new AppError("invalid_input", "Say what you checked with the payment provider.");
  if (checked.length > 1000) throw new AppError("invalid_input", "Keep the note under 1,000 characters.");
  const now = opts.now ?? new Date();
  const released = await withSystem(async (db) => {
    const actor = await actorFor(db, user);
    const agency = requireProvision(actor);
    const row = (await db.query<IntentRow>(`${SELECT} where id = $1 and agency_org_id = $2 for update`, [id, agency])).rows[0];
    if (!row) throw new AppError("not_found", "That purchase was not found.");
    const allowed = canReleaseHold({ status: row.status as PurchaseStatus, expiresAt: new Date(row.expires_at).toISOString() }, row.payment_hold, now);
    if (!allowed.ok) throw new AppError("conflict", allowed.reason ?? "This hold cannot be released.");
    await db.query("update purchase_intents set payment_hold = null where id = $1 and payment_hold is not null", [id]);
    // The provider's refund or dispute report moved the checkout that paid this purchase out of "paid". A person who checked and released the hold has judged that the payment
    // stands, so the checkout is "paid" again; without it the workspace could not adopt the payment as evidence.
    const restored = row.payment_checkout_id
      ? (await db.query("update purchase_intent_checkouts set status = 'paid' where id = $1 and status in ('refunded', 'disputed')", [row.payment_checkout_id])).rowCount ?? 0
      : 0;
    await addEvent(db, row.id, agency, "hold_released", { hold: row.payment_hold, checkoutRestoredToPaid: restored > 0 }, user.id, "user");
    await recordAudit({ orgId: agency, actorUserId: user.id, actorKind: "agency", action: "purchase_intent.hold_released", targetType: "purchase_intent", targetId: id, result: "success", metadata: { reference: row.reference, hold: row.payment_hold, whatWasChecked: checked } }, db);
    return { row, fresh: (await db.query<IntentRow>(`${SELECT} where id = $1`, [id])).rows[0] };
  });
  // A verified online payment that the inviting Super Admin allowed to provision itself carries on now, under that person's re-read permissions (it never throws for a business reason).
  if (released.fresh.auto_provision && released.fresh.payment_source === "provider" && released.fresh.status === "payment_verified") {
    // checkout.ts imports this file, so the import is made here, when it is needed.
    const { provisionPaidIntent } = await import("@/server/purchase-intents/checkout");
    await provisionPaidIntent(released.fresh.id, { now });
  }
  const after = await withSystem((db) => db.query<IntentRow>(`${SELECT} where id = $1`, [id]));
  return toView(after.rows[0], now);
}

/** Issues a fresh link (the old one stops working) while the purchase is still open. Returns the raw token once. */
export async function rotatePurchaseLink(user: SessionUser, id: unknown, opts: { now?: Date } = {}): Promise<{ token: string; expiresAt: string }> {
  if (!isId(id)) throw new AppError("not_found", "That purchase was not found.");
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    const actor = await actorFor(db, user);
    const agency = requireManage(actor);
    const row = (await db.query<IntentRow>(`${SELECT} where id = $1 and agency_org_id = $2 for update`, [id, agency])).rows[0];
    if (!row) throw new AppError("not_found", "That purchase was not found.");
    const allowed = canRotateLink({ status: row.status as PurchaseStatus, expiresAt: new Date(row.expires_at).toISOString() }, now);
    if (!allowed.ok) throw new AppError("conflict", allowed.reason ?? "A new link cannot be issued.");
    const token = newPurchaseToken();
    const expiresAt = new Date(now.getTime() + PURCHASE_LINK_DAYS * 86_400_000);
    await db.query(
      "update purchase_intents set token_hash = $2, expires_at = $3, status = case when status = 'expired' then 'invited' else status end, expired_at = null where id = $1",
      [id, hashPurchaseToken(token), expiresAt.toISOString()],
    );
    await addEvent(db, row.id, agency, "link_rotated", { expiresAt: expiresAt.toISOString() }, user.id, "user");
    await recordAudit({ orgId: agency, actorUserId: user.id, actorKind: "agency", action: "purchase_intent.link_rotated", targetType: "purchase_intent", targetId: id, result: "success", metadata: { reference: row.reference, expiresAt: expiresAt.toISOString() } }, db);
    return { token, expiresAt: expiresAt.toISOString() };
  });
}

export interface PurchaseIntentEvent {
  id: string;
  kind: string;
  detail: Record<string, unknown>;
  actorKind: string;
  createdAt: string;
}

/** The timeline of one purchase: fixed events and ids, never the buyer's or a person's free-text note. */
export async function listPurchaseIntentEvents(user: SessionUser, id: unknown): Promise<PurchaseIntentEvent[]> {
  if (!isId(id)) throw new AppError("not_found", "That purchase was not found.");
  return withSystem(async (db) => {
    const actor = await actorFor(db, user);
    const agency = requireView(actor);
    const { rows } = await db.query<{ id: string; kind: string; detail: Record<string, unknown>; actor_kind: string; created_at: Date }>(
      `select e.id::text, e.kind, e.detail, e.actor_kind, e.created_at from purchase_intent_events e
        join purchase_intents i on i.id = e.intent_id and i.agency_org_id = e.agency_org_id
       where e.intent_id = $1 and i.agency_org_id = $2 order by e.id`,
      [id, agency],
    );
    return rows.map((row) => ({ id: row.id, kind: row.kind, detail: row.detail, actorKind: row.actor_kind, createdAt: new Date(row.created_at).toISOString() }));
  });
}

export { formatUsdCents, setupFeeMicros };
