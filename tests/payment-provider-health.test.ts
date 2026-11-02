// Payment provider readiness, on embedded Postgres with the providers replaced by stand-ins: nothing here reaches PayMongo or PayPal. What is proved: the six readiness states, in
// order; that the one answer the Billing screen, the Purchase intents switch and the buyer's checkout all read cannot disagree; that "Check connection" claims only what a real
// answer showed (and reports a refusal, an outage or an unreadable answer as exactly that); that a check stops counting when the configuration changes; that the switch can never
// say "on" over a checkout nobody can use; that nothing a provider needs is ever handed to a browser; and that no workspace appears before a verified payment.
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { checkPaymentProvider, getPaymentHealth } from "@/server/billing/provider-health";
import { configFingerprint, recordCheck } from "@/server/billing/provider-checks";
import { providerReadiness } from "@/server/purchase-intents/availability";
import { createPurchaseIntent, getCheckoutSwitch, getPublicPurchase, setPurchaseCheckoutEnabled, startPurchase } from "@/server/purchase-intents/service";
import { startPurchaseCheckout } from "@/server/purchase-intents/checkout";
import { setAdapterForTests } from "@/server/customer-payments/providers";
import { createPaypalProvider } from "@/server/customer-payments/providers/paypal";
import { deriveReadiness, isPublicHttpsUrl, READINESS_LABEL } from "@/lib/payment-providers/readiness";
import { agencyUser } from "./support/fixtures";
import { agencyOrgId, rows, staffPerson } from "./support/staff-messages";

const SITE = "https://www.iacquire.online";
const NAMES = ["PAYMONGO_SECRET_KEY", "PAYMONGO_WEBHOOK_SECRET", "PAYMONGO_PAYMENT_METHODS", "PAYMONGO_API_BASE", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "PAYPAL_ENVIRONMENT", "PAYPAL_API_BASE", "APP_URL"] as const;
const SAVED: Record<string, string | undefined> = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
const setEnv = (over: Partial<Record<(typeof NAMES)[number], string | undefined>>) => {
  for (const n of NAMES) delete process.env[n];
  process.env.APP_URL = SITE;
  for (const [n, v] of Object.entries(over)) if (v !== undefined) process.env[n] = v;
  resetEnvCache();
};
const setBilling = (o: { enabled?: boolean; rate?: number | null; reviewed?: boolean } = {}) =>
  withSystem((db) => db.query(
    "update agency_billing_settings set purchase_checkout_enabled = $1, usd_php_rate = $2, fx_source = 'test fixture', fx_updated_at = now(), live_payments_review_at = case when $3 then now() else null end",
    [o.enabled ?? false, o.rate === undefined ? 58 : o.rate, o.reviewed ?? false],
  ));
const uniq = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const paymongo = (live = false, id = uniq()) => ({ PAYMONGO_SECRET_KEY: `sk_${live ? "live" : "test"}_${id}key123`, PAYMONGO_WEBHOOK_SECRET: `whsk_${id}webhook`, PAYMONGO_PAYMENT_METHODS: "card,gcash" });
const paypal = (live = false, id = uniq()) => ({ PAYPAL_CLIENT_ID: `client-${id}`, PAYPAL_CLIENT_SECRET: `secret-${id}-abc`, PAYPAL_WEBHOOK_ID: `WH-${id}`, PAYPAL_ENVIRONMENT: live ? "live" : "sandbox" });

const checkNow = (provider: "paymongo" | "paypal", live: boolean, outcome: Parameters<typeof recordCheck>[1]["outcome"] = "verified") =>
  withSystem((db) => recordCheck(db, { provider, livemode: live, outcome, facts: {}, checkedBy: null, at: new Date() }));
const healthOf = async (provider: "paymongo" | "paypal") => (await withSystem((db) => getPaymentHealth(db))).providers.find((p) => p.provider === provider)!;

async function world() {
  const agencyId = await agencyOrgId();
  const superAdmin = await staffPerson("agency_super_admin");
  const manager = await staffPerson("agency_manager");
  const staff = await staffPerson("agency_staff");
  return { agencyId, superAdmin, superSession: agencyUser(superAdmin, "agency_super_admin"), managerSession: agencyUser(manager, "agency_manager"), staffSession: agencyUser(staff, "agency_staff") };
}

