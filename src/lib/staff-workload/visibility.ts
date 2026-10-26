// Who sees what in the workload module. Pure, and the one place the rules are written, so a screen, a service and a test all ask the same function.
//
//   * A label is for the person it describes and for holders of the team permission. Never a client, never a peer.
//   * Time off: the person sees their own in full; a manager (the manage permission) sees anyone's in full; a holder of the team permission only sees that someone is away,
//     never the kind or the note (a sick day is nobody else's business).
//   * Capacity, working days and skills: the person sees their own; the team permission sees everyone's. Only the manage permission changes them (skills are the managers' to
//     record, not the person's).
//   * An item's details (its title, its client) are shown to a viewer only for a client they can open and only if they hold the permission to read that kind of work. Work
//     for any other client still counts in the person's points and labels, and is shown to this viewer only as a count.

import { READ_PERMISSIONS, type WorkItem } from "@/lib/staff-workload/sources";

export interface WorkloadCaps {
  view: boolean;
  team: boolean;
  assign: boolean;
  manage: boolean;
  settings: boolean;
}

export const NO_CAPS: WorkloadCaps = { view: false, team: false, assign: false, manage: false, settings: false };

/** The permission each capability stands for. */
export const CAP_PERMISSIONS: Record<keyof WorkloadCaps, string> = {
  view: "agency.workload.view",
  team: "agency.workload.team",
  assign: "agency.workload.assign",
  manage: "agency.workload.manage",
  settings: "agency.workload.settings",
};

export const capsFrom = (held: (permission: string) => boolean): WorkloadCaps => ({
  view: held(CAP_PERMISSIONS.view),
  team: held(CAP_PERMISSIONS.team),
  assign: held(CAP_PERMISSIONS.assign),
  manage: held(CAP_PERMISSIONS.manage),
  settings: held(CAP_PERMISSIONS.settings),
});

export interface Viewer {
  userId: string;
  caps: WorkloadCaps;
}

/** The person's own label, or anyone's for the team permission. Nothing at all without the view permission. */
export const canSeeLabelOf = (viewer: Viewer, subjectId: string): boolean => viewer.caps.view && (viewer.userId === subjectId || viewer.caps.team);

/** The kind and note of time off: the person's own, or anyone's for the manage permission. */
export const canSeeTimeOffDetail = (viewer: Viewer, subjectId: string): boolean => viewer.caps.view && (viewer.userId === subjectId || viewer.caps.manage);

/** Whether someone is away: the person themself, or the team permission. */
export const canSeeAway = (viewer: Viewer, subjectId: string): boolean => viewer.caps.view && (viewer.userId === subjectId || viewer.caps.team || viewer.caps.manage);

/** Capacity, working days and skills. */
export const canSeeProfileOf = (viewer: Viewer, subjectId: string): boolean => viewer.caps.view && (viewer.userId === subjectId || viewer.caps.team);

/** Changing a profile (capacity, working days, skills) is the manage permission's alone. */
export const canEditProfile = (viewer: Viewer): boolean => viewer.caps.view && viewer.caps.manage;

/** Time off: the person's own, or anyone's for the manage permission. */
export const canEditTimeOff = (viewer: Viewer, subjectId: string): boolean => viewer.caps.view && (viewer.userId === subjectId || viewer.caps.manage);

export interface ItemAccess {
  userId: string;
  /** The client workspaces the viewer can open right now. */
  accessibleOrgs: ReadonlySet<string>;
  /** The permissions the viewer holds right now (only the ones that matter need be listed). */
  permissions: ReadonlySet<string>;
}

/**
 * Whether the viewer may see an item's details. A support request also needs the queue permission unless the request is assigned to the viewer, as in Support itself: a person
 * without it reaches only their own requests.
 */
export function canSeeItem(access: ItemAccess, item: Pick<WorkItem, "source" | "orgId" | "assigneeId">): boolean {
  if (!access.accessibleOrgs.has(item.orgId)) return false;
  if (!READ_PERMISSIONS[item.source].every((p) => access.permissions.has(p))) return false;
  if (item.source === "support" && !access.permissions.has("agency.support.queue") && item.assigneeId !== access.userId) return false;
  return true;
}

/** Items split into those whose details the viewer may see and a count of the rest. */
export function splitVisible<T extends Pick<WorkItem, "source" | "orgId" | "assigneeId">>(items: readonly T[], access: ItemAccess): { visible: T[]; hidden: number } {
  const visible: T[] = [];
  let hidden = 0;
  for (const item of items) {
    if (canSeeItem(access, item)) visible.push(item);
    else hidden += 1;
  }
  return { visible, hidden };
}

/** Every permission name the item checks read, so a service can ask the database once. */
export const ITEM_ACCESS_PERMISSIONS: readonly string[] = [...new Set([...Object.values(READ_PERMISSIONS).flat(), "agency.support.queue"])];
