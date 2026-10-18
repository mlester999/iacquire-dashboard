"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { AppError } from "@/server/errors";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { dispatchMessage } from "@/server/messaging/send";
import {
  approveTemplate, archiveCannedReply, archiveTemplate, createCannedReply, createTemplate, duplicateCannedReply, duplicateTemplate, getTemplate, previewTemplate, previewValues,
  restoreCannedReply, restoreTemplate, testSendTemplate, updateCannedReply, updateTemplate, type TestSendResult,
} from "@/server/crm/message-templates";
import { BLOCK_REASON_LABELS, CHANNELS, MESSAGE_STATUS_LABELS, type MessageStatus } from "@/lib/messaging";
import type { Permission } from "@/lib/permissions";
import { withSystem } from "@/server/db";

// Server actions for message templates and canned replies (/crm/templates and the agency's view of it). Every rule lives in the service;
// these only parse input, resolve who is acting and refresh the screens. A test send dispatches right away so the person sees the real
// outcome (sent, held with a reason, or failed), never an assumed one.

const uuid = z.string().uuid();
const orgArg = z.string().uuid().nullable().optional();

function refresh(actor: CrmActor) {
  revalidatePath("/crm", "layout");
  revalidatePath("/inbox");
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

const channel = z.enum(CHANNELS);
const text = (max: number) => z.string().max(max, `Keep it under ${max.toLocaleString("en-US")} characters.`);

const templateSchema = z.object({
  name: text(80).optional(),
  channel: channel.nullable().optional(),
  purpose: z.enum(["service", "marketing"]).optional(),
  category: text(40).nullable().optional(),
  folderId: uuid.nullable().optional(),
  subject: text(400).nullable().optional(),
  body: text(6000).optional(),
  whatsappTemplateId: text(120).nullable().optional(),
  key: z.string().max(48).optional(),
});
const updateSchema = templateSchema.omit({ key: true }).extend({ expectedVersion: z.number().int().min(1).optional() });

const cannedSchema = z.object({
  name: text(80).optional(),
  channel: channel.nullable().optional(),
  folderId: uuid.nullable().optional(),
  category: text(40).nullable().optional(),
  body: text(6000).optional(),
});
const cannedUpdateSchema = cannedSchema.extend({ expectedVersion: z.number().int().min(1).optional() });

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function getTemplateAction(orgId: string | null, id: string) {
  return act(orgId, "crm.view", (actor) => getTemplate(actor, uuid.parse(id)), { refresh: false });
}

export async function createTemplateAction(orgId: string | null, input: z.input<typeof templateSchema>) {
  return act(orgId, "templates.manage", (actor) => createTemplate(actor, templateSchema.parse(input)));
}

export async function updateTemplateAction(orgId: string | null, id: string, input: z.input<typeof updateSchema>) {
  return act(orgId, "templates.manage", (actor) => updateTemplate(actor, uuid.parse(id), updateSchema.parse(input)));
}

export async function approveTemplateAction(orgId: string | null, id: string, input: { version: number; contentHash: string }) {
  const parsed = z.object({ version: z.number().int().min(1), contentHash: z.string().regex(/^[0-9a-f]{64}$/) });
  return act(orgId, "templates.manage", (actor) => approveTemplate(actor, uuid.parse(id), parsed.parse(input)));
}

export async function archiveTemplateAction(orgId: string | null, id: string) {
  return act(orgId, "templates.manage", (actor) => archiveTemplate(actor, uuid.parse(id)));
}

export async function restoreTemplateAction(orgId: string | null, id: string) {
  return act(orgId, "templates.manage", (actor) => restoreTemplate(actor, uuid.parse(id)));
}

export async function duplicateTemplateAction(orgId: string | null, id: string) {
  return act(orgId, "templates.manage", (actor) => duplicateTemplate(actor, uuid.parse(id)));
}

/** Renders a saved version with a contact or sample values. */
export async function previewTemplateAction(orgId: string | null, id: string, opts: { contactId?: string | null; version?: number } = {}) {
  const parsed = z.object({ contactId: uuid.nullable().optional(), version: z.number().int().min(1).optional() }).parse(opts);
  return act(orgId, "crm.view", (actor) => previewTemplate(actor, uuid.parse(id), parsed), { refresh: false });
}

/** Token values for the editor's live preview of unsaved wording. */
export async function previewValuesAction(orgId: string | null, contactId: string | null) {
  return act(orgId, "crm.view", (actor) => previewValues(actor, { contactId: contactId ? uuid.parse(contactId) : null }), { refresh: false });
}

export type TestSendOutcome =
  | Exclude<TestSendResult, { ok: true }>
  | { ok: true; to: string; status: MessageStatus | "skipped"; statusLabel: string; detail: string };

/**
 * Sends a template's current version to an approved test destination and dispatches it immediately. The result is what actually happened:
 * refused before anything was queued (with the reason), or the message's real status after the dispatcher ran.
 */
export async function testSendTemplateAction(orgId: string | null, id: string, input: { destination: string; contactId?: string | null }) {
  const parsed = z.object({ destination: z.string().trim().min(3, "Choose a test destination.").max(320), contactId: uuid.nullable().optional() }).parse(input);
  return act(orgId, "templates.manage", async (actor): Promise<TestSendOutcome> => {
    if (actor.userId) {
      const limit = await consumeRateLimit(RATE_LIMITS.inboxSendByUser, actor.userId);
      if (!limit.allowed) throw new AppError("rate_limited", "You are sending quickly. Please wait a moment.", { retryAfterSeconds: limit.retryAfterSeconds });
    }
    const queued = await testSendTemplate(actor, uuid.parse(id), parsed);
    if (!queued.ok) return queued;
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
  });
}

// ---------------------------------------------------------------------------
// Canned replies
// ---------------------------------------------------------------------------

export async function createCannedReplyAction(orgId: string | null, input: z.input<typeof cannedSchema>) {
  return act(orgId, "templates.manage", (actor) => createCannedReply(actor, cannedSchema.parse(input)));
}

export async function updateCannedReplyAction(orgId: string | null, id: string, input: z.input<typeof cannedUpdateSchema>) {
  return act(orgId, "templates.manage", (actor) => updateCannedReply(actor, uuid.parse(id), cannedUpdateSchema.parse(input)));
}

export async function archiveCannedReplyAction(orgId: string | null, id: string) {
  return act(orgId, "templates.manage", (actor) => archiveCannedReply(actor, uuid.parse(id)));
}

export async function restoreCannedReplyAction(orgId: string | null, id: string) {
  return act(orgId, "templates.manage", (actor) => restoreCannedReply(actor, uuid.parse(id)));
}

export async function duplicateCannedReplyAction(orgId: string | null, id: string) {
  return act(orgId, "templates.manage", (actor) => duplicateCannedReply(actor, uuid.parse(id)));
}
