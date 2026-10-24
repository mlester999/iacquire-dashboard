import "server-only";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { CREDIT_PRESETS_USD, MICROS_PER_USD, OPERATING_RESERVE_PER_SETUP_USD, SETUP_FEE_USD, applyMarkup, isUnitType, rateUnitLabel, usdToMicros } from "@/lib/billing";
import { createPaymentCheckout, type CheckoutInput } from "@/server/billing/payments";
import { paymongoStatus, type FetchLike } from "@/server/billing/paymongo";
import { adjustCredits, currentRate } from "@/server/billing/ledger";
import { env } from "@/server/env";
import { AUTO_PAST_DUE_MIN_DAYS_OVER } from "@/lib/billing-renewal";
import type { OrgContext } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";

export interface BillingOverview {
  balanceMicros: number;
  reservedMicros: number;
  availableMicros: number;
  budget: { monthlyBudgetMicros: number | null; warnAtPercent: number; hardStop: boolean; lowBalanceMicros: number; monthSpendMicros: number };
  autoRecharge: { enabled: false; available: false; reason: string };
  burn: { perDayMicros: number; daysRemaining: number | null; basisDays: number };
  usageByUnit: Array<{ unitType: string; quantity: number; chargedMicros: number }>;
  recentLedger: Array<{ id: string; kind: string; deltaMicros: number; memo: string | null; createdAt: string }>;
  recentPayments: Array<{ id: string; kind: string; status: string; description: string; usdMicros: number; referenceNumber: string; checkoutUrl: string | null; paidAt: string | null; createdAt: string }>;
  providerFees: Array<{ id: string; provider: string; kind: string; description: string; amountMicros: number; recurrence: string; status: string; nextDueAt: string | null }>;
  rates: { version: number; markupBps: number; unitRates: Array<{ provider: string; unitType: string; unitLabel: string; wholesaleMicrosPerUnit: number; clientMicrosPerUnit: number }> };
  payments: { canTopUp: boolean; blockedReason: string | null; presetsUsd: readonly number[]; minUsd: number; maxUsd: number };
  setup: { feeUsd: number; status: string };
}

const BURN_BASIS_DAYS = 14;

