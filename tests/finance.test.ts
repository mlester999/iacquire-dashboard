import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { adjustCredits, chargeUsage } from "@/server/billing/ledger";
import { addFinanceEntry, getFinancialReport, saveFinanceSettings, voidFinanceEntry } from "@/server/billing/finance";
import { resolvePeriod, signedUsd } from "@/lib/finance";
import { addMember, agencyUser, createOrg, createUser } from "./support/fixtures";

const usd = (n: number) => Math.round(n * 1_000_000);
const NOW = new Date("2026-10-20T12:00:00Z");
const period = resolvePeriod("this_month", NOW);

let a: Awaited<ReturnType<typeof createOrg>>;
let b: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let superAdmin: ReturnType<typeof agencyUser>;
let staff: ReturnType<typeof agencyUser>;
let unassigned: ReturnType<typeof agencyUser>;

const pay = (orgId: string, kind: string, amountUsd: number, over: { status?: string; paidAt?: string; feeMinor?: number | null; fx?: number | null; refundedUsd?: number } = {}) =>
  withSystem((db) =>
    db.query(
      `insert into payments (org_id, kind, status, description, usd_amount_micros, charged_currency, charged_amount_minor, fx_rate, fee_minor, livemode, reference_number, paid_at, refunded_micros, credits_micros)
       values ($1, $2, $3, 'test payment', $4, 'PHP', $5, $6, $7, false, $8, $9, $10, $11)`,
      [orgId, kind, over.status ?? "paid", usd(amountUsd), Math.round(amountUsd * 56 * 100), over.fx === undefined ? 56 : over.fx, over.feeMinor === undefined ? null : over.feeMinor,
        `IAQ-${crypto.randomBytes(5).toString("hex")}`, (over.status ?? "paid") === "pending" ? null : (over.paidAt ?? "2026-10-05T10:00:00Z"), usd(over.refundedUsd ?? 0), kind === "credit_topup" ? usd(amountUsd) : null],
    ),
  );

beforeAll(async () => {
  a = await createOrg({ name: "Finance A" });
  b = await createOrg({ name: "Finance B" });
  owner = await createUser();
  await addMember(a.id, owner.id, "owner");
  superAdmin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
  const s = await createUser({ platformRole: "agency_staff" });
  staff = agencyUser(s, "agency_staff");
  unassigned = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
  await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [a.id, s.id]));

  await pay(a.id, "setup_fee", 1499, { feeMinor: 5000 });
  await pay(b.id, "setup_fee", 1499); // no processing fee recorded yet
  await pay(a.id, "credit_topup", 100);
  await pay(a.id, "maintenance", 299, { status: "partially_refunded", refundedUsd: 100 });
  await pay(b.id, "setup_fee", 1499, { status: "pending" }); // never paid: not income
  await pay(b.id, "custom_project", 500, { paidAt: "2026-08-01T10:00:00Z" }); // a different month
  await withSystem(async (db) => {
    await adjustCredits(db, { orgId: a.id, deltaMicros: usd(200), reason: "seed credit", userId: owner.id });
    await chargeUsage(db, { orgId: a.id, usage: { provider: "ghl", unitType: "sms_segment", quantity: 100, wholesaleMicros: usd(10), providerReference: "fin-a-1" } });
    await chargeUsage(db, { orgId: b.id, usage: { provider: "ghl", unitType: "sms_segment", quantity: 100, wholesaleMicros: usd(10), providerReference: "fin-b-1" } }); // no credits: uncollected
    await db.query("update metered_usage_events set occurred_at = '2026-10-10T10:00:00Z'");
  });
});

