import "server-only";
import { assertCan, crmRead, type CrmActor } from "@/server/crm/actor";
import { assertProposalsEnabled } from "@/server/proposals/features";

export interface DealChoice {
  id: string;
  name: string;
  contactId: string | null;
  contactName: string | null;
  currency: string | null;
}

/** Open deals of this workspace whose name matches, for the picker on the new-proposal form. A person who cannot see deals gets none. */
export async function searchDealsForProposal(actor: CrmActor, q: string, limit = 10): Promise<DealChoice[]> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.create", "Your role can't write proposals.");
  const term = q.trim().slice(0, 80).replace(/[\\%_]/g, (m) => `\\${m}`);
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{ id: string; name: string; contact_id: string | null; contact_name: string | null; currency: string | null }>(
      `select o.id, o.name, o.contact_id, c.display_name as contact_name, o.currency
       from crm_opportunities o left join contacts c on c.id = o.contact_id and c.org_id = o.org_id
       where o.org_id = $1 and o.provider = 'native' and o.archived_at is null and o.status = 'open' and ($2 = '' or o.name ilike '%' || $2 || '%' escape '\\')
       order by o.updated_at desc limit $3`,
      [actor.orgId, term, Math.min(25, limit)],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, contactId: r.contact_id, contactName: r.contact_name, currency: r.currency }));
  });
}
