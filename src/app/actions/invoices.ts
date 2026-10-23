"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { AppError } from "@/server/errors";
import { requireOrgContextOrThrow, type OrgContext } from "@/server/tenancy/context";
import type { Permission } from "@/lib/permissions";
import { createDraft, discardDraft, issueInvoice, requestChanges, submitForApproval, updateDraft, voidInvoice, withdrawFromApproval, writeOffInvoice } from "@/server/invoices/invoices";
import { recordManualPayment, recordRefund } from "@/server/invoices/payments";
import { getInvoiceLink, rotateInvoiceLink } from "@/server/invoices/share";
import { saveInvoiceSettings } from "@/server/invoices/settings";
import { authorizeReminders, switchOffReminders } from "@/server/invoices/reminders";
import { searchDealsForInvoice } from "@/server/invoices/search";
import { startTestPayment } from "@/server/invoices/test-payment";
import { confirmLive, connectProvider, listRecentDeliveries, recheckConnection, replaceCredentials, revokeConnection, saveWebhookSecret, setConnectionPaused } from "@/server/customer-payments/connections";

// Server actions for customer invoices and the business's payment account. What each person may do is decided in src/server/invoices and src/server/customer-payments (every
// function checks its own permission and that the workspace has invoices switched on); these parse the input, resolve the signed-in workspace and refresh the screens.
// Amounts and quantities travel as the text the person typed and are parsed on the server with src/lib/money: no browser computes a number the server trusts.

const uuid = z.string().uuid({ error: "That item was not found." });
const refresh = () => {
  revalidatePath("/invoices", "layout");
  revalidatePath("/settings/payments");
};

async function act<T>(permission: Permission, fn: (ctx: OrgContext) => Promise<T>) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow();
    if (!ctx.can(permission)) throw new AppError("forbidden", "Your role doesn't allow this action. Ask a workspace owner for access.");
    const out = await fn(ctx);
    refresh();
    return out;
  });
}

const version = z.number().int().min(1);

// Drafts ----------------------------------------------------------------------

export async function createInvoiceDraftAction(input: unknown) {
  return act("invoices.create", async (ctx) => ({ id: (await createDraft(ctx, input)).invoice.id }));
}

export async function updateInvoiceDraftAction(id: string, patch: unknown, expectedVersion: number) {
  return act("invoices.create", async (ctx) => ({ version: (await updateDraft(ctx, uuid.parse(id), patch, version.parse(expectedVersion))).invoice.version }));
}

export async function discardInvoiceDraftAction(id: string) {
  return act("invoices.create", async (ctx) => {
    await discardDraft(ctx, uuid.parse(id));
    return true;
  });
}

export async function searchInvoiceDealsAction(q: string) {
  return act("invoices.create", (ctx) => searchDealsForInvoice(ctx, z.string().max(80).parse(q)));
}

// Approval and issue --------------------------------------------------------------

export async function submitInvoiceAction(id: string, expectedVersion: number) {
  return act("invoices.create", async (ctx) => ({ status: (await submitForApproval(ctx, uuid.parse(id), version.parse(expectedVersion))).invoice.status }));
}

export async function withdrawInvoiceAction(id: string) {
  return act("invoices.create", async (ctx) => ({ status: (await withdrawFromApproval(ctx, uuid.parse(id))).invoice.status }));
}

export async function requestInvoiceChangesAction(id: string, input: unknown) {
  return act("invoices.approve", async (ctx) => {
    const i = z.object({ version, note: z.string().min(3, { error: "Say what should change." }).max(400) }).parse(input);
    return { status: (await requestChanges(ctx, uuid.parse(id), i)).invoice.status };
  });
}

export async function issueInvoiceAction(id: string, expectedVersion: number) {
  return act("invoices.create", async (ctx) => {
    const r = await issueInvoice(ctx, uuid.parse(id), { version: version.parse(expectedVersion) });
    return { number: r.number };
  });
}

// Void, write off, payments and refunds -------------------------------------------------

export async function voidInvoiceAction(id: string, input: unknown) {
  return act("invoices.void", async (ctx) => ({ status: (await voidInvoice(ctx, uuid.parse(id), input)).invoice.status }));
}