export async function getBillingOverview(ctx: OrgContext): Promise<BillingOverview> {
  if (!ctx.can("usage.view")) throw new AppError("forbidden", "Only owners and managers can see credits and usage.");
  const canSeePayments = ctx.can("billing.view");
  const data = await withUser(ctx.user.id, async (db) => {
    const org = ctx.org.orgId;
    const account = await db.query<{ balance_micros: string; reserved_micros: string }>("select balance_micros, reserved_micros from credit_accounts where org_id = $1", [org]);
    const settings = await db.query<{ monthly_budget_micros: string | null; warn_at_percent: number; hard_stop: boolean; low_balance_micros: string }>(
      "select monthly_budget_micros, warn_at_percent, hard_stop, low_balance_micros from billing_settings where org_id = $1",
      [org],
    );
    const spend = await db.query<{ month: string; recent: string }>(
      `select coalesce(sum(charged_micros) filter (where occurred_at >= date_trunc('month', now())), 0)::text as month,
              coalesce(sum(charged_micros) filter (where occurred_at >= now() - ($2 || ' days')::interval), 0)::text as recent
       from metered_usage_events where org_id = $1`,
      [org, String(BURN_BASIS_DAYS)],
    );
    const units = await db.query<{ unit_type: string; quantity: string; charged: string }>(
      `select unit_type, sum(quantity)::text as quantity, sum(charged_micros)::text as charged from metered_usage_events
       where org_id = $1 and occurred_at >= date_trunc('month', now()) group by unit_type order by sum(charged_micros) desc`,
      [org],
    );
    const ledger = await db.query<{ id: string; kind: string; delta_micros: string; memo: string | null; created_at: Date }>(
      "select id, kind, delta_micros, memo, created_at from credit_ledger_entries where org_id = $1 and kind not in ('payment_initiated', 'payment_confirmed') order by id desc limit 25",
      [org],
    );
    const payments = canSeePayments
      ? await db.query<{ id: string; kind: string; status: string; description: string; usd_amount_micros: string; reference_number: string; checkout_url: string | null; paid_at: Date | null; created_at: Date }>(
          "select id, kind, status, description, usd_amount_micros, reference_number, checkout_url, paid_at, created_at from payments where org_id = $1 order by created_at desc limit 15",
          [org],
        )
      : { rows: [] as never[] };
    const fees = await db.query<{ id: string; provider: string; kind: string; description: string; amount_micros: string; recurrence: string; status: string; next_due_at: Date | null }>(
      "select id, provider, kind, description, amount_micros, recurrence, status, next_due_at from provider_fees where org_id = $1 and status <> 'cancelled' order by created_at desc limit 20",
      [org],
    );
    const unitRates = await db.query<{ provider: string; unit_type: string; unit_label: string; w: string; c: string }>(
      `select provider, unit_type, unit_label, wholesale_micros_per_unit::text as w, client_micros_per_unit::text as c
       from usage_unit_rates r join usage_rate_versions v on v.id = r.rate_version_id
       where v.version = (select max(version) from usage_rate_versions) order by provider, unit_type`,
    );
    const setup = await db.query<{ setup_fee_cents: number; setup_payment_status: string }>("select setup_fee_cents, setup_payment_status from billing_accounts where org_id = $1", [org]);
    const rate = await db.query<{ version: number; markup_bps: number }>("select version, markup_bps from usage_rate_versions order by version desc limit 1");
    return { account: account.rows[0], settings: settings.rows[0], spend: spend.rows[0], units: units.rows, ledger: ledger.rows, payments: payments.rows, fees: fees.rows, unitRates: unitRates.rows, setup: setup.rows[0], rate: rate.rows[0] };
  });
  const balance = Number(data.account?.balance_micros ?? 0);
  const reserved = Number(data.account?.reserved_micros ?? 0);
  const available = balance - reserved;
  const recent = Number(data.spend?.recent ?? 0);
  const perDay = Math.round(recent / BURN_BASIS_DAYS);
  const status = paymongoStatus();
  const limits = await withSystem((db) => db.query<{ topup_min_usd: number; topup_max_usd: number; usd_php_rate: string | null; live_payments_review_at: Date | null }>("select topup_min_usd, topup_max_usd, usd_php_rate, live_payments_review_at from agency_billing_settings"));
  const agency = limits.rows[0];
  const blockedReason = !status.configured
    ? "Payments are not connected yet. iAcquire is finishing the PayMongo setup."
    : !agency?.usd_php_rate
      ? "Checkout is waiting on an exchange rate from iAcquire."
      : status.livemode && !agency.live_payments_review_at
        ? "Live payments are switched off until iAcquire completes the payment and tax review."
        : null;
  return {
    balanceMicros: balance,
    reservedMicros: reserved,
    availableMicros: available,
    budget: {
      monthlyBudgetMicros: data.settings?.monthly_budget_micros ? Number(data.settings.monthly_budget_micros) : null,
      warnAtPercent: data.settings?.warn_at_percent ?? 80,
      hardStop: data.settings?.hard_stop ?? true,
      lowBalanceMicros: Number(data.settings?.low_balance_micros ?? 5_000_000),
      monthSpendMicros: Number(data.spend?.month ?? 0),
    },
    autoRecharge: { enabled: false, available: false, reason: "Auto-recharge stays off until PayMongo's saved-payment support is verified on the live merchant account." },
    // Only recorded usage informs this; with no history there is no estimate.
    burn: { perDayMicros: perDay, daysRemaining: perDay > 0 ? Math.floor(available / perDay) : null, basisDays: BURN_BASIS_DAYS },
    usageByUnit: data.units.map((u) => ({ unitType: u.unit_type, quantity: Number(u.quantity), chargedMicros: Number(u.charged) })),
    recentLedger: data.ledger.map((l) => ({ id: l.id, kind: l.kind, deltaMicros: Number(l.delta_micros), memo: l.memo, createdAt: new Date(l.created_at).toISOString() })),
    recentPayments: data.payments.map((p) => ({ id: p.id, kind: p.kind, status: p.status, description: p.description, usdMicros: Number(p.usd_amount_micros), referenceNumber: p.reference_number, checkoutUrl: p.status === "pending" ? p.checkout_url : null, paidAt: p.paid_at ? new Date(p.paid_at).toISOString() : null, createdAt: new Date(p.created_at).toISOString() })),
    providerFees: data.fees.map((f) => ({ id: f.id, provider: f.provider, kind: f.kind, description: f.description, amountMicros: Number(f.amount_micros), recurrence: f.recurrence, status: f.status, nextDueAt: f.next_due_at ? new Date(f.next_due_at).toISOString() : null })),
    rates: { version: data.rate?.version ?? 1, markupBps: data.rate?.markup_bps ?? 13000, unitRates: data.unitRates.map((r) => ({ provider: r.provider, unitType: r.unit_type, unitLabel: r.unit_label, wholesaleMicrosPerUnit: Number(r.w), clientMicrosPerUnit: Number(r.c) })) },
    payments: { canTopUp: ctx.can("credits.topup") && blockedReason === null, blockedReason, presetsUsd: CREDIT_PRESETS_USD, minUsd: agency?.topup_min_usd ?? 10, maxUsd: agency?.topup_max_usd ?? 2000 },
    setup: { feeUsd: (data.setup?.setup_fee_cents ?? SETUP_FEE_USD * 100) / 100, status: data.setup?.setup_payment_status ?? "not_invoiced" },
  };
}

