// The simulated PayPal (scripts/paypal-sim.mjs) exists so a browser run can take a purchase or a monthly agreement from the buyer's button to a confirmed notice with no real provider.
// It must be impossible to reach from anything that matters. This proves, without a network beyond this machine:
//   * the environment refuses it in production, for any address that is not this machine's, for the live environment and for a client id that is not the simulator's;
//   * the QA harness's own environment is blank unless the run asks for the simulator, and the isolation check refuses every other combination;
//   * a PayPal approval link on this machine is refused exactly as before, with or without the simulator: it hands out ordinary sandbox.paypal.com links and only the API calls move;
//   * the wire call goes to the simulator's address (over plain HTTP, on this machine) and never carries the secret anywhere else.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, resetEnvCache } from "@/server/env";
import { createPaypalProvider, paypalHttp, simulatedPaypalOrigin } from "@/server/customer-payments/providers/paypal";
import { openSubscription } from "@/server/billing/providers/paypal-subscriptions";
import { CRM_QA_ENV, SIM_PAYPAL, assertIsolated } from "../scripts/crm-qa-env.mjs";

const SAVED = { ...process.env };
const SIM = { PAYPAL_API_BASE: SIM_PAYPAL.base, PAYPAL_CLIENT_ID: SIM_PAYPAL.clientId, PAYPAL_CLIENT_SECRET: SIM_PAYPAL.clientSecret, PAYPAL_WEBHOOK_ID: SIM_PAYPAL.webhookId, PAYPAL_ENVIRONMENT: "sandbox" };

beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: "development", AUTH_PROVIDER: "local", DATABASE_DRIVER: "pglite", SECRET_STORE: "vault", APP_ENCRYPTION_KEY: "test-only-key-0123456789abcdef0123456789abcdef" });
  delete process.env.DATABASE_URL;
  for (const k of Object.keys(SIM)) delete process.env[k];
  delete process.env.PAYPAL_MAINTENANCE_PLAN_ID;
  resetEnvCache();
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  resetEnvCache();
});

