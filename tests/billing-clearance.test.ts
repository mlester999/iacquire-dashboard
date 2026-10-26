import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTIVATED_BEFORE_GATE_REASON,
  MANUAL_PAYMENT_KINDS,
  MANUAL_PAYMENT_METHODS,
  MAX_MANUAL_PAYMENT_CENTS,
  PAYMENT_REQUIRED_SENTENCE,
  checkManualPayment,
  checkRefundFields,
  centsToDollarText,
  checkWaiverReason,
  isSetupCleared,
  normalizeExternalReference,
  setupStatusCopy,
  type ManualPaymentFields,
} from "@/lib/billing-clearance";
import { evaluateReadiness, type RuleTask } from "@/lib/setup";
import { deriveEmployeeReadiness, type EmployeeReadinessInput } from "@/lib/workforce-readiness";

const NOW = new Date("2026-10-24T08:00:00Z");
const ctx = { today: "2026-10-24", now: NOW, agreedSetupFeeCents: 149900 };
const valid: ManualPaymentFields = { kind: "setup_fee", amount: "1499.00", method: "bank_transfer", externalReference: "BDO-2026-10-24-0042", paidOn: "2026-10-23", note: "Seen on the October statement, line 14" };
const check = (over: Partial<ManualPaymentFields>, c: Parameters<typeof checkManualPayment>[1] = ctx) => checkManualPayment({ ...valid, ...over }, c);
const failure = (r: ReturnType<typeof checkManualPayment>) => (r.ok ? null : { field: r.field, error: r.error });

describe("when the setup fee counts as confirmed", () => {
  it("only a verified payment or a recorded waiver clears it", () => {
    expect(isSetupCleared("paid")).toBe(true);
    expect(isSetupCleared("waived")).toBe(true);
    for (const s of ["not_invoiced", "invoiced", "refunded", "", null, undefined, "PAID", "paid "]) expect(isSetupCleared(s as string)).toBe(false);
  });

  it("says one honest thing per status and never claims a payment was detected", () => {
    const all = ["not_invoiced", "invoiced", "paid", "waived", "refunded", "anything else"].map((s) => setupStatusCopy(s));
    for (const c of all) expect(`${c.label} ${c.detail}`).not.toMatch(/detected|automatic|received automatically/i);
    expect(setupStatusCopy("paid")).toMatchObject({ cleared: true, tone: "success" });
    expect(setupStatusCopy("waived")).toMatchObject({ cleared: true });
    expect(setupStatusCopy("refunded")).toMatchObject({ cleared: false, tone: "danger" });
    // A refund stops new provisioning but never pauses what is running, and the screen says so.
    expect(setupStatusCopy("refunded").detail).toMatch(/not paused/);
    expect(setupStatusCopy("not_invoiced").cleared).toBe(false);
    expect(setupStatusCopy(undefined).cleared).toBe(false);
  });

  it("the data step of migration 0099 uses the recorded reason the code names", () => {
    const sql = readFileSync("supabase/migrations/0099_payment_controls.sql", "utf8");
    expect(sql).toContain(`waiver_reason = '${ACTIVATED_BEFORE_GATE_REASON}'`);
    expect(readFileSync("supabase/rollbacks/0099_payment_controls.down.sql", "utf8")).toContain(`'${ACTIVATED_BEFORE_GATE_REASON}'`);
  });
});

