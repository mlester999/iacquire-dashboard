import "server-only";
import { withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { PROVISIONING_PAYMENT_NOTE, isSetupCleared } from "@/lib/billing-clearance";

/**
 * The setup payment, as the rest of the server asks about it. One definition (the SQL function app.setup_payment_cleared: paid or waived) answers every gate, so
 * provisioning, activation, the maintenance plan and the employee readiness text cannot disagree. A status is cleared only by a verified payment (a provider's signed
 * webhook, or a Super Admin's recorded payment with its reference) or by an audited waiver with a reason: see src/server/billing/manual.ts.
 *
 * Core CRM, the inbox, the six employees' chat, the website, booking and social text posts are NEVER gated here. The gate sits only where iAcquire spends money for the
 * client (an AI employee profile, activation) or starts the second paid product (the maintenance plan). A full setup refund stops new provisioning; it never pauses a
 * workspace that is already running.
 *
 * This file stays free of the provisioning and notification code on purpose: the setup, onboarding and maintenance services import it, and what follows a clearing
 * event (src/server/billing/after-clearing.ts) imports them.
 */

/** True when the workspace's setup fee is paid or waived. Trusted server code (no signed-in user) may ask about any workspace. */
export async function isSetupPaymentCleared(db: Queryable, orgId: string): Promise<boolean> {
  const { rows } = await db.query<{ cleared: boolean }>("select app.setup_payment_cleared($1) as cleared", [orgId]);
  return rows[0]?.cleared === true;
}

/**
 * The same yes or no, asked as a signed-in member of the workspace through row-level security (the screens that show an AI employee's readiness use it). A person who
 * cannot access the workspace gets false, never another client's payment status.
 */
export async function isSetupPaymentClearedFor(userId: string, orgId: string): Promise<boolean> {
  return withUser(userId, (db) => isSetupPaymentCleared(db, orgId));
}

/** Throws a plain refusal when the setup payment is not confirmed. */
export async function assertSetupPaymentCleared(db: Queryable, orgId: string, message: string = PROVISIONING_PAYMENT_NOTE): Promise<void> {
  if (!(await isSetupPaymentCleared(db, orgId))) throw new AppError("conflict", message);
}

/**
 * Marks the setup fee paid against a verified setup payment, in the caller's transaction. Does nothing when the fee is already paid or waived: a second payment is a
 * duplicate for a person to refund, never a second clearing. Returns whether this payment is the one that cleared it. The database refuses a "paid" status that does
 * not name a verified setup payment of this workspace (migration 0099), so this is the only way the status can become "paid".
 */
export async function markSetupFeePaid(db: Queryable, o: { orgId: string; paymentId: string; updatedBy: string | null }): Promise<{ first: boolean; previous: string }> {
  const cur = (await db.query<{ setup_payment_status: string }>("select setup_payment_status from billing_accounts where org_id = $1 for update", [o.orgId])).rows[0];
  if (!cur) throw new AppError("not_found", "Billing account not found.");
  if (isSetupCleared(cur.setup_payment_status)) return { first: false, previous: cur.setup_payment_status };
  await db.query(
    `update billing_accounts set setup_payment_status = 'paid', paid_at = now(), verified_payment_id = $2, waiver_reason = null, waived_by = null, waived_at = null,
       updated_by = $3, updated_at = now() where org_id = $1`,
    [o.orgId, o.paymentId, o.updatedBy],
  );
  return { first: true, previous: cur.setup_payment_status };
}

/** Waives the setup fee with a recorded reason, in the caller's transaction. Does nothing when the fee is already cleared. */
export async function markSetupFeeWaived(db: Queryable, o: { orgId: string; reason: string; waivedBy: string }): Promise<{ first: boolean; previous: string }> {
  const cur = (await db.query<{ setup_payment_status: string }>("select setup_payment_status from billing_accounts where org_id = $1 for update", [o.orgId])).rows[0];
  if (!cur) throw new AppError("not_found", "Billing account not found.");
  if (isSetupCleared(cur.setup_payment_status)) return { first: false, previous: cur.setup_payment_status };
  await db.query(
    `update billing_accounts set setup_payment_status = 'waived', waiver_reason = $2, waived_by = $3, waived_at = now(), verified_payment_id = null,
       updated_by = $3, updated_at = now() where org_id = $1`,
    [o.orgId, o.reason, o.waivedBy],
  );
  return { first: true, previous: cur.setup_payment_status };
}
