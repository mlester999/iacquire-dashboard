// The Performance Analyst's read-only receivables review: who may run it, what it reports (and what it will not say), that it changes nothing, and that it reads only its own
// workspace. Embedded Postgres; no AI model, customer or payment provider is involved: the review is plain reads of stored records.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { WORKFORCE_CAPABILITIES, capabilitiesForRole, roleMayUseCapability } from "@/lib/workforce-capabilities";
import { applyDisputeInTx } from "@/server/invoices/apply";
import { recordManualPayment } from "@/server/invoices/payments";
import { agentId } from "./support/fixtures";
import { connectionFor, contactIn, draftBy, invoiceOrg, issuedInvoice, providerPayment, rows, type InvoiceOrg } from "./support/invoices";

const LONG_AGO = new Date("2026-01-10T12:00:00Z");
const cash = (amount: string, over: Record<string, unknown> = {}) => ({ amount, receivedOn: "2026-01-10", method: "cash" as const, evidence: "Cash, receipt 12", ...over });

interface Finding { key: string; severity: string; count: number; title: string; detail: string; samples: string[]; evidenceHref: string }
interface Result { findings: Finding[]; metrics: Array<{ key: string; value: number }>; limitations: string }

async function readyAnalyst(io: InvoiceOrg) {
  const id = await agentId(io.orgId, "performance_analyst");
  await withSystem((db) => createConfigVersion(db, { orgId: io.orgId, agentId: id, settings: defaultSettings("performance_analyst"), source: "onboarding", userId: io.c.people.owner.id, apply: true }));
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where org_id = $1", [io.orgId]));
}

async function review(io: InvoiceOrg): Promise<{ status: string; result: Result; summary: string | null }> {
  const dispatched = await dispatchCapabilityJob(io.ctx("owner"), { agentRole: "performance_analyst", capability: "receivables_review", title: "Receivables review" });
  type Job = { status: string; result: Result; result_summary: string | null };
  let job: Job | undefined;
  for (let i = 0; i < 400; i += 1) {
    job = (await rows("select status, result, result_summary from ai_work_jobs where id = $1", [dispatched.jobId]))[0] as unknown as Job;
    if (job && ["completed", "failed", "blocked", "cancelled"].includes(job.status)) break;
    await new Promise((res) => setTimeout(res, 25));
  }
  return { status: job?.status ?? "missing", result: job?.result as Result, summary: job?.result_summary ?? null };
}

const fingerprint = async (orgId: string) => {
  const out: Record<string, string> = {};
  for (const t of ["customer_invoices", "customer_invoice_lines", "customer_invoice_events", "customer_invoice_reminders", "customer_payments", "customer_refunds", "customer_payment_attempts", "customer_payment_connections", "customer_payment_events", "conversation_messages", "crm_events", "crm_activities", "tasks"]) {
    const r = await rows<{ n: string; h: string }>(`select count(*)::text as n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h from ${t} t where org_id = $1`, [orgId]);
    out[t] = `${r[0].n}:${r[0].h}`;
  }
  return out;
};

describe("the capability", () => {
  it("belongs to the Performance Analyst alone, is read-only, and needs the permission to see invoices", () => {
    expect(WORKFORCE_CAPABILITIES.receivables_review).toMatchObject({ allowedRoles: ["performance_analyst"], risk: "read_only", requiredPermission: "invoices.view", workBoardAction: true });
    for (const role of ["sales_assistant", "lead_hunter", "appointment_setter", "crm_manager", "operations_manager"] as const) expect(roleMayUseCapability(role, "receivables_review"), role).toBe(false);
    expect(roleMayUseCapability("performance_analyst", "receivables_review")).toBe(true);
    expect(capabilitiesForRole("performance_analyst").map((c) => c.key)).toContain("receivables_review");
    expect(WORKFORCE_CAPABILITIES.receivables_review.description).toMatch(/never issues, sends, voids, records or refunds anything/);
  });

  it("is refused to another employee's role and to a person who cannot see invoices", async () => {
    const io = await invoiceOrg();
    await readyAnalyst(io);
    await expect(dispatchCapabilityJob(io.ctx("owner"), { agentRole: "sales_assistant", capability: "receivables_review", title: "x" })).rejects.toThrow(/role does not include/i);
    await expect(dispatchCapabilityJob(io.ctx("support"), { agentRole: "performance_analyst", capability: "receivables_review", title: "x" })).rejects.toThrow(/can't start this work|can't start AI work/);
    await expect(dispatchCapabilityJob(io.ctx("viewer"), { agentRole: "performance_analyst", capability: "receivables_review", title: "x" })).rejects.toThrow();
  });
});