describe("reporting periods", () => {
  it("resolves calendar windows in UTC", () => {
    expect(resolvePeriod("this_month", NOW)).toMatchObject({ from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" });
    expect(resolvePeriod("last_month", NOW)).toMatchObject({ from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });
    expect(resolvePeriod("year_to_date", NOW)).toMatchObject({ from: "2026-01-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" });
    expect(new Date(resolvePeriod("last_90_days", NOW).to).getTime() - new Date(resolvePeriod("last_90_days", NOW).from).getTime()).toBe(90 * 86_400_000);
    expect(signedUsd(-1_500_000)).toBe("−$1.50");
    expect(signedUsd(usd(1234.5))).toBe("$1,234.50");
  });
});

describe("the financial report", () => {
  it("keeps cash received, refunds, prepaid credit and usage on separate lines and counts only paid payments in the period", async () => {
    const r = await getFinancialReport(superAdmin, period);
    expect(r.scope).toBe("agency");
    expect(r.received).toMatchObject({ setupMicros: usd(1499 * 2), maintenanceMicros: usd(299), projectsMicros: 0, refundedMicros: usd(100), grossMicros: usd(1499 * 2 + 299), netMicros: usd(1499 * 2 + 299 - 100) });
    // The pending setup payment and last quarter's project payment are not this month's money.
    expect(r.prepaid.topUpsMicros).toBe(usd(100)); // prepaid credit is held apart from income
    expect(r.prepaid.heldForClientsMicros).toBeGreaterThan(0);
  });

  it("separates usage charged from provider cost and shows the markup as a contribution, not a profit", async () => {
    const r = await getFinancialReport(superAdmin, period);
    expect(r.usage.providerCostMicros).toBe(usd(20));
    expect(r.usage.chargedMicros).toBe(usd(13)); // only client A had credits; client B's 13 is uncollected
    expect(r.usage.uncollectedMicros).toBe(usd(13));
    expect(r.usage.grossMarkupContributionMicros).toBe(usd(13) - usd(20)); // B's cost was absorbed, so the contribution this month is negative
    expect(r.caveats.some((c) => /could not be collected/.test(c))).toBe(true);
  });

  it("counts processing fees only where the provider reported one, and says how many are missing", async () => {
    const r = await getFinancialReport(superAdmin, period);
    expect(r.fees.knownMicros).toBe(Math.round((5000 / 100 / 56) * 1_000_000));
    expect(r.fees.paymentsCounted).toBe(1);
    expect(r.fees.paymentsWithoutFee).toBeGreaterThanOrEqual(3);
    expect(r.caveats.some((c) => /no processing fee recorded/.test(c))).toBe(true);
  });

  it("recommends the $200 operating reserve for each paid setup, as a planning figure and not a charge", async () => {
    const r = await getFinancialReport(superAdmin, period);
    expect(r.reserve).toMatchObject({ setupPayments: 2, perSetupUsd: 200, recommendedMicros: usd(400), setAsideMicros: 0 });
    await saveFinanceSettings(superAdmin, { setupReserveUsd: 150 });
    expect((await getFinancialReport(superAdmin, period)).reserve).toMatchObject({ perSetupUsd: 150, recommendedMicros: usd(300) });
    await saveFinanceSettings(superAdmin, { setupReserveUsd: 200 });
    await expect(saveFinanceSettings(staff, { setupReserveUsd: 50 })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("entries and the estimate available to distribute", () => {
  let overhead: string;
  it("takes entries from super admins only, with a category that fits the kind", async () => {
    await expect(addFinanceEntry(staff, { kind: "overhead", category: "Hosting", description: "Servers", amountUsd: 10, periodOn: "2026-10-03" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(addFinanceEntry(superAdmin, { kind: "overhead", category: "Made up", description: "x", amountUsd: 10, periodOn: "2026-10-03" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(addFinanceEntry(superAdmin, { kind: "overhead", category: "Hosting", description: "x", amountUsd: 10, periodOn: "2026-10-03", orgId: a.id })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(addFinanceEntry(superAdmin, { kind: "overhead", category: "Hosting", description: "x", amountUsd: 0, periodOn: "2026-10-03" })).rejects.toBeTruthy();
    await expect(addFinanceEntry(superAdmin, { kind: "overhead", category: "Hosting", description: "x", amountUsd: 10, periodOn: "last tuesday" })).rejects.toBeTruthy();
    await expect(addFinanceEntry(superAdmin, { kind: "direct_cost", category: "Domain", description: "x", amountUsd: 10, periodOn: "2026-10-03", orgId: crypto.randomUUID() })).rejects.toMatchObject({ code: "not_found" });
    overhead = (await addFinanceEntry(superAdmin, { kind: "overhead", category: "Hosting", description: "Servers and databases", amountUsd: 150, periodOn: "2026-10-03" })).id;
    await addFinanceEntry(superAdmin, { kind: "direct_cost", category: "Domain", description: "brightside.example registered for the client", amountUsd: 20, periodOn: "2026-10-04", orgId: a.id });
  });

  it("builds the estimate from cash, usage, fees and costs, and says what it leaves out", async () => {
    const r = await getFinancialReport(superAdmin, period);
    expect(r.costs).toMatchObject({ directMicros: usd(20), overheadMicros: usd(150) });
    const expected = r.received.netMicros + r.usage.chargedMicros - r.usage.providerCostMicros - r.fees.knownMicros - usd(20) - usd(150);
    expect(r.distributable).toMatchObject({ resultBeforeSetAsidesMicros: expected, unfundedReserveMicros: usd(400) });
    expect(r.distributable!.estimateMicros).toBe(expected - usd(400)); // the recommended reserve is not yet set aside, so it is not distributable
    expect(r.caveats.some((c) => /No tax set-aside rate/.test(c))).toBe(true);
    expect(r.tax).toMatchObject({ configuredBps: null, suggestedMicros: null });
  });

  it("uses a tax rate only once the agency enters one, and counts set-asides as set aside", async () => {
    await saveFinanceSettings(superAdmin, { taxSetAsideBps: 2000 });
    let r = await getFinancialReport(superAdmin, period);
    const before = r.distributable!.resultBeforeSetAsidesMicros;
    expect(r.tax.suggestedMicros).toBe(Math.round(before * 0.2));
    expect(r.distributable!.unfundedTaxMicros).toBe(r.tax.suggestedMicros);
    await addFinanceEntry(superAdmin, { kind: "tax_set_aside", category: "Income tax", description: "Moved to the tax account", amountUsd: 300, periodOn: "2026-10-12" });
    await addFinanceEntry(superAdmin, { kind: "reserve_set_aside", category: "Operating reserve", description: "Reserve for two setups", amountUsd: 400, periodOn: "2026-10-12" });
    r = await getFinancialReport(superAdmin, period);
    expect(r.distributable).toMatchObject({ unfundedReserveMicros: 0 });
    expect(r.distributable!.unfundedTaxMicros).toBe(Math.max(0, r.tax.suggestedMicros! - usd(300)));
    expect(r.distributable!.estimateMicros).toBe(before - usd(300) - usd(400) - r.distributable!.unfundedTaxMicros);
    expect(r.reserve).toMatchObject({ setAsideMicros: usd(400), usedMicros: 0, balanceMicros: usd(400) });
    await addFinanceEntry(superAdmin, { kind: "reserve_used", category: "Operating expense", description: "Covered a provider invoice", amountUsd: 120, periodOn: "2026-10-14" });
    expect((await getFinancialReport(superAdmin, period)).reserve.balanceMicros).toBe(usd(280));
    await saveFinanceSettings(superAdmin, { taxSetAsideBps: null }); // back to "not provided for"
    expect((await getFinancialReport(superAdmin, period)).tax.configuredBps).toBeNull();
  });

  it("never edits or deletes an entry: a mistake is voided with a reason and drops out of the totals", async () => {
    await expect(voidFinanceEntry(superAdmin, overhead, "")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(voidFinanceEntry(staff, overhead, "wrong amount")).rejects.toMatchObject({ code: "forbidden" });
    await voidFinanceEntry(superAdmin, overhead, "Entered twice by mistake");
    await expect(voidFinanceEntry(superAdmin, overhead, "again")).rejects.toMatchObject({ code: "not_found" });
    const r = await getFinancialReport(superAdmin, period);
    expect(r.costs.overheadMicros).toBe(0);
    expect(r.entries.find((e) => e.id === overhead)).toMatchObject({ voided: true, voidReason: "Entered twice by mistake" });
    await expect(withSystem((db) => db.query("delete from agency_finance_entries where id = $1", [overhead]))).rejects.toBeTruthy();
    expect(r.caveats.some((c) => /No overhead has been entered/.test(c))).toBe(true);
  });
});

describe("per client and per viewer", () => {
  it("shows each client's contribution without sharing overhead out, and costs that belong to one client only to them", async () => {
    const r = await getFinancialReport(superAdmin, period);
    const ca = r.clients.find((c) => c.orgId === a.id)!;
    const cb = r.clients.find((c) => c.orgId === b.id)!;
    expect(ca).toMatchObject({ receivedMicros: usd(1499 + 299), refundedMicros: usd(100), usageChargedMicros: usd(13), providerCostMicros: usd(10), directCostsMicros: usd(20) });
    expect(ca.contributionMicros).toBe(usd(1499 + 299 - 100 + 13 - 10 - 20) - ca.paymentFeesMicros);
    expect(cb).toMatchObject({ receivedMicros: usd(1499), usageChargedMicros: 0, providerCostMicros: usd(10), directCostsMicros: 0 });
    expect(cb.contributionMicros).toBe(usd(1499 - 10)); // B's uncollected usage cost is a real cost to the agency
  });

  it("limits assigned staff to their own clients and hides the agency-wide figures from them", async () => {
    const r = await getFinancialReport(staff, period);
    expect(r.scope).toBe("client_scope");
    expect(r.clients.map((c) => c.orgId)).toEqual([a.id]);
    expect(r.distributable).toBeNull();
    expect(r.received.setupMicros).toBe(usd(1499)); // only client A's setup
    expect(r.entries.every((e) => e.orgId === a.id && e.kind === "direct_cost")).toBe(true); // no overhead, reserve or tax
    expect(r.costs.overheadMicros).toBe(0);
    expect(r.reserve.setAsideMicros).toBe(0);
    expect(r.caveats.some((c) => /clients in your current access scope/.test(c))).toBe(true);
    const manager = agencyUser(await createUser({ platformRole: "agency_manager" }), "agency_manager");
    const managerReport = await getFinancialReport(manager, period);
    expect(managerReport.scope).toBe("client_scope");
    expect(managerReport.clients.map((c) => c.orgId)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(managerReport.distributable).toBeNull(); // all client access does not expose agency overhead or distribution figures
    const none = await getFinancialReport(unassigned, period);
    expect(none.clients).toEqual([]);
    expect(none.received.grossMicros).toBe(0);
    const clientUser = agencyUser(await createUser(), "agency_staff");
    await expect(getFinancialReport(clientUser, period)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("is invisible to clients and respects staff assignment at the database level", async () => {
    expect((await withUser(owner.id, (db) => db.query("select 1 from agency_finance_entries"))).rows).toHaveLength(0);
    const seen = async (id: string) => (await withUser(id, (db) => db.query<{ kind: string; org_id: string | null }>("select kind, org_id from agency_finance_entries"))).rows;
    expect((await seen(superAdmin.id)).length).toBeGreaterThan(3);
    expect((await seen(staff.id)).every((r) => r.kind === "direct_cost" && r.org_id === a.id)).toBe(true);
    expect(await seen(unassigned.id)).toEqual([]);
    await expect(withUser(superAdmin.id, (db) => db.query("update agency_finance_entries set amount_micros = 1"))).rejects.toBeTruthy(); // not even a super admin edits directly
  });
});
