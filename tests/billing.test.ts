import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

// Provider secrets are set before the environment is first read. Values are fake and used only to sign test payloads.
const WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";
process.env.PAYMONGO_SECRET_KEY = "sk_test_notarealkey123";
process.env.PAYMONGO_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.PAYMONGO_PAYMENT_METHODS = "card,gcash";

import { resetEnvCache } from "@/server/env";
import { withSystem, withUser } from "@/server/db";
import { applyMarkup, grossMarkup, usdToChargeMinor, usdToMicros, formatUsd, APPROVED_MARKUP_BPS, NO_MARKUP_BPS } from "@/lib/billing";
import {
  BillingBlockedError,
  adjustCredits,
  chargeUsage,
  expireStaleReservations,
  getBalance,
  grantCredits,
  reconcileOrg,
  releaseReservation,
  reserveCredits,
  reverseCredits,
  settleReservation,
} from "@/server/billing/ledger";
import { createPaymentCheckout, handlePaymongoWebhook, recordRefund } from "@/server/billing/payments";
import { parseSignatureHeader, verifyWebhookSignature } from "@/server/billing/paymongo";
import { addProviderFee, adjustOrgCredits, confirmLivePaymentsReview, getAgencyBillingOverview, getBillingOverview, setExchangeRate, startTopUp, updateBillingSettings } from "@/server/billing/service";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

type Org = Awaited<ReturnType<typeof createOrg>>;
let org: Org;
let other: Org;
let owner: { id: string; email: string };
let manager: { id: string; email: string };
let member: { id: string; email: string };
let outsider: { id: string; email: string };
let admin: { id: string; email: string };

const sign = (body: string, opts: { live?: boolean; t?: number; secret?: string } = {}) => {
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", opts.secret ?? WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
  return `t=${t},te=${opts.live ? "" : sig},li=${opts.live ? sig : ""}`;
};

function paidEvent(o: { eventId: string; checkoutId: string; reference: string; amount: number; currency?: string; livemode?: boolean; paymentId?: string; status?: string }) {
  return JSON.stringify({
    data: {
      id: o.eventId,
      type: "event",
      attributes: {
        type: "checkout_session.payment.paid",
        livemode: o.livemode ?? false,
        created_at: 1700000000,
        updated_at: 1700000000,
        data: {
          id: o.checkoutId,
          type: "checkout_session",
          attributes: {
            reference_number: o.reference,
            status: "active",
            metadata: {},
            payment_intent: { id: "pi_x", type: "payment_intent", attributes: { amount: o.amount, currency: o.currency ?? "PHP", status: "succeeded" } },
            payments: [{ id: o.paymentId ?? `pay_${crypto.randomBytes(6).toString("hex")}`, type: "payment", attributes: { amount: o.amount, fee: 250, net_amount: o.amount - 250, currency: o.currency ?? "PHP", status: o.status ?? "paid" } }],
          },
        },
      },
    },
  });
}

const deliver = (body: string, opts: Parameters<typeof sign>[1] = {}) => handlePaymongoWebhook({ rawBody: body, signatureHeader: sign(body, opts) });
const evt = () => `evt_${crypto.randomBytes(8).toString("hex")}`;

function mockFetch(checkoutId: string, ok = true) {
  const calls: Array<{ url: string; body: { data: { attributes: Record<string, unknown> } }; auth: string }> = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)), auth: String((init?.headers as Record<string, string>).Authorization) });
    return new Response(JSON.stringify(ok ? { data: { id: checkoutId, attributes: { checkout_url: `https://checkout.paymongo.com/${checkoutId}_client_abc` } } } : { errors: [{ code: "x" }] }), { status: ok ? 200 : 400 });
  };
  return { impl, calls };
}

async function payment(id: string) {
  const { rows } = await withSystem((db) => db.query<Record<string, string>>("select * from payments where id = $1", [id]));
  return rows[0];
}

beforeAll(async () => {
  resetEnvCache();
  org = await createOrg({ name: "Billing Co" });
  other = await createOrg({ name: "Other Billing Co" });
  owner = await createUser();
  manager = await createUser();
  member = await createUser();
  outsider = await createUser();
  admin = await createUser({ platformRole: "agency_super_admin" });
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, manager.id, "admin");
  await addMember(org.id, member.id, "member");
  await addMember(other.id, outsider.id, "owner");
});

describe("money and markup", () => {
  it("applies the approved 30% markup to metered wholesale cost", () => {
    // The worked example from the pricing decision: $10.00 wholesale -> $13.00 charge -> $3.00 gross markup.
    expect(applyMarkup(usdToMicros(10), APPROVED_MARKUP_BPS)).toBe(usdToMicros(13));
    expect(grossMarkup(usdToMicros(10), APPROVED_MARKUP_BPS)).toBe(usdToMicros(3));
    expect(applyMarkup(0, APPROVED_MARKUP_BPS)).toBe(0);
  });

  it("rounds a fractional micro-dollar up so the agency never under-recovers", () => {
    expect(applyMarkup(1, 13000)).toBe(2); // 1.3 micros -> 2
    expect(applyMarkup(7, 13000)).toBe(10); // 9.1 -> 10
    expect(applyMarkup(10, 13000)).toBe(13); // exact
  });

  it("never marks up fixed provider fees, taxes or processing charges", () => {
    expect(applyMarkup(usdToMicros(15), NO_MARKUP_BPS)).toBe(usdToMicros(15));
  });

  it("refuses a markup below cost or a fractional wholesale amount", () => {
    expect(() => applyMarkup(100, 9000)).toThrow(RangeError);
    expect(() => applyMarkup(1.5, 13000)).toThrow(RangeError);
    expect(() => applyMarkup(-1, 13000)).toThrow(RangeError);
  });

  it("converts USD to the PHP charge in exact minor units, rounding up", () => {
    expect(usdToChargeMinor(usdToMicros(25), 58)).toBe(145000); // 25 x 58 = 1450.00
    expect(usdToChargeMinor(usdToMicros(1), 58.123456)).toBe(5813); // 58.123456 -> 58.13
    expect(usdToChargeMinor(usdToMicros(1499), 57.5)).toBe(8619250);
    expect(() => usdToChargeMinor(1_000_000, 0)).toThrow();
  });

  it("formats tiny charges with extra precision so they are not shown as zero", () => {
    expect(formatUsd(usdToMicros(13))).toBe("$13.00");
    expect(formatUsd(1234)).toBe("$0.0012");
  });
});

