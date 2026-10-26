import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { OrgContext } from "@/server/tenancy/context";
import { formatQuantity, toDecimalString, type CurrencyCode } from "@/lib/money";
import type { InvoicePaymentStatus, InvoiceStatus } from "@/lib/invoices/state";
import {
  acceptedForInvoicing, invoiceKeyFor, planInvoiceFromSnapshot, type AcceptanceBasis, type DecisionMethod, type InvoicePlan, type PlanProblem, type RecurringLine, type SignatureState,
} from "@/lib/invoices/from-proposal";
import { assertInvoicesAvailable, invoicesEnabledIn } from "@/server/invoices/feature";
import { createDraftInTx } from "@/server/invoices/invoices";
import { toMinor } from "@/server/invoices/core";
import { featureOn, PROPOSALS_FEATURE } from "@/server/proposals/features";
import { addEvent, loadProposalRow, loadVersionRow, type ProposalRow } from "@/server/proposals/core";

// Making a draft invoice from an accepted proposal. The rules are in src/lib/invoices/from-proposal.ts (what counts as accepted, what is copied, what is left for the owner);
// this file reads the rows and writes the draft. Rules that hold throughout:
//  * The draft is exactly that: a draft. Nothing is issued, sent, reminded about or closed by making it, and a deal linked to the proposal is not touched. It is marked as made from
//    the proposal (created_via "proposal", source_type, source_id and source_version, which the database keeps for good), so, like an invoice a deal or an automation made, an owner
//    or manager has to approve it before it is issued.
//  * The figures are the proposal's saved version's, worked out again with the same money rules and compared with the version's own totals; they are copied through the invoice's
//    own line form, so a draft made here is read by exactly the rules of one typed by hand. If what was stored is not what the plan says, nothing is made.
//  * Once per saved version of the proposal. A second request for the same version finds the first draft instead of making another (the invoice's idempotency key, and the proposal
//    row locked while it is decided). The owner can explicitly ask for another, which takes the next key.
//  * Both sides say so: the invoice carries the proposal's id and version, and the proposal's history has a line naming the invoice.

/** The most invoices an owner can have made from one version of a proposal. A sanity limit, not a business rule. */
export const MAX_INVOICES_PER_PROPOSAL_VERSION = 20;

export interface InvoiceFromProposalLineView {
  description: string;
  quantity: string;
  unitPriceMinor: number;
  discountMinor: number;
  taxRateBps: number | null;
  totalMinor: number;
}

export interface InvoiceMadeFromProposalView {
  id: string;
  /** Null while it is a draft. */
  number: string | null;
  status: InvoiceStatus;
  paymentStatus: InvoicePaymentStatus;
  currency: CurrencyCode;
  totalMinor: number;
  proposalVersion: number;
  createdAt: string;
}

export interface InvoiceFromProposalPreview {
  proposalId: string;
  proposalNumber: string;
  proposalVersion: number;
  currency: string;
  /** Why no invoice can be made from this proposal now, in words the person can act on. Null when one can. */
  problem: { code: string; text: string } | null;
  /** How the proposal came to be accepted, when it is. */
  basis: { code: AcceptanceBasis; text: string } | null;
  lines: InvoiceFromProposalLineView[];
  totals: { subtotalMinor: number; taxMinor: number; totalMinor: number } | null;
  /** The monthly and yearly lines that are not copied. */
  recurring: RecurringLine[];
  notes: string[];
  /** The customer the draft would be for, or null when the proposal is not linked to a customer record (the draft then has none and one is chosen on it). */
  customerName: string | null;
  /** How many invoices were already made from this saved version: a further one needs the owner to ask for it. */
  alreadyForThisVersion: number;
}

export interface ProposalInvoicing {
  /** Invoicing is on for the workspace and the person may see or make invoices. */
  available: boolean;
  canCreate: boolean;
  /** The person may ask for a further invoice from a version that already has one (the owner or a manager: invoices.approve). */
  canMakeAnother: boolean;
  /** What an invoice made now would hold. Null for someone who cannot make one, and for a proposal that is not accepted. */
  preview: InvoiceFromProposalPreview | null;
  /** Every invoice made from this proposal, whatever version, oldest first. Empty for someone who cannot read invoices. */
  existing: InvoiceMadeFromProposalView[];
}

interface ProposalFacts {
  row: ProposalRow;
  acceptance: ReturnType<typeof acceptedForInvoicing>;
  plan: { ok: true; plan: InvoicePlan } | { ok: false; problem: PlanProblem } | null;
}

