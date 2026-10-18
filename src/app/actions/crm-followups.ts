"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import { saveFollowUpSettings, stopContactFollowUps } from "@/server/messaging/followups";
import type { Permission } from "@/lib/permissions";

// Server actions for Automation → Follow-up Sequences (/crm/follow-ups). The limits and validation live in the service; these parse input,
// resolve who is acting and refresh the screens (including the inbox, which shows each conversation's follow-up state).

const uuid = z.string().uuid();
const orgArg = z.string().uuid().nullable().optional();

function refresh(actor: CrmActor) {
  revalidatePath("/crm", "layout");
  revalidatePath("/inbox");
  revalidatePath("/settings/messaging");
  if (actor.kind === "agency") revalidatePath(`/admin/clients/${actor.orgId}/crm`, "layout");
}

async function act<T>(orgId: string | null | undefined, permission: Permission, fn: (actor: CrmActor) => Promise<T>) {
  return guard(async () => {
    const actor = await resolveCrmActor(orgArg.parse(orgId) ?? null, permission);
    const out = await fn(actor);
    refresh(actor);
    return out;
  });
}

const settingsSchema = z.object({
  preset: z.enum(["off", "gentle", "balanced", "persistent", "custom"], { error: "Choose a follow-up style." }),
  custom: z
    .object({
      attempts: z.number().int(),
      daysBetween: z.array(z.number().int()).max(20),
      channel: z.enum(["same", "sms", "whatsapp", "email"]),
      businessHoursOnly: z.boolean(),
    })
    .nullable()
    .optional(),
});

export async function saveFollowUpSettingsAction(orgId: string | null, input: z.input<typeof settingsSchema>) {
  return act(orgId, "messaging.configure", (actor) => saveFollowUpSettings(actor, settingsSchema.parse(input)));
}

export async function stopContactFollowUpsAction(orgId: string | null, contactId: string) {
  return act(orgId, "messaging.configure", (actor) => stopContactFollowUps(actor, uuid.parse(contactId)));
}
