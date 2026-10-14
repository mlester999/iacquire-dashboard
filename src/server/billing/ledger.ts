import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { applyMarkup, type UnitType } from "@/lib/billing";
import { notifyOrgRoles } from "@/server/notifications";

/** Raised when chargeable work must stop. `reason` lets callers show a specific explanation. */
export class BillingBlockedError extends AppError {
  readonly reason: "insufficient_credits" | "budget_exceeded";
  constructor(reason: "insufficient_credits" | "budget_exceeded", message: string) {
    super("usage_limit", message);
    this.reason = reason;
  }
}

export interface Balance {
  balanceMicros: number;
  reservedMicros: number;
  availableMicros: number;
}

type LedgerKind =
  | "payment_initiated"
  | "payment_confirmed"
  | "credits_granted"
  | "reservation_held"
  | "reservation_released"
  | "usage_consumed"
  | "refund"
  | "reversal"
  | "adjustment"
  | "reconciliation";

interface Account {
  balance: number;
  reserved: number;
}

/**
 * Locks the organization's account row for the rest of the transaction. Every balance change starts here,
 * which is what makes concurrent grants, reservations and settlements safe.
 */
async function lockAccount(db: Queryable, orgId: string): Promise<Account> {
  await db.query("insert into credit_accounts (org_id) values ($1) on conflict do nothing", [orgId]);
  await db.query("insert into billing_settings (org_id) values ($1) on conflict do nothing", [orgId]);
  const { rows } = await db.query<{ balance_micros: string; reserved_micros: string }>(
    "select balance_micros, reserved_micros from credit_accounts where org_id = $1 for update",
    [orgId],
  );
  return { balance: Number(rows[0].balance_micros), reserved: Number(rows[0].reserved_micros) };
}

interface Entry {
  orgId: string;
  kind: LedgerKind;
  delta?: number;
  reservedDelta?: number;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey?: string;
  memo?: string;
  createdBy?: string | null;
}

/** Appends one ledger entry and moves the cached account. A repeated idempotency key changes nothing. */
async function append(db: Queryable, acct: Account, e: Entry): Promise<{ inserted: boolean }> {
  const delta = e.delta ?? 0;
  const reservedDelta = e.reservedDelta ?? 0;
  const balance = acct.balance + delta;
  const reserved = acct.reserved + reservedDelta;
  if (balance < 0) throw new AppError("conflict", "That would take the credit balance below zero.");
  if (reserved < 0 || reserved > balance) throw new AppError("conflict", "That would reserve more credit than is available.");
  const { rows } = await db.query<{ id: string }>(
    `insert into credit_ledger_entries (org_id, kind, delta_micros, reserved_delta_micros, balance_after_micros, reserved_after_micros,
       reference_type, reference_id, idempotency_key, memo, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (org_id, idempotency_key) do nothing returning id`,
    [e.orgId, e.kind, delta, reservedDelta, balance, reserved, e.referenceType ?? null, e.referenceId ?? null, e.idempotencyKey ?? null, e.memo?.slice(0, 500) ?? null, e.createdBy ?? null],
  );
  if (!rows[0]) return { inserted: false };
  await db.query("update credit_accounts set balance_micros = $2, reserved_micros = $3, updated_at = now() where org_id = $1", [e.orgId, balance, reserved]);
  acct.balance = balance;
  acct.reserved = reserved;
  return { inserted: true };
}

export async function getBalance(db: Queryable, orgId: string): Promise<Balance> {
  const { rows } = await db.query<{ balance_micros: string; reserved_micros: string }>(
    "select balance_micros, reserved_micros from credit_accounts where org_id = $1",
    [orgId],
  );
  const balance = Number(rows[0]?.balance_micros ?? 0);
  const reserved = Number(rows[0]?.reserved_micros ?? 0);
  return { balanceMicros: balance, reservedMicros: reserved, availableMicros: balance - reserved };
}

export async function currentRate(db: Queryable): Promise<{ id: string; version: number; markupBps: number }> {
  const { rows } = await db.query<{ id: string; version: number; markup_bps: number }>(
    "select id, version, markup_bps from usage_rate_versions where effective_at <= now() order by version desc limit 1",
  );
  if (!rows[0]) throw new AppError("internal", "No usage rate has been published.");
  return { id: rows[0].id, version: rows[0].version, markupBps: rows[0].markup_bps };
}

