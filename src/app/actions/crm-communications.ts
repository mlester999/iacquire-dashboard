"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { AppError } from "@/server/errors";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import { requireAgencyOrgAccessOrThrow, requireOrgContextOrThrow } from "@/server/tenancy/context";
import { createTicket } from "@/server/support/service";
import { addTestDestination, removeTestDestination } from "@/server/crm/message-templates";
import { configureNativeChannel, disableChannel, enableChannel, runChannelCapabilityTest, switchChannelToGhl } from "@/server/messaging/channels";
import { parseResendSecret } from "@/server/messaging/transports/resend";
import { twilioSecretJson } from "@/server/messaging/transports/twilio";
import { metaWhatsappSecretJson } from "@/server/messaging/transports/meta-whatsapp";
import { CHANNEL_LABELS, CHANNELS } from "@/lib/messaging";
import type { Permission } from "@/lib/permissions";

// Server actions for communications:
//  * the client's Communication Settings (/crm/settings/communications): approved test destinations and asking iAcquire to set a channel up;
//  * the agency's per-client channel setup (/admin/clients/[id]/communications): provider credentials, sender, capability test, on/off and
//    moving back to GoHighLevel. The channel services enforce that only agency super admins store credentials or switch channels; secrets
//    typed here go straight to the credential vault and are never returned.

const orgArg = z.string().uuid().nullable().optional();

function refresh(actor: CrmActor) {
  revalidatePath("/crm", "layout");
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

const destinationSchema = z.object({
  channel: z.enum(CHANNELS),
  address: z.string().trim().min(3, "Enter the address.").max(320),
  label: z.string().max(80).optional(),
  confirmOwnAddress: z.boolean(),
});

export async function addTestDestinationAction(orgId: string | null, input: z.input<typeof destinationSchema>) {
  return act(orgId, "messaging.configure", (actor) => addTestDestination(actor, destinationSchema.parse(input)));
}

export async function removeTestDestinationAction(orgId: string | null, input: { channel: string; address: string }) {
  const parsed = z.object({ channel: z.enum(CHANNELS), address: z.string().min(1).max(320) }).parse(input);
  return act(orgId, "messaging.configure", (actor) => removeTestDestination(actor, parsed));
}

/**
 * Asks iAcquire to connect (or fix) a channel: a support request the agency is notified about, written so the team knows exactly what is
 * wanted. Only someone in the client's own workspace who configures messaging can ask.
 */
export async function requestChannelSetupAction(input: { channel: string; note?: string }) {
  return guard(async () => {
    const parsed = z.object({ channel: z.enum(CHANNELS), note: z.string().trim().max(1500).optional() }).parse(input);
    const ctx = await requireOrgContextOrThrow("messaging.configure");
    if (!ctx.can("support.use")) throw new AppError("forbidden", "Your role can't open support requests.");
    const label = CHANNEL_LABELS[parsed.channel];
    const message = [
      `Please set up ${label} for our inbox (or check why it isn't working).`,
      parsed.note ? `\nDetails from ${ctx.user.fullName || ctx.user.email}:\n${parsed.note}` : "",
      "\nSent from Communication Settings in the CRM.",
    ].join("\n");
    const t = await createTicket(ctx, { subject: `Set up ${label} messaging`, message, category: "integrations", priority: "normal", pageContext: "/crm/settings/communications" });
    revalidatePath("/crm/settings/communications");
    return { ref: t.ref };
  });
}

// ---------------------------------------------------------------------------
// Agency channel setup
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();
const secretText = z.string().max(4096).optional().nullable();

const setupSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("resend"),
    apiKey: secretText,
    senderIdentity: z.string().max(200),
    senderId: z.string().max(200),
    inboundAddress: z.string().max(320).optional().nullable(),
    replaceLiveChannel: z.boolean().optional(),
  }),
  z.object({
    provider: z.literal("twilio"),
    accountId: z.string().max(64),
    authToken: secretText,
    apiKeySid: z.string().max(64).optional().nullable(),
    apiKeySecret: secretText,
    senderIdentity: z.string().max(200),
    senderId: z.string().max(200),
    replaceLiveChannel: z.boolean().optional(),
  }),
  z.object({
    provider: z.literal("meta_whatsapp"),
    accessToken: secretText,
    accountId: z.string().max(64),
    senderIdentity: z.string().max(200),
    senderId: z.string().max(200),
    replaceLiveChannel: z.boolean().optional(),
  }),
]);

