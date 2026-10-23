import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles, notifyUser } from "@/server/notifications";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner } from "@/server/crm/workspace";
import { assertAssignable } from "@/server/crm/contacts";
import { isCurrency } from "@/lib/money";
import { sanitizeErrorText } from "@/lib/ops";
import { canonicalJson, emptyDoc, parseTemplateDoc, type ProposalDoc } from "@/lib/proposals/doc";
import { computeDocTotals, groupGrandTotals, lowersPrice, type GroupTotals } from "@/lib/proposals/money";
import { needsDiscountPermission, priceChanges } from "@/lib/proposals/lines";
import { blockingFor } from "@/lib/proposals/problems";
import { APPROVAL_REASON_TEXT, approvalReasons, canTransition, isEditable, isRevisable, selfApprovalAllowed, STATUS_LABELS, type ProposalStatus } from "@/lib/proposals/state";
import { addDays, isDay, todayIn } from "@/lib/proposals/validity";
import { addEvent, asAppError, authorCanSend, loadProposalRow, nameOf, nextNumber, PROPOSAL_COLUMNS, readSettings, rowDoc, type EventActor, type ProposalRow, type SettingsRow } from "@/server/proposals/core";
import { assertProposalsEnabled } from "@/server/proposals/features";
import { buildDoc, docFromTemplate, type DocInput } from "@/server/proposals/doc-build";
import { applyEffects } from "@/server/proposals/crm-effects";
import { ensureVersionPdf, type ProposalPdfRenderer } from "@/server/proposals/documents";
import { createShareLinkInTx } from "@/server/proposals/share";
import { voidLiveRequestsInTx } from "@/server/esign/lifecycle";
import { assertVersionIntact, checkProposal, ensureVersion } from "@/server/proposals/versions";
import { buildDetail, LIST_COLUMNS_SQL, namesOf, toSummary, type ProposalDetail, type ProposalSummary } from "@/server/proposals/view";

// Writing a proposal, getting it approved, sending it, and every way it can be stopped, revised or answered. The server decides everything here; the interface only reads
// the result. An approval is of one version: any change to what the customer will see makes a new version and voids it. Nothing here contacts the customer: a sent proposal is
// a status, a frozen version, the customer's link and (made right after the send is saved) the version's PDF. The team copies the link and gives it to the customer; the
// customer's side (the page, the emailed code, the answer) is src/server/proposals/public.ts.

export interface Deps {
  now?: Date;
  /** Tests replace the PDF writer. */
  renderer?: ProposalPdfRenderer;
}

/** The signed-in person behind a write. Agents, the API and the system never write proposals in this build; agency staff only set up the price book. */
function member(actor: CrmActor): string {
  if (actor.kind !== "member" || !actor.userId) throw new AppError("forbidden", "Only a signed-in member of the workspace can do this.");
  return actor.userId;
}

const asUser = (userId: string): EventActor => ({ id: userId, kind: "user" });
const canEditRow = (actor: CrmActor, row: ProposalRow): boolean =>
  actor.can("proposals.create") && (row.created_by === actor.userId || row.owner_user_id === actor.userId || actor.can("proposals.approve"));

function notAllowed(row: ProposalRow, what: string): AppError {
  return new AppError("conflict", `A proposal that is ${STATUS_LABELS[row.status].toLowerCase()} can't be ${what}.`);
}

const NOT_EDITABLE: Partial<Record<ProposalStatus, string>> = {
  sent: "This proposal has been sent. Revise it to change it.",
  accepted: "An accepted proposal can't be changed. Duplicate it to start a new one.",
  declined: "This proposal was declined. Revise it to change it.",
  expired: "This proposal expired. Revise it to change it.",
  withdrawn: "This proposal was withdrawn. Revise it to change it.",
  rejected: "This proposal was rejected. Duplicate it to start again.",
};

async function lockOrThrow(db: Queryable, actor: CrmActor, id: string): Promise<ProposalRow> {
  const row = await loadProposalRow(db, actor.orgId, id, true);
  if (!row) throw new AppError("not_found", "That proposal was not found.");
  return row;
}

async function workspaceTimezone(db: Queryable, orgId: string): Promise<string> {
  return (await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [orgId])).rows[0]?.timezone ?? "UTC";
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ProposalFilter {
  statuses?: ProposalStatus[];
  contactId?: string;
  opportunityId?: string;
  ownerId?: string;
  search?: string;
  limit?: number;
}

export async function listProposals(actor: CrmActor, f: ProposalFilter = {}): Promise<ProposalSummary[]> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.view", "Your role can't see proposals.");
  return crmRead(actor, async (db) => {
    const where = ["org_id = $1"];
    const params: unknown[] = [actor.orgId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (f.statuses?.length) add("status = any(?::text[])", f.statuses);
    if (f.contactId) add("contact_id = ?", f.contactId);
    if (f.opportunityId) add("opportunity_id = ?", f.opportunityId);
    if (f.ownerId) add("owner_user_id = ?", f.ownerId);
    const search = f.search?.trim().replace(/[%_\\]/g, "");
    if (search) add("(number ilike '%' || ? || '%' or title ilike '%' || ? || '%' or client_name ilike '%' || ? || '%')".replaceAll("?", `$${params.length + 1}`), search);
    const { rows } = await db.query<ProposalRow>(`select ${LIST_COLUMNS_SQL(PROPOSAL_COLUMNS)} from proposals where ${where.join(" and ")} order by created_at desc, number desc limit ${Math.min(f.limit ?? 200, 500)}`, params);
    const names = await namesOf(db, rows.map((r) => r.owner_user_id));
    return rows.map((r) => toSummary(r, names));
  });
}