/** Records that a checkout was started. It moves no money; it keeps the audit trail complete. */
export async function recordPaymentInitiated(db: Queryable, input: { orgId: string; paymentId: string; memo?: string; createdBy?: string | null }) {
  const acct = await lockAccount(db, input.orgId);
  await append(db, acct, { orgId: input.orgId, kind: "payment_initiated", referenceType: "payment", referenceId: input.paymentId, idempotencyKey: `initiated:${input.paymentId}`, memo: input.memo, createdBy: input.createdBy });
}

/** Grants prepaid credits for a confirmed payment, exactly once per payment. */
export async function grantCredits(
  db: Queryable,
  input: { orgId: string; amountMicros: number; paymentId: string; memo?: string; createdBy?: string | null },
): Promise<{ granted: boolean }> {
  if (!Number.isInteger(input.amountMicros) || input.amountMicros <= 0) throw new AppError("invalid_input", "Credit amount must be positive.");
  const acct = await lockAccount(db, input.orgId);
  await append(db, acct, { orgId: input.orgId, kind: "payment_confirmed", referenceType: "payment", referenceId: input.paymentId, idempotencyKey: `confirmed:${input.paymentId}` });
  const result = await append(db, acct, {
    orgId: input.orgId,
    kind: "credits_granted",
    delta: input.amountMicros,
    referenceType: "payment",
    referenceId: input.paymentId,
    idempotencyKey: `grant:${input.paymentId}`,
    memo: input.memo ?? "Prepaid service credits",
    createdBy: input.createdBy,
  });
  return { granted: result.inserted };
}

/** Agency adjustment. A negative adjustment can never reach credit that is reserved for running work. */
export async function adjustCredits(db: Queryable, input: { orgId: string; deltaMicros: number; reason: string; userId: string; idempotencyKey?: string }) {
  if (!Number.isInteger(input.deltaMicros) || input.deltaMicros === 0) throw new AppError("invalid_input", "Enter a non-zero amount.");
  if (input.reason.trim().length < 5) throw new AppError("invalid_input", "Record why this adjustment is being made.");
  const acct = await lockAccount(db, input.orgId);
  if (input.deltaMicros < 0 && -input.deltaMicros > acct.balance - acct.reserved) {
    throw new AppError("conflict", "That would remove credit that is reserved for work in progress.");
  }
  await append(db, acct, { orgId: input.orgId, kind: "adjustment", delta: input.deltaMicros, referenceType: "adjustment", memo: input.reason, createdBy: input.userId, idempotencyKey: input.idempotencyKey });
  return getBalance(db, input.orgId);
}

/**
 * Takes back credits when a payment is refunded or reversed. Only credit that is still unused and unreserved can
 * be removed; anything already spent is reported as a shortfall for the agency to reconcile, never a negative balance.
 */
export async function reverseCredits(
  db: Queryable,
  input: { orgId: string; paymentId: string; amountMicros: number; kind: "refund" | "reversal"; idempotencyKey: string; createdBy?: string | null; memo?: string },
): Promise<{ removedMicros: number; shortfallMicros: number }> {
  const acct = await lockAccount(db, input.orgId);
  const removable = Math.min(input.amountMicros, Math.max(0, acct.balance - acct.reserved));
  const shortfall = input.amountMicros - removable;
  if (removable > 0) {
    const r = await append(db, acct, {
      orgId: input.orgId,
      kind: input.kind,
      delta: -removable,
      referenceType: "payment",
      referenceId: input.paymentId,
      idempotencyKey: input.idempotencyKey,
      memo: `${input.memo ?? input.kind}${shortfall > 0 ? `; ${shortfall} micro-dollars already spent` : ""}`,
      createdBy: input.createdBy,
    });
    if (!r.inserted) return { removedMicros: 0, shortfallMicros: 0 };
  }
  return { removedMicros: removable, shortfallMicros: shortfall };
}

export async function monthToDateSpendMicros(db: Queryable, orgId: string): Promise<number> {
  const { rows } = await db.query<{ spent: string }>(
    "select coalesce(sum(charged_micros), 0)::text as spent from metered_usage_events where org_id = $1 and occurred_at >= date_trunc('month', now())",
    [orgId],
  );
  return Number(rows[0].spent);
}

export interface Reservation {
  id: string;
  reused: boolean;
}

/**
 * Holds credit for chargeable work before it starts. Checks the balance and the monthly budget with the account
 * locked, so two jobs can never both spend the same credit. A repeated `jobReference` returns the existing hold.
 */
