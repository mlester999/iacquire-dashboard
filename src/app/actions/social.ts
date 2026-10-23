"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { studioContext } from "@/server/websites/studio-ctx";
import type { Permission } from "@/lib/permissions";
import { fromLocalInput } from "@/lib/social/calendar";
import { POST_KINDS } from "@/lib/social/rules";
import { checkMyAccount, connectChosenPages, connectSimulatedAccount, disconnectAccount } from "@/server/social/accounts";
import { simulatedAllowed } from "@/server/social/providers";
import { createDraftFromOption, suggestCaptions, suggestIdeas, TONES } from "@/server/social/ai";
import { removeMedia } from "@/server/social/media";
import { cancelPost, createPost, decide, duplicatePost, reschedulePost, resolveUnknown, retryPost, schedulePost, submitForApproval, updatePost } from "@/server/social/posts";
import { archiveCampaign, createCampaign, saveSocialSettings } from "@/server/social/settings";

// Server actions for the social media manager. What each person may do is decided in src/server/social (every function checks its own permission); these parse
// the input, resolve the signed-in workspace and refresh the screens. Times typed by a person are read as wall-clock time in the WORKSPACE's time zone.

const uuid = z.string().uuid({ error: "That item was not found." });
const refresh = () => revalidatePath("/social", "layout");

async function act<T>(permission: Permission, fn: (ctx: Awaited<ReturnType<typeof studioContext>>) => Promise<T>) {
  return guard(async () => {
    const ctx = await studioContext(null, permission);
    const out = await fn(ctx);
    refresh();
    return out;
  });
}

const postInput = z.object({
  accountId: uuid, kind: z.enum(POST_KINDS), caption: z.string().max(70_000).optional(), hashtags: z.array(z.string().max(120)).max(60).optional(),
  linkUrl: z.string().max(1000).nullish(), mediaAssetIds: z.array(uuid).max(10).optional(), campaignId: uuid.nullish(),
});

export async function createPostAction(input: unknown) {
  return act("social.create", async (ctx) => {
    const p = await createPost(ctx, postInput.parse(input));
    return { id: p.id };
  });
}

export async function updatePostAction(id: string, patch: unknown, expectedVersion: number) {
  return act("social.create", (ctx) => updatePost(ctx, uuid.parse(id), postInput.partial().parse(patch), Number(expectedVersion)));
}

export async function submitForApprovalAction(id: string) {
  return act("social.create", (ctx) => submitForApproval(ctx, uuid.parse(id)));
}

const decision = z.object({ decision: z.enum(["approve", "request_changes", "reject"]), version: z.number().int().min(1), note: z.string().max(600).nullish() });
export async function decideAction(id: string, input: unknown) {
  return act("social.approve", (ctx) => decide(ctx, uuid.parse(id), decision.parse(input)));
}

const when = z.object({ atLocal: z.string().max(20).optional(), asap: z.boolean().optional() });
function instant(ctx: { org: { timezone: string } }, input: z.infer<typeof when>) {
  if (input.asap) return { asap: true as const, at: undefined };
  const at = input.atLocal ? fromLocalInput(input.atLocal, ctx.org.timezone) : null;
  if (!at) throw new Error("Choose a date and time.");
  return { asap: false as const, at };
}

export async function scheduleAction(id: string, input: unknown) {
  return act("social.publish", (ctx) => {
    const t = instant(ctx, when.parse(input));
    return schedulePost(ctx, uuid.parse(id), { at: t.at, asap: t.asap, timezone: ctx.org.timezone });
  });
}

export async function rescheduleAction(id: string, input: unknown) {
  return act("social.publish", (ctx) => {
    const t = instant(ctx, when.parse(input));
    if (!t.at) throw new Error("Choose a date and time.");
    return reschedulePost(ctx, uuid.parse(id), { at: t.at, timezone: ctx.org.timezone });
  });
}

