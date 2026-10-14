import "server-only";
import { z } from "zod";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { CATEGORIES, ENTRY_KINDS, MAX_ENTRY_USD, type EntryKind, type Period } from "@/lib/finance";
import type { SessionUser } from "@/server/auth/service";

const MICROS = 1_000_000;

export interface ClientFinanceRow {
  orgId: string;
  name: string;
  receivedMicros: number;
  refundedMicros: number;
  usageChargedMicros: number;
  providerCostMicros: number;
  paymentFeesMicros: number;
  directCostsMicros: number;
  /** Revenue minus costs that belong to this client. Overhead is not shared out, so this is a contribution, not a profit. */
  contributionMicros: number;
}

export interface FinanceEntryRow {
  id: string;
  kind: EntryKind;
  category: string;
  description: string;
  amountMicros: number;
  periodOn: string;
  orgId: string | null;
  orgName: string | null;
  createdAt: string;
  voided: boolean;
  voidReason: string | null;
}

export interface FinancialReport {
  period: Period;
  /** "agency" is every client plus overhead and reserve; "assigned" is only the clients this staff member looks after. */
  scope: "agency" | "assigned";
  received: { setupMicros: number; maintenanceMicros: number; projectsMicros: number; domainsMicros: number; otherMicros: number; grossMicros: number; refundedMicros: number; netMicros: number };
  /** Credits clients paid for in advance. They are owed back as service, so they are held apart from income until they are used. */
  prepaid: { topUpsMicros: number; heldForClientsMicros: number };
  usage: { chargedMicros: number; providerCostMicros: number; grossMarkupContributionMicros: number; uncollectedMicros: number };
  fees: { knownMicros: number; paymentsCounted: number; paymentsWithoutFee: number };
  costs: { directMicros: number; overheadMicros: number };
  tax: { configuredBps: number | null; setAsideMicros: number; suggestedMicros: number | null };
  reserve: { setupPayments: number; perSetupUsd: number; recommendedMicros: number; setAsideInPeriodMicros: number; setAsideMicros: number; usedMicros: number; balanceMicros: number };
  /** Null for staff who only see their own clients. */
  distributable: { resultBeforeSetAsidesMicros: number; unfundedReserveMicros: number; unfundedTaxMicros: number; estimateMicros: number } | null;
  clients: ClientFinanceRow[];
  entries: FinanceEntryRow[];
  reconciliationErrors: number;
  caveats: string[];
}

export function requireFinanceView(user: Pick<SessionUser, "platformRole">) {
  if (user.platformRole === "none") throw new AppError("forbidden", "Only agency staff can view finance.");
}
function requireFinanceManage(user: Pick<SessionUser, "platformRole">) {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can change finance records.");
}

/**
 * The agency's money, in the order it actually moves, with each kind of figure on its own line so none is mistaken for another:
 * cash received (net of refunds) is not profit; prepaid credits are a liability until used; usage charges are income only once consumed;
 * provider cost, payment fees, direct costs, overhead, tax set-asides and the reserve are each separate. The "estimate available to
 * distribute" is a planning figure and says what it leaves out.
 */