export async function getProposal(actor: CrmActor, id: string, deps: Deps = {}): Promise<ProposalDetail> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.view", "Your role can't see proposals.");
  return crmRead(actor, async (db) => {
    const row = await loadProposalRow(db, actor.orgId, id);
    if (!row) throw new AppError("not_found", "That proposal was not found.");
    return buildDetail(db, actor, row, deps.now);
  });
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export interface CreateInput {
  title?: string;
  contactId?: string | null;
  companyId?: string | null;
  opportunityId?: string | null;
  templateId?: string | null;
  currency?: string;
  clientName?: string;
  clientCompany?: string;
  clientEmail?: string | null;
  validUntil?: string | null;
  requiresSignature?: boolean;
  doc?: DocInput;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function cleanLine(text: string | undefined | null, max: number, what: string): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length > max) throw new AppError("invalid_input", `${what} can be at most ${max} characters.`);
  return t;
}

function cleanEmail(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  if (!e) return null;
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new AppError("invalid_input", "That email address doesn't look right.");
  return e;
}

function cleanTitle(title: string | undefined): string {
  const t = cleanLine(title, 160, "The title");
  if (!t) throw new AppError("invalid_input", "Give the proposal a title.");
  return t;
}

function cleanValidUntil(v: string | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (!isDay(v)) throw new AppError("invalid_input", "The valid-until date must be a real date, like 2026-11-30.");
  return v;
}

function cleanCurrency(c: string): string {
  const code = c.trim().toUpperCase();
  if (!isCurrency(code)) throw new AppError("invalid_input", `${c || "That currency"} isn't one iAcquire can total. Choose another.`);
  return code;
}

export interface Links {
  contact: { id: string; name: string; email: string | null } | null;
  company: { id: string; name: string } | null;
  deal: { id: string; name: string; currency: string; contactId: string | null; companyId: string | null } | null;
}

/**
 * The contact, company and deal a proposal points at, all looked up in THIS workspace: an id from another workspace is "not found", exactly like one that does not exist.
 * `derive` fills a missing contact and company from the deal (a new proposal); `nativeCheck` asks whether deals are managed here (only when a deal is being linked).
 */
export async function resolveLinks(db: Queryable, orgId: string, input: { contactId?: string | null; companyId?: string | null; opportunityId?: string | null }, opts: { derive: boolean; nativeCheck: boolean }): Promise<Links> {
  let deal: Links["deal"] = null;
  if (input.opportunityId) {
    if (opts.nativeCheck) await assertNativeOwner(db, orgId, "opportunities");
    const d = (await db.query<{ id: string; name: string; currency: string; contact_id: string | null; company_id: string | null }>(
      "select id, name, currency, contact_id, company_id from crm_opportunities where id = $1 and org_id = $2 and provider = 'native' and archived_at is null", [input.opportunityId, orgId],
    )).rows[0];
    if (!d) throw new AppError("not_found", "Deal not found.");
    deal = { id: d.id, name: d.name, currency: d.currency, contactId: d.contact_id, companyId: d.company_id };
    if (input.contactId && d.contact_id && input.contactId !== d.contact_id) throw new AppError("invalid_input", "That deal belongs to a different contact.");
  }
  const contactId = input.contactId ?? (opts.derive ? deal?.contactId : null) ?? null;
  const companyId = input.companyId ?? (opts.derive ? deal?.companyId : null) ?? null;
  let contact: Links["contact"] = null;
  if (contactId) {
    const c = (await db.query<{ id: string; display_name: string; email: string | null }>("select id, display_name, email::text as email from contacts where id = $1 and org_id = $2 and deleted_at is null", [contactId, orgId])).rows[0];
    if (!c) throw new AppError("not_found", "Contact not found.");
    contact = { id: c.id, name: c.display_name, email: c.email };
  }
  let company: Links["company"] = null;
  if (companyId) {
    const c = (await db.query<{ id: string; name: string }>("select id, name from crm_companies where id = $1 and org_id = $2 and deleted_at is null", [companyId, orgId])).rows[0];
    if (!c) throw new AppError("not_found", "Company not found.");
    company = c;
  }
  return { contact, company, deal };
}

/** An approved template at its approved version, as a document. A template nobody approved cannot be used: its wording has not been reviewed. */
export async function loadApprovedTemplate(db: Queryable, orgId: string, id: string) {
  const t = (await db.query<{ id: string; status: string; approved_version: number | null }>("select id, status, approved_version from proposal_templates where id = $1 and org_id = $2", [id, orgId])).rows[0];
  if (!t) throw new AppError("not_found", "That template was not found.");
  if (t.status !== "approved" || t.approved_version === null) throw new AppError("invalid_input", "Choose an approved template. The owner approves a template before anyone sends from it.");
  const v = (await db.query<{ doc: unknown }>("select doc from proposal_template_versions where template_id = $1 and org_id = $2 and version = $3", [id, orgId, t.approved_version])).rows[0];
  const parsed = parseTemplateDoc(v?.doc);
  if (!parsed.ok) throw new AppError("internal", "That template could not be read. Contact support.");
  return { id: t.id, version: t.approved_version, doc: parsed.value };
}