/** Reads what decides whether an invoice can be made from the proposal: its row, the recorded answer for the version that went out, and that version's frozen snapshot. */
async function factsOf(db: Queryable, row: ProposalRow): Promise<ProposalFacts> {
  const sent = row.sent_version;
  const version = sent === null ? null : await loadVersionRow(db, row.org_id, row.id, sent);
  const decision = sent === null ? undefined : (await db.query<{ decision: string; method: DecisionMethod; version: number; content_hash: string }>(
    `select decision, method, version, content_hash from proposal_decisions where proposal_id = $1 and org_id = $2 and version = $3 and decision = 'accepted' order by decided_at desc, id limit 1`,
    [row.id, row.org_id, sent],
  )).rows[0];
  const acceptance = acceptedForInvoicing({
    status: row.status, version: row.version, sentVersion: sent, requiresSignature: row.requires_signature, signatureState: row.signature_state as SignatureState,
    decision: decision ? { decision: decision.decision, method: decision.method, version: decision.version, contentHash: decision.content_hash } : null, versionContentHash: version?.content_hash ?? null,
  });
  return { row, acceptance, plan: acceptance.ok && version ? planInvoiceFromSnapshot(version.snapshot) : null };
}

async function invoicesMadeFrom(db: Queryable, orgId: string, proposalId: string): Promise<Array<InvoiceMadeFromProposalView & { key: string | null }>> {
  const { rows } = await db.query<{
    id: string; number: string | null; status: InvoiceStatus; payment_status: InvoicePaymentStatus; currency: CurrencyCode; total_minor: string; source_version: number; created_at: Date; idempotency_key: string | null;
  }>(
    `select id, number, status, payment_status, currency, total_minor::text as total_minor, source_version, created_at, idempotency_key
     from customer_invoices where org_id = $1 and source_type = 'proposal' and source_id = $2 order by created_at, id`,
    [orgId, proposalId],
  );
  return rows.map((r) => ({
    id: r.id, number: r.number, status: r.status, paymentStatus: r.payment_status, currency: r.currency, totalMinor: toMinor(r.total_minor), proposalVersion: r.source_version,
    createdAt: new Date(r.created_at).toISOString(), key: r.idempotency_key,
  }));
}

const strip = ({ key: _key, ...rest }: InvoiceMadeFromProposalView & { key: string | null }): InvoiceMadeFromProposalView => rest;

async function customerNameOf(db: Queryable, row: ProposalRow): Promise<string | null> {
  if (!row.contact_id) return null;
  return (await db.query<{ name: string }>(
    "select coalesce(nullif(display_name, ''), email::text, phone, 'Unnamed contact') as name from contacts where id = $1 and org_id = $2 and deleted_at is null and archived_at is null", [row.contact_id, row.org_id],
  )).rows[0]?.name ?? null;
}

function previewOf(f: ProposalFacts, customerName: string | null, alreadyForThisVersion: number): InvoiceFromProposalPreview {
  const base = { proposalId: f.row.id, proposalNumber: f.row.number, proposalVersion: f.row.sent_version ?? f.row.version, currency: f.row.currency, customerName, alreadyForThisVersion };
  const empty = { lines: [], totals: null, recurring: [], notes: [] as string[] };
  if (!f.acceptance.ok) return { ...base, ...empty, problem: { code: f.acceptance.reason, text: f.acceptance.text }, basis: null };
  const basis = { code: f.acceptance.basis, text: f.acceptance.text };
  if (!f.plan) return { ...base, ...empty, problem: { code: "no_saved_version", text: "This proposal's saved version could not be found, so no invoice is made from it. Contact support." }, basis };
  if (!f.plan.ok) return { ...base, ...empty, problem: f.plan.problem, basis };
  const p = f.plan.plan;
  return {
    ...base, problem: null, basis, recurring: p.recurring, notes: p.notes,
    lines: p.lines.map((l) => ({ description: l.description, quantity: formatQuantity(l.quantityMilli), unitPriceMinor: l.unitPriceMinor, discountMinor: l.discountMinor, taxRateBps: l.taxRateBps, totalMinor: l.totalMinor })),
    totals: { subtotalMinor: p.totals.subtotal, taxMinor: p.totals.tax, totalMinor: p.totals.total },
  };
}

const mustReadProposals = (ctx: OrgContext) => {
  if (!ctx.can("proposals.view")) throw new AppError("forbidden", "Your role can't see proposals.");
};