export async function getFinancialReport(user: SessionUser, period: Period): Promise<FinancialReport> {
  requireFinanceView(user);
  const agencyWide = user.platformRole === "agency_super_admin";
  return withSystem(async (db) => {
    // Staff see only clients they are assigned to; the same filter applies to every figure below.
    const scopeSql = agencyWide ? "true" : "o.id in (select org_id from staff_assignments where user_id = $3)";
    const base = [period.from, period.to];
    const params = agencyWide ? base : [...base, user.id];

    const settings = (await db.query<{ setup_reserve_usd: number; tax_set_aside_bps: number | null }>("select setup_reserve_usd, tax_set_aside_bps from agency_billing_settings")).rows[0] ?? { setup_reserve_usd: 200, tax_set_aside_bps: null };

    const pay = (await db.query<Record<string, string>>(
      `select
         coalesce(sum(p.usd_amount_micros) filter (where p.kind = 'setup_fee'), 0)::text as setup,
         coalesce(sum(p.usd_amount_micros) filter (where p.kind = 'maintenance'), 0)::text as maintenance,
         coalesce(sum(p.usd_amount_micros) filter (where p.kind = 'custom_project'), 0)::text as projects,
         coalesce(sum(p.usd_amount_micros) filter (where p.kind = 'domain'), 0)::text as domains,
         coalesce(sum(p.usd_amount_micros) filter (where p.kind = 'other'), 0)::text as other,
         coalesce(sum(p.refunded_micros) filter (where p.kind <> 'credit_topup'), 0)::text as refunded,
         coalesce(sum(p.usd_amount_micros) filter (where p.kind = 'credit_topup'), 0)::text as topups,
         count(*) filter (where p.kind = 'setup_fee' and p.status in ('paid', 'partially_refunded'))::text as setups,
         count(*) filter (where p.fee_minor is not null and p.fx_rate is not null)::text as fee_known,
         count(*) filter (where p.fee_minor is null or p.fx_rate is null)::text as fee_unknown,
         coalesce(sum(round(p.fee_minor::numeric / 100 / p.fx_rate * 1000000)) filter (where p.fee_minor is not null and p.fx_rate is not null), 0)::text as fees
       from payments p join organizations o on o.id = p.org_id
       where ${scopeSql} and p.status in ('paid', 'partially_refunded', 'refunded') and p.paid_at >= $1 and p.paid_at < $2`,
      params,
    )).rows[0];

    const use = (await db.query<Record<string, string>>(
      `select coalesce(sum(m.charged_micros), 0)::text as charged, coalesce(sum(m.wholesale_micros), 0)::text as wholesale, coalesce(sum(m.uncollected_micros), 0)::text as uncollected
       from metered_usage_events m join organizations o on o.id = m.org_id where ${scopeSql} and m.occurred_at >= $1 and m.occurred_at < $2`,
      params,
    )).rows[0];

    const held = (await db.query<{ v: string }>(`select coalesce(sum(a.balance_micros), 0)::text as v from credit_accounts a join organizations o on o.id = a.org_id where ${agencyWide ? "true" : "o.id in (select org_id from staff_assignments where user_id = $1)"}`, agencyWide ? [] : [user.id])).rows[0];

    // Entries: the agency-wide kinds are for super admins only; staff see the direct costs of their own clients.
    const entryScope = agencyWide ? "true" : "(e.org_id is not null and e.org_id in (select org_id from staff_assignments where user_id = $3))";
    const entryRows = await db.query<{ id: string; kind: EntryKind; category: string; description: string; amount_micros: string; period_on: string; org_id: string | null; org_name: string | null; created_at: Date; voided_at: Date | null; void_reason: string | null }>(
      `select e.id, e.kind, e.category, e.description, e.amount_micros::text, to_char(e.period_on, 'YYYY-MM-DD') as period_on, e.org_id, o.name as org_name, e.created_at, e.voided_at, e.void_reason
       from agency_finance_entries e left join organizations o on o.id = e.org_id
       where ${entryScope} and e.period_on >= $1::timestamptz::date and e.period_on < $2::timestamptz::date order by e.period_on desc, e.created_at desc limit 200`,
      params,
    );
    const live = entryRows.rows.filter((e) => !e.voided_at);
    const sumKind = (k: EntryKind) => live.filter((e) => e.kind === k).reduce((n, e) => n + Number(e.amount_micros), 0);

    // Reserve is a running balance, so it is measured over all time, not just this period.
    const reserveAll = agencyWide
      ? (await db.query<{ set_aside: string; used: string }>(
          `select coalesce(sum(amount_micros) filter (where kind = 'reserve_set_aside'), 0)::text as set_aside, coalesce(sum(amount_micros) filter (where kind = 'reserve_used'), 0)::text as used
           from agency_finance_entries where voided_at is null`,
        )).rows[0]
      : { set_aside: "0", used: "0" };

    const clientRows = await db.query<{ org_id: string; name: string; received: string; refunded: string; charged: string; wholesale: string; fees: string; direct: string }>(
      `select o.id as org_id, o.name,
         coalesce((select sum(p.usd_amount_micros) from payments p where p.org_id = o.id and p.kind <> 'credit_topup' and p.status in ('paid', 'partially_refunded', 'refunded') and p.paid_at >= $1 and p.paid_at < $2), 0)::text as received,
         coalesce((select sum(p.refunded_micros) from payments p where p.org_id = o.id and p.kind <> 'credit_topup' and p.status in ('paid', 'partially_refunded', 'refunded') and p.paid_at >= $1 and p.paid_at < $2), 0)::text as refunded,
         coalesce((select sum(m.charged_micros) from metered_usage_events m where m.org_id = o.id and m.occurred_at >= $1 and m.occurred_at < $2), 0)::text as charged,
         coalesce((select sum(m.wholesale_micros) from metered_usage_events m where m.org_id = o.id and m.occurred_at >= $1 and m.occurred_at < $2), 0)::text as wholesale,
         coalesce((select sum(round(p.fee_minor::numeric / 100 / p.fx_rate * 1000000)) from payments p where p.org_id = o.id and p.fee_minor is not null and p.fx_rate is not null and p.status in ('paid', 'partially_refunded', 'refunded') and p.paid_at >= $1 and p.paid_at < $2), 0)::text as fees,
         coalesce((select sum(e.amount_micros) from agency_finance_entries e where e.org_id = o.id and e.kind = 'direct_cost' and e.voided_at is null and e.period_on >= $1::timestamptz::date and e.period_on < $2::timestamptz::date), 0)::text as direct
       from organizations o where o.kind = 'client' and ${scopeSql} order by o.name`,
      params,
    );

    const recon = (await db.query<{ n: string }>(
      `select count(*)::text as n from organizations o cross join lateral app.credit_reconciliation(o.id) r where o.kind = 'client' and ${agencyWide ? "true" : "o.id in (select org_id from staff_assignments where user_id = $1)"} and not r.consistent`,
      agencyWide ? [] : [user.id],
    )).rows[0];

    const setups = Number(pay.setups);
    const received = {
      setupMicros: Number(pay.setup), maintenanceMicros: Number(pay.maintenance), projectsMicros: Number(pay.projects), domainsMicros: Number(pay.domains), otherMicros: Number(pay.other),
      grossMicros: Number(pay.setup) + Number(pay.maintenance) + Number(pay.projects) + Number(pay.domains) + Number(pay.other), refundedMicros: Number(pay.refunded), netMicros: 0,
    };
    received.netMicros = received.grossMicros - received.refundedMicros;
    const usage = { chargedMicros: Number(use.charged), providerCostMicros: Number(use.wholesale), grossMarkupContributionMicros: Number(use.charged) - Number(use.wholesale), uncollectedMicros: Number(use.uncollected) };
    const fees = { knownMicros: Number(pay.fees), paymentsCounted: Number(pay.fee_known), paymentsWithoutFee: Number(pay.fee_unknown) };
    const costs = { directMicros: sumKind("direct_cost"), overheadMicros: sumKind("overhead") };
    const taxSetAside = sumKind("tax_set_aside");
    const reserveSetAsideInPeriod = sumKind("reserve_set_aside");
    const recommended = setups * settings.setup_reserve_usd * MICROS;
    const taxBps = settings.tax_set_aside_bps;

    // Tax on the result, only if a rate has been provided. A negative result owes nothing.
    const resultBefore = received.netMicros + usage.chargedMicros - usage.providerCostMicros - fees.knownMicros - costs.directMicros - costs.overheadMicros;
    const suggestedTax = taxBps === null ? null : Math.max(0, Math.round((resultBefore * taxBps) / 10_000));
    const unfundedReserve = Math.max(0, recommended - reserveSetAsideInPeriod);
    const unfundedTax = suggestedTax === null ? 0 : Math.max(0, suggestedTax - taxSetAside);
    const distributable = agencyWide
      ? { resultBeforeSetAsidesMicros: resultBefore, unfundedReserveMicros: unfundedReserve, unfundedTaxMicros: unfundedTax, estimateMicros: resultBefore - taxSetAside - reserveSetAsideInPeriod - unfundedReserve - unfundedTax }
      : null;

    const caveats: string[] = [];
    if (fees.paymentsWithoutFee > 0) caveats.push(`${fees.paymentsWithoutFee} payment${fees.paymentsWithoutFee === 1 ? " has" : "s have"} no processing fee recorded yet, so fees are understated.`);
    if (taxBps === null) caveats.push("No tax set-aside rate has been entered, so no tax has been provided for. This is not tax advice; ask your accountant.");
    if (agencyWide && costs.overheadMicros === 0) caveats.push("No overhead has been entered for this period. Enter hosting, software and other running costs, or the estimate will be too high.");
    if (usage.uncollectedMicros > 0) caveats.push("Some usage could not be collected because credits ran out. It is shown above but is not income until collected.");
    if (Number(recon.n) > 0) caveats.push(`${recon.n} client credit ledger${Number(recon.n) === 1 ? " does" : "s do"} not reconcile. Resolve this before relying on these figures.`);
    if (!agencyWide) caveats.push("You see only the clients you are assigned to. Agency-wide costs, reserve and the distribution estimate are visible to super admins.");

    const clients: ClientFinanceRow[] = clientRows.rows.map((c) => {
      const row = { receivedMicros: Number(c.received), refundedMicros: Number(c.refunded), usageChargedMicros: Number(c.charged), providerCostMicros: Number(c.wholesale), paymentFeesMicros: Number(c.fees), directCostsMicros: Number(c.direct) };
      return { orgId: c.org_id, name: c.name, ...row, contributionMicros: row.receivedMicros - row.refundedMicros + row.usageChargedMicros - row.providerCostMicros - row.paymentFeesMicros - row.directCostsMicros };
    });

    return {
      period,
      scope: agencyWide ? "agency" : "assigned",
      received,
      prepaid: { topUpsMicros: Number(pay.topups), heldForClientsMicros: Number(held.v) },
      usage,
      fees,
      costs,
      tax: { configuredBps: taxBps, setAsideMicros: taxSetAside, suggestedMicros: suggestedTax },
      reserve: { setupPayments: setups, perSetupUsd: settings.setup_reserve_usd, recommendedMicros: recommended, setAsideInPeriodMicros: reserveSetAsideInPeriod, setAsideMicros: Number(reserveAll.set_aside), usedMicros: Number(reserveAll.used), balanceMicros: Number(reserveAll.set_aside) - Number(reserveAll.used) },
      distributable,
      clients,
      entries: entryRows.rows.map((e) => ({ id: e.id, kind: e.kind, category: e.category, description: e.description, amountMicros: Number(e.amount_micros), periodOn: e.period_on, orgId: e.org_id, orgName: e.org_name, createdAt: new Date(e.created_at).toISOString(), voided: Boolean(e.voided_at), voidReason: e.void_reason })),
      reconciliationErrors: Number(recon.n),
      caveats,
    };
  });
}