beforeEach(async () => {
  setEnv({});
  await setBilling();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setAdapterForTests("paypal", null);
  for (const n of NAMES) {
    if (SAVED[n] === undefined) delete process.env[n];
    else process.env[n] = SAVED[n];
  }
  resetEnvCache();
});

describe("the readiness ladder", () => {
  const base = { anySet: true, missing: [] as string[], mode: "test" as const, verifiedForCurrentConfig: false, liveReviewed: false };
  it("names the six states in the order the steps happen", () => {
    expect(deriveReadiness({ ...base, anySet: false }).label).toBe("Not connected");
    expect(deriveReadiness({ ...base, missing: ["PAYMONGO_WEBHOOK_SECRET"] }).label).toBe("Configuration incomplete");
    expect(deriveReadiness(base).label).toBe("Ready for testing");
    expect(deriveReadiness({ ...base, verifiedForCurrentConfig: true }).label).toBe("Test verified");
    expect(deriveReadiness({ ...base, mode: "live", verifiedForCurrentConfig: true }).label).toBe("Live approval required");
    expect(deriveReadiness({ ...base, mode: "live", verifiedForCurrentConfig: true, liveReviewed: true }).label).toBe("Ready for live payments");
    expect(Object.values(READINESS_LABEL)).toHaveLength(6);
  });

  it("never lets a live review stand in for a connection check, nor a check stand in for the review", () => {
    expect(deriveReadiness({ ...base, mode: "live", liveReviewed: true }).state).toBe("ready_for_testing");
    expect(deriveReadiness({ ...base, mode: "live", verifiedForCurrentConfig: true }).state).toBe("live_approval_required");
    expect(deriveReadiness({ ...base, mode: "test", liveReviewed: true }).state).toBe("ready_for_testing");
  });

  it("says a provider cannot reach this site unless its address is https on a real domain", () => {
    expect(isPublicHttpsUrl("https://www.iacquire.online/api/webhooks/paymongo")).toBe(true);
    for (const bad of ["http://www.iacquire.online/x", "https://localhost:3000/x", "https://127.0.0.1/x", "https://app.local/x", "https://[::1]/x", "not a url"]) expect(isPublicHttpsUrl(bad)).toBe(false);
  });
});

