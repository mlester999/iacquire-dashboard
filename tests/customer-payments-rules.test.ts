import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_TEXTS, CURRENT_AUTHORIZATION_VERSION, PROVIDER_CURRENCIES, PROVIDER_STATE, PUBLIC_KEY_RE, REFERENCE_RE, checkoutBlock, liveConfirmBlock, paymongoKeyProblem, paymongoModeOf, webhookSecretProblem,
  type ConnectionFacts, type Switches,
} from "@/lib/invoices/connection-rules";
import { connectSchema } from "@/lib/invoices/connection-schemas";
import {
  decideAfterPayment, decideNotSucceeded, decideSucceeded, emptyEvent, looksLikeOurReference, readFacts, storableFacts, type AttemptFacts, type Canonical, type NormalizedEvent,
} from "@/lib/invoices/payment-events";
import { CURRENCY_CODES } from "@/lib/money";
import { newPublicKey, newReference } from "@/server/customer-payments/ids";

// A small deterministic generator so the property checks are repeatable.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const REF = "CP-0123456789abcdef0123456789abcdef";
const ON: Switches = { writesEnabled: true, liveEnabled: true, simulatedAllowed: true };
const conn = (over: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
  provider: "paymongo", mode: "test", status: "connected", supportedCurrencies: ["PHP"], authorizedAt: new Date(), liveConfirmedAt: null, ...over,
});

describe("keys and the owner's authorization", () => {
  it("reads the mode from the key, and says what is wrong with one that is not a secret key", () => {
    expect(paymongoModeOf("sk_test_abcdefgh12345678")).toBe("test");
    expect(paymongoModeOf("sk_live_abcdefgh12345678")).toBe("live");
    expect(paymongoModeOf("pk_test_abcdefgh12345678")).toBeNull();
    expect(paymongoModeOf("sk_test_short")).toBeNull();
    expect(paymongoKeyProblem("pk_live_abcdefgh12345678")).toMatch(/public key/);
    expect(paymongoKeyProblem("hello")).toMatch(/sk_test_ \(test mode\) or sk_live_/);
    expect(paymongoKeyProblem("")).toMatch(/Paste/);
    expect(paymongoKeyProblem("sk_live_abcdefgh12345678")).toBeNull();
    expect(webhookSecretProblem("whsk_abcdefgh1234")).toBeNull();
    expect(webhookSecretProblem("short")).not.toBeNull();
    expect(webhookSecretProblem("has spaces in it ok")).not.toBeNull();
  });

  it("keeps the wording that was accepted readable by its version, and calls it a proposal until counsel approves it", () => {
    expect(AUTHORIZATION_TEXTS[CURRENT_AUTHORIZATION_VERSION]).toMatch(/does not hold or move my money/);
    expect(CURRENT_AUTHORIZATION_VERSION).toMatch(/^draft-/);
    expect(connectSchema.safeParse({ provider: "paymongo", apiKey: "sk_test_abcdefgh12345678", authorization: { accepted: true, version: CURRENT_AUTHORIZATION_VERSION } }).success).toBe(true);
    // Not ticked, or the wording has moved on since it was shown: not accepted.
    expect(connectSchema.safeParse({ provider: "paymongo", apiKey: "sk_test_abcdefgh12345678", authorization: { accepted: false, version: CURRENT_AUTHORIZATION_VERSION } }).success).toBe(false);
    expect(connectSchema.safeParse({ provider: "paymongo", apiKey: "sk_test_abcdefgh12345678", authorization: { accepted: true, version: "draft-1999" } }).success).toBe(false);
    expect(connectSchema.safeParse({ provider: "stripe", authorization: { accepted: true, version: CURRENT_AUTHORIZATION_VERSION } }).success).toBe(false);
  });

  it("is honest about what exists: PayMongo and PayPal built and never run against their providers, the simulated one for testing only", () => {
    expect(PROVIDER_STATE.paymongo.state).toBe("built_unverified");
    expect(PROVIDER_STATE.paypal.state).toBe("built_unverified");
    expect(PROVIDER_STATE.paypal.note).toMatch(/has not run against a PayPal app yet/);
    expect(PROVIDER_STATE.simulated.state).toBe("testing_only");
    expect(PROVIDER_CURRENCIES.paymongo).toEqual(["PHP"]);
    // PayPal is offered every currency we invoice in; whether a given PayPal account can take each one is unverified.
    expect([...PROVIDER_CURRENCIES.paypal].sort()).toEqual([...CURRENCY_CODES].sort());
    expect([...PROVIDER_CURRENCIES.simulated].sort()).toEqual([...CURRENCY_CODES].sort());
  });

  it("makes identifiers in the shape the database accepts, from a secure source, never the same twice", () => {
    const keys = new Set(Array.from({ length: 200 }, newPublicKey));
    const refs = new Set(Array.from({ length: 200 }, newReference));
    expect(keys.size).toBe(200);
    expect(refs.size).toBe(200);
    for (const k of keys) expect(k).toMatch(PUBLIC_KEY_RE);
    for (const r of refs) expect(r).toMatch(REFERENCE_RE);
  });
});