export async function updateBillingSettings(ctx: OrgContext, input: { monthlyBudgetUsd: number | null; warnAtPercent: number; lowBalanceUsd: number; hardStop: boolean }) {
  if (!ctx.can("billing.configure")) throw new AppError("forbidden", "Only owners and managers can change spending limits.");
  if (input.monthlyBudgetUsd !== null && !(input.monthlyBudgetUsd > 0 && input.monthlyBudgetUsd <= 1_000_000)) throw new AppError("invalid_input", "Enter a monthly limit above zero.");
  if (!Number.isInteger(input.warnAtPercent) || input.warnAtPercent < 1 || input.warnAtPercent > 100) throw new AppError("invalid_input", "Choose a warning level between 1 and 100 percent.");
  if (!(input.lowBalanceUsd >= 0 && input.lowBalanceUsd <= 100_000)) throw new AppError("invalid_input", "Enter a valid low-balance amount.");
  await withSystem(async (db) => {
    await db.query("insert into billing_settings (org_id) values ($1) on conflict do nothing", [ctx.org.orgId]);
    await db.query(
      "update billing_settings set monthly_budget_micros = $2, warn_at_percent = $3, hard_stop = $4, low_balance_micros = $5, updated_by = $6, updated_at = now() where org_id = $1",
      [ctx.org.orgId, input.monthlyBudgetUsd === null ? null : usdToMicros(input.monthlyBudgetUsd), input.warnAtPercent, input.hardStop, usdToMicros(input.lowBalanceUsd), ctx.user.id],
    );
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "billing.settings_changed", targetType: "billing_settings", targetId: ctx.org.orgId, result: "success", metadata: { budget: input.monthlyBudgetUsd, warnAtPercent: input.warnAtPercent, hardStop: input.hardStop } }, db);
  });
}

/** Starts a prepaid credit purchase for the signed-in workspace. Returns the PayMongo page to send the person to. */
export async function startTopUp(ctx: OrgContext, amountUsd: number, deps: { fetch?: FetchLike } = {}) {
  if (!ctx.can("credits.topup")) throw new AppError("forbidden", "Only owners and managers can add service credits.");
  if (!Number.isFinite(amountUsd)) throw new AppError("invalid_input", "Choose an amount.");
  const input: CheckoutInput = {
    orgId: ctx.org.orgId,
    kind: "credit_topup",
    usdMicros: Math.round(amountUsd) * MICROS_PER_USD,
    description: `iAcquire service credits ($${Math.round(amountUsd)})`,
    requestedBy: ctx.user.id,
  };
  if (Math.round(amountUsd) !== amountUsd) throw new AppError("invalid_input", "Choose a whole-dollar amount.");
  return createPaymentCheckout(input, deps);
}