describe("what the server reports for each provider", () => {
  it("is Not connected with nothing set, and the buyer is offered nothing", async () => {
    const h = await withSystem((db) => getPaymentHealth(db));
    expect(h.providers.map((p) => p.readiness.state)).toEqual(["not_connected", "not_connected"]);
    expect(h.providers.every((p) => !p.available && p.blockedReason)).toBe(true);
    expect(h.checkout).toMatchObject({ switchOn: false, state: "off", anyProviderAvailable: false });
  });

  it("walks PayMongo from incomplete to ready for testing to test verified, and back when the configuration changes", async () => {
    const id = uniq();
    await setBilling({ rate: null });
    setEnv({ PAYMONGO_SECRET_KEY: `sk_test_${id}key123` });
    let h = await healthOf("paymongo");
    expect(h.readiness).toMatchObject({ state: "incomplete", label: "Configuration incomplete" });
    expect(h.missing).toEqual(expect.arrayContaining(["PAYMONGO_WEBHOOK_SECRET", expect.stringMatching(/exchange rate/)]));
    expect(h.available).toBe(false);
    expect(h.envVars.find((v) => v.name === "PAYMONGO_SECRET_KEY")).toMatchObject({ set: true, secret: true, shown: null });
    expect(h.envVars.find((v) => v.name === "PAYMONGO_WEBHOOK_SECRET")).toMatchObject({ set: false, required: true });

    await setBilling({ rate: 58 });
    setEnv({ ...paymongo(false, id), PAYMONGO_SECRET_KEY: `sk_test_${id}key123` });
    h = await healthOf("paymongo");
    expect(h.readiness.state).toBe("ready_for_testing");
    expect(h.mode).toBe("test");
    expect(h.available).toBe(true);

    await checkNow("paymongo", false);
    h = await healthOf("paymongo");
    expect(h.readiness.state).toBe("test_verified");
    expect(h.check).toMatchObject({ ok: true, stale: false, mode: "test" });

    // A new webhook secret is a new configuration: the old check no longer counts and says so.
    setEnv({ ...paymongo(false, id), PAYMONGO_SECRET_KEY: `sk_test_${id}key123`, PAYMONGO_WEBHOOK_SECRET: `whsk_${uniq()}rotated` });
    h = await healthOf("paymongo");
    expect(h.readiness.state).toBe("ready_for_testing");
    expect(h.check).toMatchObject({ ok: true, stale: true });
  });

  it("needs the exchange rate for PayMongo but not for PayPal", async () => {
    await setBilling({ rate: null });
    setEnv({ ...paymongo(), ...paypal() });
    expect((await healthOf("paymongo")).readiness.state).toBe("incomplete");
    expect((await healthOf("paypal")).readiness.state).toBe("ready_for_testing");
    expect((await healthOf("paypal")).exchangeRate).toBeNull();
    expect((await healthOf("paymongo")).exchangeRate).toMatchObject({ set: false });
  });

  it("walks PayPal from incomplete (naming each missing variable) to ready for testing", async () => {
    setEnv({ PAYPAL_CLIENT_ID: "client-only-12345" });
    const h = await healthOf("paypal");
    expect(h.readiness.state).toBe("incomplete");
    expect(h.missing).toEqual(["PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID"]);
    setEnv(paypal());
    expect((await healthOf("paypal")).readiness.state).toBe("ready_for_testing");
    expect((await healthOf("paypal")).envVars.find((v) => v.name === "PAYPAL_ENVIRONMENT")).toMatchObject({ set: true, shown: "sandbox" });
  });

  it("keeps real money behind BOTH the review and a check made with exactly these live credentials", async () => {
    const id = uniq();
    setEnv(paymongo(true, id));
    // live, nothing else: complete, but not verified and not reviewed
    let h = await healthOf("paymongo");
    expect(h).toMatchObject({ mode: "live", available: false, readiness: { state: "ready_for_testing" } });
    expect(h.readiness.next).toMatch(/LIVE credentials/);
    // a passing check without the review: Live approval required
    await checkNow("paymongo", true);
    h = await healthOf("paymongo");
    expect(h).toMatchObject({ available: false, readiness: { state: "live_approval_required", label: "Live approval required" } });
    expect(h.blockedReason).toMatch(/tax review/);
    // the review without a check for THESE credentials: still not open
    setEnv(paymongo(true, uniq()));
    await setBilling({ reviewed: true });
    h = await healthOf("paymongo");
    expect(h).toMatchObject({ available: false, readiness: { state: "ready_for_testing" } });
    expect(h.blockedReason).toMatch(/connection check/);
    // both: ready for live payments, and the checkout's own gate agrees
    await checkNow("paymongo", true);
    h = await healthOf("paymongo");
    expect(h).toMatchObject({ available: true, readiness: { state: "ready_for_live", label: "Ready for live payments" } });
    expect((await withSystem((db) => providerReadiness(db, "paymongo"))).available).toBe(true);
  });

  it("agrees with the buyer's checkout gate for every configuration (state and availability never disagree)", async () => {
    const cases: Array<{ name: string; env: Parameters<typeof setEnv>[0]; reviewed: boolean; check: "none" | "ok" | "stale"; provider: "paymongo" | "paypal" }> = [
      { name: "test, complete, unchecked", env: paymongo(), reviewed: false, check: "none", provider: "paymongo" },
      { name: "test, verified", env: paymongo(), reviewed: false, check: "ok", provider: "paymongo" },
      { name: "live, verified, unreviewed", env: paymongo(true), reviewed: false, check: "ok", provider: "paymongo" },
      { name: "live, reviewed, unchecked", env: paymongo(true), reviewed: true, check: "none", provider: "paymongo" },
      { name: "live, reviewed, checked", env: paymongo(true), reviewed: true, check: "ok", provider: "paymongo" },
      { name: "live, reviewed, stale check", env: paymongo(true), reviewed: true, check: "stale", provider: "paymongo" },
      { name: "paypal sandbox, complete", env: paypal(), reviewed: false, check: "ok", provider: "paypal" },
      { name: "paypal live, reviewed, unchecked", env: paypal(true), reviewed: true, check: "none", provider: "paypal" },
      { name: "paypal live, reviewed, checked", env: paypal(true), reviewed: true, check: "ok", provider: "paypal" },
    ];
    for (const c of cases) {
      setEnv(c.env);
      await setBilling({ reviewed: c.reviewed });
      if (c.check === "ok") await checkNow(c.provider, c.provider === "paymongo" ? Boolean(c.env.PAYMONGO_SECRET_KEY?.startsWith("sk_live_")) : c.env.PAYPAL_ENVIRONMENT === "live");
      if (c.check === "stale") {
        await checkNow(c.provider, true);
        setEnv({ ...c.env, PAYMONGO_WEBHOOK_SECRET: `whsk_${uniq()}changed` });
      }
      const h = await healthOf(c.provider);
      const gate = await withSystem((db) => providerReadiness(db, c.provider));
      expect(h.available, `${c.name}: availability`).toBe(gate.available);
      const open = new Set(["ready_for_live"]);
      if (h.mode === "test") ["ready_for_testing", "test_verified"].forEach((s) => open.add(s));
      expect(open.has(h.readiness.state), `${c.name}: state ${h.readiness.state} vs available ${h.available}`).toBe(h.available);
    }
  });

  it("hands a browser no key, secret, token or webhook id: a setting is set or missing, never its value", async () => {
    setEnv({ PAYMONGO_SECRET_KEY: "sk_test_LEAKCANARY99", PAYMONGO_WEBHOOK_SECRET: "whsk_LEAKCANARYhook99", PAYPAL_CLIENT_ID: "client-LEAKCANARYid999", PAYPAL_CLIENT_SECRET: "secret-LEAKCANARYpaypal999", PAYPAL_WEBHOOK_ID: "WH-LEAKCANARYhook999" });
    const text = JSON.stringify(await withSystem((db) => getPaymentHealth(db)));
    expect(text).not.toMatch(/LEAKCANARY/);
    expect(text).toContain("PAYMONGO_WEBHOOK_SECRET");
    // The fingerprint that ties a check to a configuration is a hash, and is not stored anywhere readable as a key.
    expect(configFingerprint("paymongo")).toMatch(/^[0-9a-f]{16}$/);
    const stored = await rows<{ t: string }>("select to_jsonb(c)::text as t from payment_provider_checks c");
    expect(stored.some((r) => r.t.includes("LEAKCANARY"))).toBe(false);
  });
});

