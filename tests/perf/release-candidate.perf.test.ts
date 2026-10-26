// Measured time and statement counts for the money and scheduling paths this release candidate added, on the embedded Postgres the tests use (PGlite, in memory, one process).
// INDICATIVE ONLY: a hosted database over a network is slower per statement and faster per row, so what carries over is the NUMBER OF STATEMENTS and which job dominates, not the
// milliseconds. Run on request, never in the normal suite:  CRM_PERF=1 npx vitest run tests/perf/release-candidate.perf.test.ts
// Output: tmp/perf-release-candidate.json (git-ignored) and the table printed at the end.
import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

process.env.PAYMONGO_SECRET_KEY = "sk_test_notarealkey123";
process.env.PAYMONGO_WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";
process.env.PAYMONGO_PAYMENT_METHODS = "card,gcash";

import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { handlePaymongoWebhook } from "@/server/billing/payments";
import { createPurchaseIntent, startPurchase } from "@/server/purchase-intents/service";
import { startPurchaseCheckout } from "@/server/purchase-intents/checkout";
import { createCreditNoteDraft, issueCreditNote, submitCreditNote } from "@/server/invoices/credit-notes";
import { JOBS } from "@/server/ops/tick";
import { capture, PERF_LABEL } from "./harness";
import { agencyUser } from "../support/fixtures";
import { agencyOrgId, staffPerson } from "../support/staff-messages";
import { mockCheckoutFetch, paymongoPaidEvent, signPaymongo } from "../support/billing";
import { invoiceOrg, issuedInvoice } from "../support/invoices";
import { messagingOrg } from "../support/messaging";

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1) };
};
const out: Record<string, unknown> = { label: PERF_LABEL, at: new Date().toISOString(), node: process.version };
const NOW = new Date("2026-10-26T12:00:00Z");

describe("credit notes", () => {
  it("writes, sends and issues a credit note: time and statements per step", async () => {
    const io = await invoiceOrg();
    const steps: Record<string, { ms: number[]; statements: number[] }> = { draft: { ms: [], statements: [] }, submit: { ms: [], statements: [] }, issue: { ms: [], statements: [] } };
    for (let i = 0; i < 12; i += 1) {
      const inv = (await issuedInvoice(io, {}, NOW)).invoice;
      const draft = await capture(() => createCreditNoteDraft(io.ctx("manager"), { invoiceId: inv.id, amount: "100.00", reason: `Perf credit ${i}` }));
      const submit = await capture(() => submitCreditNote(io.ctx("manager"), draft.result.id, draft.result.version));
      const issue = await capture(() => issueCreditNote(io.ctx("owner"), draft.result.id, { version: submit.result.version }, { now: NOW }));
      for (const [k, c] of [["draft", draft], ["submit", submit], ["issue", issue]] as const) { steps[k].ms.push(c.ms); steps[k].statements.push(c.queries.length); }
    }
    out.creditNotes = Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { ...stats(v.ms), statements: Math.max(...v.statements) }]));
    expect(Math.max(...steps.issue.statements)).toBeLessThan(80);
  }, 300_000);
});

describe("a purchase becomes a workspace", () => {
  beforeAll(async () => {
    resetEnvCache();
    await agencyOrgId();
    await withSystem((db) => db.query("update agency_billing_settings set purchase_checkout_enabled = true, usd_php_rate = 58, fx_source = 'perf', fx_updated_at = now(), live_payments_review_at = now()"));
  });
  it("takes the signed paid notice to a provisioned workspace with six employees: time and statements", async () => {
    const session = agencyUser(await staffPerson("agency_super_admin"), "agency_super_admin");
    const ms: number[] = [];
    const statements: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const uid = crypto.randomUUID().slice(0, 8);
      const created = await createPurchaseIntent(session, { buyerName: "Perf Buyer", buyerEmail: `perf-${uid}@example.test`, company: `Perf Co ${uid}`, timezone: "America/Chicago", maintenanceSelected: false, autoProvision: true }, { now: NOW });
      await startPurchase(created.token, { now: NOW });
      const id = `cs_perf_${uid}`;
      const checkout = await startPurchaseCheckout(created.token, { ip: "198.51.100.77" }, { fetch: mockCheckoutFetch(id).impl as never, now: NOW });
      const row = (await withSystem((db) => db.query<{ n: string }>("select charged_amount_minor::text as n from purchase_intent_checkouts where reference_number = $1", [checkout.reference]))).rows[0];
      const body = paymongoPaidEvent({ checkoutId: id, reference: checkout.reference, amount: Number(row.n), paymentId: `pay_perf_${uid}`, eventId: `evt_perf_${uid}` });
      const c = await capture(() => handlePaymongoWebhook({ rawBody: body, signatureHeader: signPaymongo(body) }));
      expect(c.result).toMatchObject({ httpStatus: 200, outcome: "processed" });
      ms.push(c.ms);
      statements.push(c.queries.length);
    }
    out.purchaseWebhookToWorkspace = { ...stats(ms), statementsMax: Math.max(...statements), statementsMin: Math.min(...statements) };
  }, 300_000);
});

describe("the scheduler's jobs", () => {
  const orgCount = async () => Number((await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from organizations where kind = 'client'"))).rows[0].n);
  async function pass() {
    const timings: Array<{ name: string; ms: number; ok: boolean; statements: number }> = [];
    for (const job of JOBS) {
      const c = await capture(async () => { try { await job.run(); return true; } catch { return false; } });
      timings.push({ name: job.name, ms: +c.ms.toFixed(1), ok: c.result, statements: c.queries.length });
    }
    return { workspaces: await orgCount(), timings, totalMs: +timings.reduce((t, j) => t + j.ms, 0).toFixed(0), statementsTotal: timings.reduce((t, j) => t + j.statements, 0) };
  }

  it("runs every registered job at three sizes and reports which jobs grow with the number of workspaces, and how", async () => {
    const sizes: Array<Awaited<ReturnType<typeof pass>>> = [];
    for (let i = 0; i < 3; i += 1) await messagingOrg();
    for (const target of [10, 40, 160]) {
      while ((await orgCount()) < target) await messagingOrg();
      await pass(); // settles anything that is only done once for a new workspace, so the measured pass is steady state
      sizes.push(await pass());
    }
    const at = (i: number, name: string) => sizes[i].timings.find((t) => t.name === name)!;
    const growth = sizes[2].timings.map((t) => ({
      name: t.name, statements: sizes.map((_, i) => at(i, t.name).statements), ms: sizes.map((_, i) => at(i, t.name).ms),
      statementsPerWorkspaceAtLargest: +(t.statements / sizes[2].workspaces).toFixed(2),
    }));
    const growing = growth.filter((g) => g.statements[2] >= 40 && g.statements[2] >= g.statements[0] * 4).sort((x, y) => y.statements[2] - x.statements[2]);
    out.scheduler = {
      jobs: JOBS.length,
      failed: [...new Set(sizes.flatMap((z) => z.timings).filter((t) => !t.ok).map((t) => t.name))],
      sizes: sizes.map((z) => ({ workspaces: z.workspaces, totalMs: z.totalMs, statementsTotal: z.statementsTotal })),
      slowestAtLargest: [...sizes[2].timings].sort((x, y) => y.ms - x.ms).slice(0, 6),
      growWithWorkspaces: growing.slice(0, 8),
    };
    expect(JOBS.length).toBeGreaterThan(60);
  }, 900_000);

  it("writes the numbers down", () => {
    mkdirSync("tmp", { recursive: true });
    writeFileSync("tmp/perf-release-candidate.json", JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
  });
});