/** The owner approves a disclosed provider fee. Nothing is billed before this. */
export async function approveProviderFee(ctx: OrgContext, feeId: string) {
  if (ctx.role !== "owner") throw new AppError("forbidden", "Only the business owner can approve provider fees.");
  await withSystem(async (db) => {
    const res = await db.query("update provider_fees set status = 'approved', approved_by = $3, approved_at = now() where id = $1 and org_id = $2 and status = 'disclosed'", [feeId, ctx.org.orgId, ctx.user.id]);
    if (!res.rowCount) throw new AppError("not_found", "That fee is not waiting for approval.");
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "billing.provider_fee_approved", targetType: "provider_fee", targetId: feeId, result: "success" }, db);
  });
}

// ---------------------------------------------------------------------------
// Agency
// ---------------------------------------------------------------------------

type AgencyUser = Pick<SessionUser, "id" | "platformRole">;

async function agencyBillingAccess(user: AgencyUser) {
  const { rows } = await withSystem((db) => db.query<{ allowed: boolean; agency_wide: boolean }>(
    `select coalesce(app.user_has_agency_permission($1,'billing.agency_view'),false) as allowed,
            coalesce(app.user_has_agency_permission($1,'agency.security.manage'),false) as agency_wide`,
    [user.id],
  ));
  if (rows[0]?.allowed !== true) throw new AppError("forbidden", "Agency access is required.");
  return { agencyWide: rows[0].agency_wide === true };
}
function requireSuper(user: AgencyUser) {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a super admin can change billing settings.");
}

export async function setExchangeRate(user: AgencyUser, input: { usdPhpRate: number; source: string }) {
  requireSuper(user);
  if (!(input.usdPhpRate > 0 && input.usdPhpRate < 1000)) throw new AppError("invalid_input", "Enter a realistic PHP per USD rate.");
  if (input.source.trim().length < 3) throw new AppError("invalid_input", "Record where this rate came from.");
  await withSystem(async (db) => {
    await db.query("update agency_billing_settings set usd_php_rate = $1, fx_source = $2, fx_updated_at = now(), fx_updated_by = $3, updated_at = now()", [input.usdPhpRate, input.source.trim().slice(0, 200), user.id]);
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: "billing.fx_rate_set", targetType: "agency_billing_settings", result: "success", metadata: { rate: input.usdPhpRate, source: input.source } }, db);
  });
}

/** Marks the provider and the legal/tax treatment of prepaid credits as reviewed, which is what allows live checkout. */
export async function confirmLivePaymentsReview(user: AgencyUser, confirmed: boolean) {
  requireSuper(user);
  await withSystem(async (db) => {
    await db.query("update agency_billing_settings set live_payments_review_at = case when $1 then now() else null end, live_payments_review_by = case when $1 then $2::uuid else null end, updated_at = now()", [confirmed, user.id]);
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: confirmed ? "billing.live_review_confirmed" : "billing.live_review_withdrawn", targetType: "agency_billing_settings", result: "success" }, db);
  });
}

/**
 * Lets the renewal sweep mark a maintenance plan past due by itself when its paid period ended and no payment was recorded. OFF until a Super Admin turns it on (founder
 * decision, open): the sweep otherwise only tells the team. It never pauses, expires or revokes anything; it starts the same disclosed grace period a person's record does.
 */
export async function setAutoPastDue(user: AgencyUser, enabled: boolean) {
  requireSuper(user);
  await withSystem(async (db) => {
    await db.query(
      "update agency_billing_settings set auto_past_due = $1, auto_past_due_by = $2, auto_past_due_at = now(), updated_at = now()",
      [enabled, user.id],
    );
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: enabled ? "billing.auto_past_due_enabled" : "billing.auto_past_due_disabled", targetType: "agency_billing_settings", result: "success" }, db);
  });
}