function totalsFor(doc: ProposalDoc): { totals: Record<"one_time" | "monthly" | "yearly", number>; groups: GroupTotals } {
  try {
    const { groups } = computeDocTotals(doc.lines);
    return { totals: groupGrandTotals(groups), groups };
  } catch (e) {
    throw asAppError(e);
  }
}

/** The currency a new proposal is in: the one asked for, else the deal's, else the workspace's own, else US dollars. It must be one iAcquire can total. */
export async function draftCurrency(db: Queryable, orgId: string, asked: string | undefined, links: Pick<Links, "deal">): Promise<string> {
  if (asked !== undefined) return cleanCurrency(asked);
  if (links.deal && isCurrency(links.deal.currency)) return links.deal.currency;
  const ws = (await db.query<{ default_currency: string }>("select default_currency from crm_workspaces where org_id = $1", [orgId])).rows[0];
  return ws && isCurrency(ws.default_currency) ? ws.default_currency : "USD";
}

/**
 * Inserts a draft. The caller has made its permission checks. `origin: "ai"` is only ever passed by the AI drafting path; a person's proposal is "human". Whoever created
 * it owns it, and whatever its origin, it starts as a draft with no approval.
 */
export async function insertProposalDraft(db: Queryable, actor: CrmActor, input: CreateInput, origin: "human" | "ai", aiRunId: string | null = null, deps: Deps = {}): Promise<ProposalRow> {
  const now = deps.now ?? new Date();
  const links = await resolveLinks(db, actor.orgId, input, { derive: true, nativeCheck: true });
  const currency = await draftCurrency(db, actor.orgId, input.currency, links);
  const settings = await readSettings(db, actor.orgId);
  const tz = await workspaceTimezone(db, actor.orgId);
  const clientName = cleanLine(input.clientName ?? links.contact?.name, 160, "The customer's name");
  const title = cleanTitle(input.title ?? (links.deal ? `Proposal for ${links.deal.name}` : clientName ? `Proposal for ${clientName}` : "New proposal"));
  let doc = emptyDoc();
  let template: { id: string; version: number } | null = null;
  if (input.templateId) {
    const t = await loadApprovedTemplate(db, actor.orgId, input.templateId);
    doc = await docFromTemplate(db, actor.orgId, t.doc, currency);
    template = { id: t.id, version: t.version };
  }
  if (input.doc) doc = await buildDoc(db, actor.orgId, input.doc, doc, currency);
  // A new proposal starts with no saved lines, so any discount or price off the price book in what was submitted is new.
  if (needsDiscountPermission(priceChanges([], doc.lines)) && !actor.can("proposals.discount")) {
    throw new AppError("forbidden", "Giving a discount or changing a price book price needs the discount permission, which the business owner or a manager has.");
  }
  const { totals } = totalsFor(doc);
  const validUntil = input.validUntil !== undefined ? cleanValidUntil(input.validUntil) : settings.defaultValidityDays ? addDays(todayIn(tz, now), settings.defaultValidityDays) : null;
  const number = await nextNumber(db, actor.orgId);
  const { rows } = await db.query<{ id: string }>(
    `insert into proposals (org_id, number, title, contact_id, company_id, opportunity_id, template_id, template_version, owner_user_id, currency, valid_until, requires_signature, client_name, client_company,
       client_email, doc, one_time_total_minor, monthly_total_minor, yearly_total_minor, origin, ai_run_id, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12, $13, $14, $15, $16::jsonb, $17, $18, $19, $20, $21, $22) returning id`,
    [
      actor.orgId, number, title, links.contact?.id ?? null, links.company?.id ?? null, links.deal?.id ?? null, template?.id ?? null, template?.version ?? null, actor.userId, currency, validUntil,
      input.requiresSignature === true, clientName, cleanLine(input.clientCompany ?? links.company?.name, 160, "The customer's company"), cleanEmail(input.clientEmail !== undefined ? input.clientEmail : links.contact?.email),
      JSON.stringify(doc), totals.one_time, totals.monthly, totals.yearly, origin, aiRunId, actor.userId,
    ],
  );
  const row = (await loadProposalRow(db, actor.orgId, rows[0].id)) as ProposalRow;
  if (origin === "ai") await addEvent(db, actor.orgId, row.id, 1, "ai_drafted", { id: null, kind: "ai" }, { aiRunId, requestedBy: actor.userId });
  else await addEvent(db, actor.orgId, row.id, 1, "created", asUser(actor.userId as string), { template: template ? { id: template.id, version: template.version } : null, dealId: links.deal?.id ?? null });
  return row;
}

export async function createProposal(actor: CrmActor, input: CreateInput = {}, deps: Deps = {}): Promise<ProposalDetail> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.create", "Your role can't write proposals.");
  member(actor);
  return crmWrite(actor, async (db) => {
    const row = await insertProposalDraft(db, actor, input, "human", null, deps);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.created", targetType: "proposal", targetId: row.id, result: "success", metadata: { number: row.number } }, db);
    return buildDetail(db, actor, row, deps.now);
  });
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export interface UpdateInput {
  title?: string;
  clientName?: string;
  clientCompany?: string;
  clientEmail?: string | null;
  validUntil?: string | null;
  requiresSignature?: boolean;
  currency?: string;
  doc?: DocInput;
  internalNotes?: string | null;
  contactId?: string | null;
  companyId?: string | null;
  opportunityId?: string | null;
  ownerId?: string | null;
}

const contentKey = (r: { title: string; currency: string; validUntil: string | null; requiresSignature: boolean; clientName: string; clientCompany: string; clientEmail: string | null }, doc: ProposalDoc) => canonicalJson({ ...r, doc });

