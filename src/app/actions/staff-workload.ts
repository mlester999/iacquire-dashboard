"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { assignWorkItem } from "@/server/staff-workload/assign";
import { addTimeOff, removeTimeOff, updateProfile } from "@/server/staff-workload/profile";
import { setStaffWorkloadEnabled } from "@/server/staff-workload/settings";
import { suggestForItem } from "@/server/staff-workload/suggestions";
import { WORK_SOURCES } from "@/lib/staff-workload/sources";
import { TIME_OFF_KINDS } from "@/lib/staff-workload/time-off";

// Server actions for Staff workload (/admin/workload). Every one starts from the signed-in agency account and hands off to a service that reads the person's standing, the
// agency workspace and the module switch from the database for this exact request. The client sends an item reference and a person id; nothing else is trusted.

const uuid = z.string({ error: "That item was not found." }).uuid({ error: "That item was not found." });
const item = z.object({ source: z.enum(WORK_SOURCES), itemId: uuid });
const assign = item.extend({
  assigneeId: uuid.nullable(),
  expectedAssigneeId: uuid.nullable().optional(),
  via: z.enum(["board", "suggestion"]).optional(),
});

type AgencySession = Awaited<ReturnType<typeof requireAgencyOrThrow>>;

async function act<T>(fn: (session: AgencySession) => Promise<T>) {
  return guard(async () => fn(await requireAgencyOrThrow()));
}

/** The three people who could take an item, with the reasons, for the assign dialog. Read only. */
export async function suggestWorkloadAssigneeAction(input: z.input<typeof item>) {
  return act((session) => suggestForItem({ id: session.id, platformRole: session.platformRole }, item.parse(input)));
}

/** Gives the item to the chosen person through the module that owns it, after the common eligibility and stale-board checks. */
export async function assignWorkloadItemAction(input: z.input<typeof assign>) {
  return act(async (session) => {
    const parsed = assign.parse(input);
    const result = await assignWorkItem(session, parsed);
    revalidatePath("/admin/workload");
    revalidatePath("/admin/workload/board");
    return result;
  });
}

/** A Super Admin switches the module on or off for the agency workspace. Nothing is connected and nothing is sent. */
export async function setStaffWorkloadEnabledAction(enabled: boolean) {
  return act(async (session) => {
    await setStaffWorkloadEnabled({ id: session.id, platformRole: session.platformRole }, z.boolean().parse(enabled));
    revalidatePath("/admin/workload");
    revalidatePath("/admin/workload/settings");
    return { enabled };
  });
}

/** The form entry point for the off screen and the settings page: a failure is shown by the action's error boundary, not silently swallowed. */
export async function enableStaffWorkloadFormAction(): Promise<void> {
  const result = await setStaffWorkloadEnabledAction(true);
  if (!result.ok) throw new Error(result.error);
}

export async function disableStaffWorkloadFormAction(): Promise<void> {
  const result = await setStaffWorkloadEnabledAction(false);
  if (!result.ok) throw new Error(result.error);
}

const skillLevel = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const profile = z.object({
  userId: uuid,
  expectedRevision: z.number({ error: "Reload the page and try again." }).int().min(0),
  capacityPoints: z.number({ error: "Capacity must be a number." }).int().min(1, { error: "Capacity must be between 1 and 200 points." }).max(200, { error: "Capacity must be between 1 and 200 points." }).nullable().optional(),
  workingDays: z.array(z.number().int().min(1).max(7)).min(1, { error: "Choose at least one working day." }).max(7).optional(),
  skills: z.record(z.string(), skillLevel).optional(),
});

/** A manager changes capacity, working days and skills. `expectedRevision` makes a stale form a refusal, not an overwrite. */
export async function updateWorkloadProfileAction(input: z.input<typeof profile>) {
  return act(async (session) => {
    const parsed = profile.parse(input);
    const result = await updateProfile({ id: session.id, platformRole: session.platformRole }, parsed.userId, {
      capacityPoints: parsed.capacityPoints,
      workingDays: parsed.workingDays,
      skills: parsed.skills,
    }, parsed.expectedRevision);
    revalidatePath(`/admin/workload/people/${parsed.userId}`);
    revalidatePath(`/admin/workload/people/${parsed.userId}/edit`);
    revalidatePath("/admin/workload");
    return result;
  });
}

const timeOff = z.object({
  userId: uuid.optional(),
  startsOn: z.string({ error: "Choose the first day." }).regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Choose the first day." }),
  endsOn: z.string({ error: "Choose the last day." }).regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Choose the last day." }),
  partDay: z.boolean().optional(),
  kind: z.enum(TIME_OFF_KINDS).optional(),
  note: z.string().max(1000).optional(),
});

/** Time off for the person themself, or for someone else with the manage permission; the service checks the calendar rules. */
export async function addWorkloadTimeOffAction(input: z.input<typeof timeOff>) {
  return act(async (session) => {
    const parsed = timeOff.parse(input);
    const result = await addTimeOff({ id: session.id, platformRole: session.platformRole }, parsed);
    revalidatePath("/admin/workload");
    revalidatePath("/admin/workload/me");
    if (parsed.userId) {
      revalidatePath(`/admin/workload/people/${parsed.userId}`);
      revalidatePath(`/admin/workload/people/${parsed.userId}/edit`);
    }
    return result;
  });
}

export async function removeWorkloadTimeOffAction(id: string) {
  return act(async (session) => {
    const result = await removeTimeOff({ id: session.id, platformRole: session.platformRole }, uuid.parse(id));
    revalidatePath("/admin/workload");
    revalidatePath("/admin/workload/me");
    return result;
  });
}
