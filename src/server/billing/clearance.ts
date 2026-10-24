import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { notifyOrgRoles } from "@/server/notifications";
import { PROVISIONING_PAYMENT_NOTE, isSetupCleared } from "@/lib/billing-clearance";
import { requestProvisioning } from "@/server/workforce/provisioning";

/**
 * The setup payment, as the rest of the server asks about it. One definition (the SQL function app.setup_payment_cleared: paid or waived) answers every gate, so
 * provisioning, activation, the maintenance plan and the employee readiness text cannot disagree. A status is cleared only by a verified payment (a provider's signed
 * webhook, or a Super Admin's recorded payment with its reference) or by an audited waiver with a reason: see src/server/billing/manual.ts.
 *
 * Core CRM, the inbox, the six employees' chat, the website, booking and social text posts are NEVER gated here. The gate sits only where iAcquire spends money for the
 * client (an AI employee profile, activation) or starts the second paid product (the maintenance plan). A full setup refund stops new provisioning; it never pauses a
 * workspace that is already running.
 */

/** True when the workspace's setup fee is paid or waived. Trusted server code (no signed-in user) may ask about any workspace. */
export async function isSetupPaymentCleared(db: Queryable, orgId: string): Promise<boolean> {
  const { rows } = await db.query<{ cleared: boolean }>("select app.setup_payment_cleared($1) as cleared", [orgId]);
  return rows[0]?.cleared === true;
}

/** Throws a plain refusal when the setup payment is not confirmed. */
export async function assertSetupPaymentCleared(db: Queryable, orgId: string, message: string = PROVISIONING_PAYMENT_NOTE): Promise<void> {
  if (!(await isSetupPaymentCleared(db, orgId))) throw new AppError("conflict", message);
}

/**
 * Marks the setup fee paid against a verified setup payment, in the caller's transaction. Does nothing when the fee is already paid or waived: a second payment is a
 * duplicate for a person to refund, never a second clearing. Returns whether this payment is the one that cleared it.
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

/**
 * What follows any event that cleared the setup fee: the AI employees' provisioning requests are opened (idempotent, and still subject to every other condition:
 * onboarding finished, a verified owner, an active workspace) and the owners are told. Returns how many requests were opened.
 */
export async function afterSetupCleared(db: Queryable, orgId: string, o: { actorUserId: string | null; how: "payment" | "waiver"; eventKey: string }): Promise<{ provisioningRequested: number }> {
  const provisioningRequested = await requestProvisioning(db, orgId, o.actorUserId);
  await notifyOrgRoles(db, orgId, ["owner", "admin"], {
    kind: "billing_setup_cleared",
    severity: "success",
    title: o.how === "payment" ? "Your setup payment is confirmed" : "Your setup fee has been waived",
    body: "Your AI team can now be set up. iAcquire will tell you as each employee is ready.",
    link: "/employees",
    dedupeKey: `setup-cleared:${o.eventKey}`,
  });
  return { provisioningRequested };
}