export async function reserveCredits(
  db: Queryable,
  input: { orgId: string; estimateMicros: number; purpose: string; jobReference?: string; ttlSeconds?: number },
): Promise<Reservation> {
  if (!Number.isInteger(input.estimateMicros) || input.estimateMicros <= 0) throw new AppError("invalid_input", "Estimate must be positive.");
  const acct = await lockAccount(db, input.orgId);
  if (input.jobReference) {
    const { rows } = await db.query<{ id: string; status: string }>("select id, status from usage_reservations where org_id = $1 and job_reference = $2", [input.orgId, input.jobReference]);
    if (rows[0]) return { id: rows[0].id, reused: true };
  }
  if (input.estimateMicros > acct.balance - acct.reserved) {
    throw new BillingBlockedError("insufficient_credits", "There aren't enough service credits to start this. Add credits to continue.");
  }
  const { rows: settings } = await db.query<{ monthly_budget_micros: string | null; hard_stop: boolean }>("select monthly_budget_micros, hard_stop from billing_settings where org_id = $1", [input.orgId]);
  const cap = settings[0]?.monthly_budget_micros ? Number(settings[0].monthly_budget_micros) : null;
  if (cap !== null && settings[0].hard_stop) {
    const spent = await monthToDateSpendMicros(db, input.orgId);
    if (spent + acct.reserved + input.estimateMicros > cap) {
      throw new BillingBlockedError("budget_exceeded", "This would go over your monthly spending limit. Raise the limit to continue.");
    }
  }
  const { rows } = await db.query<{ id: string }>(
    `insert into usage_reservations (org_id, purpose, job_reference, estimated_micros, expires_at)
     values ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval) returning id`,
    [input.orgId, input.purpose.slice(0, 120), input.jobReference ?? null, input.estimateMicros, String(input.ttlSeconds ?? 900)],
  );
  await append(db, acct, { orgId: input.orgId, kind: "reservation_held", reservedDelta: input.estimateMicros, referenceType: "reservation", referenceId: rows[0].id, idempotencyKey: `hold:${rows[0].id}`, memo: input.purpose });
  return { id: rows[0].id, reused: false };
}

export interface UsageInput {
  provider: string;
  unitType: UnitType;
  quantity: number;
  /** What the provider charges us for this consumption, in micro-dollars. */
  wholesaleMicros: number;
  providerReference?: string;
  jobReference?: string;
  messageId?: string;
  /** Set only for a USD figure derived from another currency. */
  fx?: { rate: number; source: string; at: Date };
}

export interface UsageCharge {
  usageEventId: string;
  clientMicros: number;
  chargedMicros: number;
  uncollectedMicros: number;
  duplicate: boolean;
}

async function insertUsageEvent(db: Queryable, orgId: string, usage: UsageInput, reservationId: string | null, rate: Awaited<ReturnType<typeof currentRate>>, charged: number, clientMicros: number) {
  const uncollected = clientMicros - charged;
  const status = uncollected === 0 ? "settled" : charged === 0 ? "uncollected" : "partially_collected";
  const { rows } = await db.query<{ id: string }>(
    `insert into metered_usage_events (org_id, provider, unit_type, quantity, wholesale_micros, rate_version_id, markup_bps, client_micros,
       charged_micros, uncollected_micros, fx_rate, fx_source, fx_at, provider_reference, job_reference, message_id, reservation_id, billing_status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     on conflict (org_id, provider, provider_reference) do nothing returning id`,
    [orgId, usage.provider, usage.unitType, usage.quantity, usage.wholesaleMicros, rate.id, rate.markupBps, clientMicros, charged, uncollected,
      usage.fx?.rate ?? null, usage.fx?.source ?? null, usage.fx?.at ?? null, usage.providerReference ?? null, usage.jobReference ?? null, usage.messageId ?? null, reservationId, status],
  );
  return rows[0]?.id ?? null;
}

function validateUsage(usage: UsageInput) {
  if (!Number.isInteger(usage.wholesaleMicros) || usage.wholesaleMicros < 0) throw new AppError("invalid_input", "Wholesale cost must be a non-negative integer of micro-dollars.");
  if (!(usage.quantity >= 0)) throw new AppError("invalid_input", "Quantity must not be negative.");
}

