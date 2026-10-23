import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmWrite, type CrmActor } from "@/server/crm/actor";
import { getConsent, isSuppressed } from "@/server/messaging/contacts";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import {
  ESIGN_NOT_ENABLED_MESSAGE, isLive, maskedEmail, NOT_APPLIED_TEXT, parseSigner, PROVIDER_CAN_CANCEL, PROVIDER_LABELS, requestBlockedReason, requestKey, statusExplain, STATUS_LABELS,
  type NotAppliedReason, type RequestStatus, type SigningMode, type SigningProvider,
} from "@/lib/esign/state";
import { validityOn } from "@/lib/proposals/validity";
import { addEvent as addProposalEvent, loadProposalRow, loadVersionRow, memberUserId, type ProposalRow } from "@/server/proposals/core";
import { ensureVersionPdf } from "@/server/proposals/documents";
import { assertProposalsEnabled, ESIGN_FEATURE, featureOn } from "@/server/proposals/features";
import { refreshSignatureState } from "@/server/esign/lifecycle";
import { connectionViewIn, type ConnectionView } from "@/server/esign/connections";
import { addSigEvent, loadRequest, REQUEST_COLUMNS, type RequestRow } from "@/server/esign/core";
import { liveEsignWritesEnabled } from "@/server/esign/providers";

// Asking a customer to sign, and withdrawing the ask. A signing request is made for one SENT version of a proposal that asks for a signature, by a person who can send
// proposals, through the client's own connected signing service. Making the request sends nothing: it is a row that the worker (worker.ts) hands to the service, which then emails
// the signer. Nothing is ever marked signed from here; only the service's word does that (apply.ts).

export interface EventLine {
  id: number;
  at: string;
  kind: string;
  source: string;
  detail: Record<string, unknown>;
}

export interface RequestView {
  id: string;
  proposalVersion: number;
  /** This request is for the version the proposal is on now. */
  current: boolean;
  status: RequestStatus;
  statusLabel: string;
  explain: string;
  signerName: string;
  signerEmail: string;
  provider: SigningProvider;
  providerLabel: string;
  mode: SigningMode;
  createdAt: string;
  sentAt: string | null;
  completedAt: string | null;
  /** The signature was applied to the proposal (it became accepted). */
  applied: boolean;
  notAppliedReason: NotAppliedReason | null;
  notAppliedText: string | null;
  /** The signed copy and the certificate are files in the proposal-documents bucket; the file route checks the viewer's permission. */
  signedFileId: string | null;
  certificateFileId: string | null;
  /** completed, and the signed copy has not been fetched from the service yet (or never could be). */
  copyPending: boolean;
  copyGaveUp: boolean;
  lastError: string | null;
  voidReason: string | null;
  /** What is left to do at the service for a withdrawn request. */
  cancelNote: string | null;
  /** A person may withdraw it. */
  canVoid: boolean;
  events: EventLine[];
}

