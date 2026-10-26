import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { closeOpportunity } from "@/server/crm/opportunities";
import { systemActor } from "@/server/crm/actor";
import { createTaskInTx, type TaskInput } from "@/server/crm/tasks";
import { decideCloseRule, type CloseRuleDecision } from "@/lib/invoices/close-rule";
import { COUNTED_STATUSES } from "@/server/invoices/apply";
import { readSettings, toMinor } from "@/server/invoices/core";

// What happens to the deal linked to an invoice once the invoice is paid (the owner's close rule, default "none"). It runs AFTER the transaction that recorded the
// payment has committed, never inside it: closing a deal is the CRM's own transaction, and a payment must be recorded whether or not the deal can be closed. It is
// safe to run again at any time (a sweep, a retry): the rule acts once per invoice, and what it did is a row in the invoice's history.
//
// It never marks a deal won on a partial payment, a deposit or a refund; never reopens a deal; never acts while a dispute is open; and "won" needs the owner's rule,
// a person's mark on this one invoice, and full payment confirmed by the provider (or by hand, when the owner counts those).

const COUNTED_SQL = COUNTED_STATUSES.map((s) => `'${s}'`).join(", ");

export interface CloseRuleOutcome {
  decision: CloseRuleDecision;
  /** The task that was created, when the rule asked a person. */
  taskId?: string;
  /** Why a decided action could not be done (the deal changed in between, for example). */
  note?: string;
}

interface InvoiceFacts {
  id: string;
  number: string | null;
  closes_deal: boolean;
  status: "draft" | "pending_approval" | "issued" | "void";
  payment_status: "unpaid" | "partially_paid" | "paid" | "disputed" | "credited";
  contact_id: string | null;
  opportunity_id: string | null;
  company_id: string | null;
  is_test: boolean;
}

interface DealFacts {
  status: "open" | "won" | "lost";
  assigned_user_id: string | null;
  name: string;
}

/** A task for the deal's owner (unassigned when they have left the team: a task is never lost for that). */
async function askPerson(db: Queryable, orgId: string, inv: InvoiceFacts, assigneeId: string | null, task: Pick<TaskInput, "title" | "description" | "priority">): Promise<{ id: string }> {
  const actor = systemActor({ id: orgId });
  const input: TaskInput = { ...task, contactId: inv.contact_id, companyId: inv.company_id, opportunityId: inv.opportunity_id };
  try {
    return await createTaskInTx(db, actor, { ...input, assigneeId }, { source: "system" });
  } catch (e) {
    if (!(e instanceof AppError) || !assigneeId) throw e;
    return createTaskInTx(db, actor, input, { source: "system" });
  }
}

const recordApplied = (db: Queryable, orgId: string, invoiceId: string, detail: Record<string, unknown>) =>
  db.query(`insert into customer_invoice_events (org_id, invoice_id, kind, actor_kind, detail) values ($1, $2, 'close_rule_applied', 'system', $3::jsonb) on conflict do nothing`, [orgId, invoiceId, JSON.stringify(detail)]);

