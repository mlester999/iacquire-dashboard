// The simulated payment provider does not exist in production, whatever else is set: it cannot be connected, started, believed or reached. The environment is
// replaced (NODE_ENV only) around the calls that decide this; the real validation of production configuration is not what is tested here.
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkoutBlock } from "@/lib/invoices/connection-rules";

const mode = vi.hoisted(() => ({ nodeEnv: "test" as string }));
vi.mock("@/server/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/env")>();
  return { ...actual, env: () => ({ ...actual.env(), NODE_ENV: mode.nodeEnv }) };
});

import { paymentSwitches, simulatedAllowed } from "@/server/customer-payments/switches";
import { providerFor, setAdapterForTests } from "@/server/customer-payments/providers";
import { connectProvider } from "@/server/customer-payments/connections";
import { startCheckout } from "@/server/customer-payments/attempts";
import { readBackAllowed } from "@/server/customer-payments/events";
import { createPaymongoProvider } from "@/server/customer-payments/providers/paymongo";
import { invoiceOrg, issuedInvoice } from "./support/invoices";
import { AUTHORIZATION, connect, deliver, fakePaymongo, paymongoPaid, q, simulatedDelivery } from "./support/customer-payments";

afterEach(() => {
  mode.nodeEnv = "test";
});

describe("in production", () => {
  it("has no simulated provider: the switches say so, the registry refuses it, and a read-back is never made through it", () => {
    expect(simulatedAllowed()).toBe(true);
    expect(providerFor("simulated").id).toBe("simulated");
    expect(readBackAllowed("simulated")).toBe(true);
    mode.nodeEnv = "production";
    expect(simulatedAllowed()).toBe(false);
    expect(paymentSwitches()).toMatchObject({ simulatedAllowed: false, writesEnabled: false, liveEnabled: false });
    expect(() => providerFor("simulated")).toThrow(/not available in production/);
    expect(readBackAllowed("simulated")).toBe(false);
    // The real provider is still the real provider; it only waits for its own switch.
    expect(providerFor("paymongo").id).toBe("paymongo");
    expect(readBackAllowed("paymongo")).toBe(false);
  });

  it("refuses a simulated checkout whatever the connection says", () => {
    const conn = { provider: "simulated" as const, mode: "test" as const, status: "connected" as const, supportedCurrencies: ["PHP"], authorizedAt: new Date(), liveConfirmedAt: null };
    expect(checkoutBlock(conn, "PHP", { writesEnabled: true, liveEnabled: true, simulatedAllowed: true }, "public")).toBeNull();
    expect(checkoutBlock(conn, "PHP", { writesEnabled: true, liveEnabled: true, simulatedAllowed: false }, "public")).toMatchObject({ code: "simulated_unavailable" });
    expect(checkoutBlock(conn, "PHP", { writesEnabled: true, liveEnabled: true, simulatedAllowed: false }, "member")).toMatchObject({ code: "simulated_unavailable" });
  });

  it("cannot be connected, cannot start a checkout, and a delivery to a simulated address gets the same 403 as any unknown address", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, { isTest: true })).invoice;
    const sim = await connect(io, { provider: "simulated" });
    const fresh = await invoiceOrg();
    mode.nodeEnv = "production";
    await expect(connectProvider(fresh.ctx("owner"), { provider: "simulated", authorization: AUTHORIZATION })).rejects.toThrow(/not available in production/);
    expect(await q("select id from customer_payment_connections where org_id = $1", [fresh.orgId])).toEqual([]);
    await expect(startCheckout({ orgId: io.orgId, invoiceId: inv.id, audience: "public" })).rejects.toThrow("Online payment is not available for this invoice right now.");
    await expect(startCheckout({ orgId: io.orgId, invoiceId: inv.id, audience: "member" })).rejects.toThrow(/simulated provider is not available in production/);
    const r = await simulatedDelivery(sim, { kind: "payment.succeeded", reference: "CP-0123456789abcdef0123456789abcdef", checkoutId: "x", paymentId: "p", amountMinor: 1, currency: "PHP" });
    expect(r).toEqual({ status: 403, body: { error: "forbidden" }, outcome: "rejected" });
    expect(await q("select id from customer_payment_events where connection_id = $1", [sim.id])).toEqual([]);
  });

  it("leaves PayMongo exactly as it is in any other environment: it works only when its own switch is on", async () => {
    const f = fakePaymongo();
    setAdapterForTests("paymongo", createPaymongoProvider({ http: f.http }));
    try {
      const io = await invoiceOrg();
      const inv = (await issuedInvoice(io, { isTest: true })).invoice;
      const conn = await connect(io, { provider: "paymongo", mode: "test" });
      mode.nodeEnv = "production";
      await expect(startCheckout({ orgId: io.orgId, invoiceId: inv.id, audience: "member" })).rejects.toThrow(/Calls to payment providers are switched off/);
      expect(f.calls).toEqual([]);
      // A delivery for a real connection is still believed (it is answered on its merits, not with the 403 a stranger gets).
      expect((await deliver(conn, paymongoPaid({ checkoutId: "cs_1", reference: "CP-0123456789abcdef0123456789abcdef", amount: 100 }))).status).toBe(200);
    } finally {
      setAdapterForTests("paymongo", null);
    }
  });
});