/**
 * Changes a proposal. If anything the customer will see changes, the version goes up and any approval is void: an approved or waiting proposal goes back to a draft. A sent
 * proposal is not edited, it is revised. `expectedVersion` stops two people overwriting each other. Discounts and prices off the price book need the discount permission.
 */
export async function updateProposal(actor: CrmActor, id: string, patch: UpdateInput, expectedVersion: number, deps: Deps = {}): Promise<ProposalDetail> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.create", "Your role can't write proposals.");
  const userId = member(actor);
  return crmWrite(actor, async (db) => {
    const row = await lockOrThrow(db, actor, id);
    if (!canEditRow(actor, row)) throw new AppError("forbidden", "Only the person who wrote this proposal, or a manager, can change it.");
    if (row.version !== expectedVersion) throw new AppError("conflict", "Someone changed this proposal. Reload to see their changes, then try again.");
    if (!isEditable(row.status)) throw new AppError("conflict", NOT_EDITABLE[row.status] ?? "This proposal can't be edited right now.");
    const doc = rowDoc(row);
    const currency = patch.currency !== undefined ? cleanCurrency(patch.currency) : row.currency;
    if (currency !== row.currency && doc.lines.length) throw new AppError("conflict", "Remove the lines before changing the currency, or start a new proposal in that currency.");
    const nextDoc = patch.doc ? await buildDoc(db, actor.orgId, patch.doc, doc, currency) : doc;
    if (needsDiscountPermission(priceChanges(doc.lines, nextDoc.lines)) && !actor.can("proposals.discount")) {
      throw new AppError("forbidden", "Giving a discount or changing a price book price needs the discount permission, which the business owner or a manager has.");
    }
    const { totals } = totalsFor(nextDoc);
    const dealChanged = patch.opportunityId !== undefined && patch.opportunityId !== row.opportunity_id;
    const links = await resolveLinks(db, actor.orgId, {
      contactId: patch.contactId !== undefined ? patch.contactId : row.contact_id, companyId: patch.companyId !== undefined ? patch.companyId : row.company_id,
      opportunityId: patch.opportunityId !== undefined ? patch.opportunityId : row.opportunity_id,
    }, { derive: false, nativeCheck: dealChanged });
    let ownerId = row.owner_user_id;
    if (patch.ownerId !== undefined && patch.ownerId !== row.owner_user_id) {
      if (patch.ownerId !== userId && !actor.can("proposals.approve")) throw new AppError("forbidden", "Only the business owner or a manager can hand a proposal to someone else.");
      if (patch.ownerId) await assertAssignable(db, actor.orgId, patch.ownerId);
      ownerId = patch.ownerId;
    }
    const next = {
      title: patch.title !== undefined ? cleanTitle(patch.title) : row.title, currency,
      validUntil: patch.validUntil !== undefined ? cleanValidUntil(patch.validUntil) : row.valid_until, requiresSignature: patch.requiresSignature ?? row.requires_signature,
      clientName: patch.clientName !== undefined ? cleanLine(patch.clientName, 160, "The customer's name") : row.client_name,
      clientCompany: patch.clientCompany !== undefined ? cleanLine(patch.clientCompany, 160, "The customer's company") : row.client_company,
      clientEmail: patch.clientEmail !== undefined ? cleanEmail(patch.clientEmail) : row.client_email,
    };
    const noteText = patch.internalNotes !== undefined ? (patch.internalNotes ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim() : null;
    if (noteText && noteText.length > 4000) throw new AppError("invalid_input", "Internal notes can be at most 4,000 characters.");
    const internalNotes = patch.internalNotes !== undefined ? noteText || null : row.internal_notes;
    const contentChanged = contentKey({ title: row.title, currency: row.currency, validUntil: row.valid_until, requiresSignature: row.requires_signature, clientName: row.client_name, clientCompany: row.client_company, clientEmail: row.client_email }, doc)
      !== contentKey(next, nextDoc);
    const linksChanged = links.contact?.id !== row.contact_id || links.company?.id !== row.company_id || links.deal?.id !== row.opportunity_id;
    const other = internalNotes !== row.internal_notes || ownerId !== row.owner_user_id || linksChanged;
    if (!contentChanged && !other) return buildDetail(db, actor, row, deps.now);
    const resets = contentChanged && (row.status === "pending_approval" || row.status === "approved");
    await db.query(
      `update proposals set title = $3, currency = $4, valid_until = $5::date, requires_signature = $6, client_name = $7, client_company = $8, client_email = $9, doc = $10::jsonb,
         one_time_total_minor = $11, monthly_total_minor = $12, yearly_total_minor = $13, internal_notes = $14, contact_id = $15, company_id = $16, opportunity_id = $17, owner_user_id = $18,
         version = version + $19::int, status = $20,
         approved_version = case when $21::boolean then null else approved_version end, approved_by = case when $21::boolean then null else approved_by end, approved_at = case when $21::boolean then null else approved_at end,
         decision_note = case when $22::boolean then null else decision_note end
       where id = $1 and org_id = $2`,
      [
        id, actor.orgId, next.title, next.currency, next.validUntil, next.requiresSignature, next.clientName, next.clientCompany, next.clientEmail, JSON.stringify(nextDoc), totals.one_time, totals.monthly, totals.yearly,
        internalNotes, links.contact?.id ?? null, links.company?.id ?? null, links.deal?.id ?? null, ownerId, contentChanged ? 1 : 0, resets ? "draft" : row.status, contentChanged, resets,
      ],
    );
    if (contentChanged) await db.query("update proposal_versions set superseded_at = now() where proposal_id = $1 and org_id = $2 and version < $3 and superseded_at is null", [id, actor.orgId, row.version + 1]);
    await addEvent(db, actor.orgId, id, contentChanged ? row.version + 1 : row.version, "edited", asUser(userId), { content: contentChanged, other, approvalVoided: resets && row.approved_version !== null });
    return buildDetail(db, actor, (await loadProposalRow(db, actor.orgId, id)) as ProposalRow, deps.now);
  });
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

/** Sends a draft for approval. The version is frozen now, so the reviewer sees exactly what will go out. Blocking problems stop it here. */
export async function submitForApproval(actor: CrmActor, id: string, deps: Deps = {}): Promise<ProposalDetail> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.create", "Your role can't write proposals.");
  const userId = member(actor);
  return crmWrite(actor, async (db) => {
    const row = await lockOrThrow(db, actor, id);
    if (!canEditRow(actor, row)) throw new AppError("forbidden", "Only the person who wrote this proposal, or a manager, can send it for approval.");
    if (!canTransition(row.status, "pending_approval")) throw notAllowed(row, "sent for approval");
    const checked = await checkProposal(db, row, deps.now);
    const blocking = blockingFor(checked.problems, "submit");
    if (blocking.length) throw new AppError("invalid_input", blocking[0].message);
    const v = await ensureVersion(db, row, userId, checked);
    assertVersionIntact(v);
    await db.query("update proposals set status = 'pending_approval', decision_note = null where id = $1 and org_id = $2", [id, actor.orgId]);
    await addEvent(db, actor.orgId, id, row.version, "submitted", asUser(userId), { version: row.version });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.submitted", targetType: "proposal", targetId: id, result: "success", metadata: { version: row.version, origin: row.origin } }, db);
    const after = (await loadProposalRow(db, actor.orgId, id)) as ProposalRow;
    await applyEffects(db, actor, after, "approval_requested", await readSettings(db, actor.orgId));
    await notifyOrgRoles(db, actor.orgId, ["owner", "admin"], {
      kind: "proposal_approval_requested", title: "A proposal is waiting for your approval", body: `${row.number}: ${row.title}`.slice(0, 200), link: `/proposals/${id}`, dedupeKey: `proposal-approval:${id}:${row.version}`,
    });
    return buildDetail(db, actor, after, deps.now);
  });
}