const entrySchema = z.object({
  kind: z.enum(ENTRY_KINDS),
  category: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1, "Describe what this was for.").max(300),
  amountUsd: z.number().positive("Enter an amount above zero.").max(MAX_ENTRY_USD, "That amount is too large to enter by hand."),
  periodOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-14."),
  orgId: z.string().uuid().nullable().optional(),
});

/** Records money the agency spent or set aside. Entries are never edited or deleted: a mistake is voided, with a reason, and re-entered. */
export async function addFinanceEntry(user: SessionUser, input: z.input<typeof entrySchema>): Promise<{ id: string }> {
  requireFinanceManage(user);
  const d = entrySchema.parse(input);
  if (!CATEGORIES[d.kind].includes(d.category)) throw new AppError("invalid_input", "Choose one of the listed categories.");
  if (d.orgId && d.kind !== "direct_cost") throw new AppError("invalid_input", "Only a direct cost can belong to one client.");
  const micros = Math.round(d.amountUsd * MICROS);
  if (micros < 1) throw new AppError("invalid_input", "That amount is too small.");
  return withSystem(async (db) => {
    if (d.orgId) {
      const org = await db.query("select 1 from organizations where id = $1 and kind = 'client'", [d.orgId]);
      if (!org.rows[0]) throw new AppError("not_found", "Client not found.");
    }
    const { rows } = await db.query<{ id: string }>(
      "insert into agency_finance_entries (org_id, kind, category, description, amount_micros, period_on, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id",
      [d.orgId ?? null, d.kind, d.category, d.description, micros, d.periodOn, user.id],
    );
    await recordAudit({ orgId: d.orgId ?? null, actorUserId: user.id, actorKind: "agency", action: "finance.entry_added", targetType: "finance_entry", targetId: rows[0].id, result: "success", metadata: { kind: d.kind, category: d.category, micros } }, db);
    return { id: rows[0].id };
  });
}

