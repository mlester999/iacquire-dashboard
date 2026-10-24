// The platform's emergency switch for the customer's invoice side (INVOICES_PUBLIC_DISABLED): when it is on, the invoice page, the page a provider sends the customer back to and the three
// public routes answer "temporarily unavailable" for every workspace, before any database read; a payment a provider reports to its webhook is still recorded. Embedded Postgres; no provider.
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, resetEnvCache } from "@/server/env";
import { CRM_QA_ENV } from "../scripts/crm-qa-env.mjs";

// Every way into the database is counted, so "without reading the database" is a measurement.
const reads = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/server/db", async (original) => {
  const actual = await original<typeof import("@/server/db")>();
  const counted = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => {
    reads.n += 1;
    return fn(...a);
  };
  return { ...actual, withSystem: counted(actual.withSystem), withUser: counted(actual.withUser), readSystem: counted(actual.readSystem), withServiceRole: counted(actual.withServiceRole), withSiteRuntime: counted(actual.withSiteRuntime) };
});
vi.mock("@/server/auth/session", async (original) => ({ ...(await original<typeof import("@/server/auth/session")>()), requestMeta: async () => ({ ip: "198.51.100.9", userAgent: "test" }) }));

import { completeApprovedCheckout, loadPublicInvoice, loadReturn, paymentStatusByReference, paymentStatusByToken, startPublicPayment } from "@/server/invoices/public";
import { handleCapture, handlePay, handleStatus } from "@/server/invoices/public-http";
import { PAY_ENDPOINT, REFERENCE_HEADER, STATUS_ENDPOINT, TOKEN_HEADER, CAPTURE_ENDPOINT } from "@/lib/invoices/public-http";
import { simulatedPlatform } from "@/server/customer-payments/providers/simulated";
import InvoicePage from "@/app/pay/[token]/page";
import ReturnPage from "@/app/pay/return/[reference]/page";
import { freshIp, linkTokenOf } from "./support/invoices";
import { deliver, invoiceNow, paymentsOf, simulatedSetup } from "./support/customer-payments";

const TOKEN = "A".repeat(43);
const REFERENCE = `CP-${"a".repeat(24)}`;
const ctx = () => ({ ip: freshIp() });
const switchTo = (value: "true" | "false" | undefined) => {
  if (value === undefined) delete process.env.INVOICES_PUBLIC_DISABLED;
  else process.env.INVOICES_PUBLIC_DISABLED = value;
  resetEnvCache();
};
const request = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  new Request(`http://localhost${url}`, { method: init.method ?? "GET", headers: { "x-forwarded-for": freshIp(), "x-forwarded-host": "localhost", ...init.headers }, body: init.body });

beforeEach(() => switchTo(undefined));
afterEach(() => {
  switchTo(undefined);
  simulatedPlatform.reset();
});