export type Decision = "approve" | "request_changes" | "reject";

/** The person who wrote this version or sent it for approval: the second-person rule keeps them from approving it too. */
async function isAuthorOf(db: Queryable, row: ProposalRow, userId: string): Promise<boolean> {
  if (row.created_by === userId) return true;
  const { rows } = await db.query<{ actor_id: string | null }>("select actor_id from proposal_events where proposal_id = $1 and org_id = $2 and kind = 'submitted' and version = $3 order by id desc limit 1", [row.id, row.org_id, row.version]);
  return rows[0]?.actor_id === userId;
}

/** A reviewer's decision, bound to the version they looked at. Approving needs the approve permission, and a second pair of eyes when the workspace asked for one. */
export async function decideProposal(actor: CrmActor, id: string, input: { decision: Decision; version: number; note?: string | null }, deps: Deps = {}): Promise<ProposalDetail> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.approve", "Only the business owner or a manager can approve proposals.");
  const userId = member(actor);
  const note = input.note?.trim().slice(0, 600) || null;
  if (input.decision === "request_changes" && !note) throw new AppError("invalid_input", "Say what should change.");
  return crmWrite(actor, async (db) => {
    const row = await lockOrThrow(db, actor, id);
    if (row.status !== "pending_approval") throw new AppError("conflict", "This proposal is not waiting for approval.");
    if (row.version !== input.version) throw new AppError("conflict", "The proposal changed while you were reviewing it. Review the new version.");
    const settings = await readSettings(db, actor.orgId);
    if (input.decision === "approve") {
      if (!selfApprovalAllowed(settings.twoPerson) && (await isAuthorOf(db, row, userId))) throw new AppError("forbidden", "Your workspace asks for a second person to approve each proposal. Ask another owner or manager.");
      const checked = await checkProposal(db, row, deps.now);
      const blocking = blockingFor(checked.problems, "submit");
      if (blocking.length) throw new AppError("invalid_input", blocking[0].message);
      const v = await ensureVersion(db, row, userId, checked);
      assertVersionIntact(v);
      await db.query("update proposals set status = 'approved', approved_version = version, approved_by = $3, approved_at = now(), decision_note = $4 where id = $1 and org_id = $2", [id, actor.orgId, userId, note]);
    } else if (input.decision === "reject") {
      await db.query("update proposals set status = 'rejected', decision_note = $3, approved_version = null, approved_by = null, approved_at = null, closed_at = now() where id = $1 and org_id = $2", [id, actor.orgId, note]);
    } else {
      await db.query("update proposals set status = 'changes_requested', decision_note = $3, approved_version = null, approved_by = null, approved_at = null where id = $1 and org_id = $2", [id, actor.orgId, note]);
    }
    const kind = input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "changes_requested";
    await addEvent(db, actor.orgId, id, row.version, kind, asUser(userId), { version: row.version, note });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: `proposals.${kind}`, targetType: "proposal", targetId: id, result: "success", metadata: { version: row.version, origin: row.origin } }, db);
    if (row.created_by && row.created_by !== userId) {
      await notifyUser(db, row.created_by, actor.orgId, {
        kind: "proposal_approval_decided", title: input.decision === "approve" ? `${row.number} was approved` : input.decision === "reject" ? `${row.number} was rejected` : `Changes were requested on ${row.number}`,
        body: note ?? undefined, link: `/proposals/${id}`, dedupeKey: `proposal-decided:${id}:${row.version}:${kind}`,
      });
    }
    return buildDetail(db, actor, (await loadProposalRow(db, actor.orgId, id)) as ProposalRow, deps.now);
  });
}