export type ChannelSetupInput = z.input<typeof setupSchema>;

const CHANNEL_FOR = { resend: "email", twilio: "sms", meta_whatsapp: "whatsapp" } as const;

function refreshClient(orgId: string) {
  revalidatePath(`/admin/clients/${orgId}/communications`);
  revalidatePath(`/admin/clients/${orgId}/crm`, "layout");
  revalidatePath("/crm", "layout");
}

/**
 * Builds the vault secret from what the admin typed, with each provider's own validation (user-safe messages that never contain the value).
 * Blank secret fields keep the stored credential: credentials are replace-only and never shown again.
 */
function secretFor(input: z.output<typeof setupSchema>): string | null {
  if (input.provider === "resend") {
    const key = input.apiKey?.trim();
    if (!key) return null;
    if (!parseResendSecret(key)) throw new AppError("invalid_input", "That doesn't look like a Resend API key. They start with re_.");
    return key;
  }
  if (input.provider === "twilio") {
    const token = input.authToken?.trim();
    if (!token) {
      if (input.apiKeySecret?.trim()) throw new AppError("invalid_input", "Enter the account's Auth Token as well: the stored credential is replaced as a whole.");
      return null;
    }
    return twilioSecretJson({ accountSid: input.accountId, authToken: token, apiKeySid: input.apiKeySid, apiKeySecret: input.apiKeySecret });
  }
  const token = input.accessToken?.trim();
  return token ? metaWhatsappSecretJson({ accessToken: token }) : null;
}

/** Stores a provider credential (when one is typed) and the sender for one channel. The channel stays off and untested until the next steps. */
export async function configureChannelAction(orgId: string, input: ChannelSetupInput) {
  return guard(async () => {
    const id = uuid.parse(orgId);
    const user = await requireAgencyOrgAccessOrThrow(id, "super_admin");
    const parsed = setupSchema.parse(input);
    const status = await configureNativeChannel(user, id, {
      channel: CHANNEL_FOR[parsed.provider],
      provider: parsed.provider,
      secret: secretFor(parsed),
      senderIdentity: parsed.senderIdentity,
      senderId: parsed.senderId,
      accountId: parsed.provider === "resend" ? null : parsed.accountId,
      inboundAddress: parsed.provider === "resend" ? parsed.inboundAddress ?? null : null,
      replaceLiveChannel: parsed.replaceLiveChannel === true,
    });
    refreshClient(id);
    return status;
  });
}

/** Runs the provider's authenticated, read-only capability test with the stored credential. Nothing is sent. */
export async function runChannelTestAction(orgId: string, channel: string) {
  return guard(async () => {
    const id = uuid.parse(orgId);
    const user = await requireAgencyOrgAccessOrThrow(id, "super_admin");
    const out = await runChannelCapabilityTest(user, id, z.enum(CHANNELS).parse(channel));
    refreshClient(id);
    return { ok: out.ok, checks: out.test.checks.map((c) => ({ label: c.label, ok: c.ok, detail: c.detail })), status: out.status };
  });
}

export async function setChannelOnAction(orgId: string, channel: string, on: boolean) {
  return guard(async () => {
    const id = uuid.parse(orgId);
    const user = await requireAgencyOrgAccessOrThrow(id, "super_admin");
    const ch = z.enum(CHANNELS).parse(channel);
    const status = on === true ? await enableChannel(user, id, ch) : await disableChannel(user, id, ch);
    refreshClient(id);
    return status;
  });
}

export async function switchChannelToGhlAction(orgId: string, channel: string) {
  return guard(async () => {
    const id = uuid.parse(orgId);
    const user = await requireAgencyOrgAccessOrThrow(id, "super_admin");
    const status = await switchChannelToGhl(user, id, z.enum(CHANNELS).parse(channel));
    refreshClient(id);
    return status;
  });
}
