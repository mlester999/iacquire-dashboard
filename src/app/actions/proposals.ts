"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import type { Permission } from "@/lib/permissions";
import { BILLINGS } from "@/lib/proposals/doc";
import { draftProposalWithAi } from "@/server/proposals/ai";
import { createCatalogItem, createTaxRate, updateCatalogItem, updateTaxRate } from "@/server/proposals/catalog";
import {
  createProposal, decideProposal, duplicateProposal, recordOfflineDecision, reviseProposal, sendProposal, submitForApproval, updateProposal, withdrawProposal,
} from "@/server/proposals/proposals";
import { searchDealsForProposal } from "@/server/proposals/search";
import { getShareUrl, renewShareLink } from "@/server/proposals/share";
import { saveProposalSettings } from "@/server/proposals/settings";
import { approveTemplate, archiveTemplate, createTemplate, saveTemplate } from "@/server/proposals/templates";

// Server actions for proposals (/proposals). Every rule, and every permission check, lives in src/server/proposals; these parse the input, resolve who is acting and refresh the
// screens. The price book, tax rates and templates also take the client's id so an agency person inside an audited support session can set them up as a service; everything else
// is for the client's own team (the service refuses anyone else, whatever is passed here).

const uuid = z.string().uuid({ error: "That item was not found." });
const orgArg = z.string().uuid().nullable().optional();