// ---------------------------------------------------------------------------
// Sending, withdrawing, revising
// ---------------------------------------------------------------------------

/**
 * Marks an approved version as sent. Only a signed-in member who holds the send permission can do it: not an agent, an API key, a workflow or the system, and not the agency.
 * A proposal that needs no second look is approved by the author's own act of sending it, and its history says so. Nothing here reaches the customer yet: delivery is the
 * share link and PDF, added in a later change.
 */
export async function sendProposal(actor: CrmActor, id: string, input: { version?: number } = {}, deps: Deps = {}): Promise<ProposalDetail> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.send", "Your role can't send proposals.");
  const userId = member(actor);
  const sent = await crmWrite(actor, async (db) => {
    const row = await lockOrThrow(db, actor, id);
    if (input.version !== undefined && input.version !== row.version) throw new AppError("conflict", "The proposal changed. Review the new version before sending it.");
    if (row.status === "pending_approval") throw new AppError("conflict", "This proposal is waiting for approval.");
    if (!canTransition(row.status, "sent")) throw notAllowed(row, "sent");
    const settings = await readSettings(db, actor.orgId);
    const checked = await checkProposal(db, row, deps.now);
    const blocking = blockingFor(checked.problems, "send");
    if (blocking.length) throw new AppError("invalid_input", blocking[0].message);
    let selfApproved = false;
    if (row.status !== "approved") {
      const reasons = approvalReasons({
        origin: row.origin, authorCanSend: await authorCanSend(db, row), mode: settings.approvalMode, discountNeedsApproval: settings.discountNeedsApproval,
        lowersPrice: rowDoc(row).lines.some(lowersPrice), overMinor: settings.approvalOverMinor, groupTotals: [row.one_time_total_minor, row.monthly_total_minor, row.yearly_total_minor].map(Number),
      });
      if (reasons.length) throw new AppError("conflict", `This proposal needs approval before it can be sent. ${APPROVAL_REASON_TEXT[reasons[0]]} Send it for approval first.`);
      if (row.created_by !== userId && row.owner_user_id !== userId && !actor.can("proposals.approve")) throw new AppError("forbidden", "Only the person who wrote this proposal, or a manager, can send it.");
      selfApproved = true;
    }
    const v = await ensureVersion(db, row, userId, checked);
    assertVersionIntact(v);
    if (selfApproved) {
      await db.query("update proposals set approved_version = version, approved_by = $3, approved_at = now() where id = $1 and org_id = $2", [id, actor.orgId, userId]);
      await addEvent(db, actor.orgId, id, row.version, "self_approved", asUser(userId), { version: row.version });
      await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.approved", targetType: "proposal", targetId: id, result: "success", metadata: { version: row.version, self: true } }, db);
    } else if (row.approved_version !== row.version) {
      throw new AppError("conflict", "The approval is for an earlier version of this proposal. Send it for approval again.");
    }
    await db.query("update proposals set status = 'sent', sent_version = version, sent_at = now(), sent_by = $3, closed_at = null, decision_note = null where id = $1 and org_id = $2", [id, actor.orgId, userId]);
    await db.query("update proposal_versions set sent_at = now() where proposal_id = $1 and org_id = $2 and version = $3 and sent_at is null", [id, actor.orgId, row.version]);
    await addEvent(db, actor.orgId, id, row.version, "sent", asUser(userId), { version: row.version });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.sent", targetType: "proposal", targetId: id, result: "success", metadata: { version: row.version, number: row.number } }, db);
    const after = (await loadProposalRow(db, actor.orgId, id)) as ProposalRow;
    // The customer's link is made with the send, in the same transaction: a proposal is never "sent" without one.
    await createShareLinkInTx(db, after, row.version, userId, deps.now ?? new Date());
    await applyEffects(db, actor, after, "sent", settings, { byName: actor.label });
    return buildDetail(db, actor, after, deps.now);
  });
  // The PDF is made once the send is saved: storage cannot join the database transaction, and a PDF that cannot be made must never undo a send. The customer's page makes the
  // same document from the frozen version when no stored copy exists.
  try {
    await ensureVersionPdf(actor.orgId, id, sent.version, userId, { renderer: deps.renderer });
  } catch (e) {
    await withSystem((db) => addEvent(db, actor.orgId, id, sent.version, "pdf_failed", { id: null, kind: "system" }, { message: (e instanceof AppError ? e.message : sanitizeErrorText(e)).slice(0, 300) })).catch(() => undefined);
  }
  return getProposal(actor, id, deps);
}

/** Closes the customer's links to a proposal. */
async function revokeLinks(db: Queryable, orgId: string, proposalId: string): Promise<void> {
  await db.query("update proposal_share_links set revoked_at = now() where proposal_id = $1 and org_id = $2 and revoked_at is null", [proposalId, orgId]);
}