describe("recording a payment received outside a provider", () => {
  it("accepts a complete record and returns exact cents, never a float", () => {
    const r = check({});
    expect(r).toMatchObject({ ok: true, value: { kind: "setup_fee", amountCents: 149900, method: "bank_transfer", externalReference: "BDO-2026-10-24-0042", paidOn: "2026-10-23", paidThroughOn: null } });
    expect(check({ amount: "1,499.00" })).toMatchObject({ ok: true, value: { amountCents: 149900 } });
    expect(check({ kind: "domain", amount: "0.10" })).toMatchObject({ ok: true, value: { amountCents: 10 } });
    // 0.1 + 0.2 style sums are exact because nothing is a float.
    expect(check({ kind: "other", amount: "19.99" })).toMatchObject({ ok: true, value: { amountCents: 1999 } });
  });

  it("refuses every missing or malformed field with a message that names it", () => {
    expect(failure(check({ kind: "credit_topup" }))).toMatchObject({ field: "kind" });
    expect(failure(check({ kind: "" }))).toMatchObject({ field: "kind" });
    for (const amount of ["", "0", "0.00", "-5", "12.345", "1e3", "1.499,00", "NaN", "$1499", "1499 USD", " ", "1,49,900"]) expect(failure(check({ kind: "other", amount })), amount).toMatchObject({ field: "amount" });
    expect(failure(check({ kind: "other", amount: String(MAX_MANUAL_PAYMENT_CENTS / 100 + 1) }))).toMatchObject({ field: "amount", error: expect.stringMatching(/typo/) });
    expect(check({ kind: "other", amount: String(MAX_MANUAL_PAYMENT_CENTS / 100) }).ok).toBe(true);
    expect(failure(check({ method: "bitcoin" }))).toMatchObject({ field: "method" });
    for (const m of MANUAL_PAYMENT_METHODS) expect(check({ method: m }).ok, m).toBe(true);
    for (const reference of ["", "ab", "<script>", "ref;drop", "ref\nline", "x".repeat(121), "é".repeat(5)]) expect(failure(check({ externalReference: reference })), reference).toMatchObject({ field: "externalReference" });
    expect(failure(check({ paidOn: "yesterday" }))).toMatchObject({ field: "paidOn" });
    expect(failure(check({ paidOn: "2026-02-30" }))).toMatchObject({ field: "paidOn" });
    expect(failure(check({ paidOn: "2026-13-01" }))).toMatchObject({ field: "paidOn" });
    expect(failure(check({ note: "ok" }))).toMatchObject({ field: "note" });
    expect(failure(check({ note: "x".repeat(501) }))).toMatchObject({ field: "note" });
  });

  it("dates a payment in the workspace's day: a day ahead is allowed, further ahead or two years back is a typo", () => {
    expect(check({ paidOn: "2026-10-25" }).ok).toBe(true);
    expect(failure(check({ paidOn: "2026-10-26" }))).toMatchObject({ field: "paidOn", error: expect.stringMatching(/future/) });
    expect(check({ paidOn: "2024-10-25" }).ok).toBe(true);
    expect(failure(check({ paidOn: "2024-10-23" }))).toMatchObject({ field: "paidOn", error: expect.stringMatching(/two years/) });
    // "today" is the caller's local date, not the UTC date of the clock: a person in Manila at 02:00 on the 25th has already moved on.
    expect(check({ paidOn: "2026-10-26" }, { ...ctx, today: "2026-10-25" }).ok).toBe(true);
  });

  it("a setup fee must equal the agreed fee; any other arrangement is a waiver with a reason", () => {
    expect(failure(check({ amount: "1000.00" }))).toMatchObject({ field: "amount", error: expect.stringMatching(/waive the setup fee/) });
    expect(failure(check({ amount: "1499.01" }))).toMatchObject({ field: "amount" });
    expect(check({ amount: "1000.00" }, { ...ctx, agreedSetupFeeCents: 100000 }).ok).toBe(true);
    // The rule is for the setup fee only.
    expect(check({ kind: "domain", amount: "12.00" }).ok).toBe(true);
  });

  it("a maintenance payment names the period it covers, and the period cannot be over or years away", () => {
    expect(failure(check({ kind: "maintenance", amount: "299.00" }))).toMatchObject({ field: "paidThroughOn" });
    expect(failure(check({ kind: "maintenance", amount: "299.00", paidThroughOn: "2026-01-01" }))).toMatchObject({ field: "paidThroughOn", error: expect.stringMatching(/already ended/) });
    expect(failure(check({ kind: "maintenance", amount: "299.00", paidThroughOn: "2029-01-01" }))).toMatchObject({ field: "paidThroughOn", error: expect.stringMatching(/year ahead/) });
    expect(check({ kind: "maintenance", amount: "299.00", paidThroughOn: "2026-11-23" })).toMatchObject({ ok: true, value: { paidThroughOn: "2026-11-23" } });
    // Other kinds ignore a stray period.
    expect(check({ kind: "other", amount: "5.00", paidThroughOn: "2020-01-01" })).toMatchObject({ ok: true, value: { paidThroughOn: null } });
  });

  it("writes cents back as the text a person types, with integers only", () => {
    expect(centsToDollarText(149900)).toBe("1499.00");
    expect(centsToDollarText(5)).toBe("0.05");
    expect(centsToDollarText(0)).toBe("0.00");
    expect(centsToDollarText(10_000_000)).toBe("100000.00");
    expect(centsToDollarText(Number.MAX_SAFE_INTEGER - 1)).toMatch(/^\d+\.\d{2}$/);
    // What the form offers is what the check accepts, for every amount.
    for (const cents of [1, 99, 100, 101, 12345, 149900, 10_000_000]) expect(check({ kind: "other", amount: centsToDollarText(cents) })).toMatchObject({ ok: true, value: { amountCents: cents } });
  });

  it("collapses a reference's spaces, keeps its case for display, and rejects stray characters in one pass", () => {
    expect(normalizeExternalReference("  BDO   2026 / 0042  ")).toBe("BDO 2026 / 0042");
    expect(normalizeExternalReference("ABC-123_x.y#z:+/1")).toBe("ABC-123_x.y#z:+/1");
    expect(normalizeExternalReference("ab")).toBeNull();
    expect(normalizeExternalReference("   ")).toBeNull();
    expect(MANUAL_PAYMENT_KINDS).not.toContain("credit_topup");
  });

  it("stays linear on 20,000 characters in every free-text field", () => {
    const long = "a ".repeat(10_000);
    const t = performance.now();
    expect(failure(check({ externalReference: long }))).toMatchObject({ field: "externalReference" });
    expect(failure(check({ note: long }))).toMatchObject({ field: "note" });
    expect(failure(check({ kind: "other", amount: "9".repeat(20_000) }))).toMatchObject({ field: "amount" });
    expect(checkWaiverReason(long).ok).toBe(false);
    expect(checkRefundFields({ amount: "5.00", reason: long }).ok).toBe(false);
    expect(normalizeExternalReference(" ".repeat(20_000))).toBeNull();
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe("waivers and refunds need a person's reason", () => {
  it("a waiver reason is required, collapsed, and bounded", () => {
    expect(checkWaiverReason("")).toMatchObject({ ok: false });
    expect(checkWaiverReason("short")).toMatchObject({ ok: false, error: expect.stringMatching(/at least 10/) });
    expect(checkWaiverReason("          ")).toMatchObject({ ok: false });
    expect(checkWaiverReason("Founding client\n\n  agreed   in writing")).toEqual({ ok: true, reason: "Founding client agreed in writing" });
    expect(checkWaiverReason("x".repeat(501))).toMatchObject({ ok: false });
  });

  it("a refund needs a positive exact amount and a reason", () => {
    expect(checkRefundFields({ amount: "100.00", reason: "Client cancelled before work began" })).toEqual({ ok: true, amountCents: 10000, reason: "Client cancelled before work began" });
    expect(checkRefundFields({ amount: "0", reason: "Client cancelled before work began" })).toMatchObject({ ok: false, field: "amount" });
    expect(checkRefundFields({ amount: "-1", reason: "Client cancelled before work began" })).toMatchObject({ ok: false, field: "amount" });
    expect(checkRefundFields({ amount: "1.001", reason: "Client cancelled before work began" })).toMatchObject({ ok: false, field: "amount" });
    expect(checkRefundFields({ amount: "10", reason: "no" })).toMatchObject({ ok: false, field: "reason" });
  });
});

describe("activation readiness with the setup payment", () => {
  const task = (over: Partial<RuleTask> = {}): RuleTask => ({ id: "t1", title: "Done", status: "completed", required: true, hidden: false, serviceExcluded: false, completionMode: "manual", checkKey: null, dependsOn: [], ...over });
  const base = { state: "ready_for_review" as const, tasks: [task()], checks: {} };

  it("an unconfirmed payment blocks activation, first, and never blocks marking the setup ready for review", () => {
    const unpaid = evaluateReadiness({ ...base, payment: { cleared: false } });
    expect(unpaid.canActivate).toBe(false);
    expect(unpaid.blockers[0]).toMatchObject({ code: "payment_unverified", message: expect.stringMatching(/Record the payment, or waive the setup fee/) });
    expect(unpaid.taskBlockers).toEqual([]);
    const inSetup = evaluateReadiness({ state: "in_setup", tasks: [task()], checks: {}, payment: { cleared: false } });
    expect(inSetup.canMarkReady).toBe(true);
    expect(inSetup.canActivate).toBe(false);
  });

  it("a confirmed payment, or a caller that did not ask, adds no blocker", () => {
    expect(evaluateReadiness({ ...base, payment: { cleared: true } })).toMatchObject({ canActivate: true, blockers: [] });
    expect(evaluateReadiness(base)).toMatchObject({ canActivate: true, blockers: [] });
  });

  it("keeps the other blockers when the payment is also missing", () => {
    const r = evaluateReadiness({ state: "ready_for_review", tasks: [task({ status: "pending" })], checks: {}, payment: { cleared: false } });
    expect(r.blockers.map((b) => b.code)).toEqual(["payment_unverified", "task_incomplete"]);
  });
});

describe("what an AI employee card says before the setup payment is confirmed", () => {
  const at = "2026-10-20T00:00:00.000Z";
  const unconfigured: EmployeeReadinessInput = { displayName: "Sales Assistant", enabled: true, status: "provisioning", configVersion: null, lastHealthCheckAt: null, lastHealthOk: null, inventoryDigest: null, evaluatedAt: at };
  const configured: EmployeeReadinessInput = { ...unconfigured, configVersion: 1 };

  it("stays at Setup required with the sentence, for an employee that is not yet working", () => {
    for (const input of [unconfigured, configured]) {
      const r = deriveEmployeeReadiness({ ...input, paymentCleared: false });
      expect(r).toMatchObject({ stage: "setup", label: "Setup required", chatAvailable: false, cta: "none" });
      expect(r.description).toBe(`${PAYMENT_REQUIRED_SENTENCE}.`);
    }
    expect(PAYMENT_REQUIRED_SENTENCE).toBe("Your AI team starts after your setup payment is confirmed");
  });

  it("changes nothing when the payment is confirmed or the caller did not ask", () => {
    for (const paymentCleared of [true, undefined]) {
      expect(deriveEmployeeReadiness({ ...configured, paymentCleared })).toEqual(deriveEmployeeReadiness(configured));
    }
    expect(deriveEmployeeReadiness({ ...configured, paymentCleared: true }).description).not.toContain("setup payment");
  });

  it("never pauses an employee that is already authorized: a refund stops new provisioning only", () => {
    const working: EmployeeReadinessInput = {
      ...configured, configVersion: 2, status: "online", lastHealthCheckAt: at, lastHealthOk: true, credentialCurrent: true,
      inventoryContract: "hermes.api_server.tool_catalog.v1", inventoryDigest: "a".repeat(64), inventoryVerifiedAt: at, inventoryExpiresAt: "2026-10-20T00:02:00.000Z", inventoryToolCount: 6,
    };
    const baseline = deriveEmployeeReadiness(working);
    expect(baseline.chatAvailable).toBe(true);
    const refunded = deriveEmployeeReadiness({ ...working, paymentCleared: false });
    expect(refunded.chatAvailable).toBe(true);
    expect(refunded.stage).toBe(baseline.stage);
  });

  it("a paused employee still reads as paused", () => {
    expect(deriveEmployeeReadiness({ ...configured, enabled: false, paymentCleared: false }).stage).toBe("disabled");
  });
});