async function existingUsage(db: Queryable, orgId: string, usage: UsageInput): Promise<UsageCharge | null> {
  if (!usage.providerReference) return null;
  const { rows } = await db.query<{ id: string; client_micros: string; charged_micros: string; uncollected_micros: string }>(
    "select id, client_micros, charged_micros, uncollected_micros from metered_usage_events where org_id = $1 and provider = $2 and provider_reference = $3",
    [orgId, usage.provider, usage.providerReference],
  );
  const r = rows[0];
  return r ? { usageEventId: r.id, clientMicros: Number(r.client_micros), chargedMicros: Number(r.charged_micros), uncollectedMicros: Number(r.uncollected_micros), duplicate: true } : null;
}

/**
 * Settles a reservation with the real consumption. The held credit is released and the actual client charge
 * (wholesale x the current markup) is consumed. If the work cost more than was held, the extra is taken only from
 * free credit; whatever cannot be collected is recorded on the usage line for reconciliation, never as a negative balance.
 */
export async function settleReservation(db: Queryable, input: { orgId: string; reservationId: string; usage: UsageInput }): Promise<UsageCharge> {
  validateUsage(input.usage);
  const acct = await lockAccount(db, input.orgId);
  const duplicate = await existingUsage(db, input.orgId, input.usage);
  if (duplicate) return duplicate;
  const { rows } = await db.query<{ id: string; status: string; estimated_micros: string }>(
    "select id, status, estimated_micros from usage_reservations where id = $1 and org_id = $2 for update",
    [input.reservationId, input.orgId],
  );
  const reservation = rows[0];
  if (!reservation) throw new AppError("not_found", "Reservation not found.");
  if (reservation.status !== "held") throw new AppError("conflict", "This reservation was already settled or released.");
  const held = Number(reservation.estimated_micros);
  const rate = await currentRate(db);
  const clientMicros = applyMarkup(input.usage.wholesaleMicros, rate.markupBps);
  // Own hold covers up to `held`; anything above must come from credit nobody else has reserved.
  const headroom = Math.max(0, acct.balance - acct.reserved);
  const charged = Math.min(clientMicros, held + headroom, acct.balance);
  await append(db, acct, { orgId: input.orgId, kind: "reservation_released", reservedDelta: -held, referenceType: "reservation", referenceId: reservation.id, idempotencyKey: `release:${reservation.id}`, memo: "Settled" });
  if (charged > 0) {
    await append(db, acct, { orgId: input.orgId, kind: "usage_consumed", delta: -charged, referenceType: "reservation", referenceId: reservation.id, idempotencyKey: `consume:${reservation.id}`, memo: `${input.usage.provider} ${input.usage.unitType}` });
  }
  await db.query("update usage_reservations set status = 'settled', settled_micros = $2, resolved_at = now() where id = $1", [reservation.id, charged]);
  const eventId = await insertUsageEvent(db, input.orgId, input.usage, reservation.id, rate, charged, clientMicros);
  if (clientMicros > 0) await afterCharge(db, input.orgId, acct, clientMicros - charged);
  return { usageEventId: eventId ?? "", clientMicros, chargedMicros: charged, uncollectedMicros: clientMicros - charged, duplicate: false };
}

/** Charges usage that already happened (a provider reported the cost afterwards) without a prior reservation. */
export async function chargeUsage(db: Queryable, input: { orgId: string; usage: UsageInput }): Promise<UsageCharge> {
  validateUsage(input.usage);
  const acct = await lockAccount(db, input.orgId);
  const duplicate = await existingUsage(db, input.orgId, input.usage);
  if (duplicate) return duplicate;
  const rate = await currentRate(db);
  const clientMicros = applyMarkup(input.usage.wholesaleMicros, rate.markupBps);
  const charged = Math.min(clientMicros, Math.max(0, acct.balance - acct.reserved));
  if (charged > 0) {
    await append(db, acct, { orgId: input.orgId, kind: "usage_consumed", delta: -charged, referenceType: "usage", memo: `${input.usage.provider} ${input.usage.unitType}` });
  }
  const eventId = await insertUsageEvent(db, input.orgId, input.usage, null, rate, charged, clientMicros);
  if (clientMicros > 0) await afterCharge(db, input.orgId, acct, clientMicros - charged);
  return { usageEventId: eventId ?? "", clientMicros, chargedMicros: charged, uncollectedMicros: clientMicros - charged, duplicate: false };
}