describe("credit ledger", () => {
  it("grants credits exactly once per payment even when delivered twice at the same time", async () => {
    const paymentId = crypto.randomUUID();
    await withSystem((db) => db.query("insert into payments (id, org_id, kind, description, usd_amount_micros, charged_currency, charged_amount_minor, livemode, reference_number, credits_micros) values ($1, $2, 'credit_topup', 'x', $3, 'PHP', 100, false, $4, $3)", [paymentId, org.id, usdToMicros(50), `IAQ-TEST${paymentId.slice(0, 6)}`]));
    const results = await Promise.all([1, 2, 3].map(() => withSystem((db) => grantCredits(db, { orgId: org.id, amountMicros: usdToMicros(50), paymentId }))));
    expect(results.filter((r) => r.granted)).toHaveLength(1);
    expect((await withSystem((db) => getBalance(db, org.id))).balanceMicros).toBe(usdToMicros(50));
    expect((await withSystem((db) => reconcileOrg(db, org.id))).consistent).toBe(true);
  });

  it("reserves credit before work and never lets two jobs spend the same credit", async () => {
    const orgX = await createOrg({ name: "Reserve Co" });
    await withSystem((db) => adjustCredits(db, { orgId: orgX.id, deltaMicros: usdToMicros(10), reason: "seed credit for test", userId: owner.id }));
    const attempts = await Promise.allSettled([1, 2, 3].map((n) => withSystem((db) => reserveCredits(db, { orgId: orgX.id, estimateMicros: usdToMicros(6), purpose: `job ${n}`, jobReference: `job-${n}` }))));
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    const failure = attempts.find((a) => a.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(BillingBlockedError);
    expect((failure.reason as BillingBlockedError).reason).toBe("insufficient_credits");
    const b = await withSystem((db) => getBalance(db, orgX.id));
    expect(b).toEqual({ balanceMicros: usdToMicros(10), reservedMicros: usdToMicros(6), availableMicros: usdToMicros(4) });
  });

  it("returns the same hold for a repeated job reference", async () => {
    const orgX = await createOrg({ name: "Idem Co" });
    await withSystem((db) => adjustCredits(db, { orgId: orgX.id, deltaMicros: usdToMicros(5), reason: "seed credit for test", userId: owner.id }));
    const a = await withSystem((db) => reserveCredits(db, { orgId: orgX.id, estimateMicros: usdToMicros(1), purpose: "reply", jobReference: "msg-1" }));
    const b = await withSystem((db) => reserveCredits(db, { orgId: orgX.id, estimateMicros: usdToMicros(1), purpose: "reply", jobReference: "msg-1" }));
    expect(b).toEqual({ id: a.id, reused: true });
    expect((await withSystem((db) => getBalance(db, orgX.id))).reservedMicros).toBe(usdToMicros(1));
  });

  it("settles to the real cost, releases the unused hold and applies the markup", async () => {
    const orgX = await createOrg({ name: "Settle Co" });
    await withSystem((db) => adjustCredits(db, { orgId: orgX.id, deltaMicros: usdToMicros(20), reason: "seed credit for test", userId: owner.id }));
    const hold = await withSystem((db) => reserveCredits(db, { orgId: orgX.id, estimateMicros: usdToMicros(8), purpose: "sms" }));
    const charge = await withSystem((db) => settleReservation(db, { orgId: orgX.id, reservationId: hold.id, usage: { provider: "ghl", unitType: "sms_segment", quantity: 100, wholesaleMicros: usdToMicros(5), providerReference: "batch-1" } }));
    expect(charge).toMatchObject({ clientMicros: usdToMicros(6.5), chargedMicros: usdToMicros(6.5), uncollectedMicros: 0, duplicate: false });
    const b = await withSystem((db) => getBalance(db, orgX.id));
    expect(b).toEqual({ balanceMicros: usdToMicros(13.5), reservedMicros: 0, availableMicros: usdToMicros(13.5) });
    // Settling twice (a retry) neither double charges nor errors.
    const again = await withSystem((db) => settleReservation(db, { orgId: orgX.id, reservationId: hold.id, usage: { provider: "ghl", unitType: "sms_segment", quantity: 100, wholesaleMicros: usdToMicros(5), providerReference: "batch-1" } }));
    expect(again.duplicate).toBe(true);
    expect((await withSystem((db) => getBalance(db, orgX.id))).balanceMicros).toBe(usdToMicros(13.5));
    expect((await withSystem((db) => reconcileOrg(db, orgX.id))).consistent).toBe(true);
  });

  it("never charges below zero: overage beyond free credit is recorded as uncollected", async () => {
    const orgX = await createOrg({ name: "Overage Co" });
    await withSystem((db) => adjustCredits(db, { orgId: orgX.id, deltaMicros: usdToMicros(4), reason: "seed credit for test", userId: owner.id }));
    const hold = await withSystem((db) => reserveCredits(db, { orgId: orgX.id, estimateMicros: usdToMicros(2), purpose: "research" }));
    // Real wholesale cost $5 -> client charge $6.50, but only $4 exists.
    const charge = await withSystem((db) => settleReservation(db, { orgId: orgX.id, reservationId: hold.id, usage: { provider: "llm", unitType: "ai_tokens_out", quantity: 1000, wholesaleMicros: usdToMicros(5) } }));
    expect(charge.chargedMicros).toBe(usdToMicros(4));
    expect(charge.uncollectedMicros).toBe(usdToMicros(2.5));
    const b = await withSystem((db) => getBalance(db, orgX.id));
    expect(b.balanceMicros).toBe(0);
    expect(b.reservedMicros).toBe(0);
    const { rows } = await withSystem((db) => db.query<{ billing_status: string; uncollected_micros: string }>("select billing_status, uncollected_micros from metered_usage_events where org_id = $1", [orgX.id]));
    expect(rows[0]).toEqual({ billing_status: "partially_collected", uncollected_micros: usdToMicros(2.5) });
    // Credits are exhausted, so further chargeable work is refused and the owner was told.
    await expect(withSystem((db) => reserveCredits(db, { orgId: orgX.id, estimateMicros: 1000, purpose: "more" }))).rejects.toBeInstanceOf(BillingBlockedError);
  });

  it("does not let overage eat credit reserved by another job", async () => {
    const orgX = await createOrg({ name: "Two Jobs Co" });
    await withSystem((db) => adjustCredits(db, { orgId: orgX.id, deltaMicros: usdToMicros(10), reason: "seed credit for test", userId: owner.id }));
    const a = await withSystem((db) => reserveCredits(db, { orgId: orgX.id, estimateMicros: usdToMicros(3), purpose: "a" }));
    await withSystem((db) => reserveCredits(db, { orgId: orgX.id, estimateMicros: usdToMicros(6), purpose: "b" }));
    // Job a overruns hugely; only its hold plus the $1 of free credit can be charged, job b's $6 stays protected.
    const charge = await withSystem((db) => settleReservation(db, { orgId: orgX.id, reservationId: a.id, usage: { provider: "llm", unitType: "ai_tokens_out", quantity: 1, wholesaleMicros: usdToMicros(20) } }));
    expect(charge.chargedMicros).toBe(usdToMicros(4));
    const b = await withSystem((db) => getBalance(db, orgX.id));
    expect(b).toEqual({ balanceMicros: usdToMicros(6), reservedMicros: usdToMicros(6), availableMicros: 0 });
  });

  it("releases unused and expired holds", async () => {
    const orgX = await createOrg({ name: "Release Co" });
    await withSystem((db) => adjustCredits(db, { orgId: orgX.id, deltaMicros: usdToMicros(10), reason: "seed credit for test", userId: owner.id }));
    const a = await withSystem((db) => reserveCredits(db, { orgId: orgX.id, estimateMicros: usdToMicros(2), purpose: "a" }));
    const b = await withSystem((db) => reserveCredits(db, { orgId: orgX.id, estimateMicros: usdToMicros(3), purpose: "b", ttlSeconds: 60 }));
    expect(await withSystem((db) => releaseReservation(db, { orgId: orgX.id, reservationId: a.id }))).toEqual({ released: true });
    expect(await withSystem((db) => releaseReservation(db, { orgId: orgX.id, reservationId: a.id }))).toEqual({ released: false });
    await withSystem((db) => db.query("update usage_reservations set expires_at = now() - interval '1 minute' where id = $1", [b.id]));
    expect(await withSystem((db) => expireStaleReservations(db))).toBeGreaterThanOrEqual(1);
    expect((await withSystem((db) => getBalance(db, orgX.id))).reservedMicros).toBe(0);
    await expect(withSystem((db) => settleReservation(db, { orgId: orgX.id, reservationId: b.id, usage: { provider: "x", unitType: "other", quantity: 1, wholesaleMicros: 1 } }))).rejects.toThrow(/already settled or released/);
  });

  it("charges usage reported after the fact, and de-duplicates by provider reference", async () => {
    const orgX = await createOrg({ name: "After Co" });
    await withSystem((db) => adjustCredits(db, { orgId: orgX.id, deltaMicros: usdToMicros(3), reason: "seed credit for test", userId: owner.id }));
    const usage = { provider: "ghl", unitType: "sms_segment" as const, quantity: 4, wholesaleMicros: usdToMicros(1), providerReference: "evt-77" };
    const first = await withSystem((db) => chargeUsage(db, { orgId: orgX.id, usage }));
    const second = await withSystem((db) => chargeUsage(db, { orgId: orgX.id, usage }));
    expect(first.chargedMicros).toBe(usdToMicros(1.3));
    expect(second.duplicate).toBe(true);
    expect((await withSystem((db) => getBalance(db, orgX.id))).balanceMicros).toBe(usdToMicros(3) - usdToMicros(1.3));
  });

  it("enforces the monthly budget with a hard stop, and lets the client raise it", async () => {
    const orgX = await createOrg({ name: "Budget Co" });
    const ownerX = await createUser();
    await addMember(orgX.id, ownerX.id, "owner");
    await withSystem((db) => adjustCredits(db, { orgId: orgX.id, deltaMicros: usdToMicros(100), reason: "seed credit for test", userId: ownerX.id }));
    await updateBillingSettings(ctxFor(ownerX, orgX, "owner"), { monthlyBudgetUsd: 10, warnAtPercent: 80, lowBalanceUsd: 5, hardStop: true });
    await withSystem((db) => chargeUsage(db, { orgId: orgX.id, usage: { provider: "ghl", unitType: "sms_segment", quantity: 1, wholesaleMicros: usdToMicros(6.5), providerReference: "b1" } }));
    // $8.45 spent of $10: past the 80% warning level.
    const warned = await withSystem((db) => db.query("select 1 from notifications where org_id = $1 and kind = 'billing_budget_warning'", [orgX.id]));
    expect(warned.rows.length).toBeGreaterThan(0);
    await expect(withSystem((db) => reserveCredits(db, { orgId: orgX.id, estimateMicros: usdToMicros(3), purpose: "over" }))).rejects.toMatchObject({ reason: "budget_exceeded" });
    await updateBillingSettings(ctxFor(ownerX, orgX, "owner"), { monthlyBudgetUsd: 50, warnAtPercent: 80, lowBalanceUsd: 5, hardStop: true });
    await expect(withSystem((db) => reserveCredits(db, { orgId: orgX.id, estimateMicros: usdToMicros(3), purpose: "ok" }))).resolves.toBeTruthy();
    await expect(updateBillingSettings(ctxFor(member, org, "member"), { monthlyBudgetUsd: 5, warnAtPercent: 80, lowBalanceUsd: 5, hardStop: true })).rejects.toThrow(/Only owners and managers/);
  });

  it("adjustments cannot remove credit that is reserved for running work", async () => {
    const orgX = await createOrg({ name: "Adjust Co" });
    await withSystem((db) => adjustCredits(db, { orgId: orgX.id, deltaMicros: usdToMicros(10), reason: "seed credit for test", userId: owner.id }));
    await withSystem((db) => reserveCredits(db, { orgId: orgX.id, estimateMicros: usdToMicros(8), purpose: "a" }));
    await expect(withSystem((db) => adjustCredits(db, { orgId: orgX.id, deltaMicros: -usdToMicros(5), reason: "correction needed here", userId: owner.id }))).rejects.toThrow(/reserved/);
    await expect(withSystem((db) => adjustCredits(db, { orgId: orgX.id, deltaMicros: -usdToMicros(1), reason: "x", userId: owner.id }))).rejects.toThrow(/why/);
  });

  it("the database refuses to rewrite or delete ledger history", async () => {
    await expect(withSystem((db) => db.query("update credit_ledger_entries set delta_micros = 1 where org_id = $1", [org.id]))).rejects.toThrow(/append-only/);
    await expect(withSystem((db) => db.query("delete from credit_ledger_entries where org_id = $1", [org.id]))).rejects.toThrow(/append-only/);
    await expect(withSystem((db) => db.query("update usage_rate_versions set markup_bps = 20000"))).rejects.toThrow(/append-only/);
  });

  it("detects a ledger that no longer matches its account (reconciliation)", async () => {
    const orgX = await createOrg({ name: "Drift Co" });
    await withSystem((db) => adjustCredits(db, { orgId: orgX.id, deltaMicros: usdToMicros(5), reason: "seed credit for test", userId: owner.id }));
    expect((await withSystem((db) => reconcileOrg(db, orgX.id))).consistent).toBe(true);
    await withSystem((db) => db.query("update credit_accounts set balance_micros = balance_micros + 1000 where org_id = $1", [orgX.id]));
    const r = await withSystem((db) => reconcileOrg(db, orgX.id));
    expect(r.consistent).toBe(false);
    expect(r.balanceMicros - r.ledgerBalanceMicros).toBe(1000);
    const overview = await getAgencyBillingOverview({ id: admin.id, platformRole: "agency_super_admin" });
    expect(overview.reconciliationErrors.map((e) => e.orgId)).toContain(orgX.id);
  });

  it("an unreversible refund never drives the balance negative", async () => {
    const orgX = await createOrg({ name: "Refund Co" });
    await withSystem((db) => adjustCredits(db, { orgId: orgX.id, deltaMicros: usdToMicros(10), reason: "seed credit for test", userId: owner.id }));
    const res = await withSystem((db) => reverseCredits(db, { orgId: orgX.id, paymentId: crypto.randomUUID(), amountMicros: usdToMicros(25), kind: "refund", idempotencyKey: `refund:${uid8()}` }));
    expect(res).toEqual({ removedMicros: usdToMicros(10), shortfallMicros: usdToMicros(15) });
    expect((await withSystem((db) => getBalance(db, orgX.id))).balanceMicros).toBe(0);
  });
});

const uid8 = () => crypto.randomBytes(6).toString("hex");

describe("PayMongo signature verification", () => {
  const body = '{"data":{"id":"evt_1"}}';
  it("accepts a correct test-mode signature and a correct live-mode signature", () => {
    expect(verifyWebhookSignature({ header: sign(body), rawBody: body, secret: WEBHOOK_SECRET })).toEqual({ ok: true, livemode: false });
    expect(verifyWebhookSignature({ header: sign(body, { live: true }), rawBody: body, secret: WEBHOOK_SECRET })).toEqual({ ok: true, livemode: true });
  });

  it("rejects a tampered body, the wrong secret, and a missing or malformed header", () => {
    expect(verifyWebhookSignature({ header: sign(body), rawBody: body + " ", secret: WEBHOOK_SECRET })).toMatchObject({ ok: false, reason: "mismatch" });
    expect(verifyWebhookSignature({ header: sign(body, { secret: "other-secret-value" }), rawBody: body, secret: WEBHOOK_SECRET })).toMatchObject({ ok: false, reason: "mismatch" });
    expect(verifyWebhookSignature({ header: null, rawBody: body, secret: WEBHOOK_SECRET })).toMatchObject({ ok: false, reason: "missing" });
    expect(verifyWebhookSignature({ header: "garbage", rawBody: body, secret: WEBHOOK_SECRET })).toMatchObject({ ok: false, reason: "malformed" });
    expect(verifyWebhookSignature({ header: "t=1700000000,te=,li=", rawBody: body, secret: WEBHOOK_SECRET })).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("will not accept a test-mode signature as live, or a header carrying both signatures", () => {
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
    expect(verifyWebhookSignature({ header: `t=${t},te=${sig},li=${sig}`, rawBody: body, secret: WEBHOOK_SECRET })).toMatchObject({ ok: false, reason: "malformed" });
    // A signature placed in `li` for a payload that was signed as `te` is still computed over the same bytes, so mode is taken from the field used.
    expect(verifyWebhookSignature({ header: `t=${t},te=,li=${sig}`, rawBody: body, secret: WEBHOOK_SECRET })).toEqual({ ok: true, livemode: true });
  });

  it("rejects a very old timestamp", () => {
    const old = Math.floor(Date.now() / 1000) - 3 * 24 * 3600;
    expect(verifyWebhookSignature({ header: sign(body, { t: old }), rawBody: body, secret: WEBHOOK_SECRET })).toMatchObject({ ok: false, reason: "stale" });
  });

  it("parses the header parts", () => {
    expect(parseSignatureHeader("t=1496734173,te=abc,li=")).toEqual({ timestamp: "1496734173", test: "abc", live: "" });
    expect(parseSignatureHeader("te=abc")).toBeNull();
  });
});

describe("checkout and payment confirmation", () => {
  async function setRate() {
    await setExchangeRate({ id: admin.id, platformRole: "agency_super_admin" }, { usdPhpRate: 58, source: "Test fixture rate (not a market rate)" });
  }

  it("will not start a checkout until an exchange rate has been recorded", async () => {
    const { impl, calls } = mockFetch("cs_norate");
    const count = async () => (await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from payments where org_id = $1", [org.id]))).rows[0].n;
    const before = await count();
    await expect(startTopUp(ctxFor(owner, org, "owner"), 25, { fetch: impl })).rejects.toThrow(/exchange rate/);
    expect(calls).toHaveLength(0);
    // Nothing is left behind that could later be confirmed.
    expect(await count()).toBe(before);
  });

  it("creates a PHP checkout with the converted amount, our reference, and the configured payment methods", async () => {
    await setRate();
    const { impl, calls } = mockFetch("cs_topup_1");
    const out = await startTopUp(ctxFor(owner, org, "owner"), 25, { fetch: impl });
    expect(out.checkoutUrl).toMatch(/^https:\/\/checkout\.paymongo\.com\//);
    const attrs = calls[0].body.data.attributes as { line_items: Array<{ amount: number; currency: string }>; payment_method_types: string[]; reference_number: string; description: string };
    expect(calls[0].url).toBe("https://api.paymongo.com/v2/checkout_sessions");
    expect(attrs.line_items[0]).toMatchObject({ amount: 145000, currency: "PHP" });
    expect(attrs.payment_method_types).toEqual(["card", "gcash"]);
    expect(attrs.description).toContain(out.referenceNumber);
    expect(calls[0].auth.startsWith("Basic ")).toBe(true);
    const p = await payment(out.paymentId);
    expect(p).toMatchObject({ status: "pending", provider_checkout_id: "cs_topup_1", kind: "credit_topup", credits_micros: usdToMicros(25) });
    expect(p.fx_rate).toBe("58.000000");
  });

  it("limits top-ups to whole-dollar amounts within the configured range, and to people who may buy credits", async () => {
    const { impl } = mockFetch("cs_bad");
    await expect(startTopUp(ctxFor(owner, org, "owner"), 5, { fetch: impl })).rejects.toThrow(/from \$10 to \$2000/);
    await expect(startTopUp(ctxFor(owner, org, "owner"), 25.5, { fetch: impl })).rejects.toThrow(/whole-dollar/);
    await expect(startTopUp(ctxFor(owner, org, "owner"), 5000, { fetch: impl })).rejects.toThrow(/from \$10/);
    await expect(startTopUp(ctxFor(member, org, "member"), 25, { fetch: impl })).rejects.toThrow(/Only owners and managers/);
  });

  it("marks a checkout failed and grants nothing when the provider rejects it", async () => {
    const before = await withSystem((db) => getBalance(db, org.id));
    const { impl } = mockFetch("cs_rejected", false);
    await expect(startTopUp(ctxFor(owner, org, "owner"), 50, { fetch: impl })).rejects.toThrow(/Nothing was charged/);
    const { rows } = await withSystem((db) => db.query<{ status: string }>("select status from payments where org_id = $1 order by created_at desc limit 1", [org.id]));
    expect(rows[0].status).toBe("failed");
    expect(await withSystem((db) => getBalance(db, org.id))).toEqual(before);
  });

  it("refuses a checkout link that does not point to PayMongo", async () => {
    const evil = async () => new Response(JSON.stringify({ data: { id: "cs_evil", attributes: { checkout_url: "https://evil.example/pay" } } }), { status: 200 });
    await expect(startTopUp(ctxFor(owner, org, "owner"), 25, { fetch: evil })).rejects.toThrow(/did not point to PayMongo/);
  });

  it("grants the right credits exactly once for a verified payment, and ignores a replay or retry", async () => {
    const { impl } = mockFetch("cs_paid_1");
    const out = await startTopUp(ctxFor(manager, org, "admin"), 100, { fetch: impl });
    const before = (await withSystem((db) => getBalance(db, org.id))).balanceMicros;
    const body = paidEvent({ eventId: evt(), checkoutId: "cs_paid_1", reference: out.referenceNumber, amount: 580000 });
    const first = await deliver(body);
    expect(first).toMatchObject({ httpStatus: 200, outcome: "processed" });
    const after = (await withSystem((db) => getBalance(db, org.id))).balanceMicros;
    expect(after - before).toBe(usdToMicros(100));
    const p = await payment(out.paymentId);
    expect(p).toMatchObject({ status: "paid", fee_minor: 250 });
    expect(p.provider_payment_id).toMatch(/^pay_/);
    // Same event again (PayMongo retry or an attacker replaying a captured request).
    expect(await deliver(body)).toMatchObject({ httpStatus: 200, outcome: "duplicate" });
    // A different event id for the same checkout (for example a second delivery path).
    expect(await deliver(paidEvent({ eventId: evt(), checkoutId: "cs_paid_1", reference: out.referenceNumber, amount: 580000 }))).toMatchObject({ httpStatus: 200, outcome: "ignored" });
    expect((await withSystem((db) => getBalance(db, org.id))).balanceMicros).toBe(after);
    const ledger = await withSystem((db) => db.query("select 1 from credit_ledger_entries where org_id = $1 and kind = 'credits_granted' and reference_id = $2", [org.id, out.paymentId]));
    expect(ledger.rows).toHaveLength(1);
    expect((await withSystem((db) => reconcileOrg(db, org.id))).consistent).toBe(true);
    const note = await withUser(owner.id, (db) => db.query("select 1 from notifications where kind = 'billing_payment_received'"));
    expect(note.rows.length).toBeGreaterThan(0);
  });

  it("rejects forged, tampered, wrongly-moded and unsigned deliveries without granting anything", async () => {
    const { impl } = mockFetch("cs_forge_1");
    const out = await startTopUp(ctxFor(owner, org, "owner"), 25, { fetch: impl });
    const before = (await withSystem((db) => getBalance(db, org.id))).balanceMicros;
    const body = paidEvent({ eventId: evt(), checkoutId: "cs_forge_1", reference: out.referenceNumber, amount: 145000 });
    expect(await handlePaymongoWebhook({ rawBody: body, signatureHeader: null })).toMatchObject({ httpStatus: 401 });
    expect(await handlePaymongoWebhook({ rawBody: body, signatureHeader: sign(body, { secret: "attacker-guess-secret" }) })).toMatchObject({ httpStatus: 401 });
    expect(await handlePaymongoWebhook({ rawBody: body + "\n", signatureHeader: sign(body) })).toMatchObject({ httpStatus: 401 });
    // Signed as a live event but the payload says test mode.
    expect(await deliver(body, { live: true })).toMatchObject({ httpStatus: 400 });
    expect((await withSystem((db) => getBalance(db, org.id))).balanceMicros).toBe(before);
    expect((await payment(out.paymentId)).status).toBe("pending");
  });

  it("grants nothing when the paid amount or currency differs from what was requested, and alerts the agency", async () => {
    const { impl } = mockFetch("cs_short_1");
    const out = await startTopUp(ctxFor(owner, org, "owner"), 50, { fetch: impl });
    const before = (await withSystem((db) => getBalance(db, org.id))).balanceMicros;
    const short = await deliver(paidEvent({ eventId: evt(), checkoutId: "cs_short_1", reference: out.referenceNumber, amount: 100000 }));
    expect(short).toMatchObject({ httpStatus: 200, outcome: "rejected" });
    expect((await payment(out.paymentId)).status).toBe("mismatch");
    expect((await withSystem((db) => getBalance(db, org.id))).balanceMicros).toBe(before);
    const { impl: impl2 } = mockFetch("cs_usd_1");
    const out2 = await startTopUp(ctxFor(owner, org, "owner"), 50, { fetch: impl2 });
    const wrongCurrency = await deliver(paidEvent({ eventId: evt(), checkoutId: "cs_usd_1", reference: out2.referenceNumber, amount: 290000, currency: "USD" }));
    expect(wrongCurrency.outcome).toBe("rejected");
    expect((await withSystem((db) => getBalance(db, org.id))).balanceMicros).toBe(before);
  });

  it("does not credit an unpaid or unknown checkout, and never takes the workspace from the event", async () => {
    const { impl } = mockFetch("cs_unpaid_1");
    const out = await startTopUp(ctxFor(owner, org, "owner"), 25, { fetch: impl });
    const before = (await withSystem((db) => getBalance(db, org.id))).balanceMicros;
    const otherBefore = (await withSystem((db) => getBalance(db, other.id))).balanceMicros;
    // Payment object not paid.
    expect((await deliver(paidEvent({ eventId: evt(), checkoutId: "cs_unpaid_1", reference: out.referenceNumber, amount: 145000, status: "pending" }))).outcome).toBe("ignored");
    // A checkout id we never created.
    expect((await deliver(paidEvent({ eventId: evt(), checkoutId: "cs_never_created", reference: out.referenceNumber, amount: 145000 }))).outcome).toBe("ignored");
    // Our checkout id with another payment's reference is rejected.
    const bodyMismatch = paidEvent({ eventId: evt(), checkoutId: "cs_unpaid_1", reference: "IAQ-SOMEONEELSE1", amount: 145000 });
    expect((await deliver(bodyMismatch)).outcome).toBe("rejected");
    // Metadata naming another workspace is never consulted.
    const smuggled = JSON.parse(paidEvent({ eventId: evt(), checkoutId: "cs_unpaid_1", reference: out.referenceNumber, amount: 145000 }));
    smuggled.data.attributes.data.attributes.metadata = { org_id: other.id };
    const smuggledBody = JSON.stringify(smuggled);
    expect((await deliver(smuggledBody)).outcome).toBe("processed");
    expect((await withSystem((db) => getBalance(db, org.id))).balanceMicros - before).toBe(usdToMicros(25));
    expect((await withSystem((db) => getBalance(db, other.id))).balanceMicros).toBe(otherBefore);
  });

  it("ignores live events in a test environment and unknown event types, always acknowledging them", async () => {
    const live = paidEvent({ eventId: evt(), checkoutId: "cs_any", reference: "IAQ-ANY12345", amount: 100, livemode: true });
    expect(await deliver(live, { live: true })).toMatchObject({ httpStatus: 200, outcome: "ignored" });
    const other = JSON.stringify({ data: { id: evt(), type: "event", attributes: { type: "source.chargeable", livemode: false, data: { id: "src_1", type: "source", attributes: {} } } } });
    expect(await deliver(other)).toMatchObject({ httpStatus: 200, outcome: "ignored" });
  });

  it("notes a failed attempt that carries our reference, grants nothing, and leaves the checkout open", async () => {
    const { impl } = mockFetch("cs_fail_1");
    const out = await startTopUp(ctxFor(owner, org, "owner"), 25, { fetch: impl });
    const failed = JSON.stringify({ data: { id: evt(), type: "event", attributes: { type: "payment.failed", livemode: false, data: { id: "pay_f1", type: "payment", attributes: { amount: 145000, currency: "PHP", status: "failed", description: `iAcquire credits [${out.referenceNumber}]` } } } } });
    const before = (await withSystem((db) => getBalance(db, org.id))).balanceMicros;
    expect((await deliver(failed)).outcome).toBe("processed");
    expect((await payment(out.paymentId)).status).toBe("pending");
    expect((await withSystem((db) => getBalance(db, org.id))).balanceMicros).toBe(before);
    const unlinked = JSON.stringify({ data: { id: evt(), type: "event", attributes: { type: "payment.failed", livemode: false, data: { id: "pay_f2", type: "payment", attributes: { amount: 1, currency: "PHP", status: "failed", description: "no reference" } } } } });
    expect((await deliver(unlinked)).outcome).toBe("ignored");
  });

  it("confirms the setup fee from a verified payment only, and only for the agreed amount", async () => {
    const orgS = await createOrg({ name: "Setup Fee Co" });
    const ownerS = await createUser();
    await addMember(orgS.id, ownerS.id, "owner");
    const { impl } = mockFetch("cs_setup_1");
    const { createPaymentCheckout: create } = await import("@/server/billing/payments");
    await expect(create({ orgId: orgS.id, kind: "setup_fee", usdMicros: usdToMicros(1000), description: "Setup", requestedBy: admin.id }, { fetch: impl })).rejects.toThrow(/agreed price/);
    const out = await create({ orgId: orgS.id, kind: "setup_fee", usdMicros: usdToMicros(1499), description: "iAcquire setup", requestedBy: admin.id }, { fetch: impl });
    let { rows } = await withSystem((db) => db.query<{ setup_payment_status: string }>("select setup_payment_status from billing_accounts where org_id = $1", [orgS.id]));
    expect(rows[0].setup_payment_status).toBe("not_invoiced");
    expect((await deliver(paidEvent({ eventId: evt(), checkoutId: "cs_setup_1", reference: out.referenceNumber, amount: usdToChargeMinor(usdToMicros(1499), 58) }))).outcome).toBe("processed");
    ({ rows } = await withSystem((db) => db.query<{ setup_payment_status: string }>("select setup_payment_status from billing_accounts where org_id = $1", [orgS.id])));
    expect(rows[0].setup_payment_status).toBe("paid");
    await expect(create({ orgId: orgS.id, kind: "setup_fee", usdMicros: usdToMicros(1499), description: "again", requestedBy: admin.id }, { fetch: impl })).rejects.toThrow(/already paid/);
    // No monthly platform fee exists anywhere in the model.
    const { rows: kinds } = await withSystem((db) => db.query<{ kind: string }>("select distinct kind from payments"));
    expect(kinds.map((k) => k.kind).every((k) => ["setup_fee", "credit_topup", "maintenance", "custom_project", "domain", "other"].includes(k))).toBe(true);
  });

  it("refunds restore only unused credit and keep the ledger consistent", async () => {
    const orgR = await createOrg({ name: "Refund Flow Co" });
    const ownerR = await createUser();
    await addMember(orgR.id, ownerR.id, "owner");
    const { impl } = mockFetch("cs_refund_1");
    const out = await startTopUp(ctxFor(ownerR, orgR, "owner"), 50, { fetch: impl });
    await deliver(paidEvent({ eventId: evt(), checkoutId: "cs_refund_1", reference: out.referenceNumber, amount: usdToChargeMinor(usdToMicros(50), 58) }));
    await withSystem((db) => chargeUsage(db, { orgId: orgR.id, usage: { provider: "ghl", unitType: "sms_segment", quantity: 1, wholesaleMicros: usdToMicros(20), providerReference: "spent-1" } }));
    // $26 was spent; refunding $50 can only take back the $24 still unused.
    const res = await recordRefund({ paymentId: out.paymentId, amountMicros: usdToMicros(50), actorUserId: admin.id, reason: "Customer cancelled" });
    expect(res).toEqual({ removedMicros: usdToMicros(24), shortfallMicros: usdToMicros(26) });
    expect((await payment(out.paymentId)).status).toBe("refunded");
    expect((await withSystem((db) => getBalance(db, orgR.id))).balanceMicros).toBe(0);
    expect((await withSystem((db) => reconcileOrg(db, orgR.id))).consistent).toBe(true);
    await expect(recordRefund({ paymentId: out.paymentId, amountMicros: 1, actorUserId: admin.id, reason: "again please" })).rejects.toThrow(/Only a paid payment/);
  });

  it("keeps live checkout blocked until the legal and tax review is confirmed", async () => {
    const saved = process.env.PAYMONGO_SECRET_KEY;
    process.env.PAYMONGO_SECRET_KEY = "sk_live_notarealkey123";
    resetEnvCache();
    try {
      const { impl, calls } = mockFetch("cs_live_1");
      await expect(startTopUp(ctxFor(owner, org, "owner"), 25, { fetch: impl })).rejects.toThrow(/tax review/);
      expect(calls).toHaveLength(0);
      await expect(confirmLivePaymentsReview({ id: owner.id, platformRole: "none" }, true)).rejects.toThrow(/super admin/);
      await confirmLivePaymentsReview({ id: admin.id, platformRole: "agency_super_admin" }, true);
      const out = await startTopUp(ctxFor(owner, org, "owner"), 25, { fetch: impl });
      expect((await payment(out.paymentId)).livemode).toBe(true);
      await confirmLivePaymentsReview({ id: admin.id, platformRole: "agency_super_admin" }, false);
    } finally {
      process.env.PAYMONGO_SECRET_KEY = saved;
      resetEnvCache();
    }
  });

  it("reports honest blocked states when payments are not configured", async () => {
    const savedKey = process.env.PAYMONGO_SECRET_KEY;
    const savedSecret = process.env.PAYMONGO_WEBHOOK_SECRET;
    delete process.env.PAYMONGO_SECRET_KEY;
    delete process.env.PAYMONGO_WEBHOOK_SECRET;
    resetEnvCache();
    try {
      await expect(createPaymentCheckout({ orgId: org.id, kind: "credit_topup", usdMicros: usdToMicros(25), description: "x", requestedBy: null })).rejects.toThrow(/not connected/);
      expect(await handlePaymongoWebhook({ rawBody: "{}", signatureHeader: "t=1700000000,te=a,li=" })).toMatchObject({ httpStatus: 503 });
      const overview = await getBillingOverview(ctxFor(owner, org, "owner"));
      expect(overview.payments.canTopUp).toBe(false);
      expect(overview.payments.blockedReason).toMatch(/not connected/);
    } finally {
      process.env.PAYMONGO_SECRET_KEY = savedKey;
      process.env.PAYMONGO_WEBHOOK_SECRET = savedSecret;
      resetEnvCache();
    }
  });
});

describe("billing visibility and tenant isolation", () => {
  it("shows owners and managers credits and usage, and keeps provider wholesale cost private", async () => {
    const overview = await getBillingOverview(ctxFor(owner, org, "owner"));
    expect(overview.autoRecharge).toMatchObject({ enabled: false, available: false });
    expect(overview.rates.markupBps).toBe(13000);
    expect(overview.recentPayments.length).toBeGreaterThan(0);
    await expect(getBillingOverview(ctxFor(member, org, "member"))).rejects.toThrow(/Only owners and managers/);
    // Managers see credits but not payment records (billing.view is owner-only).
    expect((await getBillingOverview(ctxFor(manager, org, "admin"))).recentPayments).toEqual([]);
    await expect(withUser(owner.id, (db) => db.query("select wholesale_micros from metered_usage_events"))).rejects.toThrow(/permission denied/);
    await expect(withUser(owner.id, (db) => db.query("select provider_checkout_id from payments"))).rejects.toThrow(/permission denied/);
    await expect(withUser(owner.id, (db) => db.query("select * from payment_webhook_events"))).rejects.toThrow(/permission denied/);
    await expect(withUser(owner.id, (db) => db.query("select * from agency_billing_settings"))).rejects.toThrow(/permission denied/);
  });

  it("never lets one workspace read another's ledger, accounts, payments or usage", async () => {
    for (const table of ["credit_ledger_entries", "credit_accounts", "payments", "usage_reservations", "billing_settings", "provider_fees"]) {
      const rows = await withUser(outsider.id, (db) => db.query(`select 1 from ${table} where org_id = $1`, [org.id]));
      expect(rows.rows, table).toEqual([]);
    }
    const usage = await withUser(outsider.id, (db) => db.query("select 1 from metered_usage_events where org_id = $1", [org.id]));
    expect(usage.rows).toEqual([]);
  });

  it("denies the application role any write to money tables", async () => {
    for (const sql of [
      "update credit_accounts set balance_micros = 999999999 where org_id = $1",
      "insert into credit_ledger_entries (org_id, kind, delta_micros, balance_after_micros, reserved_after_micros) values ($1, 'credits_granted', 1, 1, 0)",
      "update payments set status = 'paid' where org_id = $1",
      "update billing_settings set monthly_budget_micros = 1 where org_id = $1",
    ]) {
      await expect(withUser(owner.id, (db) => db.query(sql, [org.id]))).rejects.toThrow(/permission denied|row-level security/);
    }
  });

  it("only a super admin can set the exchange rate, adjust credits, or confirm the live review", async () => {
    await expect(setExchangeRate({ id: owner.id, platformRole: "agency_staff" }, { usdPhpRate: 55, source: "x rate source" })).rejects.toThrow(/super admin/);
    await expect(adjustOrgCredits({ id: owner.id, platformRole: "agency_staff" }, { orgId: org.id, deltaUsd: 5, reason: "goodwill credit" })).rejects.toThrow(/super admin/);
    await expect(setExchangeRate({ id: admin.id, platformRole: "agency_super_admin" }, { usdPhpRate: -1, source: "x rate source" })).rejects.toThrow(/realistic/);
    const balance = await adjustOrgCredits({ id: admin.id, platformRole: "agency_super_admin" }, { orgId: other.id, deltaUsd: 5, reason: "goodwill credit for outage" });
    expect(balance.balanceMicros).toBeGreaterThanOrEqual(usdToMicros(5));
  });

  it("keeps revenue, payment fees, the operating reserve and gross markup as separate lines", async () => {
    const orgA = await createOrg({ name: "Report Co" });
    const { impl } = mockFetch("cs_report_1");
    const { createPaymentCheckout: create } = await import("@/server/billing/payments");
    const out = await create({ orgId: orgA.id, kind: "setup_fee", usdMicros: usdToMicros(1499), description: "Setup", requestedBy: admin.id }, { fetch: impl });
    await deliver(paidEvent({ eventId: evt(), checkoutId: "cs_report_1", reference: out.referenceNumber, amount: usdToChargeMinor(usdToMicros(1499), 58) }));
    await withSystem((db) => adjustCredits(db, { orgId: orgA.id, deltaMicros: usdToMicros(50), reason: "seed credit for test", userId: admin.id }));
    await withSystem((db) => chargeUsage(db, { orgId: orgA.id, usage: { provider: "llm", unitType: "ai_tokens_in", quantity: 10, wholesaleMicros: usdToMicros(10), providerReference: "report-1" } }));
    const o = await getAgencyBillingOverview({ id: admin.id, platformRole: "agency_super_admin" });
    expect(o.totals.setupPaidCount).toBeGreaterThanOrEqual(1);
    expect(o.totals.recommendedOperatingReserveMicros).toBe(o.totals.setupPaidCount * usdToMicros(200));
    expect(o.totals.grossMarkupContributionMicros).toBe(o.totals.meteredClientChargedMicros - o.totals.meteredWholesaleMicros);
    expect(o.totals.knownPaymentFeesMinorPhp).toBeGreaterThanOrEqual(250);
    const client = o.clients.find((c) => c.orgId === orgA.id)!;
    expect(client).toMatchObject({ monthWholesaleMicros: usdToMicros(10), monthChargedMicros: usdToMicros(13), monthContributionMicros: usdToMicros(3) });
    // Staff only see clients they are assigned to.
    const staff = await createUser({ platformRole: "agency_staff" });
    const scoped = await getAgencyBillingOverview({ id: staff.id, platformRole: "agency_staff" });
    expect(scoped.clients).toEqual([]);
    await expect(getAgencyBillingOverview({ id: owner.id, platformRole: "none" })).rejects.toThrow(/Agency access/);
  });

  it("discloses provider fees separately and bills them only after the owner approves", async () => {
    await addProviderFee({ id: admin.id, platformRole: "agency_super_admin" }, { orgId: org.id, provider: "ghl", kind: "number_rental", description: "SMS number rental", amountUsd: 2, recurrence: "monthly" });
    const { rows } = await withSystem((db) => db.query<{ id: string; status: string }>("select id, status from provider_fees where org_id = $1", [org.id]));
    expect(rows[0].status).toBe("disclosed");
    const { approveProviderFee } = await import("@/server/billing/service");
    await expect(approveProviderFee(ctxFor(manager, org, "admin"), rows[0].id)).rejects.toThrow(/business owner/);
    await approveProviderFee(ctxFor(owner, org, "owner"), rows[0].id);
    const after = await withSystem((db) => db.query<{ status: string }>("select status from provider_fees where id = $1", [rows[0].id]));
    expect(after.rows[0].status).toBe("approved");
    // Provider fees carry no markup and never create metered usage lines.
    const usage = await withSystem((db) => db.query("select 1 from metered_usage_events where org_id = $1 and unit_type = 'other'", [org.id]));
    expect(usage.rows).toHaveLength(0);
  });
});