describe("when a checkout may be started", () => {
  it("is refused for an account that is not connected, paused, half set up, in trouble, unauthorized or in another currency, each with its own reason", () => {
    expect(checkoutBlock(null, "PHP", ON, "member")?.code).toBe("not_connected");
    expect(checkoutBlock(conn({ status: "revoked" }), "PHP", ON, "member")?.code).toBe("not_connected");
    expect(checkoutBlock(conn({ status: "disabled" }), "PHP", ON, "member")?.code).toBe("paused");
    expect(checkoutBlock(conn({ status: "pending_verification" }), "PHP", ON, "member")?.code).toBe("not_ready");
    expect(checkoutBlock(conn({ status: "needs_attention" }), "PHP", ON, "member")?.code).toBe("needs_attention");
    expect(checkoutBlock(conn({ authorizedAt: null }), "PHP", ON, "member")?.code).toBe("not_authorized");
    expect(checkoutBlock(conn(), "USD", ON, "member")?.code).toBe("currency");
    expect(checkoutBlock(conn(), "PHP", ON, "member")).toBeNull();
  });

  it("never sends a customer to a real provider's test mode, and sends nobody to a real provider while the calls switch is off", () => {
    expect(checkoutBlock(conn({ mode: "test" }), "PHP", ON, "public")?.code).toBe("test_mode_public");
    expect(checkoutBlock(conn({ mode: "test" }), "PHP", { ...ON, writesEnabled: false }, "member")?.code).toBe("provider_calls_off");
    // The simulated provider is open to both so the whole path can be clicked through, but only outside production.
    expect(checkoutBlock(conn({ provider: "simulated", supportedCurrencies: ["PHP"] }), "PHP", { ...ON, writesEnabled: false }, "public")).toBeNull();
    expect(checkoutBlock(conn({ provider: "simulated", supportedCurrencies: ["PHP"] }), "PHP", { ...ON, simulatedAllowed: false }, "member")?.code).toBe("simulated_unavailable");
  });

  it("opens real money only when the service-wide switch is on AND the owner confirmed going live", () => {
    const live = conn({ mode: "live", liveConfirmedAt: new Date() });
    expect(checkoutBlock(live, "PHP", ON, "public")).toBeNull();
    expect(checkoutBlock(live, "PHP", { ...ON, liveEnabled: false }, "public")?.code).toBe("live_off");
    expect(checkoutBlock(conn({ mode: "live", liveConfirmedAt: null }), "PHP", ON, "public")?.code).toBe("live_not_confirmed");
    expect(checkoutBlock(live, "PHP", { ...ON, liveEnabled: false }, "member")?.code).toBe("live_off");
  });

  it("lets the owner confirm going live only after a provider-confirmed test payment, with live keys, an authorized connected account and both switches on", () => {
    const ok = { connection: conn({ mode: "live" }), hasConfirmedTestPayment: true };
    expect(liveConfirmBlock(ok, ON)).toBeNull();
    expect(liveConfirmBlock({ ...ok, hasConfirmedTestPayment: false }, ON)).toMatch(/test payment/);
    expect(liveConfirmBlock({ ...ok, connection: conn({ mode: "test" }) }, ON)).toMatch(/live keys/);
    expect(liveConfirmBlock({ ...ok, connection: conn({ mode: "live", status: "pending_verification" }) }, ON)).toMatch(/webhook signing secret/);
    expect(liveConfirmBlock({ ...ok, connection: conn({ mode: "live", status: "needs_attention" }) }, ON)).toMatch(/connected/);
    expect(liveConfirmBlock({ ...ok, connection: conn({ mode: "live", authorizedAt: null }) }, ON)).toMatch(/authorization/);
    expect(liveConfirmBlock(ok, { ...ON, writesEnabled: false })).toMatch(/switched off/);
    expect(liveConfirmBlock(ok, { ...ON, liveEnabled: false })).toMatch(/whole service/);
    expect(liveConfirmBlock({ ...ok, connection: conn({ provider: "simulated" }) }, ON)).toMatch(/no live mode/);
  });
});