export async function runCloseRule(orgId: string, invoiceId: string): Promise<CloseRuleOutcome> {
  // Step 1, one transaction: read the facts, decide, and for a task create it and record that the rule acted.
  const first = await withSystem(async (db): Promise<{ outcome: CloseRuleOutcome; inv: InvoiceFacts | null; deal: DealFacts | null; rule: string }> => {
    const inv = (await db.query<InvoiceFacts>("select id, number, closes_deal, status, payment_status, contact_id, opportunity_id, company_id, is_test from customer_invoices where id = $1 and org_id = $2", [invoiceId, orgId])).rows[0];
    if (!inv) return { outcome: { decision: { action: "none", reason: "not_fully_paid" }, note: "The invoice was not found." }, inv: null, deal: null, rule: "none" };
    const settings = await readSettings(db, orgId);
    const deal = inv.opportunity_id
      ? (await db.query<DealFacts>("select status, assigned_user_id, name from crm_opportunities where id = $1 and org_id = $2 and archived_at is null", [inv.opportunity_id, orgId])).rows[0] ?? null
      : null;
    const flags = (await db.query<{ manual: boolean; test: boolean; dispute: boolean; applied: boolean }>(
      `select exists (select 1 from customer_payments where invoice_id = $1 and org_id = $2 and status in (${COUNTED_SQL}) and verification = 'manual') as manual,
              exists (select 1 from customer_payments where invoice_id = $1 and org_id = $2 and status in (${COUNTED_SQL}) and livemode = false) as test,
              exists (select 1 from customer_payments where invoice_id = $1 and org_id = $2 and status = 'disputed') as dispute,
              exists (select 1 from customer_invoice_events where invoice_id = $1 and org_id = $2 and kind = 'close_rule_applied') as applied`, [invoiceId, orgId],
    )).rows[0];
    const decision = decideCloseRule({
      rule: settings.closeRule, closesDeal: inv.closes_deal, invoiceStatus: inv.status, paymentStatus: inv.payment_status, hasDispute: flags.dispute, dealStatus: deal?.status ?? null,
      allProviderConfirmed: !flags.manual, countManualAsVerified: settings.countManualAsVerified, alreadyApplied: flags.applied, hasTestPayment: flags.test, isTest: inv.is_test,
    });
    if (decision.action !== "task") return { outcome: { decision }, inv, deal, rule: settings.closeRule };
    const task = await askPerson(db, orgId, inv, deal?.assigned_user_id ?? null, {
      title: `Invoice ${inv.number ?? ""} is paid: mark the deal won?`.replace(/\s+/g, " ").trim(),
      description: `The invoice for the deal "${deal?.name ?? ""}" was paid in full. If the deal is done, mark it won. Nothing was changed automatically.`,
      priority: "normal",
    });
    await recordApplied(db, orgId, invoiceId, { action: "task", taskId: task.id, rule: settings.closeRule });
    return { outcome: { decision, taskId: task.id }, inv, deal, rule: settings.closeRule };
  });
  if (first.outcome.decision.action !== "won" || !first.inv?.opportunity_id) return first.outcome;

  // Step 2, the CRM's own transaction: close the deal. Closing a deal that is already won changes nothing, so a retry after a crash is safe.
  const dealId = first.inv.opportunity_id;
  const outcome: CloseRuleOutcome = { decision: first.outcome.decision };
  try {
    await closeOpportunity(systemActor({ id: orgId }), dealId, "won");
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    // The deal moved on its own (a person closed it as lost, or archived it) between the decision and now: nothing is forced, and a person is asked instead.
    outcome.note = e.message;
    const inv = first.inv;
    const deal = first.deal;
    outcome.taskId = (await withSystem(async (db) => {
      const task = await askPerson(db, orgId, inv, deal?.assigned_user_id ?? null, {
        title: `Invoice ${inv.number ?? ""} is paid, but its deal could not be marked won`.replace(/\s+/g, " ").trim(),
        description: `The invoice was paid in full and the rule asked for the deal to be marked won, but the deal could not be changed (${e.message}). Please look at it.`,
        priority: "normal",
      });
      await recordApplied(db, orgId, invoiceId, { action: "task", taskId: task.id, rule: first.rule, note: "deal_not_closable" });
      return task;
    })).id;
    return outcome;
  }
  await withSystem(async (db) => {
    await recordApplied(db, orgId, invoiceId, { action: "won", dealId, rule: first.rule });
    await recordAudit({ orgId, actorKind: "system", action: "invoice.deal_closed_won", targetType: "customer_invoice", targetId: invoiceId, result: "success", metadata: { dealId, number: first.inv?.number } }, db);
  });
  return outcome;
}

/**
 * A refund recorded after the rule already marked the deal won does not reopen it: a task asks the deal's owner to take another look. Once per refund; does nothing when
 * the rule never acted, or acted only by asking.
 */
export async function runRefundReview(orgId: string, invoiceId: string, refundId: string): Promise<{ taskId: string | null }> {
  return withSystem(async (db) => {
    const won = (await db.query("select 1 from customer_invoice_events where invoice_id = $1 and org_id = $2 and kind = 'close_rule_applied' and detail->>'action' = 'won'", [invoiceId, orgId])).rows[0];
    if (!won) return { taskId: null };
    const done = await db.query("select 1 from customer_invoice_events where invoice_id = $1 and org_id = $2 and kind = 'refund_review_task' and detail->>'refundId' = $3", [invoiceId, orgId, refundId]);
    if (done.rows[0]) return { taskId: null };
    const inv = (await db.query<InvoiceFacts>("select id, number, closes_deal, status, payment_status, contact_id, opportunity_id, company_id, is_test from customer_invoices where id = $1 and org_id = $2", [invoiceId, orgId])).rows[0];
    const refund = (await db.query<{ amount_minor: string }>("select amount_minor::text as amount_minor from customer_refunds where id = $1 and org_id = $2 and status = 'succeeded'", [refundId, orgId])).rows[0];
    if (!inv || !refund) return { taskId: null };
    const deal = inv.opportunity_id ? (await db.query<{ assigned_user_id: string | null }>("select assigned_user_id from crm_opportunities where id = $1 and org_id = $2 and archived_at is null", [inv.opportunity_id, orgId])).rows[0] : undefined;
    const task = await askPerson(db, orgId, inv, deal?.assigned_user_id ?? null, {
      title: `A refund was recorded on invoice ${inv.number ?? ""}: review the deal`.replace(/\s+/g, " ").trim(),
      description: "This invoice closed its deal as won when it was paid. A refund has since been recorded. The deal was not changed; decide whether it still stands.",
      priority: "high",
    });
    await db.query("insert into customer_invoice_events (org_id, invoice_id, kind, actor_kind, detail) values ($1, $2, 'refund_review_task', 'system', $3::jsonb)", [orgId, invoiceId, JSON.stringify({ refundId, taskId: task.id, amountMinor: toMinor(refund.amount_minor) })]);
    return { taskId: task.id };
  });
}