/**
 * What the proposal's page needs to offer an invoice: whether invoicing is on and the person may use it, what an invoice made now would hold (for an accepted proposal, and for
 * someone who may make one), and the invoices already made from this proposal. Reads only; makes nothing.
 */
export async function invoicingForProposal(ctx: OrgContext, proposalId: string): Promise<ProposalInvoicing> {
  return withSystem(async (db) => {
    const none: ProposalInvoicing = { available: false, canCreate: false, canMakeAnother: false, preview: null, existing: [] };
    if (ctx.org.kind !== "client" || !ctx.can("proposals.view") || !(ctx.can("invoices.view") || ctx.can("invoices.create"))) return none;
    if (!(await invoicesEnabledIn(db, ctx.org.orgId)) || !(await featureOn(ctx.org.orgId, PROPOSALS_FEATURE, db))) return none;
    const row = await loadProposalRow(db, ctx.org.orgId, proposalId);
    if (!row) return none;
    const made = ctx.can("invoices.view") ? await invoicesMadeFrom(db, ctx.org.orgId, row.id) : [];
    const canCreate = ctx.can("invoices.create");
    let preview: InvoiceFromProposalPreview | null = null;
    if (canCreate && row.status === "accepted") {
      const facts = await factsOf(db, row);
      // The count is of this version, not of the proposal, and is read even by someone who cannot list invoices: it only decides whether a further one has to be asked for.
      const forVersion = (await db.query<{ n: string }>("select count(*)::text as n from customer_invoices where org_id = $1 and source_type = 'proposal' and source_id = $2 and source_version = $3", [row.org_id, row.id, row.sent_version])).rows[0];
      preview = previewOf(facts, await customerNameOf(db, row), Number(forVersion.n));
    }
    return { available: true, canCreate, canMakeAnother: canCreate && ctx.can("invoices.approve"), preview, existing: made.map(strip) };
  });
}

export interface CreateInvoiceFromProposalInput {
  /** The version of the proposal the person was looking at. */
  version: number;
  /** The owner or a manager explicitly asks for a further invoice from a version that already has one. Anyone else is refused: the first draft is the answer. */
  another?: boolean;
}

export type CreateInvoiceFromProposalResult =
  | { status: "created"; invoiceId: string; lines: number; recurringLines: number }
  | { status: "already"; invoiceId: string; count: number };

/**
 * Makes a draft invoice from an accepted proposal. Refused, with the reason in words, when the proposal is not accepted (or its record does not say how), when it asked for a
 * signature its record does not show, or when its figures cannot be copied. A repeat for the same saved version returns the draft that exists instead of making another, unless
 * the person asks for a further one.
 */