describe("reading and storing the facts of an event", () => {
  const full: NormalizedEvent = {
    ...emptyEvent("payment.succeeded", { eventId: "evt_1", type: "checkout_session.payment.paid", livemode: true }),
    checkoutId: "cs_1", reference: REF, paymentId: "pay_1", amountMinor: 150000, currency: "PHP", feeMinor: 250, method: "card", reason: null, occurredAt: "2026-10-23T12:00:00.000Z",
  };

  it("round-trips through the stored form, and trims what is too long", () => {
    expect(readFacts(JSON.parse(JSON.stringify(storableFacts(full))))).toEqual(full);
    const long = storableFacts({ ...full, reason: "x".repeat(500), method: "y".repeat(100), eventId: "e".repeat(400), type: "t".repeat(400) });
    expect(long.reason).toHaveLength(200);
    expect(long.method).toHaveLength(40);
    expect(long.eventId).toHaveLength(200);
    expect(long.type).toHaveLength(120);
  });

  it("refuses anything that is not exactly the shape this code writes", () => {
    for (const bad of [null, "x", [], 5, {}, { ...full, kind: "payment.paid" }, { ...full, livemode: "yes" }, { ...full, eventId: "" }, { ...full, type: null }]) expect(readFacts(bad), JSON.stringify(bad)).toBeNull();
    // A currency this product does not know, a negative or fractional amount are dropped to null rather than trusted.
    expect(readFacts({ ...full, currency: "XXX" })?.currency).toBeNull();
    expect(readFacts({ ...full, amountMinor: -5 })?.amountMinor).toBeNull();
    expect(readFacts({ ...full, amountMinor: 10.5 })?.amountMinor).toBeNull();
  });

  it("knows a reference of its own by its shape alone", () => {
    expect(looksLikeOurReference(REF)).toBe(true);
    expect(looksLikeOurReference("CP-short")).toBe(false);
    expect(looksLikeOurReference("IAQ-0123456789ABCDEF0123")).toBe(false);
    expect(looksLikeOurReference(null)).toBe(false);
  });
});