describe("the environment", () => {
  it("accepts the simulator on this machine in development with its made-up credentials", () => {
    Object.assign(process.env, SIM);
    resetEnvCache();
    expect(env().PAYPAL_API_BASE).toBe(SIM_PAYPAL.base);
    expect(simulatedPaypalOrigin()).toBe("http://127.0.0.1:3282");
  });

  it("is refused in production, off this machine, in the live environment and with a client id that is not the simulator's", () => {
    Object.assign(process.env, SIM, { NODE_ENV: "production" });
    resetEnvCache();
    expect(() => env()).toThrow(/refused in production/);

    Object.assign(process.env, SIM, { NODE_ENV: "development", PAYPAL_API_BASE: "https://api-m.paypal.com" });
    resetEnvCache();
    expect(() => env()).toThrow(/may only name this machine/);

    Object.assign(process.env, SIM, { NODE_ENV: "development", PAYPAL_API_BASE: "http://192.168.1.20:3282" });
    resetEnvCache();
    expect(() => env()).toThrow(/may only name this machine/);

    Object.assign(process.env, SIM, { NODE_ENV: "development", PAYPAL_ENVIRONMENT: "live" });
    resetEnvCache();
    expect(() => env()).toThrow(/never used with the live environment/);

    Object.assign(process.env, SIM, { NODE_ENV: "development", PAYPAL_CLIENT_ID: "AbCdEf123456-real-looking-client-id" });
    resetEnvCache();
    expect(() => env()).toThrow(/only used with the simulator's made-up client id/);
  });

  it("is invisible when it is not configured: there is no simulator origin and every PayPal call goes to PayPal's own origin", () => {
    expect(simulatedPaypalOrigin()).toBeNull();
    Object.assign(process.env, SIM);
    resetEnvCache();
    expect(simulatedPaypalOrigin()).toBe("http://127.0.0.1:3282");
    for (const k of Object.keys(SIM)) delete process.env[k];
    resetEnvCache();
    expect(simulatedPaypalOrigin()).toBeNull();
  });
});

const isolated = (over: Record<string, string | undefined>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paypal-sim-guard-"));
  fs.writeFileSync(path.join(root, ".env"), "");
  return () => assertIsolated({ root, files: [".env"], env: { ...CRM_QA_ENV, ...over } });
};

describe("the QA harness", () => {
  it("has no PayPal in its environment unless the run asks for the simulator, and is isolated either way", () => {
    expect(CRM_QA_ENV.PAYPAL_API_BASE).toBe("");
    expect(CRM_QA_ENV.PAYPAL_CLIENT_ID).toBe("");
    expect(CRM_QA_ENV.PAYPAL_CLIENT_SECRET).toBe("");
    expect(CRM_QA_ENV.PAYPAL_WEBHOOK_ID).toBe("");
    expect(CRM_QA_ENV.PAYPAL_MAINTENANCE_PLAN_ID).toBe("");
    expect(CRM_QA_ENV.PAYPAL_ENVIRONMENT).toBe("sandbox");
    expect(isolated({})).not.toThrow();
    const sim = { PAYPAL_API_BASE: SIM_PAYPAL.base, PAYPAL_CLIENT_ID: SIM_PAYPAL.clientId, PAYPAL_CLIENT_SECRET: SIM_PAYPAL.clientSecret, PAYPAL_WEBHOOK_ID: SIM_PAYPAL.webhookId, PAYPAL_MAINTENANCE_PLAN_ID: SIM_PAYPAL.planId };
    expect(isolated(sim)).not.toThrow();
  });

  it("refuses a real app, another address, the live environment, or credentials without the address", () => {
    const sim = { PAYPAL_API_BASE: SIM_PAYPAL.base, PAYPAL_CLIENT_ID: SIM_PAYPAL.clientId, PAYPAL_CLIENT_SECRET: SIM_PAYPAL.clientSecret, PAYPAL_WEBHOOK_ID: SIM_PAYPAL.webhookId, PAYPAL_MAINTENANCE_PLAN_ID: SIM_PAYPAL.planId };
    for (const bad of [
      { ...sim, PAYPAL_CLIENT_ID: "AbCdEf123456-real-looking-client-id" },
      { ...sim, PAYPAL_API_BASE: "https://api-m.paypal.com" },
      { ...sim, PAYPAL_API_BASE: "http://127.0.0.1:3281" },
      { ...sim, PAYPAL_ENVIRONMENT: "live" },
      { ...sim, PAYPAL_WEBHOOK_ID: "WH-REAL-0123456789" },
      { PAYPAL_CLIENT_ID: SIM_PAYPAL.clientId },
      { PAYPAL_CLIENT_SECRET: SIM_PAYPAL.clientSecret },
      { PAYPAL_WEBHOOK_ID: SIM_PAYPAL.webhookId },
    ]) {
      expect(isolated(bad), JSON.stringify(Object.keys(bad))).toThrow();
    }
  });
});

describe("the approval link and the wire call", () => {
  const order = (href: string) => ({ id: "ORDSIM1234567", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href }] });
  const credentials = { apiKey: "client-id-123456", apiSecret: "client-secret-123456", webhookSecret: null, settings: { environment: "sandbox" } } as never;
  const input = { reference: "IAQ-ABCDEFGH12345678", amountMinor: 149900, currency: "USD", description: "Setup", successUrl: "https://app.example.test/return", cancelUrl: "https://app.example.test/cancel" } as never;
  const providerWith = (href: string) => createPaypalProvider({
    http: async (req) => (req.path === "/v1/oauth2/token" ? { status: 200, json: { access_token: "token-123456" } } : { status: 201, json: order(href) }),
  });

  it("hands a customer only a PayPal page: a link on this machine is refused with or without the simulator, and the simulator's ordinary sandbox link is accepted", async () => {
    const sandbox = "https://www.sandbox.paypal.com/checkoutnow?token=ORDSIM1234567";
    await expect(providerWith(sandbox).createCheckout(credentials, input)).resolves.toMatchObject({ checkoutUrl: sandbox });
    for (const bad of ["http://127.0.0.1:3282/approve/ORDSIM1234567", "https://evilpaypal.com/checkoutnow", "http://www.paypal.com/checkoutnow", "https://evil.example.test/approve", "https://paypal.com.evil.example.test/x"]) {
      await expect(providerWith(bad).createCheckout(credentials, input), bad).rejects.toMatchObject({ kind: "invalid_response" });
    }
    // Configuring the simulator changes where the API calls go, never which pages a customer may be sent to.
    Object.assign(process.env, SIM);
    resetEnvCache();
    await expect(providerWith(sandbox).createCheckout(credentials, input)).resolves.toMatchObject({ checkoutUrl: sandbox });
    for (const bad of ["http://127.0.0.1:3282/approve/ORDSIM1234567", "http://localhost:3282/approve/ORDSIM1234567", "http://127.0.0.1:9999/approve/ORDSIM1234567"]) {
      await expect(providerWith(bad).createCheckout(credentials, input), bad).rejects.toMatchObject({ kind: "invalid_response" });
    }
  });

  it("holds a subscription approval link to the same rule", async () => {
    Object.assign(process.env, SIM, { PAYPAL_MAINTENANCE_PLAN_ID: SIM_PAYPAL.planId });
    resetEnvCache();
    const link = (href: string) => async (req: { path: string }) => (req.path === "/v1/oauth2/token" ? { status: 200, json: { access_token: "token-123456" } } : { status: 201, json: { id: "I-SIM123456", status: "APPROVAL_PENDING", links: [{ rel: "approve", href }] } });
    const open = (href: string) => openSubscription({ reference: "IAQ-ABCDEFGH12345678", returnUrl: "https://app.example.test/r", cancelUrl: "https://app.example.test/c" }, { http: link(href) as never });
    const sandbox = "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=I-SIM123456";
    await expect(open(sandbox)).resolves.toMatchObject({ approvalUrl: sandbox });
    await expect(open("http://127.0.0.1:3282/subscribe/I-SIM123456")).rejects.toMatchObject({ kind: "invalid_response" });
    await expect(open("https://evil.example.test/subscribe")).rejects.toMatchObject({ kind: "invalid_response" });
  });

  describe("against a server on this machine", () => {
    let server: http.Server;
    let seen: Array<{ method: string; url: string; authorization: string | undefined }> = [];
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it("sends the sandbox call to the simulator's address only, with the secret in a header and never in the address", async () => {
      Object.assign(process.env, SIM, { PAYPAL_API_BASE: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
      resetEnvCache();
      seen = [];
      const res = await paypalHttp({ method: "POST", path: "/v1/oauth2/token", environment: "sandbox", basic: { id: "qa-sim-paypal-client-id", secret: "qa-sim-paypal-client-secret" }, contentType: "application/x-www-form-urlencoded", body: "grant_type=client_credentials" });
      expect(res).toEqual({ status: 200, json: { ok: true } });
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe("/v1/oauth2/token");
      expect(seen[0].authorization).toBe(`Basic ${Buffer.from("qa-sim-paypal-client-id:qa-sim-paypal-client-secret").toString("base64")}`);
      expect(seen[0].url).not.toContain("secret");
    });
  });
});