export async function adjustOrgCredits(user: AgencyUser, input: { orgId: string; deltaUsd: number; reason: string }) {
  requireSuper(user);
  return withSystem(async (db) => {
    const balance = await adjustCredits(db, { orgId: input.orgId, deltaMicros: usdToMicros(input.deltaUsd), reason: input.reason, userId: user.id });
    await recordAudit({ orgId: input.orgId, actorUserId: user.id, actorKind: "agency", action: "billing.credits_adjusted", targetType: "credit_account", targetId: input.orgId, result: "success", metadata: { deltaUsd: input.deltaUsd, reason: input.reason } }, db);
    return balance;
  });
}

/**
 * Publishes the per-unit rate for a metered service once the agency has measured the provider's real wholesale cost.
 * The client price is derived from the approved markup, never typed in, so the two cannot disagree. Until a rate exists, the
 * messaging rules refuse to send on that channel because it could not be billed.
 */
export async function publishUnitRate(user: AgencyUser, input: { provider: string; unitType: string; wholesaleMicrosPerUnit: number; note?: string }) {
  requireSuper(user);
  if (!isUnitType(input.unitType)) throw new AppError("invalid_input", "Choose a known usage unit.");
  if (!Number.isInteger(input.wholesaleMicrosPerUnit) || input.wholesaleMicrosPerUnit <= 0) {
    const per = input.unitType === "ai_tokens_in" || input.unitType === "ai_tokens_out" ? "per 1,000 tokens" : "per unit";
    throw new AppError("invalid_input", `Enter the provider's wholesale cost ${per} in micro-dollars (1 USD = 1,000,000).`);
  }
  return withSystem(async (db) => {
    const rate = await currentRate(db);
    const client = applyMarkup(input.wholesaleMicrosPerUnit, rate.markupBps);
    await db.query(
      `insert into usage_unit_rates (rate_version_id, provider, unit_type, unit_label, wholesale_micros_per_unit, client_micros_per_unit, note)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (rate_version_id, provider, unit_type) do update set unit_label = excluded.unit_label, wholesale_micros_per_unit = excluded.wholesale_micros_per_unit,
         client_micros_per_unit = excluded.client_micros_per_unit, note = excluded.note, published_at = now()`,
      [rate.id, input.provider.slice(0, 60), input.unitType, rateUnitLabel(input.unitType), input.wholesaleMicrosPerUnit, client, input.note?.slice(0, 300) ?? null],
    );
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: "billing.unit_rate_published", targetType: "usage_unit_rate", targetId: `${input.provider}:${input.unitType}`, result: "success", metadata: { wholesaleMicrosPerUnit: input.wholesaleMicrosPerUnit, clientMicrosPerUnit: client } }, db);
    return { clientMicrosPerUnit: client };
  });
}

export async function addProviderFee(user: AgencyUser, input: { orgId: string; provider: string; kind: "number_rental" | "sender_registration" | "whatsapp_connection" | "domain" | "other"; description: string; amountUsd: number; recurrence: "one_time" | "monthly" | "annual" }) {
  if (user.platformRole === "none") throw new AppError("forbidden", "Agency access is required.");
  if (!(input.amountUsd > 0)) throw new AppError("invalid_input", "Enter the fee amount.");
  await withSystem(async (db) => {
    await db.query(
      "insert into provider_fees (org_id, provider, kind, description, amount_micros, recurrence, created_by) values ($1, $2, $3, $4, $5, $6, $7)",
      [input.orgId, input.provider.slice(0, 60), input.kind, input.description.slice(0, 200), usdToMicros(input.amountUsd), input.recurrence, user.id],
    );
    await recordAudit({ orgId: input.orgId, actorUserId: user.id, actorKind: "agency", action: "billing.provider_fee_disclosed", targetType: "provider_fee", result: "success", metadata: { provider: input.provider, kind: input.kind, amountUsd: input.amountUsd } }, db);
  });
}