describe("Check connection", () => {
  const OURS = `${SITE}/api/webhooks/paymongo`;
  const hook = (over: Record<string, unknown> = {}) => ({ id: "hook_1", type: "webhook", attributes: { url: OURS, status: "enabled", livemode: false, events: ["checkout_session.payment.paid", "payment.failed"], ...over } });
  /** PayMongo's API as a stand-in: answers each path as told, and records every request. */
  function stub(answers: { payments?: number | "down"; webhooks?: number | "down"; hooks?: unknown[]; paymentsBody?: unknown }) {
    const calls: Array<{ method: string; url: string; auth: string | null }> = [];
    const impl = async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname + new URL(url).search;
      calls.push({ method: init?.method ?? "GET", url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null });
      const which = path.startsWith("/v1/payments") ? answers.payments ?? 200 : answers.webhooks ?? 200;
      if (which === "down") throw new Error("connect ECONNREFUSED");
      const body = path.startsWith("/v1/payments") ? answers.paymentsBody ?? { data: [] } : { data: answers.hooks ?? [hook()] };
      return new Response(JSON.stringify(which >= 200 && which < 300 ? body : { errors: [{ detail: "x" }] }), { status: which });
    };
    return { impl: impl as never, calls };
  }
  const configure = () => setEnv(paymongo(false, "chk1"));

  it("verifies PayMongo with two read-only questions, records the result with this configuration and moves the state to Test verified", async () => {
    configure();
    const w = await world();
    const s = stub({});
    const result = await checkPaymentProvider(w.superSession, "paymongo", { fetch: s.impl });
    expect(result.outcome).toBe("verified");
    expect(result.health.readiness.state).toBe("test_verified");
    expect(result.health.check).toMatchObject({ ok: true, stale: false, webhook: "registered", eventsMissing: [] });
    expect(s.calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`)).toEqual(["GET /v1/payments?limit=1", "GET /v1/webhooks"]);
    // The key travels in a header, never in an address, and nothing is created.
    expect(s.calls.every((c) => c.auth?.startsWith("Basic ") && !c.url.includes("sk_test"))).toBe(true);
    const [stored] = await rows<{ ok: boolean; outcome: string; fingerprint: string; checked_by: string; facts: Record<string, unknown> }>("select ok, outcome, fingerprint, checked_by, facts from payment_provider_checks where provider = 'paymongo' order by id desc limit 1");
    expect(stored).toMatchObject({ ok: true, outcome: "verified", fingerprint: configFingerprint("paymongo"), checked_by: w.superAdmin.id });
    expect(JSON.stringify(stored)).not.toContain("sk_test");
    const audit = await rows<{ action: string; result: string; metadata: Record<string, unknown> }>("select action, result, metadata from audit_logs where action = 'payment_provider.checked' order by id desc limit 1");
    expect(audit[0]).toMatchObject({ result: "success", metadata: { provider: "paymongo", mode: "test", outcome: "verified" } });
  });

  it("reports credentials the provider refuses, an outage and an answer it cannot read as exactly that, never as a success", async () => {
    configure();
    const w = await world();
    expect((await checkPaymentProvider(w.superSession, "paymongo", { fetch: stub({ payments: 401, webhooks: 401 }).impl })).outcome).toBe("credentials_rejected");
    expect((await checkPaymentProvider(w.superSession, "paymongo", { fetch: stub({ payments: "down", webhooks: "down" }).impl })).outcome).toBe("unreachable");
    expect((await checkPaymentProvider(w.superSession, "paymongo", { fetch: stub({ payments: 503 }).impl })).outcome).toBe("unreachable");
    expect((await checkPaymentProvider(w.superSession, "paymongo", { fetch: stub({ payments: 200, paymentsBody: { oops: true }, webhooks: 500 }).impl })).outcome).toBe("unexpected_response");
    const h = await healthOf("paymongo");
    expect(h.readiness.state).toBe("ready_for_testing");
    expect(h.check).toMatchObject({ ok: false, outcome: "unexpected_response" });
  });

  it("does not call a connection verified when no enabled webhook for this site's address exists, or it lacks the event that confirms a payment", async () => {
    configure();
    const w = await world();
    const none = await checkPaymentProvider(w.superSession, "paymongo", { fetch: stub({ hooks: [] }).impl });
    expect(none).toMatchObject({ outcome: "webhook_not_registered" });
    expect(none.health.check).toMatchObject({ ok: false, webhook: "not_registered" });
    expect(none.health.readiness.state).toBe("ready_for_testing");
    const off = await checkPaymentProvider(w.superSession, "paymongo", { fetch: stub({ hooks: [hook({ status: "disabled" })] }).impl });
    expect(off.outcome).toBe("webhook_not_registered");
    const partial = await checkPaymentProvider(w.superSession, "paymongo", { fetch: stub({ hooks: [hook({ events: ["payment.failed"] })] }).impl });
    expect(partial.outcome).toBe("webhook_not_registered");
    expect(partial.health.check?.eventsMissing).toEqual(["checkout_session.payment.paid"]);
    // A webhook listed with a trailing slash still counts as ours.
    const slash = await checkPaymentProvider(w.superSession, "paymongo", { fetch: stub({ hooks: [hook({ url: `${OURS}/` })] }).impl });
    expect(slash.outcome).toBe("verified");
    // The key is proven by the webhook list when the payments list is not offered, and the answer is said to be unknown when the list cannot be read.
    expect((await checkPaymentProvider(w.superSession, "paymongo", { fetch: stub({ payments: 404 }).impl })).outcome).toBe("verified");
    const unknown = await checkPaymentProvider(w.superSession, "paymongo", { fetch: stub({ webhooks: 404 }).impl });
    expect(unknown).toMatchObject({ outcome: "verified" });
    expect(unknown.health.check?.webhook).toBe("unknown");
  });

  it("calls nothing when the provider is not configured, and only a Super Admin may run a check", async () => {
    const w = await world();
    const s = stub({});
    expect((await checkPaymentProvider(w.superSession, "paymongo", { fetch: s.impl })).outcome).toBe("not_configured");
    expect(s.calls).toHaveLength(0);
    configure();
    await expect(checkPaymentProvider(w.managerSession, "paymongo", { fetch: s.impl })).rejects.toMatchObject({ code: "forbidden" });
    await expect(checkPaymentProvider(w.staffSession, "paymongo", { fetch: s.impl })).rejects.toMatchObject({ code: "forbidden" });
    expect(s.calls).toHaveLength(0);
  });

  it("limits how often a connection can be checked", async () => {
    configure();
    const w = await world();
    const s = stub({});
    for (let n = 0; n < 12; n++) await checkPaymentProvider(w.superSession, "paymongo", { fetch: s.impl });
    await expect(checkPaymentProvider(w.superSession, "paymongo", { fetch: s.impl })).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("verifies PayPal through the existing adapter (token, then the webhook list) and reports a refusal as such", async () => {
    setEnv(paypal(false, "pp1pp1pp1pp1"));
    const w = await world();
    const hooks = [{ id: "WH-1", url: `${SITE}/api/webhooks/paypal` }];
    const http = (token: number, list: unknown[]) => vi.fn(async (req: { path: string }) => {
      if (req.path === "/v1/oauth2/token") return token === 200 ? { status: 200, json: { access_token: "A21AA-test-token" } } : { status: token, json: { error: "invalid_client" } };
      if (req.path === "/v1/notifications/webhooks") return { status: 200, json: { webhooks: list } };
      return { status: 404, json: null };
    });
    const ok = http(200, hooks);
    setAdapterForTests("paypal", createPaypalProvider({ http: ok as never }));
    const verified = await checkPaymentProvider(w.superSession, "paypal");
    expect(verified).toMatchObject({ outcome: "verified" });
    expect(verified.health.readiness.state).toBe("test_verified");
    expect(JSON.stringify(verified)).not.toContain("A21AA-test-token");
    setAdapterForTests("paypal", createPaypalProvider({ http: http(200, []) as never }));
    expect((await checkPaymentProvider(w.superSession, "paypal")).outcome).toBe("webhook_not_registered");
    setAdapterForTests("paypal", createPaypalProvider({ http: http(401, []) as never }));
    const refused = await checkPaymentProvider(w.superSession, "paypal");
    expect(refused.outcome).toBe("credentials_rejected");
    expect(refused.health.check?.message).toMatch(/did not accept/);
  });
});

describe("the switch and the buyer's checkout", () => {
  it("refuses to switch online checkout on while no provider is ready, and always lets it be switched off", async () => {
    const w = await world();
    await expect(setPurchaseCheckoutEnabled(w.superSession, true)).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/no payment provider is ready/) });
    expect((await getCheckoutSwitch(w.superSession)).enabled).toBe(false);
    setEnv(paymongo());
    const on = await setPurchaseCheckoutEnabled(w.superSession, true);
    expect(on).toMatchObject({ enabled: true, available: true, state: "open_test" });
    expect((await setPurchaseCheckoutEnabled(w.superSession, false)).state).toBe("off");
  });

  it("says On, but blocked, when the switch is on over no ready provider (the state the screenshot showed), and offers the buyer nothing", async () => {
    const w = await world();
    await setBilling({ enabled: true });
    const view = await getCheckoutSwitch(w.superSession);
    expect(view).toMatchObject({ enabled: true, available: false, state: "blocked" });
    expect(view.headline).toMatch(/NOT offered online payment/);
    expect(view.providers.map((p) => p.readiness.state)).toEqual(["not_connected", "not_connected"]);
    // The buyer: confirmed, but no Pay button and no way to open a checkout.
    const created = await createPurchaseIntent(w.superSession, { buyerName: "Bailey Buyer", buyerEmail: `b-${uniq()}@example.test`, company: `Buyer ${uniq()}`, timezone: "America/Chicago" });
    await startPurchase(created.token);
    expect((await getPublicPurchase(created.token))?.checkout).toMatchObject({ offered: false, providers: [] });
    await expect(startPurchaseCheckout(created.token, { ip: "203.0.113.50" })).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(await rows("select 1 from purchase_intent_checkouts where intent_id = $1", [created.id])).toHaveLength(0);
    // Nothing was paid, so no workspace exists.
    expect(await rows("select 1 from organizations where created_by = $1 and kind = 'client'", [w.superAdmin.id])).toEqual([]);
  });

  it("shows the same provider state on the switch as on the Billing screen", async () => {
    const w = await world();
    setEnv({ ...paymongo(), PAYPAL_CLIENT_ID: "client-only-12345" });
    await checkNow("paymongo", false);
    const view = await getCheckoutSwitch(w.superSession);
    const health = await withSystem((db) => getPaymentHealth(db));
    expect(view.providers.map((p) => [p.id, p.readiness.state])).toEqual(health.providers.map((p) => [p.provider, p.readiness.state]));
    expect(view.providers.map((p) => p.readiness.state)).toEqual(["test_verified", "incomplete"]);
  });
});