export async function voidFinanceEntry(user: SessionUser, entryId: string, reason: string): Promise<void> {
  requireFinanceManage(user);
  const why = reason.trim();
  if (why.length < 3 || why.length > 300) throw new AppError("invalid_input", "Say why this entry is being voided, in 3 to 300 characters.");
  await withSystem(async (db) => {
    const res = await db.query<{ org_id: string | null }>("update agency_finance_entries set voided_at = now(), voided_by = $2, void_reason = $3 where id = $1 and voided_at is null returning org_id", [entryId, user.id, why]);
    if (!res.rows[0]) throw new AppError("not_found", "That entry doesn't exist or was already voided.");
    await recordAudit({ orgId: res.rows[0].org_id, actorUserId: user.id, actorKind: "agency", action: "finance.entry_voided", targetType: "finance_entry", targetId: entryId, result: "success" }, db);
  });
}

const settingsSchema = z.object({
  setupReserveUsd: z.number().int().min(0).max(1499).optional(),
  taxSetAsideBps: z.number().int().min(0).max(5000).nullable().optional(),
});

/** The reserve recommendation and the tax rate are the agency's own decisions; neither is assumed. */
export async function saveFinanceSettings(user: SessionUser, input: z.input<typeof settingsSchema>): Promise<void> {
  requireFinanceManage(user);
  const d = settingsSchema.parse(input);
  await withSystem(async (db) => {
    await db.query("insert into agency_billing_settings (singleton) values (true) on conflict do nothing");
    await db.query(
      `update agency_billing_settings set setup_reserve_usd = coalesce($1, setup_reserve_usd), tax_set_aside_bps = case when $2::boolean then $3 else tax_set_aside_bps end, updated_at = now()`,
      [d.setupReserveUsd ?? null, d.taxSetAsideBps !== undefined, d.taxSetAsideBps ?? null],
    );
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: "finance.settings_changed", result: "success", metadata: { setupReserveUsd: d.setupReserveUsd ?? null, taxSetAsideBps: d.taxSetAsideBps ?? null } }, db);
  });
}
