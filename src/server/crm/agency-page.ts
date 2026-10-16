import "server-only";
import { notFound } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { activeSupportSession, agencyActor, agencyCanAccessClient, type CrmActor } from "@/server/crm/actor";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";

const UUID = /^[0-9a-f-]{36}$/i;

/** The client an agency CRM page is about, after checking the person may work on it. Unknown or unassigned clients are a 404. */
export async function agencyCrmClient(orgId: string) {
  if (!UUID.test(orgId)) notFound();
  const user = await requireAgency();
  if (!(await agencyCanAccessClient(user, orgId))) notFound();
  const { rows } = await withSystem((db) => db.query<{ id: string; name: string }>("select id, name from organizations where id = $1 and kind = 'client'", [orgId]));
  if (!rows[0]) notFound();
  const session = await activeSupportSession(user, orgId);
  return { user, org: rows[0], session };
}

/** The agency actor for a page inside the support-session gate, or null when there is no session (the layout shows the gate instead). */
export async function agencyCrmPageActor(orgId: string): Promise<CrmActor | null> {
  const { user, session } = await agencyCrmClient(orgId);
  if (!session) return null;
  try {
    return await agencyActor(user, orgId);
  } catch (err) {
    if (err instanceof AppError && err.code === "forbidden") return null;
    throw err;
  }
}