export interface SignatureTab {
  /** Electronic signing is switched on for the workspace. */
  enabled: boolean;
  connection: ConnectionView | null;
  requests: RequestView[];
  /** Why a request cannot be made right now, in words; null when it can. */
  blocked: string | null;
  canRequest: boolean;
  canConnect: boolean;
  /** The signer the form starts with: the customer named on the proposal. */
  defaultSigner: { name: string; email: string };
  /** The simulated service can be acted for (test and QA only): never true in production. */
  simulated: boolean;
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

const CANCEL_NOTE: Record<RequestRow["cancel_state"], (label: string) => string | null> = {
  none: () => null,
  wanted: (label) => `iAcquire will tell ${label} to withdraw it.`,
  done: (label) => `${label} was told to withdraw it.`,
  manual: (label) => `iAcquire cannot withdraw it at ${label}. Withdraw the document there too; a signature that arrives for it is not applied to the proposal.`,
};

function toRequestView(r: RequestRow, events: EventLine[], proposal: Pick<ProposalRow, "version">, canSend: boolean): RequestView {
  const label = PROVIDER_LABELS[r.provider];
  return {
    id: r.id, proposalVersion: r.proposal_version, current: r.proposal_version === proposal.version, status: r.status, statusLabel: STATUS_LABELS[r.status],
    explain: statusExplain(r.status, { signerName: r.signer_name, mode: r.mode, providerLabel: label }), signerName: r.signer_name, signerEmail: r.signer_email, provider: r.provider,
    providerLabel: label, mode: r.mode, createdAt: new Date(r.created_at).toISOString(), sentAt: iso(r.sent_at), completedAt: iso(r.completed_at), applied: r.applied_at !== null,
    notAppliedReason: r.not_applied_reason, notAppliedText: r.not_applied_reason ? NOT_APPLIED_TEXT[r.not_applied_reason] : null, signedFileId: r.signed_file_id,
    certificateFileId: r.certificate_file_id, copyPending: r.status === "completed" && !r.signed_file_id && r.copy_gave_up_at === null, copyGaveUp: r.copy_gave_up_at !== null && !r.signed_file_id, lastError: r.last_error,
    voidReason: r.void_reason, cancelNote: r.provider_document_id || r.cancel_state !== "none" ? CANCEL_NOTE[r.cancel_state](label) : null,
    canVoid: canSend && isLive(r.status), events,
  };
}

/** The Signature tab of a proposal. Cheap when signing is not switched on for the workspace. */
export async function signatureTabIn(db: Queryable, actor: Pick<CrmActor, "can">, row: ProposalRow, now = new Date()): Promise<SignatureTab> {
  const empty: SignatureTab = {
    enabled: false, connection: null, requests: [], blocked: ESIGN_NOT_ENABLED_MESSAGE, canRequest: false, canConnect: false,
    defaultSigner: { name: row.client_name, email: row.client_email ?? "" }, simulated: false,
  };
  if (!(await featureOn(row.org_id, ESIGN_FEATURE, db))) return empty;
  const connection = await connectionViewIn(db, row.org_id);
  const { rows } = await db.query<RequestRow>(`select ${REQUEST_COLUMNS} from signature_requests where proposal_id = $1 and org_id = $2 order by created_at desc, id desc limit 20`, [row.id, row.org_id]);
  const ev = rows.length
    ? (await db.query<{ id: string; request_id: string; at: Date; kind: string; source: string; detail: Record<string, unknown> }>(
        "select id::text as id, request_id, at, kind, source, detail from signature_events where request_id = any($1::uuid[]) and org_id = $2 order by id desc limit 300", [rows.map((r) => r.id), row.org_id],
      )).rows
    : [];
  const tz = (await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [row.org_id])).rows[0]?.timezone ?? "UTC";
  const canSend = actor.can("proposals.send");
  const requests = rows.map((r) => toRequestView(r, ev.filter((e) => e.request_id === r.id).slice(0, 25).map((e) => ({ id: Number(e.id), at: new Date(e.at).toISOString(), kind: e.kind, source: e.source, detail: e.detail })), row, canSend));
  const blocked = requestBlockedReason({
    esignOn: true, connection: connection ? { status: connection.status, mode: connection.mode, detail: connection.statusDetail } : null, writesEnabled: liveEsignWritesEnabled(),
    proposal: { status: row.status, version: row.version, sentVersion: row.sent_version, requiresSignature: row.requires_signature, pastDate: validityOn(row.valid_until, now, tz) === "expired" },
    liveRequest: rows.some((r) => isLive(r.status) && r.proposal_version === row.version),
  });
  return {
    enabled: true, connection, requests, blocked, canRequest: canSend && blocked === null, canConnect: actor.can("proposals.connect"), defaultSigner: empty.defaultSigner,
    simulated: connection?.mode === "simulated",
  };
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

export interface RequestSignatureInput {
  signerName?: string | null;
  signerEmail?: string | null;
}

export interface Deps {
  now?: Date;
}

/**
 * Asks the proposal's customer to sign the version that was sent. Needs the send permission, a sent proposal that asks for a signature, a connection that works, and a signer with
 * a real email address who has not opted out. One live request per version: asking again while one is out returns it. Nothing reaches the signing service from here.
 */
export async function requestSignature(actor: CrmActor, proposalId: string, input: RequestSignatureInput = {}, deps: Deps = {}): Promise<{ requestId: string; created: boolean }> {
  await assertProposalsEnabled(actor.orgId);
  if (!(await featureOn(actor.orgId, ESIGN_FEATURE))) throw new AppError("not_enabled", ESIGN_NOT_ENABLED_MESSAGE);
  assertCan(actor, "proposals.send", "Your role can't send proposals.");
  const userId = memberUserId(actor);
  const now = deps.now ?? new Date();
  const first = await crmWrite(actor, (db) => loadProposalRow(db, actor.orgId, proposalId));
  if (!first) throw new AppError("not_found", "That proposal was not found.");
  const signer = parseSigner({ name: input.signerName ?? first.client_name, email: input.signerEmail ?? first.client_email });
  if (!signer.ok) throw new AppError("invalid_input", signer.message);
  if (!(await consumeRateLimit(RATE_LIMITS.esignRequestByOrg, actor.orgId)).allowed) throw new AppError("rate_limited", "Too many signing requests were made just now. Try again in a little while.");
  // The PDF is stored before the transaction (storage cannot join it). It is the same file the customer's page offers, and its hash is what the request is locked to.
  if (first.status === "sent" && first.sent_version === first.version) await ensureVersionPdf(actor.orgId, proposalId, first.version, userId).catch(() => undefined);

  return crmWrite(actor, async (db) => {
    const row = await loadProposalRow(db, actor.orgId, proposalId, true);
    if (!row) throw new AppError("not_found", "That proposal was not found.");
    const live = (await db.query<{ id: string }>(
      "select id from signature_requests where proposal_id = $1 and org_id = $2 and proposal_version = $3 and status in ('queued', 'sending', 'sent', 'viewed', 'unknown') for update", [row.id, actor.orgId, row.version],
    )).rows[0];
    if (live) return { requestId: live.id, created: false };
    const connection = await connectionViewIn(db, actor.orgId);
    const tz = (await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [actor.orgId])).rows[0]?.timezone ?? "UTC";
    const blocked = requestBlockedReason({
      esignOn: true, connection: connection ? { status: connection.status, mode: connection.mode, detail: connection.statusDetail } : null, writesEnabled: liveEsignWritesEnabled(),
      proposal: { status: row.status, version: row.version, sentVersion: row.sent_version, requiresSignature: row.requires_signature, pastDate: validityOn(row.valid_until, now, tz) === "expired" }, liveRequest: false,
    });
    if (blocked || !connection) throw new AppError("conflict", blocked ?? "No signing service is connected.");
    // The signing service emails the signer itself, which is outside iAcquire's message chain, so the same opt-outs that chain honours are honoured here.
    if (await isSuppressed(db, actor.orgId, "email", signer.email)) throw new AppError("conflict", "That address opted out or bounced, so a signing request can't be sent to it. Use another address, or record the signing yourself.");
    if (row.contact_id && (await getConsent(db, actor.orgId, row.contact_id, "email", "service")) === "revoked") {
      throw new AppError("conflict", "This customer withdrew consent to be emailed, so a signing request can't be sent. Record the signing yourself.");
    }
    const version = await loadVersionRow(db, actor.orgId, row.id, row.version);
    if (!version || !version.pdf_file_id || !version.pdf_sha256) throw new AppError("conflict", "The document for this version isn't stored yet, so it can't be sent for signing. Try again in a moment.");
    const ordinal = Number((await db.query<{ n: string }>("select count(*)::text as n from signature_requests where proposal_id = $1 and org_id = $2 and proposal_version = $3", [row.id, actor.orgId, row.version])).rows[0].n);
    const contact = row.contact_id && row.client_email && row.client_email.toLowerCase() === signer.email ? row.contact_id : null;
    const key = requestKey(row.id, row.version, ordinal);
    const inserted = await db.query<{ id: string }>(
      `insert into signature_requests (org_id, proposal_id, proposal_version, version_hash, pdf_file_id, pdf_sha256, connection_id, provider, mode, signer_name, signer_email, signer_contact_id, idempotency_key, run_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15) on conflict (idempotency_key) do nothing returning id`,
      [actor.orgId, row.id, row.version, version.content_hash, version.pdf_file_id, version.pdf_sha256, connection.id, connection.provider, connection.mode, signer.name, signer.email, contact, key, now.toISOString(), userId],
    );
    if (!inserted.rows[0]) {
      const existing = (await db.query<{ id: string }>("select id from signature_requests where idempotency_key = $1 and org_id = $2", [key, actor.orgId])).rows[0];
      if (!existing) throw new AppError("conflict", "A signing request was just made by someone else. Reload to see it.");
      return { requestId: existing.id, created: false };
    }
    const id = inserted.rows[0].id;
    await addSigEvent(db, actor.orgId, id, "created", "user", { by: userId, signer: maskedEmail(signer.email), provider: connection.provider, mode: connection.mode });
    await addProposalEvent(db, actor.orgId, row.id, row.version, "signature_requested", { id: userId, kind: "user" }, { requestId: id, signer: maskedEmail(signer.email), provider: connection.provider, mode: connection.mode });
    await refreshSignatureState(db, actor.orgId, row.id);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.signature_requested", targetType: "proposal", targetId: row.id, result: "success", metadata: { version: row.version, requestId: id, provider: connection.provider, mode: connection.mode } }, db);
    return { requestId: id, created: true };
  });
}

