"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { AppError } from "@/server/errors";
import { withSystem } from "@/server/db";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { decideApproval } from "@/server/approvals/service";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { dispatchMessage } from "@/server/messaging/send";
import { testSendTemplate } from "@/server/crm/message-templates";
import {
  cancelCampaign, createCampaign, duplicateCampaign, pauseCampaign, pendingApprovalFor, previewCampaign, requestCampaignApproval, resumeCampaign, testableTemplate, updateCampaign,
} from "@/server/crm/campaigns";
import { BLOCK_REASON_LABELS, CHANNELS, MESSAGE_STATUS_LABELS, type MessageStatus } from "@/lib/messaging";
import type { Permission } from "@/lib/permissions";

// Server actions for campaigns (/crm/campaigns). Every rule lives in the service (src/server/crm/campaigns.ts); these parse input, resolve
// who is acting and refresh the screens. An owner's decision goes through the Approval Center's own decideApproval, so the decision is
// recorded and executed exactly as it would be there. A test send dispatches right away so the person sees what really happened.

const uuid = z.string().uuid();
const orgArg = z.string().uuid().nullable().optional();
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/, "Open the preview first: approval covers exactly what it shows.");

function refresh(actor: CrmActor) {
  revalidatePath("/crm", "layout");
  revalidatePath("/approvals");
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

const schedule = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("now") }),
  z.object({ mode: z.literal("later"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date."), time: z.string().regex(/^\d{2}:\d{2}$/, "Choose a time.") }),
]);

const campaignSchema = z.object({
  name: z.string().max(200).optional(),
  channel: z.enum(CHANNELS).optional(),
  smartListId: uuid.nullable().optional(),
  templateId: uuid.nullable().optional(),
  schedule: schedule.optional(),
  ratePerMinute: z.number().int("Use a whole number of messages a minute.").min(1, "Send at least one message a minute.").max(600, "Send at most 600 messages a minute.").optional(),
});
const updateSchema = campaignSchema.extend({ expectedUpdatedAt: z.string().datetime().optional() });

export async function createCampaignAction(orgId: string | null, input: z.input<typeof campaignSchema>) {
  return act(orgId, "campaigns.manage", (actor) => createCampaign(actor, campaignSchema.parse(input)));
}

export async function updateCampaignAction(orgId: string | null, id: string, input: z.input<typeof updateSchema>) {
  return act(orgId, "campaigns.manage", (actor) => updateCampaign(actor, uuid.parse(id), updateSchema.parse(input)));
}

export async function duplicateCampaignAction(orgId: string | null, id: string) {
  return act(orgId, "campaigns.manage", (actor) => duplicateCampaign(actor, uuid.parse(id)));
}

/** The builder's live preview: a saved campaign, or the unsaved form. Counts only. */
export async function previewCampaignAction(orgId: string | null, input: { campaignId?: string; draft?: z.input<typeof campaignSchema> }) {
  const parsed = z.object({ campaignId: uuid.optional(), draft: campaignSchema.partial().optional() }).parse(input);
  return act(orgId, "campaigns.manage", (actor) => previewCampaign(actor, parsed), { refresh: false });
}

export type DecisionOutcome = { decided: boolean; status: "requested" | "pending" | "approved" | "blocked" | "returned"; detail: string };

async function ownerDecides(approvalId: string, decision: "approve" | "reject" | "request_changes", note?: string): Promise<{ status: "succeeded" | "failed" | "blocked" | null; detail: string }> {
  const ctx = await requireOrgContextOrThrow();
  const { outcome } = await decideApproval(ctx, approvalId, decision, note);
  return { status: outcome?.status ?? null, detail: outcome?.detail ?? "" };
}

/**
 * Asks for the owner's approval of exactly what the preview showed. When the person asking is the owner, that is their decision: it is
 * approved at once through the Approval Center's own path (and re-checked there).
 */
export async function requestCampaignApprovalAction(orgId: string | null, id: string, shown: string) {
  return act(orgId, "campaigns.manage", async (actor): Promise<DecisionOutcome> => {
    const campaignId = uuid.parse(id);
    const hash = fingerprint.parse(shown);
    const req = await requestCampaignApproval(actor, campaignId, { fingerprint: hash });
    if (actor.kind === "member" && actor.can("campaigns.send")) {
      const approvalId = req.status === "pending" ? await pendingApprovalFor(actor, campaignId, hash) : req.approvalId;
      const out = await ownerDecides(approvalId, "approve");
      return out.status === "succeeded" ? { decided: true, status: "approved", detail: out.detail } : { decided: true, status: "blocked", detail: out.detail || "It wasn't approved." };
    }
    return req.status === "pending"
      ? { decided: false, status: "pending", detail: "It's already waiting for the owner's approval." }
      : { decided: false, status: "requested", detail: "Sent to the owner for approval. They decide here or in Approvals." };
  });
}

/** The owner approves a pending request on the campaign itself, after checking it still covers what they were shown. */
export async function approveCampaignAction(orgId: string | null, id: string, shown: string) {
  return act(orgId, "campaigns.send", async (actor): Promise<DecisionOutcome> => {
    const approvalId = await pendingApprovalFor(actor, uuid.parse(id), fingerprint.parse(shown));
    const out = await ownerDecides(approvalId, "approve");
    return out.status === "succeeded" ? { decided: true, status: "approved", detail: out.detail } : { decided: true, status: "blocked", detail: out.detail || "It wasn't approved." };
  });
}

/** The owner sends a pending request back to draft, with what should change. */
export async function returnCampaignAction(orgId: string | null, id: string, note: string) {
  const text = z.string().trim().min(3, "Say what should change.").max(1000).parse(note);
  return act(orgId, "campaigns.send", async (actor): Promise<DecisionOutcome> => {
    const approvalId = await pendingApprovalFor(actor, uuid.parse(id), null);
    await ownerDecides(approvalId, "request_changes", text);
    return { decided: true, status: "returned", detail: "Sent back to draft with your note." };
  });
}

export async function pauseCampaignAction(orgId: string | null, id: string) {
  return act(orgId, "campaigns.manage", (actor) => pauseCampaign(actor, uuid.parse(id)));
}

export async function resumeCampaignAction(orgId: string | null, id: string) {
  return act(orgId, "campaigns.send", (actor) => resumeCampaign(actor, uuid.parse(id)));
}

export async function cancelCampaignAction(orgId: string | null, id: string) {
  return act(orgId, "campaigns.manage", (actor) => cancelCampaign(actor, uuid.parse(id)));
}

export type CampaignTestOutcome =
  | { ok: false; detail: string }
  | { ok: true; to: string; status: MessageStatus | "skipped"; statusLabel: string; detail: string };

/**
 * Sends the campaign's message to one of the workspace's approved test destinations (never a customer) through the template test path,
 * then dispatches it so the result is what really happened.
 */
export async function testSendCampaignAction(orgId: string | null, id: string, input: { destination: string; contactId?: string | null }) {
  const parsed = z.object({ destination: z.string().trim().min(3, "Choose a test destination.").max(320), contactId: uuid.nullable().optional() }).parse(input);
  return act(orgId, "campaigns.manage", async (actor): Promise<CampaignTestOutcome> => {
    if (actor.userId) {
      const limit = await consumeRateLimit(RATE_LIMITS.inboxSendByUser, actor.userId);
      if (!limit.allowed) throw new AppError("rate_limited", "You are sending quickly. Please wait a moment.", { retryAfterSeconds: limit.retryAfterSeconds });
    }
    const t = await testableTemplate(actor, uuid.parse(id));
    const queued = await testSendTemplate(actor, t.templateId, parsed);
    if (!queued.ok) return { ok: false, detail: queued.detail };
    let status: MessageStatus | "skipped" = "queued";
    try {
      status = (await dispatchMessage(queued.messageId)).status;
    } catch {
      status = "queued";
    }
    const row = await withSystem((db) => db.query<{ status: MessageStatus; status_detail: string | null; blocked_reason: string | null }>("select status, status_detail, blocked_reason from conversation_messages where id = $1 and org_id = $2", [queued.messageId, actor.orgId]));
    const m = row.rows[0];
    const final = m?.status ?? (status === "skipped" ? "queued" : status);
    const reason = m?.blocked_reason ? (BLOCK_REASON_LABELS[m.blocked_reason] ?? m.blocked_reason) : null;
    const detail =
      final === "sent" ? `Handed to the provider for ${queued.to}. Delivery shows in the inbox once the provider confirms it.`
      : final === "delivered" || final === "read" ? `The provider confirmed delivery to ${queued.to}.`
      : final === "blocked" ? `Not sent: ${reason ?? m?.status_detail ?? "a sending rule held it back"}.`
      : final === "failed" ? `The provider didn't accept it${m?.status_detail ? `: ${m.status_detail}` : "."}`
      : `Queued for ${queued.to}. It goes out on the next send run.`;
    return { ok: true, to: queued.to, status: final, statusLabel: MESSAGE_STATUS_LABELS[final], detail };
  }, { refresh: false });
}
