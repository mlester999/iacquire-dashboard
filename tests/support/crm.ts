// Synthetic fixtures for the Native CRM tests. Nothing here contacts a provider.
import { withSystem } from "@/server/db";
import { memberActor, systemActor, type CrmActor } from "@/server/crm/actor";
import type { OrgRole } from "@/lib/permissions";
import { addMember, agencyUser, createOrg, createUser, ctxFor, uid } from "./fixtures";

export type CrmPerson = { id: string; email: string };
export const CRM_ROLES = { owner: "owner", manager: "admin", sales: "sales_rep", setter: "appointment_setter", support: "support", viewer: "viewer" } as const satisfies Record<string, OrgRole>;
export type CrmWho = keyof typeof CRM_ROLES;

export interface CrmOrg {
  org: Awaited<ReturnType<typeof createOrg>>;
  people: Record<CrmWho, CrmPerson>;
  actor: (who: CrmWho) => CrmActor;
  system: CrmActor;
}

/** A client workspace on iAcquire Native CRM with one person in every client role. */
export async function crmOrg(opts: { name?: string; timezone?: string } = {}): Promise<CrmOrg> {
  const org = await createOrg({ name: opts.name ?? `CRM ${uid()}` });
  const people = {} as Record<CrmWho, CrmPerson>;
  for (const who of Object.keys(CRM_ROLES) as CrmWho[]) {
    people[who] = await createUser({ name: `${who[0].toUpperCase()}${who.slice(1)} Person` });
    await addMember(org.id, people[who].id, CRM_ROLES[who]);
  }
  if (opts.timezone) await withSystem((db) => db.query("update organizations set timezone = $2 where id = $1", [org.id, opts.timezone]));
  const tz = opts.timezone ?? "UTC";
  return {
    org,
    people,
    actor: (who) => {
      const ctx = ctxFor(people[who], org, CRM_ROLES[who]);
      ctx.org.timezone = tz;
      return memberActor(ctx);
    },
    system: systemActor({ id: org.id, name: org.name, timezone: tz }),
  };
}

export async function agencyPeople() {
  const superUser = await createUser({ platformRole: "agency_super_admin", name: "Agency Admin" });
  const staffUser = await createUser({ platformRole: "agency_staff", name: "Agency Staff" });
  return { superAdmin: agencyUser(superUser, "agency_super_admin"), staff: agencyUser(staffUser, "agency_staff") };
}

export async function eventsFor(orgId: string, type?: string) {
  const { rows } = await withSystem((db) =>
    db.query<{ type: string; entity_id: string | null; contact_id: string | null; payload: Record<string, unknown>; depth: number }>(
      "select type, entity_id, contact_id, payload, depth from crm_events where org_id = $1 and ($2::text is null or type = $2) order by id",
      [orgId, type ?? null],
    ),
  );
  return rows;
}
