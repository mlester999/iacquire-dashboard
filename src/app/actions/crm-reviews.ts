"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import {
  cancelReviewRequest, createReviewDestination, deleteReviewDestination, moveReviewDestination, previewReviewRequest, requestReview, setFeedbackFollowUp,
  setReviewDestinationActive, updateReviewDestination,
} from "@/server/crm/reviews";
import type { Permission } from "@/lib/permissions";

// Server actions for CRM → Reviews (/crm/reviews). Validation and every rule live in src/server/crm/reviews.ts; these parse input,
// resolve who is acting and refresh the screens.

const uuid = z.string().uuid({ error: "Choose an item from the list." });
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

const destinationSchema = z.object({
  platform: z.string().max(20),
  label: z.string().max(200).nullable().optional(),
  url: z.string().max(600, { error: "That link is too long." }),
});

export async function createReviewDestinationAction(orgId: string | null, input: z.input<typeof destinationSchema>) {
  return act(orgId, "reviews.manage", (actor) => createReviewDestination(actor, destinationSchema.parse(input)));
}

export async function updateReviewDestinationAction(orgId: string | null, id: string, input: z.input<typeof destinationSchema>) {
  return act(orgId, "reviews.manage", (actor) => updateReviewDestination(actor, uuid.parse(id), destinationSchema.parse(input)));
}

export async function setReviewDestinationActiveAction(orgId: string | null, id: string, active: boolean) {
  return act(orgId, "reviews.manage", (actor) => setReviewDestinationActive(actor, uuid.parse(id), z.boolean().parse(active)));
}

export async function moveReviewDestinationAction(orgId: string | null, id: string, direction: "up" | "down") {
  return act(orgId, "reviews.manage", (actor) => moveReviewDestination(actor, uuid.parse(id), z.enum(["up", "down"]).parse(direction)));
}

export async function deleteReviewDestinationAction(orgId: string | null, id: string) {
  return act(orgId, "reviews.manage", (actor) => deleteReviewDestination(actor, uuid.parse(id)));
}

const requestSchema = z.object({
  contactId: uuid,
  templateId: uuid,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, { error: "Choose an approved template." }),
  businessHoursOnly: z.boolean().optional(),
});

export async function previewReviewRequestAction(orgId: string | null, input: { contactId: string; templateId: string }) {
  return act(orgId, "reviews.manage", (actor) => previewReviewRequest(actor, { contactId: uuid.parse(input.contactId), templateId: uuid.parse(input.templateId) }), { refresh: false });
}

export async function requestReviewAction(orgId: string | null, input: z.input<typeof requestSchema>) {
  return act(orgId, "reviews.manage", (actor) => requestReview(actor, requestSchema.parse(input)));
}

export async function cancelReviewRequestAction(orgId: string | null, id: string) {
  return act(orgId, "reviews.manage", (actor) => cancelReviewRequest(actor, uuid.parse(id)));
}

export async function setFeedbackFollowUpAction(orgId: string | null, id: string, status: "new" | "acknowledged" | "resolved") {
  return act(orgId, "reviews.manage", (actor) => setFeedbackFollowUp(actor, uuid.parse(id), z.enum(["new", "acknowledged", "resolved"]).parse(status)));
}
