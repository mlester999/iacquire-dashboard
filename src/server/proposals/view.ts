import "server-only";
import type { Queryable } from "@/server/db";
import type { CrmActor } from "@/server/crm/actor";
import { computeDocTotals, groupGrandTotals, lowersPrice, zeroGroups, type GroupTotals } from "@/lib/proposals/money";
import type { Billing, ProposalDoc } from "@/lib/proposals/doc";
import type { Problem } from "@/lib/proposals/problems";
import type { ProposalSnapshot } from "@/lib/proposals/snapshot";
import { approvalReasons, isEditable, type ApprovalReason, type ProposalStatus } from "@/lib/proposals/state";
import { shareViewFor, type ShareView } from "@/server/proposals/share";
import { checkProposal } from "@/server/proposals/versions";
import { authorCanSend, iso, loadVersionRow, money, readSettings, rowDoc, type ProposalRow } from "@/server/proposals/core";

// What the screens read. A summary is a row of a list; a detail is one proposal with its problems, approval need, saved versions, recorded answers and history.

export interface ProposalSummary {
  id: string;
  number: string;
  title: string;
  status: ProposalStatus;
  origin: "human" | "ai";
  clientName: string;
  clientCompany: string;
  currency: string;
  /** The grand total (tax included) of each billing group. Groups are never added together. */
  totals: Record<Billing, number>;
  validUntil: string | null;
  ownerId: string | null;
  ownerName: string | null;
  version: number;
  requiresSignature: boolean;
  contactId: string | null;
  companyId: string | null;
  opportunityId: string | null;
  sentAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VersionSummary {
  version: number;
  contentHash: string;
  createdAt: string;
  createdByName: string | null;
  sentAt: string | null;
  supersededAt: string | null;
  hasPdf: boolean;
  /** The stored PDF of this version, for someone who can see proposals to download (the file route checks the permission). */
  pdfFileId: string | null;
  totals: Record<Billing, number>;
}

export interface DecisionView {
  id: string;
  version: number;
  decision: "accepted" | "declined" | "changes_requested";
  method: "verified_acknowledgement" | "provider_signature" | "recorded_by_staff";
  decidedName: string | null;
  decidedEmail: string | null;
  note: string | null;
  acknowledgementVersion: number | null;
  contentHash: string;
  recordedByName: string | null;
  decidedAt: string;
}

export interface EventView {
  id: number;
  at: string;
  kind: string;
  version: number | null;
  actorKind: "user" | "ai" | "system" | "recipient" | "provider";
  actorName: string | null;
  detail: Record<string, unknown>;
}

export interface ProposalDetail extends ProposalSummary {
  doc: ProposalDoc;
  /** Worked out from the lines as they are now, line by line. */
  liveTotals: GroupTotals;
  clientEmail: string | null;
  internalNotes: string | null;
  templateId: string | null;
  templateVersion: number | null;
  approvedVersion: number | null;
  approvedByName: string | null;
  approvedAt: string | null;
  decisionNote: string | null;
  sentVersion: number | null;
  sentByName: string | null;
  signatureState: ProposalRow["signature_state"];
  problems: Problem[];
  /** Whether a second look is needed before this goes out, as it would be for the person asking. */
  approval: { required: boolean; reasons: ApprovalReason[] };
  versions: VersionSummary[];
  decisions: DecisionView[];
  events: EventView[];
  /** The customer's link, once the proposal has been sent: how far it has been seen (opened, viewed in a browser, or opened with the emailed code) and whether it still works. */
  share: ShareView | null;
  /**
   * What the customer reads. For a proposal that can still be edited it is the working copy with its placeholders filled in (`frozen: false`: it is not what a reviewer approved
   * until a version is made); otherwise it is the saved version, exactly as frozen. Null when the figures cannot be worked out (the problems say why).
   */
  preview: { snapshot: ProposalSnapshot; version: number; frozen: boolean; contentHash: string | null } | null;
  createdById: string | null;
  /** What the person looking at it may do with it, as the server works it out (it checks again on every action). */
  viewer: { userId: string | null; canEdit: boolean; isAuthor: boolean };
  /** For an AI-written draft: what the checks removed from the model's answer, so the person knows the draft is not everything it wrote. Null for a proposal a person started. */
  ai: { droppedCount: number; dropped: Array<{ field: string; reason: string; text: string; detail: string }>; rejectedItems: number } | null;
}

export const LIST_COLUMNS_SQL = (columns: string): string => columns.replace("client_email::text as client_email, doc,", "client_email::text as client_email, '{}'::jsonb as doc,");

export async function namesOf(db: Queryable, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!unique.length) return new Map();
  const { rows } = await db.query<{ id: string; n: string }>("select id, coalesce(nullif(full_name, ''), email::text) as n from users where id = any($1::uuid[])", [unique]);
  return new Map(rows.map((r) => [r.id, r.n]));
}

