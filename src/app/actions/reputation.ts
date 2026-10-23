"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import { saveReputationSettings } from "@/server/reputation/settings";
import { approveBatch, cancelBatch, createBatch, duplicateBatch, pauseBatch, requestBatchApproval, resumeBatch, returnBatch, updateBatch } from "@/server/reputation/batches";
import { checkConnection, connectChosenLocation, connectFacebookPage, connectSimulatedSite, disconnectConnection, startGoogleConnect } from "@/server/reputation/connections";
import { syncNow } from "@/server/reputation/sync";
import { linkReviewContact } from "@/server/reputation/public-reviews";
import { cancelReply, decideReply, editReply, postReply, resolveReply, startReply, submitReply } from "@/server/reputation/replies";
import { draftReplyWithAi } from "@/server/reputation/reply-ai";
import type { Permission } from "@/lib/permissions";

// Server actions for the reputation features that sit beside CRM → Reviews. Every rule lives in src/server/reputation; these parse input, resolve who is acting and
// refresh the screens. (Marking feedback acknowledged or resolved stays in actions/crm-reviews.ts.)

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

/**
 * Changes the workspace's reputation settings (what counts as low feedback, how long the team has to acknowledge it, the optional assists). The service takes the
 * patch as an unknown value and refuses anything it does not list; the version is the one the person's screen showed, so two people cannot overwrite each other.
 */
export async function saveReputationSettingsAction(orgId: string | null, patch: unknown, expectedVersion: number) {
  return act(orgId, "reviews.manage", (actor) => saveReputationSettings(actor, patch, z.number().int().min(0).parse(expectedVersion)));
}

// ---------------------------------------------------------------------------
// Review request batches. Every rule (who may do what, what the approval covers, what the scheduler checks) is in src/server/reputation/batches.ts; these parse input and
// refresh the screens. The criteria are passed through untouched: the service's strict schema refuses any choice that is not a completed service and where it happened.
// ---------------------------------------------------------------------------

const uuid = z.string().uuid({ error: "Choose an item from the list." });
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/, { error: "Look at the preview again, then continue." });
const batchInput = z.object({
  name: z.string().max(300),
  templateId: uuid,
  kind: z.enum(["review", "survey"]).optional(),
  scale: z.enum(["csat5", "nps10"]).optional(),
  criteria: z.unknown(),
  ratePerMinute: z.number().int().optional(),
});

export async function createBatchAction(orgId: string | null, input: z.input<typeof batchInput>) {
  return act(orgId, "reviews.manage", (actor) => createBatch(actor, batchInput.parse(input)));
}

export async function updateBatchAction(orgId: string | null, id: string, input: z.input<typeof batchInput>, expectedUpdatedAt?: string) {
  return act(orgId, "reviews.manage", (actor) => updateBatch(actor, uuid.parse(id), { ...batchInput.parse(input), expectedUpdatedAt: z.string().max(40).optional().parse(expectedUpdatedAt) }));
}

export async function duplicateBatchAction(orgId: string | null, id: string) {
  return act(orgId, "reviews.manage", (actor) => duplicateBatch(actor, uuid.parse(id)));
}

export async function requestBatchApprovalAction(orgId: string | null, id: string, fingerprintValue: string) {
  return act(orgId, "reviews.manage", (actor) => requestBatchApproval(actor, uuid.parse(id), { fingerprint: fingerprint.parse(fingerprintValue) }));
}

// The owner's decision: the permission to send to many customers at once is the owner's alone.
export async function approveBatchAction(orgId: string | null, id: string, fingerprintValue: string) {
  return act(orgId, "campaigns.send", (actor) => approveBatch(actor, uuid.parse(id), { fingerprint: fingerprint.parse(fingerprintValue) }));
}

export async function returnBatchAction(orgId: string | null, id: string, note?: string | null) {
  return act(orgId, "campaigns.send", (actor) => returnBatch(actor, uuid.parse(id), z.string().max(600).nullish().parse(note)));
}

export async function pauseBatchAction(orgId: string | null, id: string) {
  return act(orgId, "reviews.manage", (actor) => pauseBatch(actor, uuid.parse(id)));
}

export async function resumeBatchAction(orgId: string | null, id: string) {
  return act(orgId, "reviews.manage", (actor) => resumeBatch(actor, uuid.parse(id)));
}

export async function cancelBatchAction(orgId: string | null, id: string) {
  return act(orgId, "reviews.manage", (actor) => cancelBatch(actor, uuid.parse(id)));
}

