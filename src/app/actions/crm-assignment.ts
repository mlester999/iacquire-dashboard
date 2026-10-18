"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import {
  createAssignmentRule, deleteAssignmentRule, listAssignmentHistory, moveAssignmentRule, setAssignmentRuleActive, updateAssignmentRule,
  ASSIGNMENT_ENTITIES, ASSIGNMENT_STRATEGIES, MAX_RULE_MEMBERS,
} from "@/server/crm/assignment";
import type { Permission } from "@/lib/permissions";

// Server actions for Settings → Lead Assignment (/crm/settings/assignment and the agency's view of it). Every rule lives in the service;
// these only parse input, resolve who is acting and refresh the screens.

const uuid = z.string().uuid();
const orgArg = z.string().uuid().nullable().optional();

function refresh(actor: CrmActor) {
  revalidatePath("/crm", "layout");
  if (actor.kind === "agency") revalidatePath(`/admin/clients/${actor.orgId}/crm`, "layout");
}

async function act<T>(orgId: string | null | undefined, permission: Permission, fn: (actor: CrmActor) => Promise<T>, opts: { refresh?: boolean } = {}) {
  return guard(async () => {
    const actor = await resolveCrmActor(orgArg.parse(orgId) ?? null, permission);
    const out = await fn(actor);
    if (opts.refresh !== false) refresh(actor);
    return out;
  });
}

const entity = z.enum(ASSIGNMENT_ENTITIES as unknown as ["contact", "opportunity"]);
const ruleSchema = z.object({
  name: z.string().max(200),
  entity,
  conditions: z.unknown().optional(),
  strategy: z.enum(ASSIGNMENT_STRATEGIES as unknown as ["round_robin", "weighted", "priority", "keep_existing_owner"]),
  respectWorkingHours: z.boolean().optional(),
  fallback: z.enum(["unassigned", "fallback_user"]).optional(),
  fallbackUserId: uuid.nullable().optional(),
  reassignOwned: z.boolean().optional(),
  active: z.boolean().optional(),
  members: z
    .array(z.object({ userId: uuid, weight: z.number().int().optional(), priority: z.number().int().optional(), paused: z.boolean().optional() }))
    .max(MAX_RULE_MEMBERS, `A rule can have at most ${MAX_RULE_MEMBERS} members.`)
    .optional(),
});

export async function createAssignmentRuleAction(orgId: string | null, input: z.input<typeof ruleSchema>) {
  return act(orgId, "contacts.assign", (actor) => createAssignmentRule(actor, ruleSchema.parse(input)));
}

export async function updateAssignmentRuleAction(orgId: string | null, id: string, input: z.input<typeof ruleSchema>) {
  return act(orgId, "contacts.assign", (actor) => updateAssignmentRule(actor, uuid.parse(id), ruleSchema.parse(input)));
}

export async function setAssignmentRuleActiveAction(orgId: string | null, id: string, active: boolean) {
  return act(orgId, "contacts.assign", (actor) => setAssignmentRuleActive(actor, uuid.parse(id), z.boolean().parse(active)));
}

export async function moveAssignmentRuleAction(orgId: string | null, id: string, direction: "up" | "down") {
  return act(orgId, "contacts.assign", (actor) => moveAssignmentRule(actor, uuid.parse(id), z.enum(["up", "down"]).parse(direction)));
}

export async function deleteAssignmentRuleAction(orgId: string | null, id: string) {
  return act(orgId, "contacts.assign", (actor) => deleteAssignmentRule(actor, uuid.parse(id)));
}

export async function assignmentHistoryAction(orgId: string | null, recordEntity: "contact" | "opportunity", recordId: string) {
  return act(orgId, "contacts.view", (actor) => listAssignmentHistory(actor, { entity: entity.parse(recordEntity), entityId: uuid.parse(recordId), limit: 100 }), { refresh: false });
}