export async function createInvoiceFromProposal(ctx: OrgContext, proposalId: string, input: CreateInvoiceFromProposalInput): Promise<CreateInvoiceFromProposalResult> {
  return withSystem(async (db): Promise<CreateInvoiceFromProposalResult> => {
    await assertInvoicesAvailable(db, ctx);
    if (!ctx.can("invoices.create")) throw new AppError("forbidden", "Your role can't write invoices.");
    mustReadProposals(ctx);
    if (!(await featureOn(ctx.org.orgId, PROPOSALS_FEATURE, db))) throw new AppError("not_enabled", "Proposals aren't switched on for your workspace, so no invoice is made from one.");
    if (!Number.isInteger(input.version) || input.version < 1) throw new AppError("invalid_input", "Look at the proposal again before you make an invoice.");
    // MUTATION-A
    // The proposal row is locked while this is decided: two people pressing the button at once are taken one after the other, and the second finds the first one's draft.
    const row = await loadProposalRow(db, ctx.org.orgId, proposalId, true);
    if (!row) throw new AppError("not_found", "That proposal was not found.");
    if (row.version !== input.version) throw new AppError("conflict", "The proposal changed. Look at the new version before you make an invoice.");
    const facts = await factsOf(db, row);
    if (!facts.acceptance.ok) throw new AppError("conflict", facts.acceptance.text);
    if (!facts.plan) throw new AppError("conflict", "This proposal's saved version could not be found, so no invoice is made from it. Contact support.");
    if (!facts.plan.ok) throw new AppError("invalid_input", facts.plan.problem.text);
    const plan = facts.plan.plan;
    const version = row.sent_version as number;

    const made = (await invoicesMadeFrom(db, ctx.org.orgId, row.id)).filter((i) => i.proposalVersion === version);
    if (made.length) {
      // A plain repeat finds the draft that exists. A further one is a deliberate act by someone who may approve invoices, never an accidental second click.
      if (!input.another) return { status: "already", invoiceId: made[0].id, count: made.length };
      if (!ctx.can("invoices.approve")) throw new AppError("forbidden", "Only the business owner or a manager can ask for another invoice from this version of the proposal.");
    }
    if (made.length >= MAX_INVOICES_PER_PROPOSAL_VERSION) throw new AppError("conflict", `${made.length} invoices were already made from this version of the proposal. Work from one of those.`);
    // The key of the first invoice of a version is its base; each further one takes the first number that is free, because a draft that was discarded frees its key.
    const taken = new Set(made.map((i) => i.key));
    let ordinal = 0;
    while (taken.has(invoiceKeyFor(row.id, version, ordinal))) ordinal += 1;

    // A customer, company or deal that is gone (removed, archived) is left off the draft instead of stopping it: the person chooses on the draft.
    const contact = row.contact_id && (await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null", [row.contact_id, row.org_id])).rows[0] ? row.contact_id : null;
    const company = row.company_id && (await db.query("select 1 from crm_companies where id = $1 and org_id = $2 and deleted_at is null", [row.company_id, row.org_id])).rows[0] ? row.company_id : null;
    // A deal is kept only if it fits the invoice's own rule that a deal belongs to the invoice's customer; otherwise it is left off like a customer that is gone.
    const dealRow = row.opportunity_id ? (await db.query<{ contact_id: string | null }>("select contact_id from crm_opportunities where id = $1 and org_id = $2 and archived_at is null", [row.opportunity_id, row.org_id])).rows[0] : undefined;
    const dealsCustomer = dealRow?.contact_id ?? null;
    const dealFits = dealRow !== undefined && (contact ? dealsCustomer === null || dealsCustomer === contact : dealsCustomer === null || Boolean((await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null", [dealsCustomer, row.org_id])).rows[0]));
    const deal = dealFits ? row.opportunity_id : null;

    const recurringDetail = plan.recurring.slice(0, 8).map((r) => ({ name: r.name.slice(0, 50), billing: r.billing, totalMinor: r.totalMinor }));
    const drafted = await createDraftInTx(db, ctx, {
      contactId: contact, companyId: company, opportunityId: deal, currency: plan.currency, taxInclusive: false, lines: plan.lines.map((l) => l.form), closesDeal: false,
      idempotencyKey: invoiceKeyFor(row.id, version, ordinal),
    }, {
      source: {
        type: "proposal", id: row.id, version,
        eventDetail: { proposalId: row.id, proposalNumber: row.number, proposalVersion: version, recurringLines: plan.recurring.length, recurring: recurringDetail, basis: facts.acceptance.basis, ...(ordinal > 0 ? { another: true } : {}) },
      },
    });
    if (!drafted.created) {
      // A twin request took the same key between the check above and the insert, which the lock should have made impossible: it is the same invoice.
      return { status: "already", invoiceId: drafted.detail.invoice.id, count: made.length + 1 };
    }
    // What was stored is what the plan said, to the minor unit: the plan was worked out from the saved version, the draft was read back through the invoice form's own rules.
    const inv = drafted.detail.invoice;
    if (inv.currency !== plan.currency || inv.subtotalMinor !== plan.totals.subtotal || inv.taxMinor !== plan.totals.tax || inv.totalMinor !== plan.totals.total || drafted.detail.lines.length !== plan.lines.length) {
      throw new AppError("internal", "The draft's figures were not what the proposal's saved version says, so it was not made. Contact support.");
    }
    await addEvent(db, ctx.org.orgId, row.id, version, "invoice_drafted", { id: ctx.user.id, kind: "user" }, { invoiceId: inv.id, lines: plan.lines.length, recurringLines: plan.recurring.length, basis: facts.acceptance.basis });
    await recordAudit({
      orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "invoice.drafted_from_proposal", targetType: "customer_invoice", targetId: inv.id, result: "success",
      metadata: { proposalId: row.id, proposalNumber: row.number, proposalVersion: version, lines: plan.lines.length, recurringLines: plan.recurring.length, total: toDecimalString(plan.totals.total, plan.currency), currency: plan.currency, basis: facts.acceptance.basis, another: ordinal > 0 },
    }, db);
    return { status: "created", invoiceId: inv.id, lines: plan.lines.length, recurringLines: plan.recurring.length };
  });
}