export interface AgencyBillingOverview {
  paymongo: { configured: boolean; webhookConfigured: boolean; livemode: boolean | null; problems: string[] };
  fx: { usdPhpRate: number | null; source: string | null; updatedAt: string | null };
  liveReviewConfirmedAt: string | null;
  /** The renewal sweep's one switch (off unless a Super Admin turned it on), and the numbers it works by. Absent on sample pages that predate it. */
  planRenewals?: { autoPastDue: boolean; changedAt: string | null; graceDays: number; minDaysOver: number };
  markupBps: number;
  /** Cash and contribution are separate lines; none of them is profit. */
  totals: {
    setupPaidCount: number;
    setupRevenueMicros: number;
    recommendedOperatingReserveMicros: number;
    creditsSoldMicros: number;
    refundedMicros: number;
    knownPaymentFeesMinorPhp: number;
    meteredWholesaleMicros: number;
    meteredClientChargedMicros: number;
    grossMarkupContributionMicros: number;
    uncollectedMicros: number;
    creditLiabilityMicros: number;
  };
  clients: Array<{ orgId: string; name: string; balanceMicros: number; monthWholesaleMicros: number; monthChargedMicros: number; monthContributionMicros: number; uncollectedMicros: number }>;
  reconciliationErrors: Array<{ orgId: string; name: string; balanceMicros: number; ledgerBalanceMicros: number; reservedMicros: number; ledgerReservedMicros: number }>;
  unmatchedEvents: Array<{ id: string; eventType: string; outcome: string; detail: string | null; receivedAt: string }>;
}