export async function cancelPostAction(id: string) {
  return act("social.create", (ctx) => cancelPost(ctx, uuid.parse(id)));
}
export async function retryPostAction(id: string) {
  return act("social.publish", (ctx) => retryPost(ctx, uuid.parse(id)));
}
export async function resolveUnknownAction(id: string, outcome: "posted" | "not_posted", permalink?: string | null) {
  return act("social.publish", (ctx) => resolveUnknown(ctx, uuid.parse(id), { outcome: z.enum(["posted", "not_posted"]).parse(outcome), permalink: permalink ?? null }));
}
export async function duplicatePostAction(id: string) {
  return act("social.create", async (ctx) => ({ id: (await duplicatePost(ctx, uuid.parse(id))).id }));
}

// AI drafting ---------------------------------------------------------------

const ideasInput = z.object({ accountId: uuid, campaignId: uuid.nullish(), topic: z.string().max(200).nullish(), tone: z.enum(TONES).optional() });
export async function suggestIdeasAction(input: unknown) {
  return act("social.create", (ctx) => suggestIdeas(ctx, ideasInput.parse(input)));
}

const captionsInput = z.object({
  accountId: uuid, kind: z.enum(POST_KINDS), idea: z.object({ title: z.string().max(200), angle: z.string().max(600) }).nullish(), topic: z.string().max(300).nullish(),
  campaignId: uuid.nullish(), tone: z.enum(TONES).optional(),
});
export async function suggestCaptionsAction(input: unknown) {
  return act("social.create", (ctx) => suggestCaptions(ctx, captionsInput.parse(input)));
}

export async function draftFromOptionAction(runId: string, index: number, input: unknown) {
  return act("social.create", async (ctx) => {
    const p = await createDraftFromOption(ctx, uuid.parse(runId), z.number().int().min(0).max(5).parse(index), postInput.pick({ accountId: true, kind: true, campaignId: true, linkUrl: true, mediaAssetIds: true }).parse(input));
    return { id: p.id };
  });
}

// Accounts ------------------------------------------------------------------

export async function connectChosenAction(stateId: string, picks: unknown) {
  return act("social.connect", (ctx) => connectChosenPages(ctx, uuid.parse(stateId), z.array(z.object({ pageId: z.string().max(80), includeInstagram: z.boolean().optional() })).max(50).parse(picks)));
}
export async function disconnectAccountAction(id: string) {
  return act("social.connect", (ctx) => disconnectAccount(ctx, uuid.parse(id)));
}
export async function checkAccountAction(id: string) {
  return act("social.connect", async (ctx) => ({ status: await checkMyAccount(ctx, uuid.parse(id)) }));
}
export async function connectTestAccountAction(input: unknown) {
  return act("social.connect", async (ctx) => {
    if (!simulatedAllowed()) throw new Error("Test accounts are not available here.");
    const i = z.object({ platform: z.enum(["facebook", "instagram"]), name: z.string().max(120) }).parse(input);
    return connectSimulatedAccount(ctx, i);
  });
}

// Media, settings and campaigns ---------------------------------------------

export async function removeMediaAction(id: string) {
  return act("social.create", async (ctx) => {
    await removeMedia(ctx, uuid.parse(id));
    return true;
  });
}

const settingsPatch = z.object({
  approvalForPublishers: z.boolean().optional(), aiDraftsEnabled: z.boolean().optional(), trackingLinks: z.boolean().optional(),
  defaultHashtags: z.array(z.string().max(120)).max(20).optional(), brandVoiceNote: z.string().max(600).nullish(),
});
export async function saveSocialSettingsAction(patch: unknown, expectedVersion: number) {
  return act("social.settings", (ctx) => saveSocialSettings(ctx, settingsPatch.parse(patch), Number(expectedVersion)));
}

export async function createCampaignAction(input: unknown) {
  return act("social.create", (ctx) => createCampaign(ctx, z.object({ name: z.string().max(120), goal: z.string().max(400).nullish(), startsOn: z.string().max(10).nullish(), endsOn: z.string().max(10).nullish() }).parse(input)));
}
export async function archiveCampaignAction(id: string) {
  return act("social.create", async (ctx) => {
    await archiveCampaign(ctx, uuid.parse(id));
    return true;
  });
}
