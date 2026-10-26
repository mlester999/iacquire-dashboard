import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { MoneyError } from "@/lib/money";
import { isOrgRole, roleHasPermission } from "@/lib/permissions";
import type { ProposalStatus } from "@/lib/proposals/state";
import { emptyDoc, parseDoc, type ProposalDoc } from "@/lib/proposals/doc";
import type { ProposalSnapshot } from "@/lib/proposals/snapshot";

// What every proposals service needs: reading a proposal and its frozen versions, the workspace's settings, the history log and the number counter. No permission checks live
// here: the callers make them.

export interface ProposalRow {
  id: string;
  org_id: string;
  number: string;
  title: string;
  status: ProposalStatus;
  contact_id: string | null;
  company_id: string | null;
  opportunity_id: string | null;
  template_id: string | null;
  template_version: number | null;
  owner_user_id: string | null;
  currency: string;
  valid_until: string | null;
  requires_signature: boolean;
  client_name: string;
  client_company: string;
  client_email: string | null;
  doc: unknown;
  /** bigint columns come back as text from the hosted driver and as numbers from the embedded one; they are always asked for as text. */
  one_time_total_minor: string;
  monthly_total_minor: string;
  yearly_total_minor: string;
  internal_notes: string | null;
  origin: "human" | "ai";
  ai_run_id: string | null;
  version: number;
  approved_version: number | null;
  approved_by: string | null;
  approved_at: Date | null;
  decision_note: string | null;
  sent_version: number | null;
  sent_at: Date | null;
  sent_by: string | null;
  signature_state: "none" | "requested" | "completed" | "failed" | "recorded_offline";
  closed_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export const PROPOSAL_COLUMNS =
  "id, org_id, number, title, status, contact_id, company_id, opportunity_id, template_id, template_version, owner_user_id, currency, to_char(valid_until, 'YYYY-MM-DD') as valid_until, requires_signature, "
  + "client_name, client_company, client_email::text as client_email, doc, one_time_total_minor::text as one_time_total_minor, monthly_total_minor::text as monthly_total_minor, "
  + "yearly_total_minor::text as yearly_total_minor, internal_notes, origin, ai_run_id, version, approved_version, approved_by, approved_at, decision_note, sent_version, sent_at, sent_by, "
  + "signature_state, closed_at, created_by, created_at, updated_at";

export async function loadProposalRow(db: Queryable, orgId: string, id: string, lock = false): Promise<ProposalRow | null> {
  const { rows } = await db.query<ProposalRow>(`select ${PROPOSAL_COLUMNS} from proposals where id = $1 and org_id = $2${lock ? " for update" : ""}`, [id, orgId]);
  return rows[0] ?? null;
}

/** The working document of a row. A row that holds no document yet reads as an empty one. */
export function rowDoc(row: Pick<ProposalRow, "doc">): ProposalDoc {
  const parsed = parseDoc(row.doc);
  if (parsed.ok) return parsed.value;
  if (row.doc && typeof row.doc === "object" && Object.keys(row.doc as object).length === 0) return emptyDoc();
  throw new AppError("internal", "This proposal's document could not be read. Contact support.");
}

export interface VersionRow {
  id: string;
  org_id: string;
  proposal_id: string;
  version: number;
  snapshot: ProposalSnapshot;
  content_hash: string;
  source_hash: string;
  pdf_file_id: string | null;
  pdf_sha256: string | null;
  created_by: string | null;
  created_at: Date;
  sent_at: Date | null;
  superseded_at: Date | null;
}

export const VERSION_COLUMNS = "id, org_id, proposal_id, version, snapshot, content_hash, source_hash, pdf_file_id, pdf_sha256, created_by, created_at, sent_at, superseded_at";

export async function loadVersionRow(db: Queryable, orgId: string, proposalId: string, version: number): Promise<VersionRow | null> {
  const { rows } = await db.query<VersionRow>(`select ${VERSION_COLUMNS} from proposal_versions where proposal_id = $1 and org_id = $2 and version = $3`, [proposalId, orgId, version]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingsRow {
  aiDraftsEnabled: boolean;
  approvalMode: "ai_and_discounts" | "all";
  approvalOverMinor: number | null;
  discountNeedsApproval: boolean;
  twoPerson: boolean;
  defaultValidityDays: number | null;
  tagOnSendId: string | null;
  stageOnSendId: string | null;
  dealOnAccept: "none" | "won_stage";
  version: number;
}

/** What a workspace that never saved its settings has: AI drafts off, approval only where it must be, no CRM effects, no validity period. Version 0 means "never saved". */
export const DEFAULT_SETTINGS: SettingsRow = {
  aiDraftsEnabled: false, approvalMode: "ai_and_discounts", approvalOverMinor: null, discountNeedsApproval: true, twoPerson: false, defaultValidityDays: null,
  tagOnSendId: null, stageOnSendId: null, dealOnAccept: "none", version: 0,
};

export async function readSettings(db: Queryable, orgId: string): Promise<SettingsRow> {
  const { rows } = await db.query<{
    ai_drafts_enabled: boolean; approval_mode: "ai_and_discounts" | "all"; approval_over_minor: string | null; discount_needs_approval: boolean; two_person: boolean;
    default_validity_days: number | null; tag_on_send_id: string | null; stage_on_send_id: string | null; deal_on_accept: "none" | "won_stage"; version: number;
  }>(
    `select ai_drafts_enabled, approval_mode, approval_over_minor::text as approval_over_minor, discount_needs_approval, two_person, default_validity_days, tag_on_send_id, stage_on_send_id,
            deal_on_accept, version from proposal_settings where org_id = $1`,
    [orgId],
  );
  const r = rows[0];
  if (!r) return { ...DEFAULT_SETTINGS };
  return {
    aiDraftsEnabled: r.ai_drafts_enabled, approvalMode: r.approval_mode, approvalOverMinor: r.approval_over_minor === null ? null : Number(r.approval_over_minor),
    discountNeedsApproval: r.discount_needs_approval, twoPerson: r.two_person, defaultValidityDays: r.default_validity_days, tagOnSendId: r.tag_on_send_id,
    stageOnSendId: r.stage_on_send_id, dealOnAccept: r.deal_on_accept, version: r.version,
  };
}

// ---------------------------------------------------------------------------
// History and numbering
// ---------------------------------------------------------------------------

export type EventActor = { id: string | null; kind: "user" | "ai" | "system" | "recipient" | "provider" };

export async function addEvent(db: Queryable, orgId: string, proposalId: string, version: number | null, kind: string, actor: EventActor, detail: Record<string, unknown> = {}): Promise<void> {
  await db.query("insert into proposal_events (org_id, proposal_id, version, kind, actor_id, actor_kind, detail) values ($1, $2, $3, $4, $5, $6, $7::jsonb)", [orgId, proposalId, version, kind.slice(0, 40), actor.id, actor.kind, JSON.stringify(detail)]);
}

/** P-0001, P-0002 ...: one upsert that returns the new number, so two proposals made at once never share one. */
export async function nextNumber(db: Queryable, orgId: string): Promise<string> {
  const { rows } = await db.query<{ last_number: number }>(
    "insert into proposal_counters (org_id, last_number) values ($1, 1) on conflict (org_id) do update set last_number = proposal_counters.last_number + 1 returning last_number", [orgId],
  );
  return `P-${String(rows[0].last_number).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Money rules that failed (a discount above its line, a total too large) as a message a person can act on. Anything else passes through. */
export function asAppError(e: unknown): unknown {
  return e instanceof MoneyError ? new AppError("invalid_input", e.message) : e;
}

/**
 * Whether the person who wrote the proposal could send it themselves. A proposal written by someone who cannot always needs a second person's approval, so this is about the
 * author's role, not about whoever is looking at it. Someone who has left the workspace cannot.
 */
export async function authorCanSend(db: Queryable, row: Pick<ProposalRow, "org_id" | "created_by">): Promise<boolean> {
  if (!row.created_by) return false;
  const { rows } = await db.query<{ role: string }>("select role from organization_memberships where org_id = $1 and user_id = $2 and status = 'active'", [row.org_id, row.created_by]);
  const role = rows[0]?.role;
  return isOrgRole(role) && roleHasPermission(role, "proposals.send");
}

/** The signed-in person behind a write. Agents, the API, workflows and the system never write proposals; agency staff only set up the price book and templates. */
export function memberUserId(actor: { kind: string; userId: string | null }): string {
  if (actor.kind !== "member" || !actor.userId) throw new AppError("forbidden", "Only a signed-in member of the workspace can do this.");
  return actor.userId;
}

export const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);
export const money = (v: string | number | null | undefined): number => Number(v ?? 0);

/** A person's display name, or null. */
export async function nameOf(db: Queryable, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const { rows } = await db.query<{ n: string }>("select coalesce(nullif(full_name, ''), email::text) as n from users where id = $1", [userId]);
  return rows[0]?.n ?? null;
}
