// customerPaymentReconcile through the real tick endpoint: it runs only when SCHEDULER_JOBS_ONLY names it, and it touches nothing outside its own tables. Embedded Postgres.
const CRON = "customer-payments-scheduler-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON;
process.env.SCHEDULER_ENABLED = "true";

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { POST as tick } from "@/app/api/internal/tick/route";
import { JOBS } from "@/server/ops/tick";
import { sha256 } from "@/server/security/crypto";
import { emptyEvent, storableFacts } from "@/lib/invoices/payment-events";
import { simulatedPlatform } from "@/server/customer-payments/providers/simulated";
import { invoiceNow, paymentsOf, q, simulatedSetup } from "./support/customer-payments";

const setOnly = (value: string | undefined) => {
  if (value === undefined) delete process.env.SCHEDULER_JOBS_ONLY;
  else process.env.SCHEDULER_JOBS_ONLY = value;
  resetEnvCache();
};
beforeAll(() => resetEnvCache());
afterEach(() => setOnly(undefined));

const releaseLease = () => withSystem((db) => db.query("update worker_job_runs set last_finished_at = now() - interval '5 minutes' where job_name = 'scheduler_tick' and last_finished_at is not null"));
async function runTick() {
  await releaseLease();
  const res = await tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: { authorization: `Bearer ${CRON}` } }));
  return { status: res.status, ran: ((await res.json()) as { ran: Record<string, number | string> }).ran };
}
const heartbeats = async () => (await q<{ job_name: string }>("select job_name from worker_job_runs where job_name <> 'scheduler_tick' order by job_name")).map((r) => r.job_name);

describe("customerPaymentReconcile", () => {
  it("is a registered job on a fifteen-minute rhythm", () => {
    const job = JOBS.find((j) => j.name === "customerPaymentReconcile");
    expect(job).toBeDefined();
    expect(job!.everyMinutes).toBe(15);
  });

  it("applies a delivery that was received and never finished only when the scheduler is told to run it", async () => {
    const { io, inv, conn, a } = await simulatedSetup();
    // The platform holds the payment the delivery speaks of (the simulated provider is read back before a payment is counted).
    const paid = simulatedPlatform.pay(a.checkoutId!, conn.webhookSecret);
    const facts = { ...emptyEvent("payment.succeeded", { eventId: "evt_stale_receipt", type: "t", livemode: false }), checkoutId: a.checkoutId, reference: a.reference, paymentId: paid.paymentId, amountMinor: a.amountMinor, currency: "PHP" };
    // A delivery that was received half an hour ago and never finished (a receipt's time of arrival is fixed once written, so it is written with its age).
    const receipt = await withSystem((db) =>
      db.query<{ id: string }>(
        `insert into customer_payment_events (org_id, connection_id, provider_event_id, event_type, livemode, outcome, detail, payload_sha256, received_at)
         values ($1, $2, $3, $4, false, 'received', $5::jsonb, $6, now() - interval '30 minutes') returning id`,
        [io.orgId, conn.id, facts.eventId, facts.type, JSON.stringify({ facts: storableFacts(facts) }), sha256("stale")],
      ),
    );
    const stored = { receiptId: receipt.rows[0].id };
    // Other jobs named: this one does not run, leaves no heartbeat, and the delivery waits.
    setOnly("aiWorkRecovery,crmWorkflowRecovery");
    const other = await runTick();
    expect(other.status).toBe(200);
    expect(Object.keys(other.ran).sort()).toEqual(["aiWorkRecovery", "crmWorkflowRecovery"]);
    expect(await paymentsOf(inv.id)).toEqual([]);
    expect((await q<{ outcome: string }>("select outcome from customer_payment_events where id = $1", [stored.receiptId]))[0].outcome).toBe("received");
    const afterOther = await heartbeats();
    expect(afterOther.includes("customerPaymentReconcile")).toBe(false);

    // Named: it runs, applies it, and is the only job that ran.
    setOnly("customerPaymentReconcile");
    const named = await runTick();
    expect(Object.keys(named.ran)).toEqual(["customerPaymentReconcile"]);
    expect(named.ran.customerPaymentReconcile).toBeGreaterThanOrEqual(1);
    expect(await paymentsOf(inv.id)).toMatchObject([{ status: "succeeded", provider_payment_id: paid.paymentId }]);
    expect(await invoiceNow(inv.id)).toMatchObject({ payment_status: "paid" });
    expect(new Set(await heartbeats())).toEqual(new Set([...afterOther, "customerPaymentReconcile"]));
  });
});