/** Frees credit held for work that never ran. */
export async function releaseReservation(db: Queryable, input: { orgId: string; reservationId: string; reason?: string; expired?: boolean }) {
  const acct = await lockAccount(db, input.orgId);
  const { rows } = await db.query<{ status: string; estimated_micros: string }>("select status, estimated_micros from usage_reservations where id = $1 and org_id = $2 for update", [input.reservationId, input.orgId]);
  if (!rows[0]) throw new AppError("not_found", "Reservation not found.");
  if (rows[0].status !== "held") return { released: false };
  const held = Number(rows[0].estimated_micros);
  await append(db, acct, { orgId: input.orgId, kind: "reservation_released", reservedDelta: -held, referenceType: "reservation", referenceId: input.reservationId, idempotencyKey: `release:${input.reservationId}`, memo: input.reason ?? "Released unused" });
  await db.query("update usage_reservations set status = $2, settled_micros = 0, resolved_at = now() where id = $1", [input.reservationId, input.expired ? "expired" : "released"]);
  return { released: true };
}

/** Releases holds that outlived their work, so a crashed worker cannot lock credit forever. */
export async function expireStaleReservations(db: Queryable, limit = 200): Promise<number> {
  const { rows } = await db.query<{ id: string; org_id: string }>("select id, org_id from usage_reservations where status = 'held' and expires_at <= now() order by expires_at limit $1", [limit]);
  for (const r of rows) await releaseReservation(db, { orgId: r.org_id, reservationId: r.id, reason: "Expired", expired: true });
  return rows.length;
}

export interface Reconciliation {
  consistent: boolean;
  balanceMicros: number;
  ledgerBalanceMicros: number;
  reservedMicros: number;
  ledgerReservedMicros: number;
}

export async function reconcileOrg(db: Queryable, orgId: string): Promise<Reconciliation> {
  const { rows } = await db.query<{ balance_micros: string; ledger_balance_micros: string; reserved_micros: string; ledger_reserved_micros: string; consistent: boolean }>(
    "select * from app.credit_reconciliation($1)",
    [orgId],
  );
  const r = rows[0];
  if (!r) return { consistent: true, balanceMicros: 0, ledgerBalanceMicros: 0, reservedMicros: 0, ledgerReservedMicros: 0 };
  return { consistent: r.consistent, balanceMicros: Number(r.balance_micros), ledgerBalanceMicros: Number(r.ledger_balance_micros), reservedMicros: Number(r.reserved_micros), ledgerReservedMicros: Number(r.ledger_reserved_micros) };
}

/** Warns the owner and managers about low credit, an exhausted balance, an approaching budget, or uncollected usage. Each alert is sent once per day or month. */
export async function afterCharge(db: Queryable, orgId: string, acct: Account, uncollectedMicros: number) {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const { rows } = await db.query<{ monthly_budget_micros: string | null; warn_at_percent: number; low_balance_micros: string }>(
    "select monthly_budget_micros, warn_at_percent, low_balance_micros from billing_settings where org_id = $1",
    [orgId],
  );
  const s = rows[0];
  const free = acct.balance - acct.reserved;
  if (free <= 0 || uncollectedMicros > 0) {
    await notifyOrgRoles(db, orgId, ["owner", "admin"], {
      kind: "billing_credits_exhausted",
      severity: "critical",
      title: "Your service credits have run out",
      body: "New chargeable work is paused. Your leads, conversations and records are safe, and urgent escalations are still shown. Add credits to resume.",
      link: "/settings/billing",
      dedupeKey: `credits_exhausted:${today}`,
    });
  } else if (s && free <= Number(s.low_balance_micros)) {
    await notifyOrgRoles(db, orgId, ["owner", "admin"], {
      kind: "billing_low_balance",
      severity: "warning",
      title: "Your service credits are running low",
      body: "Add credits so automated replies and follow-ups can continue.",
      link: "/settings/billing",
      dedupeKey: `low_balance:${today}`,
    });
  }
  if (s?.monthly_budget_micros) {
    const cap = Number(s.monthly_budget_micros);
    const spent = await monthToDateSpendMicros(db, orgId);
    if (spent * 100 >= cap * s.warn_at_percent) {
      await notifyOrgRoles(db, orgId, ["owner", "admin"], {
        kind: "billing_budget_warning",
        severity: "warning",
        title: `You've used ${Math.min(100, Math.floor((spent / cap) * 100))}% of this month's spending limit`,
        link: "/settings/billing",
        dedupeKey: `budget:${month}:${s.warn_at_percent}`,
      });
    }
  }
}
