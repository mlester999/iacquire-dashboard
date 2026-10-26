import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/service";

// Invoicing is dormant until a Super Admin switches it on for a workspace: org_features, feature "invoices"; no row means off. This is the one entitlement seam in
// front of the module (where invoicing sits relative to the implementation fee and the monthly plan is the founder's decision, and nothing here prices it). When the
// shared feature helper that proposals use is merged, this file is the single place to point at it.
//
// Switching it off hides the screens and refuses new invoice work; it never stops a payment that arrives for an invoice already issued from being recorded, because
// that money was received whatever the switch says.

export const INVOICES_FEATURE = "invoices";
export const INVOICES_NOT_ENABLED_MESSAGE = "Customer invoices are not switched on for this workspace yet. Ask your iAcquire team to enable them.";
export const INVOICES_CLIENT_ONLY_MESSAGE = "Customer invoices belong to a client's own workspace. They are not available in an agency workspace.";

export async function invoicesEnabledIn(db: Queryable, orgId: string): Promise<boolean> {
  const { rows } = await db.query<{ enabled: boolean }>("select enabled from org_features where org_id = $1 and feature = $2", [orgId, INVOICES_FEATURE]);
  return rows[0]?.enabled === true;
}

/** Refuses invoice work in an agency workspace, and in a client workspace nobody switched it on for. Ask before any permission check, so the reason given is the true one. */
export async function assertInvoicesAvailable(db: Queryable, ctx: { org: { orgId: string; kind: "agency" | "client" } }): Promise<void> {
  if (ctx.org.kind !== "client") throw new AppError("forbidden", INVOICES_CLIENT_ONLY_MESSAGE);
  if (!(await invoicesEnabledIn(db, ctx.org.orgId))) throw new AppError("not_enabled", INVOICES_NOT_ENABLED_MESSAGE);
}

/** Whether a workspace has invoicing, for deciding what to show. */
export function invoicesEnabled(orgId: string): Promise<boolean> {
  return withSystem((db) => invoicesEnabledIn(db, orgId));
}

/** A Super Admin switches invoicing on or off for one client workspace. Audited. Nothing is created, sent or charged by switching it on. */
export async function setInvoicesEnabled(user: Pick<SessionUser, "id" | "platformRole">, orgId: string, enabled: boolean): Promise<void> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can switch customer invoices on or off for a workspace.");
  await withSystem(async (db) => {
    const org = (await db.query<{ kind: string; status: string }>("select kind, status from organizations where id = $1", [orgId])).rows[0];
    if (!org) throw new AppError("not_found", "That workspace was not found.");
    if (org.kind !== "client") throw new AppError("invalid_input", INVOICES_CLIENT_ONLY_MESSAGE);
    await db.query(
      `insert into org_features (org_id, feature, enabled, updated_by) values ($1, $2, $3, $4)
       on conflict (org_id, feature) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()`,
      [orgId, INVOICES_FEATURE, enabled, user.id],
    );
    await recordAudit({ orgId, actorUserId: user.id, actorKind: "agency", action: enabled ? "invoices.enabled" : "invoices.disabled", targetType: "organization", targetId: orgId, result: "success" }, db);
  });
}