// ---------------------------------------------------------------------------
// Withdrawing
// ---------------------------------------------------------------------------

/** Withdraws a request that is still out. The proposal stays sent; the customer can be asked again. A signature that arrives for a withdrawn request is not applied. */
export async function voidSignatureRequest(actor: CrmActor, requestId: string, deps: Deps = {}): Promise<void> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.send", "Your role can't send proposals.");
  const userId = memberUserId(actor);
  await crmWrite(actor, async (db) => {
    const peek = await loadRequest(db, actor.orgId, requestId);
    if (!peek) throw new AppError("not_found", "That signing request was not found.");
    const proposal = await loadProposalRow(db, actor.orgId, peek.proposal_id, true);
    const req = await loadRequest(db, actor.orgId, requestId, true);
    if (!proposal || !req) throw new AppError("not_found", "That signing request was not found.");
    if (!isLive(req.status)) throw new AppError("conflict", "That signing request is no longer out, so there is nothing to withdraw.");
    const hasDocument = Boolean(req.provider_document_id || req.provider_state?.documentId);
    const cancel = !hasDocument ? "none" : PROVIDER_CAN_CANCEL[req.provider] ? "wanted" : "manual";
    await db.query(
      "update signature_requests set status = 'voided', void_reason = 'Withdrawn by a person.', cancel_state = $3, finished_at = $4::timestamptz, lease_until = null, claimed_by = null where id = $1 and org_id = $2",
      [req.id, actor.orgId, cancel, (deps.now ?? new Date()).toISOString()],
    );
    await addSigEvent(db, actor.orgId, req.id, "voided", "user", { by: userId, cancel });
    await addProposalEvent(db, actor.orgId, proposal.id, req.proposal_version, "signature_withdrawn", { id: userId, kind: "user" }, { requestId: req.id, cancel });
    await refreshSignatureState(db, actor.orgId, proposal.id);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.signature_withdrawn", targetType: "proposal", targetId: proposal.id, result: "success", metadata: { version: req.proposal_version, requestId: req.id } }, db);
  });
}
