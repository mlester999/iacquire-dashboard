import "server-only";
import { withUser } from "@/server/db";
import { loadStaffActor, type StaffUser } from "@/server/staff-messages/access";

export interface DirectoryPerson {
  id: string;
  name: string;
  role: "agency_staff" | "agency_manager" | "agency_super_admin";
  /** True for the person asking. */
  self: boolean;
}

/**
 * The people who can be added to a conversation or messaged: active agency accounts that may use Messages. Row-level security on users hides other staff from an agency
 * person, so this reads through app.staff_directory(), a function that answers only to someone who may use Messages and returns a name and a role, never an address, a status
 * or a last sign-in.
 */
export async function listStaffDirectory(user: StaffUser): Promise<DirectoryPerson[]> {
  const actor = await loadStaffActor(user);
  const { rows } = await withUser(actor.userId, (db) =>
    db.query<{ id: string; name: string; platform_role: DirectoryPerson["role"] }>("select id, name, platform_role from app.staff_directory() order by lower(name), id"),
  );
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.platform_role, self: r.id === actor.userId }));
}
