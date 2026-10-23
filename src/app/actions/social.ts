"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { AppError } from "@/server/errors";
import { requireOrgContextOrThrow, type OrgContext } from "@/server/tenancy/context";
import type { Permission } from "@/lib/permissions";
import { fromLocalInput } from "@/lib/social/calendar";
import { MAX_HASHTAGS } from "@/lib/social/limits";
import { httpsUrl, LINK_NOT_HTTPS } from "@/lib/social/links";
import { skippedNotice, type SkippedAccount } from "@/lib/social/notices";
import { POST_KINDS } from "@/lib/social/rules";
import { checkMyAccount, connectChosenPages, connectSimulatedAccount, disconnectAccount } from "@/server/social/accounts";
import { encodeSocialNotice, SOCIAL_NOTICE_COOKIE, SOCIAL_NOTICE_COOKIE_OPTIONS } from "@/server/social/notice";
import { simulatedAllowed } from "@/server/social/providers";
import { assertSocialWorkspace } from "@/server/social/workspace";
import { createDraftFromOption, suggestCaptions, suggestIdeas, TONES } from "@/server/social/ai";
import { removeMedia } from "@/server/social/media";
import { cancelPost, createPost, decide, duplicatePost, reschedulePost, resolveUnknown, retryPost, schedulePost, submitForApproval, updatePost } from "@/server/social/posts";
import { archiveCampaign, createCampaign, saveSocialSettings } from "@/server/social/settings";

// Server actions for the social media manager. What each person may do is decided in src/server/social (every function checks its own permission); these parse
// the input, resolve the signed-in workspace and refresh the screens. Times typed by a person are read as wall-clock time in the WORKSPACE's time zone.

const uuid = z.string().uuid({ error: "That item was not found." });
const refresh = () => revalidatePath("/social", "layout");

// Social media belongs to the client business that owns the accounts, so it is used inside a client workspace. The pages show a notice and the sign-in routes
// refuse in an agency workspace; this is the same rule for the actions, in the same words, and it is asked first so the reason given is the true one.
async function act<T>(permission: Permission, fn: (ctx: OrgContext) => Promise<T>) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow();
    assertSocialWorkspace(ctx);
    if (!ctx.can(permission)) throw new AppError("forbidden", "Your role doesn't allow this action. Ask a workspace owner for access.");
    const out = await fn(ctx);
    refresh();
    return out;
  });
}

const postInput = z.object({
  accountId: uuid, kind: z.enum(POST_KINDS), caption: z.string().max(70_000).optional(),
  hashtags: z.array(z.string().max(120)).max(MAX_HASHTAGS, { error: `A post can carry at most ${MAX_HASHTAGS} hashtags.` }).optional(),
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
  if (!at) throw new AppError("invalid_input", "Choose a date and time.");
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
    if (!t.at) throw new AppError("invalid_input", "Choose a date and time.");
    return reschedulePost(ctx, uuid.parse(id), { at: t.at, timezone: ctx.org.timezone });
  });
}

export async function cancelPostAction(id: string) {
  return act("social.create", (ctx) => cancelPost(ctx, uuid.parse(id)));
}
export async function retryPostAction(id: string) {
  return act("social.publish", (ctx) => retryPost(ctx, uuid.parse(id)));
}
// The link a person pastes for a post they found on the Page is shown to everyone as "View the post", so it must be a real https address, not whatever was typed.
const resolveInput = z.object({
  outcome: z.enum(["posted", "not_posted"]),
  permalink: z.string().max(500, { error: LINK_NOT_HTTPS }).nullish().refine((v) => !v?.trim() || httpsUrl(v) !== null, { error: LINK_NOT_HTTPS }),
});
export async function resolveUnknownAction(id: string, outcome: "posted" | "not_posted", permalink?: string | null) {
  return act("social.publish", (ctx) => {
    const input = resolveInput.parse({ outcome, permalink });
    return resolveUnknown(ctx, uuid.parse(id), { outcome: input.outcome, permalink: httpsUrl(input.permalink) });
  });
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

// Which accounts were not connected, and why, goes back to the accounts page in the short-lived notice cookie the sign-in routes already use. It is never put in
// the address: an address can be written by anyone, and this page is where owners handle their Meta sign-ins.
async function rememberConnectNotice(connected: number, skipped: SkippedAccount[]) {
  const jar = await cookies();
  const notice = skippedNotice(connected, skipped);
  // With nothing to report, a notice left from an earlier sign-in must not sit beside a clean result.
  if (notice) jar.set(SOCIAL_NOTICE_COOKIE, encodeSocialNotice(notice), SOCIAL_NOTICE_COOKIE_OPTIONS);
  else jar.set(SOCIAL_NOTICE_COOKIE, "", { ...SOCIAL_NOTICE_COOKIE_OPTIONS, maxAge: 0 });
}

export async function connectChosenAction(stateId: string, picks: unknown) {
  return act("social.connect", async (ctx) => {
    const out = await connectChosenPages(ctx, uuid.parse(stateId), z.array(z.object({ pageId: z.string().max(80), includeInstagram: z.boolean().optional() })).max(50).parse(picks));
    await rememberConnectNotice(out.connected.length, out.skipped);
    return out;
  });
}
export async function disconnectAccountAction(id: string) {
  return act("social.connect", (ctx) => disconnectAccount(ctx, uuid.parse(id)));
}
export async function checkAccountAction(id: string) {
  return act("social.connect", async (ctx) => ({ status: await checkMyAccount(ctx, uuid.parse(id)) }));
}
export async function connectTestAccountAction(input: unknown) {
  return act("social.connect", async (ctx) => {
    if (!simulatedAllowed()) throw new AppError("forbidden", "Test accounts are not available here.");
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
