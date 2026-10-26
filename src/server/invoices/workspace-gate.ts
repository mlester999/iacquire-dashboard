import "server-only";
import type { Queryable } from "@/server/db";
import { env } from "@/server/env";

// Two questions every door a customer can open on an invoice asks first: has the whole customer-facing side been switched off by the platform, and does this workspace take
// customers right now. Neither is about a payment that is already on its way: a provider's report of money that arrived is recorded whatever either says.

/** The platform's emergency switch for everything a customer can reach on an invoice (INVOICES_PUBLIC_DISABLED). It is checked first, before any database read. */
export const invoicesPublicDisabled = (): boolean => env().INVOICES_PUBLIC_DISABLED;

/**
 * A workspace that takes no customers right now: suspended, archived, or paused by iAcquire (a client that has been shut down is). The same reading as the customer's proposal
 * page and the signing requests (src/server/proposals/public.ts, src/server/esign/core.ts), pinned to theirs by a test. A workspace that is not found takes none.
 */
export async function workspaceTakesNoCustomers(db: Queryable, orgId: string): Promise<boolean> {
  const { rows } = await db.query<{ stopped: boolean }>(
    `select (o.status in ('suspended', 'archived') or exists (select 1 from automation_pauses ap join organizations apo on apo.id = ap.org_id
        where ap.active and ap.scope = 'agency' and (ap.org_id = o.id or apo.kind = 'agency'))) as stopped from organizations o where o.id = $1`,
    [orgId],
  );
  return rows[0]?.stopped ?? true;
}
