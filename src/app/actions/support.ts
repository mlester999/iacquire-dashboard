"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { clientReply, createTicket, listTickets, newTicketSchema } from "@/server/support/service";
import { actionError } from "@/server/errors";
import { z } from "zod";

export async function createTicketAction(input: z.input<typeof newTicketSchema>) {
  try {
    const ctx = await requireOrgContextOrThrow("support.use");
    const parsed = newTicketSchema.safeParse(input);
    if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Check the form.", code: "invalid_input" as const };
    const t = await createTicket(ctx, parsed.data);
    revalidatePath("/support");
    return { ok: true as const, data: { id: t.id, ref: t.ref, externalNotification: t.externalNotification } };
  } catch (err) {
    return actionError(err);
  }
}

export async function listMyTicketsAction() {
  try {
    const ctx = await requireOrgContextOrThrow("support.use");
    const rows = await listTickets(ctx);
    return {
      ok: true as const,
      data: rows.slice(0, 20).map((t) => ({ id: t.id, ref: t.ref, subject: t.subject, status: t.status, lastMessageAt: new Date(t.last_message_at).toISOString() })),
    };
  } catch (err) {
    return actionError(err);
  }
}

export async function replyTicketAction(ticketId: string, body: string) {
  try {
    const ctx = await requireOrgContextOrThrow("support.use");
    await clientReply(ctx, ticketId, body);
    revalidatePath(`/support/${ticketId}`);
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}