export async function getAgencyBillingOverview(user: AgencyUser): Promise<AgencyBillingOverview> {
  const { agencyWide } = await agencyBillingAccess(user);
  return withSystem(async (db) => {
    const scope = agencyWide ? "true" : "app.user_can_access_org($1,o.id)";
    const params = agencyWide ? [] : [user.id];
    const settings = await db.query<{ usd_php_rate: string | null; fx_source: string | null; fx_updated_at: Date | null; live_payments_review_at: Date | null; auto_past_due: boolean; auto_past_due_at: Date | null }>(
      "select usd_php_rate, fx_source, fx_updated_at, live_payments_review_at, auto_past_due, auto_past_due_at from agency_billing_settings",
    );
    const totals = await db.query<Record<string, string>>(
      `select
         (select count(*) from payments p join organizations o on o.id = p.org_id where ${scope} and p.kind = 'setup_fee' and p.status in ('paid', 'partially_refunded', 'refunded'))::text as setup_count,
         (select coalesce(sum(p.usd_amount_micros - p.refunded_micros), 0) from payments p join organizations o on o.id = p.org_id where ${scope} and p.kind = 'setup_fee' and p.status in ('paid', 'partially_refunded'))::text as setup_rev,
         (select coalesce(sum(p.usd_amount_micros), 0) from payments p join organizations o on o.id = p.org_id where ${scope} and p.kind = 'credit_topup' and p.status in ('paid', 'partially_refunded', 'refunded'))::text as credits_sold,
         (select coalesce(sum(p.refunded_micros), 0) from payments p join organizations o on o.id = p.org_id where ${scope} and p.status in ('partially_refunded', 'refunded'))::text as refunded,
         (select coalesce(sum(p.fee_minor), 0) from payments p join organizations o on o.id = p.org_id where ${scope} and p.charged_currency = 'PHP' and p.status in ('paid', 'partially_refunded', 'refunded'))::text as fees_php,
         (select coalesce(sum(m.wholesale_micros), 0) from metered_usage_events m join organizations o on o.id = m.org_id where ${scope})::text as wholesale,
         (select coalesce(sum(m.charged_micros), 0) from metered_usage_events m join organizations o on o.id = m.org_id where ${scope})::text as charged,
         (select coalesce(sum(m.uncollected_micros), 0) from metered_usage_events m join organizations o on o.id = m.org_id where ${scope})::text as uncollected,
         (select coalesce(sum(a.balance_micros), 0) from credit_accounts a join organizations o on o.id = a.org_id where ${scope})::text as liability`,
      params,
    );
    const t = totals.rows[0];
    const clients = await db.query<{ org_id: string; name: string; balance: string; wholesale: string; charged: string; uncollected: string }>(
      `select o.id as org_id, o.name, coalesce(a.balance_micros, 0)::text as balance,
         coalesce(sum(m.wholesale_micros) filter (where m.occurred_at >= date_trunc('month', now())), 0)::text as wholesale,
         coalesce(sum(m.charged_micros) filter (where m.occurred_at >= date_trunc('month', now())), 0)::text as charged,
         coalesce(sum(m.uncollected_micros), 0)::text as uncollected
       from organizations o left join credit_accounts a on a.org_id = o.id left join metered_usage_events m on m.org_id = o.id
       where o.kind = 'client' and ${scope} group by o.id, o.name, a.balance_micros order by o.name`,
      params,
    );
    const recon = await db.query<{ org_id: string; name: string; balance_micros: string; ledger_balance_micros: string; reserved_micros: string; ledger_reserved_micros: string }>(
      `select o.id as org_id, o.name, r.balance_micros::text, r.ledger_balance_micros::text, r.reserved_micros::text, r.ledger_reserved_micros::text
       from organizations o cross join lateral app.credit_reconciliation(o.id) r where o.kind = 'client' and ${scope} and not r.consistent`,
      params,
    );
    const events = await db.query<{ id: string; event_type: string; outcome: string; detail: string | null; received_at: Date }>(
      `select e.id, e.event_type, e.outcome, e.detail, e.received_at from payment_webhook_events e
       where (e.outcome in ('rejected', 'error') or (e.outcome = 'ignored' and e.event_type = 'payment.failed') or e.event_type ~* '(refund|dispute|chargeback)')
         and ($2::boolean or exists (
           select 1 from payments p join organizations o on o.id=p.org_id
           where p.id=e.payment_id and app.user_can_access_org($1,o.id)
         ))
       order by e.received_at desc limit 25`,
      [user.id, agencyWide],
    );
    const rate = await currentRate(db);
    const setupCount = Number(t.setup_count);
    return {
      paymongo: paymongoStatus(),
      fx: { usdPhpRate: settings.rows[0]?.usd_php_rate ? Number(settings.rows[0].usd_php_rate) : null, source: settings.rows[0]?.fx_source ?? null, updatedAt: settings.rows[0]?.fx_updated_at ? new Date(settings.rows[0].fx_updated_at).toISOString() : null },
      liveReviewConfirmedAt: settings.rows[0]?.live_payments_review_at ? new Date(settings.rows[0].live_payments_review_at).toISOString() : null,
      planRenewals: {
        autoPastDue: settings.rows[0]?.auto_past_due === true,
        changedAt: settings.rows[0]?.auto_past_due_at ? new Date(settings.rows[0].auto_past_due_at).toISOString() : null,
        graceDays: env().STUDIO_PAYMENT_GRACE_DAYS,
        minDaysOver: AUTO_PAST_DUE_MIN_DAYS_OVER,
      },
      markupBps: rate.markupBps,
      totals: {
        setupPaidCount: setupCount,
        setupRevenueMicros: Number(t.setup_rev),
        recommendedOperatingReserveMicros: setupCount * OPERATING_RESERVE_PER_SETUP_USD * MICROS_PER_USD,
        creditsSoldMicros: Number(t.credits_sold),
        refundedMicros: Number(t.refunded),
        knownPaymentFeesMinorPhp: Number(t.fees_php),
        meteredWholesaleMicros: Number(t.wholesale),
        meteredClientChargedMicros: Number(t.charged),
        grossMarkupContributionMicros: Number(t.charged) - Number(t.wholesale),
        uncollectedMicros: Number(t.uncollected),
        creditLiabilityMicros: Number(t.liability),
      },
      clients: clients.rows.map((c) => ({ orgId: c.org_id, name: c.name, balanceMicros: Number(c.balance), monthWholesaleMicros: Number(c.wholesale), monthChargedMicros: Number(c.charged), monthContributionMicros: Number(c.charged) - Number(c.wholesale), uncollectedMicros: Number(c.uncollected) })),
      reconciliationErrors: recon.rows.map((r) => ({ orgId: r.org_id, name: r.name, balanceMicros: Number(r.balance_micros), ledgerBalanceMicros: Number(r.ledger_balance_micros), reservedMicros: Number(r.reserved_micros), ledgerReservedMicros: Number(r.ledger_reserved_micros) })),
      unmatchedEvents: events.rows.map((e) => ({ id: e.id, eventType: e.event_type, outcome: e.outcome, detail: e.detail, receivedAt: new Date(e.received_at).toISOString() })),
    };
  });
}
