"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import { createApiKey, revokeApiKey } from "@/server/crm/api-keys";
import {
  createWebhookSubscription, deleteWebhookSubscription, listWebhookDeliveries, redeliverWebhook, rotateWebhookSecret, sendTestWebhook, setWebhookSubscriptionActive,
  updateWebhookSubscription,
} from "@/server/crm/webhooks";

// Server actions for CRM Settings → API & Webhooks (/crm/settings/api). Everything needs crm.api.manage, and the services also require a
// person in the client's own workspace: agency support sessions can't create keys or webhooks. Secrets are returned once, at creation.

const orgArg = z.string().uuid().nullable().optional();
const uuid = z.string().uuid();

async function act<T>(orgId: string | null | undefined, fn: (actor: CrmActor) => Promise<T>, opts: { refresh?: boolean } = {}) {
  return guard(async () => {
    const actor = await resolveCrmActor(orgArg.parse(orgId) ?? null, "crm.api.manage");
    const out = await fn(actor);
    if (opts.refresh !== false) revalidatePath("/crm/settings/api");
    return out;
  });
}

const keyInput = z.object({
  name: z.string().max(200),
  scopes: z.array(z.string().max(40)).max(20),
  expiresInDays: z.number().int().nullable().optional(),
});

export async function createApiKeyAction(orgId: string | null, input: z.input<typeof keyInput>) {
  return act(orgId, (actor) => createApiKey(actor, keyInput.parse(input)));
}

export async function revokeApiKeyAction(orgId: string | null, id: string) {
  return act(orgId, (actor) => revokeApiKey(actor, uuid.parse(id)));
}

const webhookInput = z.object({ name: z.string().max(200), url: z.string().max(600), eventTypes: z.array(z.string().max(60)).max(60) });

export async function createWebhookAction(orgId: string | null, input: z.input<typeof webhookInput>) {
  return act(orgId, (actor) => createWebhookSubscription(actor, webhookInput.parse(input)));
}

export async function updateWebhookAction(orgId: string | null, id: string, input: z.input<typeof webhookInput>) {
  return act(orgId, (actor) => updateWebhookSubscription(actor, uuid.parse(id), webhookInput.parse(input)));
}

export async function setWebhookActiveAction(orgId: string | null, id: string, active: boolean) {
  return act(orgId, (actor) => setWebhookSubscriptionActive(actor, uuid.parse(id), z.boolean().parse(active)));
}

export async function deleteWebhookAction(orgId: string | null, id: string) {
  return act(orgId, (actor) => deleteWebhookSubscription(actor, uuid.parse(id)));
}

export async function rotateWebhookSecretAction(orgId: string | null, id: string) {
  return act(orgId, (actor) => rotateWebhookSecret(actor, uuid.parse(id)));
}

export async function sendTestWebhookAction(orgId: string | null, id: string) {
  return act(orgId, (actor) => sendTestWebhook(actor, uuid.parse(id)));
}

export async function redeliverWebhookAction(orgId: string | null, deliveryId: string) {
  return act(orgId, (actor) => redeliverWebhook(actor, uuid.parse(deliveryId)));
}

export async function listWebhookDeliveriesAction(orgId: string | null, subscriptionId: string, opts: { filter?: "all" | "failed" | "delivered"; cursor?: string | null } = {}) {
  const parsed = z.object({ filter: z.enum(["all", "failed", "delivered"]).optional(), cursor: z.string().max(120).nullable().optional() }).parse(opts);
  return act(orgId, (actor) => listWebhookDeliveries(actor, uuid.parse(subscriptionId), { ...parsed, limit: 25 }), { refresh: false });
}