export function toSummary(r: ProposalRow, names: Map<string, string>): ProposalSummary {
  return {
    id: r.id, number: r.number, title: r.title, status: r.status, origin: r.origin, clientName: r.client_name, clientCompany: r.client_company, currency: r.currency,
    totals: { one_time: money(r.one_time_total_minor), monthly: money(r.monthly_total_minor), yearly: money(r.yearly_total_minor) }, validUntil: r.valid_until,
    ownerId: r.owner_user_id, ownerName: r.owner_user_id ? names.get(r.owner_user_id) ?? null : null, version: r.version, requiresSignature: r.requires_signature,
    contactId: r.contact_id, companyId: r.company_id, opportunityId: r.opportunity_id, sentAt: iso(r.sent_at), closedAt: iso(r.closed_at), createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function buildDetail(db: Queryable, actor: CrmActor, row: ProposalRow, now = new Date()): Promise<ProposalDetail> {
  const [vs, ds, es] = await Promise.all([
    db.query<{ version: number; content_hash: string; created_by: string | null; created_at: Date; sent_at: Date | null; superseded_at: Date | null; has_pdf: boolean; pdf_file_id: string | null; a: string; b: string; c: string }>(
      `select version, content_hash, created_by, created_at, sent_at, superseded_at, pdf_file_id is not null as has_pdf, pdf_file_id::text as pdf_file_id, one_time_total_minor::text as a, monthly_total_minor::text as b, yearly_total_minor::text as c
       from proposal_versions where proposal_id = $1 and org_id = $2 order by version desc`, [row.id, row.org_id],
    ),
    db.query<{ id: string; version: number; decision: DecisionView["decision"]; method: DecisionView["method"]; decided_name: string | null; decided_email: string | null; note: string | null; acknowledgement_version: number | null; content_hash: string; recorded_by: string | null; decided_at: Date }>(
      `select id, version, decision, method, decided_name, decided_email::text as decided_email, note, acknowledgement_version, content_hash, recorded_by, decided_at
       from proposal_decisions where proposal_id = $1 and org_id = $2 order by decided_at, id`, [row.id, row.org_id],
    ),
    db.query<{ id: string; at: Date; kind: string; version: number | null; actor_kind: EventView["actorKind"]; actor_id: string | null; detail: Record<string, unknown> }>(
      "select id::text as id, at, kind, version, actor_kind, actor_id, detail from proposal_events where proposal_id = $1 and org_id = $2 order by id desc limit 300", [row.id, row.org_id],
    ),
  ]);
  const names = await namesOf(db, [row.owner_user_id, row.approved_by, row.sent_by, ...vs.rows.map((v) => v.created_by), ...ds.rows.map((d) => d.recorded_by), ...es.rows.map((e) => e.actor_id)]);
  const doc = rowDoc(row);
  let liveTotals = zeroGroups();
  try {
    liveTotals = computeDocTotals(doc.lines).groups;
  } catch {
    // The problems list says why the figures cannot be worked out.
  }
  const checked = isEditable(row.status) ? await checkProposal(db, row, now) : null;
  let preview: ProposalDetail["preview"] = null;
  if (checked?.frozen) preview = { snapshot: checked.frozen.snapshot, version: row.version, frozen: false, contentHash: null };
  else if (!checked) {
    const saved = await loadVersionRow(db, row.org_id, row.id, row.version);
    if (saved) preview = { snapshot: saved.snapshot, version: saved.version, frozen: true, contentHash: saved.content_hash };
  }
  let ai: ProposalDetail["ai"] = null;
  if (row.origin === "ai" && row.ai_run_id) {
    const run = (await db.query<{ output: { dropped?: Array<{ field: string; reason: string; text: string; detail: string }>; droppedCount?: number; rejectedItems?: number } }>("select output from proposal_ai_runs where id = $1 and org_id = $2", [row.ai_run_id, row.org_id])).rows[0];
    if (run) ai = { droppedCount: run.output.droppedCount ?? run.output.dropped?.length ?? 0, dropped: (run.output.dropped ?? []).slice(0, 30), rejectedItems: run.output.rejectedItems ?? 0 };
  }
  // The person who wrote this version, or sent it for approval, is its author for the second-person rule (the most recent "submitted" event of this version).
  const submitter = es.rows.find((e) => e.kind === "submitted" && e.version === row.version)?.actor_id ?? null;
  const me = actor.kind === "member" ? actor.userId : null;
  const viewer = {
    userId: me,
    canEdit: Boolean(me) && actor.can("proposals.create") && (row.created_by === me || row.owner_user_id === me || actor.can("proposals.approve")),
    isAuthor: Boolean(me) && (row.created_by === me || submitter === me),
  };
  const settings = await readSettings(db, row.org_id);
  const reasons = approvalReasons({
    origin: row.origin, authorCanSend: await authorCanSend(db, row), mode: settings.approvalMode, discountNeedsApproval: settings.discountNeedsApproval,
    lowersPrice: doc.lines.some(lowersPrice), overMinor: settings.approvalOverMinor, groupTotals: Object.values(groupGrandTotals(liveTotals)),
  });
  return {
    ...toSummary(row, names), doc, liveTotals, clientEmail: row.client_email, internalNotes: row.internal_notes, templateId: row.template_id, templateVersion: row.template_version,
    approvedVersion: row.approved_version, approvedByName: row.approved_by ? names.get(row.approved_by) ?? null : null, approvedAt: iso(row.approved_at), decisionNote: row.decision_note,
    sentVersion: row.sent_version, sentByName: row.sent_by ? names.get(row.sent_by) ?? null : null, signatureState: row.signature_state,
    // Problems are about what can still be fixed before it goes out: a proposal that has been sent has nothing to fix, and a past date on it is just history.
    problems: checked?.problems ?? [],
    approval: { required: reasons.length > 0, reasons },
    versions: vs.rows.map((v) => ({
      version: v.version, contentHash: v.content_hash, createdAt: new Date(v.created_at).toISOString(), createdByName: v.created_by ? names.get(v.created_by) ?? null : null,
      sentAt: iso(v.sent_at), supersededAt: iso(v.superseded_at), hasPdf: v.has_pdf, pdfFileId: v.pdf_file_id, totals: { one_time: money(v.a), monthly: money(v.b), yearly: money(v.c) },
    })),
    decisions: ds.rows.map((d) => ({
      id: d.id, version: d.version, decision: d.decision, method: d.method, decidedName: d.decided_name, decidedEmail: d.decided_email, note: d.note, acknowledgementVersion: d.acknowledgement_version,
      contentHash: d.content_hash, recordedByName: d.recorded_by ? names.get(d.recorded_by) ?? null : null, decidedAt: new Date(d.decided_at).toISOString(),
    })),
    events: es.rows.map((e) => ({ id: Number(e.id), at: new Date(e.at).toISOString(), kind: e.kind, version: e.version, actorKind: e.actor_kind, actorName: e.actor_id ? names.get(e.actor_id) ?? null : null, detail: e.detail })),
    share: await shareViewFor(db, actor, row, now),
    preview,
    createdById: row.created_by,
    viewer,
    ai,
  };
}