// ---------------------------------------------------------------------------
// Public reviews: connecting a review site, reading it, and replying. Every rule is in src/server/reputation (connections, sync, replies, reply-ai); these parse input, resolve who is
// acting and refresh the screens. A review or a rating is never an input to any of them: reviews arrive only from a review site. Replies are gated by the service itself
// (reviews.respond to write, reviews.reply_publish to approve and post), so the permission named here is only what lets iAcquire support through to be told no, in words.
// ---------------------------------------------------------------------------

const siteArg = z.enum(["google", "facebook"]);
const replyBody = z.string().max(5000);
const version = z.number().int().min(1);

export async function connectSimulatedSiteAction(orgId: string | null, provider: "google" | "facebook", name?: string) {
  return act(orgId, "reviews.manage", (actor) => connectSimulatedSite(actor, { provider: siteArg.parse(provider), name: z.string().max(200).optional().parse(name) }));
}

export async function connectFacebookPageAction(orgId: string | null, socialAccountId: string) {
  return act(orgId, "reviews.manage", (actor) => connectFacebookPage(actor, uuid.parse(socialAccountId)));
}

/** Where to send the browser to sign in with Google. The sign-in comes back to /api/reputation/oauth/google/callback, which finishes it. */
export async function startGoogleConnectAction(orgId: string | null) {
  return act(orgId, "reviews.manage", (actor) => startGoogleConnect(actor, null));
}

export async function connectGoogleLocationAction(orgId: string | null, stateId: string, accountId: string, locationId: string) {
  return act(orgId, "reviews.manage", (actor) => connectChosenLocation(actor, stateId, { accountId: z.string().max(200).parse(accountId), locationId: z.string().max(200).parse(locationId) }));
}

export async function checkConnectionAction(orgId: string | null, id: string) {
  return act(orgId, "reviews.manage", async (actor) => ({ status: await checkConnection(actor, uuid.parse(id)) }));
}

export async function disconnectConnectionAction(orgId: string | null, id: string) {
  return act(orgId, "reviews.manage", (actor) => disconnectConnection(actor, uuid.parse(id)));
}

export async function readReviewsNowAction(orgId: string | null, id: string) {
  return act(orgId, "reviews.manage", async (actor) => {
    const r = await syncNow(actor, uuid.parse(id));
    return { status: r.status, inserted: r.inserted, updated: r.updated, removed: r.removed, complete: r.complete, reason: r.reason };
  });
}

export async function linkReviewContactAction(orgId: string | null, reviewId: string, contactId: string | null) {
  return act(orgId, "reviews.manage", (actor) => linkReviewContact(actor, uuid.parse(reviewId), contactId === null ? null : uuid.parse(contactId)));
}

export async function startReplyAction(orgId: string | null, reviewId: string, body: string) {
  return act(orgId, "contacts.view", (actor) => startReply(actor, uuid.parse(reviewId), { body: replyBody.parse(body) }));
}

export async function draftReplyWithAiAction(orgId: string | null, reviewId: string) {
  return act(orgId, "contacts.view", (actor) => draftReplyWithAi(actor, uuid.parse(reviewId)));
}

export async function editReplyAction(orgId: string | null, replyId: string, body: string, expectedVersion: number) {
  return act(orgId, "contacts.view", (actor) => editReply(actor, uuid.parse(replyId), { body: replyBody.parse(body), expectedVersion: version.parse(expectedVersion) }));
}

export async function submitReplyAction(orgId: string | null, replyId: string, replyVersion: number) {
  return act(orgId, "contacts.view", (actor) => submitReply(actor, uuid.parse(replyId), { version: version.parse(replyVersion) }));
}

export async function decideReplyAction(orgId: string | null, replyId: string, decision: "approve" | "request_changes" | "reject", replyVersion: number, note?: string | null) {
  return act(orgId, "contacts.view", (actor) => decideReply(actor, uuid.parse(replyId), { decision: z.enum(["approve", "request_changes", "reject"]).parse(decision), version: version.parse(replyVersion), note: z.string().max(600).nullish().parse(note) }));
}

export async function postReplyAction(orgId: string | null, replyId: string) {
  return act(orgId, "contacts.view", (actor) => postReply(actor, uuid.parse(replyId)));
}

export async function cancelReplyAction(orgId: string | null, replyId: string) {
  return act(orgId, "contacts.view", (actor) => cancelReply(actor, uuid.parse(replyId)));
}

export async function resolveReplyAction(orgId: string | null, replyId: string, outcome: "posted" | "not_posted") {
  return act(orgId, "contacts.view", (actor) => resolveReply(actor, uuid.parse(replyId), { outcome: z.enum(["posted", "not_posted"]).parse(outcome) }));
}
