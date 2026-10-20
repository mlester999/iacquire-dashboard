"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import {
  listMyRequests, markRequestRead, newTicketSchema, postClientMessage, reopenRequest, submitRequest, clientMessageSchema, submitRequestSchema, type MyRequestsQuery,
} from "@/server/support/service";
import { findSimilarRequests } from "@/server/support/duplicates";
import { improveRequestDraft, suggestForDraft } from "@/server/support/ai";
import { actionError } from "@/server/errors";
import { REQUEST_TYPES } from "@/lib/support/lifecycle";

// Server actions for the client side of Support & Requests. Every one re-reads the person's workspace and permission from the session;
// nothing the browser sends (an organisation id, a role, a request id) is trusted without the same checks the pages use.

function refresh(ticketId?: string) {
  revalidatePath("/support/requests");
  revalidatePath("/support");
  if (ticketId) revalidatePath(`/support/${ticketId}`);
}

/** Opens a request of any type. Returns the real reference, or the reason it could not be created. */
export async function submitRequestAction(input: z.input<typeof submitRequestSchema>) {
  try {
    const ctx = await requireOrgContextOrThrow("support.use");
    const r = await submitRequest(ctx, input);
    refresh(r.id);
    return { ok: true as const, data: r };
  } catch (err) {
    return actionError(err);
  }
}

/** The earlier entry point, used by the help widget and the maintenance panel. */
export async function createTicketAction(input: z.input<typeof newTicketSchema>) {
  try {
    const ctx = await requireOrgContextOrThrow("support.use");
    const parsed = newTicketSchema.safeParse(input);
    if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Check the form.", code: "invalid_input" as const };
    const t = await submitRequest(ctx, parsed.data);
    refresh(t.id);
    return { ok: true as const, data: { id: t.id, ref: t.ref, externalNotification: t.externalNotification } };
  } catch (err) {
    return actionError(err);
  }
}

export async function listMyTicketsAction() {
  try {
    const ctx = await requireOrgContextOrThrow("support.use");
    const page = await listMyRequests(ctx, { pageSize: 20 });
    return { ok: true as const, data: page.items.map((t) => ({ id: t.id, ref: t.ref, subject: t.subject, status: t.status, lastMessageAt: t.lastActivityAt })) };
  } catch (err) {
    return actionError(err);
  }
}

export async function postMessageAction(ticketId: string, input: z.input<typeof clientMessageSchema>) {
  try {
    const ctx = await requireOrgContextOrThrow("support.use");
    const r = await postClientMessage(ctx, ticketId, input);
    refresh(ticketId);
    return { ok: true as const, data: r };
  } catch (err) {
    return actionError(err);
  }
}

/** The earlier plain-text reply. */
export async function replyTicketAction(ticketId: string, body: string) {
  return postMessageAction(ticketId, { body });
}

export async function reopenRequestAction(ticketId: string, note?: string) {
  try {
    const ctx = await requireOrgContextOrThrow("support.use");
    await reopenRequest(ctx, ticketId, note);
    refresh(ticketId);
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function markRequestReadAction(ticketId: string) {
  try {
    const ctx = await requireOrgContextOrThrow("support.use");
    await markRequestRead(ctx, ticketId);
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

/** A page of the person's own requests, for "load more" and live refresh. */
export async function listRequestsAction(query: MyRequestsQuery) {
  try {
    const ctx = await requireOrgContextOrThrow("support.use");
    return { ok: true as const, data: await listMyRequests(ctx, query) };
  } catch (err) {
    return actionError(err);
  }
}

const similarSchema = z.object({ subject: z.string().max(200), type: z.enum(REQUEST_TYPES).optional() });
export async function findSimilarRequestsAction(input: z.input<typeof similarSchema>) {
  try {
    const ctx = await requireOrgContextOrThrow("support.use");
    const parsed = similarSchema.parse(input);
    return { ok: true as const, data: await findSimilarRequests(ctx, parsed) };
  } catch (err) {
    return actionError(err);
  }
}

const draftSchema = z.object({ subject: z.string().max(200), text: z.string().max(6000) });
/** A topic suggestion and related help articles from the person's own words. No AI provider is called. */
export async function suggestForDraftAction(input: z.input<typeof draftSchema>) {
  try {
    await requireOrgContextOrThrow("support.use");
    return { ok: true as const, data: suggestForDraft(draftSchema.parse(input)) };
  } catch (err) {
    return actionError(err);
  }
}

const improveSchema = z.object({ type: z.enum(REQUEST_TYPES), subject: z.string().max(200), text: z.string().max(6000) });
/** Optional AI help to say something more clearly. The result is shown for the person to accept or ignore; nothing is sent. */
export async function improveRequestDraftAction(input: z.input<typeof improveSchema>) {
  try {
    const ctx = await requireOrgContextOrThrow("support.use");
    return { ok: true as const, data: await improveRequestDraft(ctx, improveSchema.parse(input)) };
  } catch (err) {
    return actionError(err);
  }
}
