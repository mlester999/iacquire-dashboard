import "server-only";
import type { Queryable } from "@/server/db";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { suggestAssignees, type SuggestionCandidate, type SuggestionList } from "@/lib/staff-workload/suggest";
import { ASSIGN_PERMISSIONS, WORK_SOURCES, type WorkItem, type WorkSource } from "@/lib/staff-workload/sources";
import { canSeeItem } from "@/lib/staff-workload/visibility";
import { isId, requireWorkloadCap, throttle, type StaffUser } from "@/server/staff-workload/access";
import { computeTeam } from "@/server/staff-workload/engine";
import { loadWorkItem } from "@/server/staff-workload/projection";
import { itemAccess, toItemView, type ItemView } from "@/server/staff-workload/view";

// Who could take an item, ranked, with the reasons (src/lib/staff-workload/suggest.ts has the rule). This only reads: a suggestion is applied by a person clicking it, and that
// goes through assign.ts and the module's own assign function. Nothing here is AI, and nothing here is sent to anyone.

const NOT_FOUND = "That item was not found.";

/**
 * The people an item can be given to. ONE rule for every kind of work, asked before any module is: an active agency account that can open the item's client right now and holds
 * every permission that kind of work needs (the modules themselves check different things, and the audit found setup and projects ignore a denied permission).
 */
export async function eligibleAssigneeIds(db: Queryable, source: WorkSource, orgId: string, exceptUserId: string | null = null): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select u.id::text as id from users u
      where u.status = 'active' and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin')
        and app.user_can_access_org(u.id, $1::uuid)
        and not exists (select 1 from unnest($2::text[]) as p(permission) where not coalesce(app.user_has_agency_permission(u.id, p.permission), false))
        and ($3::uuid is null or u.id <> $3::uuid)
      order by u.id`,
    [orgId, [...ASSIGN_PERMISSIONS[source]], exceptUserId],
  );
  return rows.map((r) => r.id);
}

/** Whether this one person could be given the item (the same rule as eligibleAssigneeIds). */
export async function isEligibleAssignee(db: Queryable, source: WorkSource, orgId: string, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `select exists (
       select 1 from users u
        where u.id = $1::uuid and u.status = 'active' and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin')
          and app.user_can_access_org(u.id, $2::uuid)
          and not exists (select 1 from unnest($3::text[]) as p(permission) where not coalesce(app.user_has_agency_permission(u.id, p.permission), false))
     ) as ok`,
    [userId, orgId, [...ASSIGN_PERMISSIONS[source]]],
  );
  return rows[0]?.ok === true;
}

/** When the board last gave each person an item. A person it never gave one to is absent. */
async function lastAssigned(db: Queryable, userIds: readonly string[]): Promise<Map<string, string>> {
  if (!userIds.length) return new Map();
  const { rows } = await db.query<{ to_user: string; at: Date }>(
    "select to_user::text, max(created_at) as at from work_assignment_events where to_user = any($1::uuid[]) group by to_user", [[...userIds]],
  );
  return new Map(rows.map((r) => [r.to_user, new Date(r.at).toISOString()]));
}

export interface SuggestionsFor {
  item: ItemView;
  list: SuggestionList;
}

export const parseItemRef = (source: unknown, itemId: unknown): { source: WorkSource; itemId: string } => {
  if (typeof source !== "string" || !(WORK_SOURCES as readonly string[]).includes(source) || !isId(itemId)) throw new AppError("not_found", NOT_FOUND);
  return { source: source as WorkSource, itemId };
};

/** Up to three people the item could go to, with the reasons. The assign permission only; an item for a client the viewer cannot open reads as not found. */
export async function suggestForItem(user: StaffUser, input: { source: unknown; itemId: unknown }, opts: { now?: Date } = {}): Promise<SuggestionsFor> {
  const actor = await requireWorkloadCap(user, "assign");
  const ref = parseItemRef(input.source, input.itemId);
  await throttle("staffWorkloadReadByUser", user.id);
  return withSystem(async (db) => {
    const item = await loadWorkItem(db, ref.source, ref.itemId);
    if (!item) throw new AppError("not_found", NOT_FOUND);
    // The viewer must be able to see the item to be offered ways to hand it on: the client, and the permission to read that kind of work.
    const access = await itemAccess(db, actor.userId, [item]);
    if (!canSeeItem(access, item)) throw new AppError("not_found", NOT_FOUND);
    const ids = await eligibleAssigneeIds(db, ref.source, item.orgId, item.assigneeId);
    const now = opts.now ?? new Date();
    const team = await computeTeam(db, now, { userIds: ids });
    const last = await lastAssigned(db, ids);
    const candidates: SuggestionCandidate[] = team.people.map((p) => ({
      userId: p.person.userId,
      name: p.person.name,
      skills: p.person.profile.skills,
      personCapacity: p.person.profile.capacityPoints,
      availableHalfDays: Math.round(p.result.availableDays * 2),
      items: p.items,
      lastAssignedAt: last.get(p.person.userId) ?? null,
    }));
    const list = suggestAssignees(item as WorkItem, candidates, team.rules.rules, now, team.today, team.supportTargetsEnabled);
    return { item: toItemView(item, team.rules.rules, team), list };
  });
}