describe("what a verified 'payment succeeded' event may do", () => {
  const attempt: AttemptFacts = { reference: REF, checkoutId: "cs_1", settingUp: false, amountMinor: 150000, currency: "PHP" };
  const event: NormalizedEvent = { ...emptyEvent("payment.succeeded", { eventId: "evt_1", type: "t", livemode: false }), checkoutId: "cs_1", reference: REF, paymentId: "pay_1", amountMinor: 150000, currency: "PHP" };
  const input = (e: Partial<NormalizedEvent> = {}, a: AttemptFacts | null = attempt, canonical: Canonical | "missing" | null = null, live = false) => ({ event: { ...event, ...e }, connectionLive: live, attempt: a, canonical });
  const paid: Canonical = { status: "paid", amountMinor: 150000, currency: "PHP", reference: REF, checkoutId: "cs_1" };

  it("applies when every fact agrees, with or without the provider's own read-back", () => {
    expect(decideSucceeded(input()).action).toBe("apply");
    expect(decideSucceeded(input({}, attempt, paid)).action).toBe("apply");
    expect(decideSucceeded(input({}, attempt, { ...paid, reference: null, checkoutId: null })).action).toBe("apply");
    expect(decideSucceeded(input({ livemode: true }, attempt, null, true)).action).toBe("apply");
  });

  it("says why each disagreement is not applied", () => {
    expect(decideSucceeded(input({ livemode: true }))).toMatchObject({ action: "reject", reason: expect.stringMatching(/other mode/) });
    expect(decideSucceeded(input({ reference: null }))).toMatchObject({ action: "ignore" });
    expect(decideSucceeded(input({ reference: "IAQ-0123456789ABCDEF0123" }))).toMatchObject({ action: "ignore" });
    expect(decideSucceeded(input({}, null))).toMatchObject({ action: "reject", reason: expect.stringMatching(/No checkout/) });
    expect(decideSucceeded(input({ paymentId: null }))).toMatchObject({ action: "reject" });
    expect(decideSucceeded(input({}, { ...attempt, checkoutId: null, settingUp: true }))).toMatchObject({ action: "defer" });
    // An old attempt that never learned its checkout id has nothing to compare: the money is kept for a person.
    expect(decideSucceeded(input({}, { ...attempt, checkoutId: null, settingUp: false }))).toMatchObject({ action: "review", reason: "checkout_mismatch" });
    expect(decideSucceeded(input({ checkoutId: "cs_other" }))).toMatchObject({ action: "review", reason: "checkout_mismatch", record: true });
    expect(decideSucceeded(input({ checkoutId: null }))).toMatchObject({ action: "review", reason: "checkout_mismatch" });
    expect(decideSucceeded(input({ amountMinor: 149999 }))).toMatchObject({ action: "review", reason: "amount_mismatch", record: true });
    expect(decideSucceeded(input({ amountMinor: 150001 }))).toMatchObject({ action: "review", reason: "amount_mismatch" });
    expect(decideSucceeded(input({ amountMinor: 0 }))).toMatchObject({ action: "review", record: false });
    // Another currency cannot be held in a payment row of this invoice at all.
    expect(decideSucceeded(input({ currency: "USD" }))).toMatchObject({ action: "review", reason: "currency_mismatch", record: false });
    expect(decideSucceeded(input({}, attempt, "missing"))).toMatchObject({ action: "review", reason: "provider_missing_payment" });
    for (const disagree of [{ status: "pending" as const }, { status: "failed" as const }, { amountMinor: 1 }, { currency: "USD" }, { reference: "CP-aaaaaaaaaaaaaaaaaaaaaaaa" }, { checkoutId: "cs_x" }]) {
      expect(decideSucceeded(input({}, attempt, { ...paid, ...disagree })), JSON.stringify(disagree)).toMatchObject({ action: "review", reason: "provider_disagrees" });
    }
  });

  it("applies money ONLY when every fact agrees, over thousands of combinations", () => {
    const r = rng(20261023);
    const pick = <T,>(...v: T[]) => v[Math.floor(r() * v.length)];
    let applied = 0;
    for (let i = 0; i < 4000; i += 1) {
      const live = r() < 0.5;
      const modeOk = r() < 0.85;
      const refKind = pick("ours", "ours", "ours", "foreign", "none");
      const attemptKind = pick("found", "found", "found", "missing");
      const checkoutKind = pick("match", "match", "match", "other", "none");
      const stored = pick<string | null>("cs_1", "cs_1", null);
      const amountKind = pick("match", "match", "match", "less", "more");
      const currencyOk = r() < 0.85;
      const hasPayment = r() < 0.95;
      const canon = pick<Canonical | "missing" | null>(null, null, paid, { ...paid, status: "pending" }, { ...paid, amountMinor: 5 }, "missing");
      const settingUp = r() < 0.3;
      const e: Partial<NormalizedEvent> = {
        livemode: modeOk ? live : !live, reference: refKind === "ours" ? REF : refKind === "foreign" ? "IAQ-0123456789ABCDEF0123" : null,
        checkoutId: checkoutKind === "match" ? "cs_1" : checkoutKind === "other" ? "cs_2" : null, amountMinor: amountKind === "match" ? 150000 : amountKind === "less" ? 149999 : 150001,
        currency: currencyOk ? "PHP" : "USD", paymentId: hasPayment ? "pay_1" : null,
      };
      const a: AttemptFacts | null = attemptKind === "found" ? { ...attempt, checkoutId: stored, settingUp: stored === null && settingUp } : null;
      const d = decideSucceeded(input(e, a, canon, live));
      const canonOk = canon === null || (canon !== "missing" && canon.status === "paid" && canon.amountMinor === 150000 && canon.currency === "PHP");
      const allAgree = modeOk && refKind === "ours" && attemptKind === "found" && hasPayment && stored === "cs_1" && checkoutKind === "match" && amountKind === "match" && currencyOk && canonOk;
      expect(d.action === "apply", JSON.stringify({ e, a, canon })).toBe(allAgree);
      if (d.action === "apply") applied += 1;
    }
    expect(applied).toBeGreaterThan(100);
  });

  it("answers failed and pending payments quietly when they are not ours, and records them when they are", () => {
    const failed: NormalizedEvent = { ...emptyEvent("payment.failed", { eventId: "evt_f", type: "payment.failed", livemode: false }), reference: REF, paymentId: "pay_f" };
    expect(decideNotSucceeded({ event: failed, connectionLive: false, attempt })).toEqual({ action: "apply" });
    expect(decideNotSucceeded({ event: { ...failed, reference: null }, connectionLive: false, attempt })).toMatchObject({ action: "ignore" });
    expect(decideNotSucceeded({ event: failed, connectionLive: false, attempt: null })).toMatchObject({ action: "ignore" });
    expect(decideNotSucceeded({ event: { ...failed, checkoutId: "cs_x" }, connectionLive: false, attempt })).toMatchObject({ action: "ignore" });
    expect(decideNotSucceeded({ event: failed, connectionLive: true, attempt })).toMatchObject({ action: "reject" });
  });

  it("applies a refund or a dispute only to a payment that was received, waits for one that is not here yet, and refuses another currency", () => {
    const refund: NormalizedEvent = { ...emptyEvent("refund.succeeded", { eventId: "evt_r", type: "r", livemode: false }), paymentId: "pay_1", refundId: "ref_1", amountMinor: 1000, currency: "PHP" };
    const pay = (status: "succeeded" | "pending" | "failed" | "needs_review" | "partially_refunded" | "refunded" | "disputed") => ({ status, currency: "PHP", amountMinor: 150000 });
    const decide = (event: NormalizedEvent, payment: ReturnType<typeof pay> | null, live = false) => decideAfterPayment({ event, connectionLive: live, payment });
    for (const s of ["succeeded", "partially_refunded", "refunded", "disputed"] as const) expect(decide(refund, pay(s)).action, s).toBe("apply");
    expect(decide(refund, null)).toMatchObject({ action: "defer" });
    expect(decide(refund, pay("pending"))).toMatchObject({ action: "defer" });
    expect(decide(refund, pay("needs_review"))).toMatchObject({ action: "defer" });
    expect(decide(refund, pay("failed"))).toMatchObject({ action: "reject" });
    expect(decide({ ...refund, currency: "USD" }, pay("succeeded"))).toMatchObject({ action: "reject", reason: expect.stringMatching(/currency/) });
    expect(decide({ ...refund, paymentId: null }, pay("succeeded"))).toMatchObject({ action: "ignore" });
    expect(decide(refund, pay("succeeded"), true)).toMatchObject({ action: "reject" });
    expect(decide({ ...refund, kind: "dispute.opened", currency: null }, pay("succeeded")).action).toBe("apply");
  });
});