describe("with the switch on", () => {
  it("answers every way into the invoice side as unavailable without touching the database, for a link that exists or not", async () => {
    const s = await simulatedSetup();
    const token = await linkTokenOf(s.io, s.inv.id);
    switchTo("true");
    expect(env().INVOICES_PUBLIC_DISABLED).toBe(true);
    reads.n = 0;
    const providerCalls = simulatedPlatform.calls();
    for (const t of [token, TOKEN]) {
      expect(await loadPublicInvoice(t, ctx())).toEqual({ state: "disabled" });
      expect(await startPublicPayment(t, ctx())).toMatchObject({ ok: false, reason: "disabled", message: expect.stringMatching(/temporarily unavailable/) });
      expect(await paymentStatusByToken(t, ctx())).toEqual({ state: "disabled" });
    }
    expect(await loadReturn(s.a.reference, ctx())).toEqual({ state: "disabled" });
    expect(await paymentStatusByReference(s.a.reference, ctx())).toEqual({ state: "disabled" });
    expect(await completeApprovedCheckout(s.a.reference, s.a.checkoutId!, ctx())).toEqual({ ok: false, reason: "unavailable" });
    expect(reads.n).toBe(0);
    expect(await paymentsOf(s.inv.id)).toEqual([]);
    expect(simulatedPlatform.calls()).toBe(providerCalls);
  });

  it("answers the routes 503 with a time to come back, caches nothing and names no workspace", async () => {
    const s = await simulatedSetup();
    const token = await linkTokenOf(s.io, s.inv.id);
    switchTo("true");
    reads.n = 0;
    const pay = await handlePay(request(PAY_ENDPOINT, { method: "POST", headers: { [TOKEN_HEADER]: token } }));
    expect(pay.status).toBe(503);
    expect(pay.headers.get("retry-after")).toBe("300");
    expect(pay.headers.get("cache-control")).toBe("no-store");
    expect(await pay.json()).toEqual({ error: "disabled", message: expect.stringMatching(/Invoices are temporarily unavailable/) });
    for (const headers of [{ [TOKEN_HEADER]: token }, { [REFERENCE_HEADER]: s.a.reference }] as Array<Record<string, string>>) {
      const status = await handleStatus(request(STATUS_ENDPOINT, { headers }));
      expect(status.status).toBe(503);
      expect(status.headers.get("retry-after")).toBe("300");
      expect(await status.json()).toEqual({ error: "unavailable" });
    }
    const capture = await handleCapture(request(CAPTURE_ENDPOINT, { method: "POST", body: JSON.stringify({ reference: s.a.reference, checkoutId: s.a.checkoutId }) }));
    expect(capture.status).toBe(503);
    expect(reads.n).toBe(0);
  });

  it("shows the customer one honest sentence on the invoice page and on the page they come back to, and reads nothing", async () => {
    switchTo("true");
    reads.n = 0;
    const invoice = renderToStaticMarkup(await InvoicePage({ params: Promise.resolve({ token: TOKEN }) }));
    expect(invoice).toContain("Invoices are temporarily unavailable");
    expect(invoice).toContain("Please try again later, or contact the business directly.");
    const back = renderToStaticMarkup(await ReturnPage({ params: Promise.resolve({ reference: REFERENCE }), searchParams: Promise.resolve({}) }));
    expect(back).toContain("Invoices are temporarily unavailable");
    expect(back).toContain("contact the business and tell them the time you paid");
    expect(reads.n).toBe(0);
  });

  it("still records a payment the provider reports to its webhook: money that arrived is recorded whatever a switch says", async () => {
    const s = await simulatedSetup();
    const paid = simulatedPlatform.pay(s.a.checkoutId!, s.conn.webhookSecret);
    switchTo("true");
    expect((await deliver(s.conn, paid.rawBody, { signature: paid.signature })).outcome).toBe("processed");
    expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "succeeded" }]);
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("paid");
  });
});

describe("with the switch off (the default)", () => {
  it("works as before, and a value other than true does not switch anything off", async () => {
    const s = await simulatedSetup();
    const token = await linkTokenOf(s.io, s.inv.id);
    for (const value of [undefined, "false", ""] as const) {
      if (value === "") process.env.INVOICES_PUBLIC_DISABLED = "";
      else switchTo(value);
      resetEnvCache();
      expect(env().INVOICES_PUBLIC_DISABLED, String(value)).toBe(false);
    }
    expect((await loadPublicInvoice(token, ctx())).state).toBe("ok");
    expect((await paymentStatusByToken(token, ctx())).state).toBe("ok");
    const page = renderToStaticMarkup(await InvoicePage({ params: Promise.resolve({ token }) }));
    expect(page).toContain("TEST-0001");
    expect(page).not.toContain("temporarily unavailable");
  });
});

describe("where the switch is documented and pinned", () => {
  const text = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const valueOf = (file: string, name: string) => new RegExp(`^${name}=(.*?)\\r?$`, "m").exec(text(file))?.[1];

  it("is listed in .env.example, off, with a value the schema accepts", () => {
    expect(valueOf(".env.example", "INVOICES_PUBLIC_DISABLED")).toBe("false");
  });

  it("is pinned off in the browser QA environment, so a stray value in the shell cannot change what a run looks at", () => {
    expect(CRM_QA_ENV.INVOICES_PUBLIC_DISABLED).toBe("false");
    expect({ INVOICES_PUBLIC_DISABLED: "true", ...CRM_QA_ENV }.INVOICES_PUBLIC_DISABLED).toBe("false");
  });
});