export async function writeOffInvoiceAction(id: string, input: unknown) {
  return act("invoices.refund", async (ctx) => ({ writtenOff: (await writeOffInvoice(ctx, uuid.parse(id), input)).invoice.writtenOffAt !== null }));
}

export async function recordPaymentAction(id: string, input: unknown) {
  return act("invoices.record_payment", async (ctx) => {
    const r = await recordManualPayment(ctx, uuid.parse(id), input);
    return { duplicate: r.duplicate, justPaid: r.justPaid, closeRule: r.closeRule ? { action: r.closeRule.decision.action, taskId: r.closeRule.taskId } : null };
  });
}

export async function recordRefundAction(paymentId: string, input: unknown) {
  return act("invoices.refund", async (ctx) => {
    const r = await recordRefund(ctx, uuid.parse(paymentId), input);
    return { duplicate: r.duplicate, reviewTaskCreated: r.reviewTaskId !== null };
  });
}

// The customer's link --------------------------------------------------------------------

export async function getInvoiceLinkAction(id: string) {
  return act("invoices.send", (ctx) => getInvoiceLink(ctx, uuid.parse(id)));
}

export async function rotateInvoiceLinkAction(id: string) {
  return act("invoices.send", async (ctx) => {
    await rotateInvoiceLink(ctx, uuid.parse(id));
    return true;
  });
}

// Settings and reminders ---------------------------------------------------------------------

export async function saveInvoiceSettingsAction(patch: unknown, expectedVersion: number) {
  return act("invoices.settings", async (ctx) => ({ version: (await saveInvoiceSettings(ctx, patch, z.number().int().min(0).parse(expectedVersion))).version }));
}

export async function authorizeRemindersAction(input: unknown) {
  return act("invoices.settings", async (ctx) => {
    const i = z.object({ wordingHash: z.string().regex(/^[0-9a-f]{64}$/), settingsVersion: z.number().int().min(0) }).parse(input);
    const o = await authorizeReminders(ctx, i);
    return { active: o.active };
  });
}

export async function switchOffRemindersAction() {
  return act("invoices.send", async (ctx) => {
    await switchOffReminders(ctx);
    return true;
  });
}

// The business's payment account -----------------------------------------------------------------

export async function connectProviderAction(input: unknown) {
  return act("invoices.connect_payments", async (ctx) => {
    const c = await connectProvider(ctx, input);
    return { id: c.id, status: c.status };
  });
}

export async function saveWebhookSecretAction(id: string, input: unknown) {
  return act("invoices.connect_payments", async (ctx) => ({ status: (await saveWebhookSecret(ctx, uuid.parse(id), input)).status }));
}

export async function replaceKeysAction(id: string, input: unknown) {
  return act("invoices.connect_payments", async (ctx) => ({ status: (await replaceCredentials(ctx, uuid.parse(id), input)).status }));
}

export async function recheckConnectionAction(id: string) {
  return act("invoices.connect_payments", async (ctx) => {
    const c = await recheckConnection(ctx, uuid.parse(id));
    return { status: c.status, lastError: c.lastError };
  });
}

export async function confirmLiveAction(id: string) {
  return act("invoices.connect_payments", async (ctx) => ({ liveConfirmedAt: (await confirmLive(ctx, uuid.parse(id))).liveConfirmedAt }));
}

export async function pauseConnectionAction(id: string, paused: boolean) {
  return act("invoices.connect_payments", async (ctx) => ({ status: (await setConnectionPaused(ctx, uuid.parse(id), z.boolean().parse(paused))).status }));
}

export async function disconnectConnectionAction(id: string) {
  return act("invoices.connect_payments", (ctx) => revokeConnection(ctx, uuid.parse(id)));
}

export async function recentDeliveriesAction(id: string) {
  return act("invoices.connect_payments", (ctx) => listRecentDeliveries(ctx, uuid.parse(id)));
}

/** Opens the provider's payment page for one of the owner's own invoices, through an account in test mode. Moves no real money. */
export async function startTestPaymentAction(invoiceId: string) {
  return act("invoices.connect_payments", async (ctx) => ({ url: (await startTestPayment(ctx, uuid.parse(invoiceId))).url }));
}