describe("what it reports", () => {
  it("says there is nothing to review for a workspace that never had customer invoices switched on", async () => {
    const io = await invoiceOrg({ enabled: false });
    await readyAnalyst(io);
    const r = await review(io);
    expect(r.status).toBe("completed");
    expect(r.result.findings.map((f) => f.key)).toEqual(["receivables_not_switched_on"]);
    expect(r.result.metrics).toEqual([]);
  });

  it("finds nothing to report in a workspace whose invoices are all in order", async () => {
    const io = await invoiceOrg();
    await readyAnalyst(io);
    const paid = await issuedInvoice(io, { dueOn: "2026-02-01" }, LONG_AGO);
    await recordManualPayment(io.ctx("owner"), paid.invoice.id, cash("1500"), { now: LONG_AGO });
    const r = await review(io);
    expect(r.status).toBe("completed");
    expect(r.result.findings).toEqual([]);
    expect(r.result.metrics.map((m) => [m.key, m.value])).toEqual([["receivables_open_invoices", 0], ["receivables_overdue_invoices", 0], ["receivables_paid_invoices", 1]]);
  });

  it("reports what is overdue per currency without ever adding currencies together, and names no customer", async () => {
    const io = await invoiceOrg();
    await readyAnalyst(io);
    const contactId = await contactIn(io, { firstName: "Zelda", lastName: "Quimby" });
    await issuedInvoice(io, { contactId, dueOn: "2026-01-20" }, LONG_AGO);
    await issuedInvoice(io, { contactId, dueOn: "2026-01-21", currency: "USD" }, LONG_AGO);
    const r = await review(io);
    const overdue = r.result.findings.find((f) => f.key === "receivables_overdue")!;
    expect(overdue).toMatchObject({ severity: "critical", count: 2, evidenceHref: "/invoices" });
    expect(overdue.detail).toContain("PHP 1,500.00 and USD 1,500.00");
    expect(overdue.title).toBe("2 unpaid invoices are past their due date");
    expect(overdue.samples).toHaveLength(2);
    expect(overdue.samples[0]).toMatch(/^INV-0001: PHP 1,500\.00, \d+ days late$/);
    expect(JSON.stringify(r.result)).not.toMatch(/Zelda|Quimby|@example\.test|\+1555/);
    expect(r.result.metrics.find((m) => m.key === "receivables_overdue_invoices")?.value).toBe(2);
    expect(r.result.limitations).toMatch(/never added together/);
  });

  it("reports payments held out of the books, failed attempts, disputes, overpayment, stuck notices, an account needing attention, approvals waiting and reminders on hold or blocked", async () => {
    const io = await invoiceOrg();
    await readyAnalyst(io);
    const conn = await connectionFor(io);
    const contactId = await contactIn(io);
    const held = await issuedInvoice(io, { contactId, dueOn: "2099-01-01" }, LONG_AGO);
    await providerPayment(io, held.invoice.id, conn, 700, { livemode: true, status: "needs_review" });
    await providerPayment(io, held.invoice.id, conn, 800, { livemode: true, status: "failed" });
    const disputed = await issuedInvoice(io, { contactId, dueOn: "2099-01-01" }, LONG_AGO);
    const part = await providerPayment(io, disputed.invoice.id, conn, 50_000, { livemode: true });
    await withSystem((db) => applyDisputeInTx(db, { orgId: io.orgId, paymentId: part.paymentId, open: true, actor: { id: null, kind: "provider" } }));
    const over = await issuedInvoice(io, { contactId, dueOn: "2099-01-01" }, LONG_AGO);
    await recordManualPayment(io.ctx("owner"), over.invoice.id, cash("2000", { allowOverpayment: true }), { now: LONG_AGO });
    await withSystem(async (db) => {
      await db.query("insert into customer_payment_events (org_id, connection_id, provider_event_id, event_type, outcome) values ($1, $2, 'evt_a', 'payment.paid', 'error'), ($1, $2, 'evt_b', 'refund.updated', 'deferred')", [io.orgId, conn]);
      await db.query("update customer_payment_connections set status = 'needs_attention' where id = $1", [conn]);
    });
    // Waiting for approval for three days (its history line is written with that age).
    const waiting = await draftBy(io, "sales");
    await withSystem(async (db) => {
      await db.query("update customer_invoices set status = 'pending_approval' where id = $1", [waiting.invoice.id]);
      await db.query("insert into customer_invoice_events (org_id, invoice_id, at, kind, actor_kind) values ($1, $2, now() - interval '3 days', 'submitted', 'user')", [io.orgId, waiting.invoice.id]);
      await db.query("update customer_invoice_settings set reminders_enabled = true, reminders_authorized_at = now(), reminders_authorized_by = $2, reminders_body_hash = repeat('a', 64) where org_id = $1", [io.orgId, io.c.people.owner.id]);
      await db.query("insert into customer_invoice_reminders (org_id, invoice_id, step_key, due_at, status, reason) values ($1, $2, 'on_due:0', now(), 'blocked', 'no_consent'), ($1, $2, 'after_due:3', now(), 'blocked', 'credits')", [io.orgId, held.invoice.id]);
    });

    const r = await review(io);
    expect(r.status).toBe("completed");
    const by = Object.fromEntries(r.result.findings.map((f) => [f.key, f]));
    expect(by.receivables_connection_attention).toMatchObject({ severity: "critical", count: 1, evidenceHref: "/settings/payments" });
    expect(by.receivables_deliveries_stuck).toMatchObject({ severity: "critical", count: 1 });
    expect(by.receivables_payments_review).toMatchObject({ severity: "critical", count: 1 });
    expect(by.receivables_payments_failed).toMatchObject({ severity: "warning", count: 1 });
    expect(by.receivables_disputes).toMatchObject({ severity: "warning", count: 1 });
    expect(by.receivables_overpaid).toMatchObject({ severity: "warning", count: 1 });
    expect(by.receivables_approvals_waiting).toMatchObject({ severity: "warning", count: 1 });
    expect(by.receivables_reminders_on_hold).toMatchObject({ severity: "warning", count: 1, evidenceHref: "/invoices/settings" });
    expect(by.receivables_reminders_on_hold.detail).toMatch(/changed since the owner authorized them/);
    expect(by.receivables_reminders_blocked).toMatchObject({ severity: "info", count: 2 });
    expect(by.receivables_reminders_blocked.samples.sort()).toEqual(["1 reminder: No consent on record for this kind of message", "1 reminder: Not enough service credits"]);
    // The checks that mean money may be unrecorded come first, and an overdue finding is absent because nothing owed is past due (the dates are in 2099).
    expect(by.receivables_overdue).toBeUndefined();
    expect(r.result.findings[0].key).toBe("receivables_connection_attention");
    expect(r.summary).toMatch(/Receivables review found 9 signals/);
  });
});

describe("what it never does", () => {
  it("changes nothing in the workspace it reads, and reads nothing of another's", async () => {
    const a = await invoiceOrg();
    const b = await invoiceOrg();
    await readyAnalyst(a);
    await issuedInvoice(a, { dueOn: "2026-01-20" }, LONG_AGO);
    await issuedInvoice(b, { dueOn: "2026-01-20" }, LONG_AGO);
    await issuedInvoice(b, { dueOn: "2026-01-20" }, LONG_AGO);
    const beforeA = await fingerprint(a.orgId);
    const beforeB = await fingerprint(b.orgId);
    const r = await review(a);
    expect(r.status).toBe("completed");
    // Only its own workspace's single overdue invoice is counted, and the other workspace's two are not.
    expect(r.result.findings.find((f) => f.key === "receivables_overdue")?.count).toBe(1);
    expect(await fingerprint(a.orgId)).toEqual(beforeA);
    expect(await fingerprint(b.orgId)).toEqual(beforeB);
    // It contacted nobody: no message exists in either workspace.
    expect(await rows("select 1 from conversation_messages where org_id = any($1::uuid[])", [[a.orgId, b.orgId]])).toHaveLength(0);
  });
});