/** Takes a proposal back. The customer can no longer accept it. A sent proposal is withdrawn by anyone who can send; a draft by the person who wrote it or a manager. */
export async function withdrawProposal(actor: CrmActor, id: string, deps: Deps = {}): Promise<ProposalDetail> {
  await assertProposalsEnabled(actor.orgId);
  const userId = member(actor);
  return crmWrite(actor, async (db) => {
    const row = await lockOrThrow(db, actor, id);
    if (!(canEditRow(actor, row) || actor.can("proposals.send"))) throw new AppError("forbidden", "Only the person who wrote this proposal, or someone who can send proposals, can withdraw it.");
    if (!canTransition(row.status, "withdrawn")) throw notAllowed(row, "withdrawn");
    const wasSent = row.status === "sent";
    await db.query("update proposals set status = 'withdrawn', closed_at = now() where id = $1 and org_id = $2", [id, actor.orgId]);
    await revokeLinks(db, actor.orgId, id);
    // A signing request that is out is withdrawn with the proposal: a signature that arrives later is kept as the service's fact and not applied.
    await voidLiveRequestsInTx(db, actor.orgId, id, "voided", "The proposal was withdrawn.", { userId, now: deps.now });
    await addEvent(db, actor.orgId, id, row.version, "withdrawn", asUser(userId), { wasSent });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.withdrawn", targetType: "proposal", targetId: id, result: "success", metadata: { version: row.version, wasSent } }, db);
    const after = (await loadProposalRow(db, actor.orgId, id)) as ProposalRow;
    if (wasSent) await applyEffects(db, actor, after, "withdrawn", await readSettings(db, actor.orgId), { byName: actor.label });
    return buildDetail(db, actor, after, deps.now);
  });
}

/**
 * Starts the next version of a proposal that was sent, declined, expired or withdrawn: a draft with the same wording, no approval, the old version marked superseded and its link
 * closed. An accepted proposal is final; a change to it is a new proposal (duplicate).
 */
export async function reviseProposal(actor: CrmActor, id: string, deps: Deps = {}): Promise<ProposalDetail> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.create", "Your role can't write proposals.");
  const userId = member(actor);
  return crmWrite(actor, async (db) => {
    const row = await lockOrThrow(db, actor, id);
    if (!(canEditRow(actor, row) || actor.can("proposals.send"))) throw new AppError("forbidden", "Only the person who wrote this proposal, or someone who can send proposals, can revise it.");
    if (!isRevisable(row.status)) throw new AppError("conflict", row.status === "accepted" ? "An accepted proposal can't be revised. Duplicate it to start a new one." : `A proposal that is ${STATUS_LABELS[row.status].toLowerCase()} can't be revised.`);
    await db.query(
      `update proposals set status = 'draft', version = version + 1, approved_version = null, approved_by = null, approved_at = null, decision_note = null, closed_at = null,
         signature_state = case when signature_state = 'completed' then signature_state else 'none' end where id = $1 and org_id = $2`, [id, actor.orgId],
    );
    await revokeLinks(db, actor.orgId, id);
    await db.query("update proposal_versions set superseded_at = now() where proposal_id = $1 and org_id = $2 and superseded_at is null", [id, actor.orgId]);
    // The version a signer was asked to sign is replaced. A request still out for it ends as superseded, and a signature that arrives for it is never applied to the new version.
    await voidLiveRequestsInTx(db, actor.orgId, id, "superseded", "The proposal was revised.", { userId, now: deps.now });
    await addEvent(db, actor.orgId, id, row.version + 1, "revised", asUser(userId), { from: row.version, was: row.status });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.revised", targetType: "proposal", targetId: id, result: "success", metadata: { from: row.version } }, db);
    return buildDetail(db, actor, (await loadProposalRow(db, actor.orgId, id)) as ProposalRow, deps.now);
  });
}

/**
 * A new draft with the same wording and lines: how an accepted proposal is amended, or a good one reused. A copy of an AI-written proposal is still AI-written, so it still needs
 * a person's approval and the always-approve rule cannot be sidestepped by copying. The valid-until date is not carried over once it has passed.
 */
export async function duplicateProposal(actor: CrmActor, id: string, deps: Deps = {}): Promise<ProposalDetail> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.create", "Your role can't write proposals.");
  const userId = member(actor);
  return crmWrite(actor, async (db) => {
    const src = await loadProposalRow(db, actor.orgId, id);
    if (!src) throw new AppError("not_found", "That proposal was not found.");
    const tz = await workspaceTimezone(db, actor.orgId);
    const today = todayIn(tz, deps.now ?? new Date());
    const number = await nextNumber(db, actor.orgId);
    const { rows } = await db.query<{ id: string }>(
      `insert into proposals (org_id, number, title, contact_id, company_id, opportunity_id, template_id, template_version, owner_user_id, currency, valid_until, requires_signature, client_name, client_company,
         client_email, doc, one_time_total_minor, monthly_total_minor, yearly_total_minor, internal_notes, origin, ai_run_id, created_by)
       select org_id, $3, title, contact_id, company_id, opportunity_id, template_id, template_version, $4, currency, case when valid_until >= $5::date then valid_until end, requires_signature, client_name, client_company,
         client_email, doc, one_time_total_minor, monthly_total_minor, yearly_total_minor, internal_notes, origin, case when origin = 'ai' then ai_run_id end, $4
       from proposals where id = $1 and org_id = $2 returning id`,
      [id, actor.orgId, number, userId, today],
    );
    await addEvent(db, actor.orgId, rows[0].id, 1, "created", asUser(userId), { duplicatedFrom: id, origin: src.origin });
    await addEvent(db, actor.orgId, rows[0].id, 1, "duplicated", asUser(userId), { from: id, number: src.number });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.created", targetType: "proposal", targetId: rows[0].id, result: "success", metadata: { number, duplicatedFrom: src.number } }, db);
    return buildDetail(db, actor, (await loadProposalRow(db, actor.orgId, rows[0].id)) as ProposalRow, deps.now);
  });
}