function refresh(actor: CrmActor) {
  revalidatePath("/proposals", "layout");
  // A contact's or deal's page lists its proposals.
  revalidatePath("/crm", "layout");
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

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const discount = z.union([
  z.object({ kind: z.literal("percent"), bps: z.number().int() }),
  z.object({ kind: z.literal("fixed"), minor: z.number().int() }),
]).nullable();

const line = z.object({
  id: z.string().max(40).optional(),
  catalogItemId: uuid.nullable(),
  name: z.string().max(400),
  description: z.string().max(4000),
  unitLabel: z.string().max(100),
  quantityMilli: z.number().int(),
  unitPriceMinor: z.number().int(),
  billing: z.enum(BILLINGS),
  taxRateId: uuid.nullable(),
  discount,
  note: z.string().max(1000),
});

const doc = z.object({
  sections: z.array(z.object({ id: z.string().max(40).optional(), heading: z.string().max(400), body: z.string().max(12_000).optional() })).max(60).optional(),
  lines: z.array(line).max(200).optional(),
  terms: z.string().max(24_000).optional(),
});

const patch = z.object({
  title: z.string().max(400).optional(),
  clientName: z.string().max(400).optional(),
  clientCompany: z.string().max(400).optional(),
  clientEmail: z.string().max(400).nullable().optional(),
  validUntil: z.string().max(10).nullable().optional(),
  requiresSignature: z.boolean().optional(),
  currency: z.string().max(10).optional(),
  internalNotes: z.string().max(8000).nullable().optional(),
  contactId: uuid.nullable().optional(),
  companyId: uuid.nullable().optional(),
  opportunityId: uuid.nullable().optional(),
  ownerId: uuid.nullable().optional(),
  doc: doc.optional(),
});

const create = patch.pick({ title: true, clientName: true, clientCompany: true, clientEmail: true, validUntil: true, requiresSignature: true, currency: true, contactId: true, companyId: true, opportunityId: true })
  .extend({ templateId: uuid.nullable().optional() });

export async function searchDealsAction(q: string) {
  return act(null, "proposals.create", (actor) => searchDealsForProposal(actor, z.string().max(80).parse(q)), { refresh: false });
}

export async function createProposalAction(input: unknown) {
  return act(null, "proposals.create", async (actor) => ({ id: (await createProposal(actor, create.parse(input))).id }));
}

const aiInput = z.object({
  contactId: uuid.nullable().optional(), companyId: uuid.nullable().optional(), opportunityId: uuid.nullable().optional(), templateId: uuid.nullable().optional(),
  currency: z.string().max(10).optional(), brief: z.string().max(2000).nullable().optional(),
});

/** Asks the language model for a first draft. The result is a saved draft that still has to be approved by a person; what the checks removed comes back so it can be shown. */
export async function draftWithAiAction(input: unknown) {
  return act(null, "proposals.create", async (actor) => {
    const out = await draftProposalWithAi(actor, aiInput.parse(input));
    return { id: out.proposal.id, runId: out.runId, dropped: out.dropped.slice(0, 30), droppedCount: out.dropped.length, rejectedItems: out.rejectedItems };
  });
}

export async function updateProposalAction(id: string, input: unknown, expectedVersion: number) {
  return act(null, "proposals.create", (actor) => updateProposal(actor, uuid.parse(id), patch.parse(input), z.number().int().min(1).parse(expectedVersion)));
}

export async function submitForApprovalAction(id: string) {
  return act(null, "proposals.create", (actor) => submitForApproval(actor, uuid.parse(id)));
}

const decision = z.object({ decision: z.enum(["approve", "request_changes", "reject"]), version: z.number().int().min(1), note: z.string().max(600).nullish() });
export async function decideProposalAction(id: string, input: unknown) {
  return act(null, "proposals.approve", (actor) => decideProposal(actor, uuid.parse(id), decision.parse(input)));
}

export async function sendProposalAction(id: string, version: number) {
  return act(null, "proposals.send", (actor) => sendProposal(actor, uuid.parse(id), { version: z.number().int().min(1).parse(version) }));
}

export async function withdrawProposalAction(id: string) {
  return act(null, "proposals.view", (actor) => withdrawProposal(actor, uuid.parse(id)));
}

export async function reviseProposalAction(id: string) {
  return act(null, "proposals.create", (actor) => reviseProposal(actor, uuid.parse(id)));
}

export async function duplicateProposalAction(id: string) {
  return act(null, "proposals.create", async (actor) => ({ id: (await duplicateProposal(actor, uuid.parse(id))).id }));
}

const offline = z.object({
  decision: z.enum(["accepted", "declined"]), note: z.string().max(2000).nullish(), decidedName: z.string().max(400).nullish(), decidedEmail: z.string().max(400).nullish(),
  version: z.number().int().min(1).optional(),
});
export async function recordOfflineDecisionAction(id: string, input: unknown) {
  return act(null, "proposals.record_decision", (actor) => recordOfflineDecision(actor, uuid.parse(id), offline.parse(input)));
}

// ---------------------------------------------------------------------------
// The customer's link
// ---------------------------------------------------------------------------

/** The address to give the customer. It is returned to the person who asked and shown on screen; it is never logged, audited or kept in a message. */
export async function getShareUrlAction(id: string) {
  return act(null, "proposals.send", (actor) => getShareUrl(actor, uuid.parse(id)), { refresh: false });
}

export async function renewShareLinkAction(id: string) {
  return act(null, "proposals.send", (actor) => renewShareLink(actor, uuid.parse(id)));
}

// ---------------------------------------------------------------------------
// Settings, price book, tax rates and templates
// ---------------------------------------------------------------------------

const settingsPatch = z.object({
  aiDraftsEnabled: z.boolean().optional(),
  approvalMode: z.enum(["ai_and_discounts", "all"]).optional(),
  approvalOverMinor: z.number().int().nullable().optional(),
  discountNeedsApproval: z.boolean().optional(),
  twoPerson: z.boolean().optional(),
  defaultValidityDays: z.number().int().nullable().optional(),
  tagOnSendId: uuid.nullable().optional(),
  stageOnSendId: uuid.nullable().optional(),
  dealOnAccept: z.enum(["none", "won_stage"]).optional(),
});

export async function saveProposalSettingsAction(input: unknown, expectedVersion: number) {
  return act(null, "proposals.settings", (actor) => saveProposalSettings(actor, settingsPatch.parse(input), z.number().int().min(0).parse(expectedVersion)));
}

const taxRate = z.object({ name: z.string().max(200), rateBps: z.number() });
export async function createTaxRateAction(orgId: string | null, input: unknown) {
  return act(orgId, "proposals.catalog", (actor) => createTaxRate(actor, taxRate.parse(input)));
}
export async function updateTaxRateAction(orgId: string | null, id: string, input: unknown) {
  return act(orgId, "proposals.catalog", (actor) => updateTaxRate(actor, uuid.parse(id), taxRate.partial().extend({ archived: z.boolean().optional() }).parse(input)));
}

const item = z.object({
  name: z.string().max(400), description: z.string().max(4000).optional(), unitLabel: z.string().max(100).optional(), unitPriceMinor: z.number().int(), currency: z.string().max(10),
  billing: z.enum(BILLINGS).optional(), taxRateId: uuid.nullable().optional(),
});
export async function createCatalogItemAction(orgId: string | null, input: unknown) {
  return act(orgId, "proposals.catalog", (actor) => createCatalogItem(actor, item.parse(input)));
}
export async function updateCatalogItemAction(orgId: string | null, id: string, input: unknown, expectedVersion: number) {
  return act(orgId, "proposals.catalog", (actor) => updateCatalogItem(actor, uuid.parse(id), item.partial().extend({ archived: z.boolean().optional() }).parse(input), z.number().int().min(1).parse(expectedVersion)));
}

const templateDoc = z.object({
  sections: z.array(z.object({ id: z.string().max(40).optional(), heading: z.string().max(400), body: z.string().max(12_000).optional() })).max(60).optional(),
  lines: z.array(z.object({ id: z.string().max(40).optional(), catalogItemId: uuid, quantityMilli: z.number().int(), note: z.string().max(1000).optional() })).max(200).optional(),
  terms: z.string().max(24_000).optional(),
});
export async function createTemplateAction(orgId: string | null, input: unknown) {
  return act(orgId, "proposals.catalog", async (actor) => {
    const i = z.object({ name: z.string().max(400), doc: templateDoc.optional() }).parse(input);
    return { id: (await createTemplate(actor, i)).id };
  });
}
export async function saveTemplateAction(orgId: string | null, id: string, input: unknown, expectedVersion: number) {
  return act(orgId, "proposals.catalog", (actor) => saveTemplate(actor, uuid.parse(id), z.object({ name: z.string().max(400).optional(), doc: templateDoc.optional() }).parse(input), z.number().int().min(1).parse(expectedVersion)));
}
/** Approving a template is the owner's: the agency can build one for a client, but the wording is the business's to stand behind. */
export async function approveTemplateAction(id: string, version: number) {
  return act(null, "proposals.settings", (actor) => approveTemplate(actor, uuid.parse(id), z.number().int().min(1).parse(version)));
}
export async function archiveTemplateAction(orgId: string | null, id: string) {
  return act(orgId, "proposals.catalog", async (actor) => {
    await archiveTemplate(actor, uuid.parse(id));
    return true;
  });
}
