// invoiceOverdueSweep and invoiceReminders through the real tick endpoint: each is registered on its own rhythm, runs ONLY when SCHEDULER_JOBS_ONLY names it, and does only its own
// work. Embedded Postgres; nothing is sent to anyone.
const CRON = "invoices-scheduler-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON;
process.env.SCHEDULER_ENABLED = "true";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { POST as tick } from "@/app/api/internal/tick/route";
import { JOBS } from "@/server/ops/tick";
import { JOB_LABELS } from "@/lib/ops";
import { authorizeReminders, getReminderOverview } from "@/server/invoices/reminders";
import { addMessaging, consentTo, contactIn, invoiceOrg, issuedInvoice, rows, type InvoiceOrg } from "./support/invoices";

const LONG_AGO = new Date("2026-01-10T12:00:00Z");

const setOnly = (value: string | undefined) => {
  if (value === undefined) delete process.env.SCHEDULER_JOBS_ONLY;
  else process.env.SCHEDULER_JOBS_ONLY = value;
  resetEnvCache();
};
beforeAll(() => resetEnvCache());
afterEach(() => setOnly(undefined));
// Both jobs work across every workspace, so what an earlier test left to do is set aside first.
beforeEach(async () => {
  await withSystem(async (db) => {
    // Each test starts with the two jobs due (the slot a previous test used is cleared).
    await db.query("delete from worker_job_runs where job_name in ('invoiceOverdueSweep', 'invoiceReminders')");
    await db.query("update customer_invoice_reminders set status = 'cancelled', reason = 'test_leftover' where status = 'scheduled' or (status = 'queued' and message_id is null)");
    await db.query("insert into customer_invoice_events (org_id, invoice_id, kind, actor_kind, detail) select org_id, id, 'overdue', 'system', jsonb_build_object('dueOn', to_char(due_on, 'YYYY-MM-DD')) from customer_invoices i where status = 'issued' and due_on is not null and not exists (select 1 from customer_invoice_events e where e.invoice_id = i.id and e.kind = 'overdue')");
  });
});

const releaseLease = () => withSystem((db) => db.query("update worker_job_runs set last_finished_at = now() - interval '5 minutes' where job_name = 'scheduler_tick' and last_finished_at is not null"));
async function runTick() {
  await releaseLease();
  const res = await tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: { authorization: `Bearer ${CRON}` } }));
  return { status: res.status, ran: ((await res.json()) as { ran: Record<string, number | string> }).ran };
}
const heartbeats = async () => (await rows<{ job_name: string }>("select job_name from worker_job_runs where job_name <> 'scheduler_tick' order by job_name")).map((r) => r.job_name);

/** A workspace with an owed invoice that went overdue months ago, and a reminder that came due an hour ago and may go (everything the owner has to authorize is authorized). */
async function owing(): Promise<{ io: InvoiceOrg; invoiceId: string }> {
  const io = await invoiceOrg();
  await addMessaging(io);
  const contactId = await contactIn(io);
  await consentTo(io, contactId, "email");
  const inv = await issuedInvoice(io, { contactId, dueOn: "2026-01-20" }, LONG_AGO);
  const o = await getReminderOverview(io.ctx("owner"));
  await authorizeReminders(io.ctx("owner"), { wordingHash: o.wordingHash, settingsVersion: o.settingsVersion });
  await withSystem((db) => db.query("update customer_invoice_reminders set status = 'scheduled', reason = null, due_at = now() - interval '1 hour' where invoice_id = $1 and step_key = 'on_due:0'", [inv.invoice.id]));
  return { io, invoiceId: inv.invoice.id };
}
const overdueLines = (invoiceId: string) => rows("select 1 from customer_invoice_events where invoice_id = $1 and kind = 'overdue' and actor_kind = 'system' and detail ? 'daysOverdue'", [invoiceId]);
const reminderRow = async (invoiceId: string) => (await rows<{ status: string; message_id: string | null }>("select status, message_id from customer_invoice_reminders where invoice_id = $1 and step_key = 'on_due:0'", [invoiceId]))[0];

describe("the two invoice jobs", () => {
  it("are registered once each, on their own rhythms, with a plain label for the health page", () => {
    for (const [name, every] of [["invoiceOverdueSweep", 60], ["invoiceReminders", 15]] as const) {
      expect(JOBS.filter((j) => j.name === name), name).toHaveLength(1);
      expect(JOBS.find((j) => j.name === name)?.everyMinutes, name).toBe(every);
      expect(JOB_LABELS[name].length, name).toBeGreaterThan(20);
    }
  });

  it("do nothing when the scheduler is told to run other jobs only", async () => {
    const { io, invoiceId } = await owing();
    setOnly("aiWorkRecovery,crmWorkflowRecovery");
    const r = await runTick();
    expect(r.status).toBe(200);
    expect(Object.keys(r.ran).sort()).toEqual(["aiWorkRecovery", "crmWorkflowRecovery"]);
    expect(await overdueLines(invoiceId)).toHaveLength(0);
    expect(await reminderRow(invoiceId)).toMatchObject({ status: "scheduled", message_id: null });
    expect(await rows("select 1 from conversation_messages where org_id = $1", [io.orgId])).toHaveLength(0);
    const beats = await heartbeats();
    expect(beats).not.toContain("invoiceOverdueSweep");
    expect(beats).not.toContain("invoiceReminders");
  });

  it("run the overdue sweep alone when only it is named: it notes the late invoice and queues no reminder", async () => {
    const { invoiceId } = await owing();
    setOnly("invoiceOverdueSweep");
    const r = await runTick();
    expect(Object.keys(r.ran)).toEqual(["invoiceOverdueSweep"]);
    expect(Number(r.ran.invoiceOverdueSweep)).toBeGreaterThanOrEqual(1);
    expect(await overdueLines(invoiceId)).toHaveLength(1);
    expect(await reminderRow(invoiceId)).toMatchObject({ status: "scheduled", message_id: null });
    expect(await heartbeats()).toContain("invoiceOverdueSweep");
  });

  it("run the reminders job alone when only it is named: it queues the due reminder and notes nothing as overdue", async () => {
    const { io, invoiceId } = await owing();
    setOnly("invoiceReminders");
    const r = await runTick();
    expect(Object.keys(r.ran)).toEqual(["invoiceReminders"]);
    expect(Number(r.ran.invoiceReminders)).toBeGreaterThanOrEqual(1);
    const row = await reminderRow(invoiceId);
    expect(row.status).toBe("queued");
    expect(row.message_id).not.toBeNull();
    expect(await overdueLines(invoiceId)).toHaveLength(0);
    // It queued the message for the send chain's dispatcher; it did not send it.
    expect((await rows<{ status: string; scope: string }>("select status, scope from conversation_messages where org_id = $1", [io.orgId]))).toEqual([{ status: "queued", scope: "billing" }]);
  });

  it("hold their slot after running, so a second tick right away does the work once", async () => {
    const { io } = await owing();
    setOnly("invoiceReminders");
    await runTick();
    const again = await runTick();
    expect(again.ran.invoiceReminders).toBe("skipped");
    expect(await rows("select 1 from conversation_messages where org_id = $1", [io.orgId])).toHaveLength(1);
  });
});