// ---------------------------------------------------------------------------
// An answer given outside the product
// ---------------------------------------------------------------------------

export interface OfflineDecisionInput {
  decision: "accepted" | "declined";
  note?: string | null;
  /** Who gave the answer, as the business knows it. Defaults to the customer named on the proposal. */
  decidedName?: string | null;
  decidedEmail?: string | null;
  /** A stored scan or photo of the signed copy (a file in the proposal-documents bucket). */
  attestationFileId?: string | null;
  version?: number;
}

/**
 * The customer accepted or declined by phone, on paper or in person, and a person at the business writes it down. It is recorded as that person's word and labelled that way
 * everywhere: "recorded by <name>; not verified by the client". It is never described as an electronic signature. Only the owner and managers can do it. A proposal that was
 * approved but never sent online (a printed copy signed in person) can be recorded too; it is then also marked as delivered offline.
 */
export async function recordOfflineDecision(actor: CrmActor, id: string, input: OfflineDecisionInput, deps: Deps = {}): Promise<ProposalDetail> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.record_decision", "Only the business owner or a manager can record a decision made outside the product.");
  const userId = member(actor);
  if (input.decision !== "accepted" && input.decision !== "declined") throw new AppError("invalid_input", "Choose whether the customer accepted or declined.");
  const note = input.note?.trim().slice(0, 2000) || null;
  return crmWrite(actor, async (db) => {
    const row = await lockOrThrow(db, actor, id);
    if (input.version !== undefined && input.version !== row.version) throw new AppError("conflict", "The proposal changed. Look at the new version before recording an answer.");
    if (row.status !== "sent" && row.status !== "approved") throw new AppError("conflict", "An answer can be recorded for a proposal that is approved or sent.");
    const existing = await db.query("select 1 from proposal_decisions where proposal_id = $1 and org_id = $2 and version = $3 and decision in ('accepted', 'declined')", [id, actor.orgId, row.version]);
    if (existing.rows[0]) throw new AppError("conflict", "An answer is already recorded for this version.");
    const checked = await checkProposal(db, row, deps.now);
    const v = await ensureVersion(db, row, userId, checked);
    assertVersionIntact(v);
    if (input.attestationFileId) {
      const f = await db.query("select 1 from private_files where id = $1 and org_id = $2 and bucket = 'proposal-documents' and status = 'ready'", [input.attestationFileId, actor.orgId]);
      if (!f.rows[0]) throw new AppError("invalid_input", "That file was not found among this workspace's proposal documents.");
    }
    const decidedName = cleanLine(input.decidedName ?? row.client_name, 160, "The name") || null;
    const decidedEmail = cleanEmail(input.decidedEmail !== undefined ? input.decidedEmail : row.client_email);
    const fromApproved = row.status === "approved";
    if (fromApproved) await addEvent(db, actor.orgId, id, row.version, "delivered_offline", asUser(userId), { version: row.version });
    // A person's record of the signing replaces any request still out: the signer must not be asked again, and a signature that arrives later is not applied on top.
    await voidLiveRequestsInTx(db, actor.orgId, id, "voided", "The answer was recorded by a person.", { userId, now: deps.now });
    await db.query(
      `insert into proposal_decisions (org_id, proposal_id, version, content_hash, decision, method, decided_name, decided_email, note, recorded_by, attestation_file_id)
       values ($1, $2, $3, $4, $5, 'recorded_by_staff', $6, $7, $8, $9, $10)`,
      [actor.orgId, id, row.version, v.content_hash, input.decision, decidedName, decidedEmail, note, userId, input.attestationFileId ?? null],
    );
    await db.query(
      `update proposals set status = $3, closed_at = now(), sent_version = version, sent_at = coalesce(sent_at, now()), sent_by = coalesce(sent_by, $4),
         signature_state = case when requires_signature and $3 = 'accepted' then 'recorded_offline' else signature_state end where id = $1 and org_id = $2`,
      [id, actor.orgId, input.decision, userId],
    );
    await db.query("update proposal_versions set sent_at = coalesce(sent_at, now()) where proposal_id = $1 and org_id = $2 and version = $3", [id, actor.orgId, row.version]);
    await revokeLinks(db, actor.orgId, id);
    await addEvent(db, actor.orgId, id, row.version, input.decision, asUser(userId), { method: "recorded_by_staff", hasScan: Boolean(input.attestationFileId) });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.decision_recorded", targetType: "proposal", targetId: id, result: "success", metadata: { decision: input.decision, version: row.version, name: await nameOf(db, userId) } }, db);
    const after = (await loadProposalRow(db, actor.orgId, id)) as ProposalRow;
    await applyEffects(db, actor, after, input.decision, await readSettings(db, actor.orgId), { recordedByPerson: true, byName: actor.label });
    return buildDetail(db, actor, after, deps.now);
  });
}

export type { ProposalDetail, ProposalSummary, SettingsRow };
