// Fixtures for the proposals tests. Synthetic workspaces only: nothing is sent to anyone and no provider is contacted.
import { withSystem } from "@/server/db";
import { memberActor, type CrmActor } from "@/server/crm/actor";
import { adjustCredits } from "@/server/billing/ledger";
import type { LlmConfig } from "@/server/llm/client";
import type { OrgRole } from "@/lib/permissions";
import { createCatalogItem, createTaxRate, type CatalogItemView, type TaxRateView } from "@/server/proposals/catalog";
import { createProposal, decideProposal, sendProposal, submitForApproval, type CreateInput } from "@/server/proposals/proposals";
import { getShareUrl } from "@/server/proposals/share";
import { saveProposalSettings } from "@/server/proposals/settings";
import { clearFeatureCache } from "@/server/proposals/features";
import type { LineInput } from "@/server/proposals/doc-build";
import { crmOrg, type CrmOrg } from "./crm";
import { addMember, createUser, ctxFor } from "./fixtures";

export interface ProposalOrg extends CrmOrg {
  /** A team member: may draft proposals but not send them, so what they write always needs approval. */
  member: CrmActor;
  /** Another owner-level approver, for the second-person rule. */
  coOwner: CrmActor;
  item: CatalogItemView;
  tax: TaxRateView;
}

export const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

/** Switches the proposals feature on or off for a workspace, the way a Super Admin would (and forgets the short cache so the change is seen at once). */
export async function setFeature(orgId: string, on: boolean, feature = "proposals") {
  await withSystem((db) => db.query("insert into org_features (org_id, feature, enabled) values ($1, $2, $3) on conflict (org_id, feature) do update set enabled = excluded.enabled", [orgId, feature, on]));
  clearFeatureCache(orgId);
}

export async function personWithRole(orgId: string, org: CrmOrg["org"], role: OrgRole, name: string = role): Promise<CrmActor> {
  const user = await createUser({ name: `${name} Person` });
  await addMember(orgId, user.id, role);
  const ctx = ctxFor(user, org, role);
  return memberActor(ctx);
}

/**
 * A client workspace with the proposals feature on, one person in every client role, a team member and a second owner, one tax rate and one price book item. The prices
 * are made up for the tests: no real price list exists anywhere in the product.
 */
export async function proposalOrg(opts: { feature?: boolean; timezone?: string } = {}): Promise<ProposalOrg> {
  const c = await crmOrg({ timezone: opts.timezone });
  // The fixture's own rows need the feature on; a test of the "off" state switches it off again afterwards.
  await setFeature(c.org.id, true);
  const member = await personWithRole(c.org.id, c.org, "member", "member");
  const coOwner = await personWithRole(c.org.id, c.org, "owner", "co-owner");
  const owner = c.actor("owner");
  const tax = await createTaxRate(owner, { name: "Sales tax", rateBps: 1200 });
  const item = await createCatalogItem(owner, { name: "Website build", description: "Design and build of a five page website.", unitLabel: "project", unitPriceMinor: 150_000, currency: "USD", billing: "one_time", taxRateId: tax.id });
  if (opts.feature === false) await setFeature(c.org.id, false);
  return { ...c, member, coOwner, item, tax };
}

export const lineOf = (item: Pick<CatalogItemView, "id">, quantityMilli = 1000, over: Partial<LineInput> = {}): LineInput => ({ catalogItemId: item.id, quantityMilli, ...over });

/** A draft written by `who` with one price book line and a customer on it, ready to submit. */
export async function draftBy(p: ProposalOrg, who: "owner" | "manager" | "sales" | "member" = "sales", over: CreateInput = {}) {
  const actor = who === "member" ? p.member : p.actor(who);
  return createProposal(actor, { title: "Website proposal", clientName: "Maria Santos", clientEmail: `maria-${Math.random().toString(36).slice(2, 8)}@example.test`, doc: { lines: [lineOf(p.item)], terms: "Payment is due within 14 days." }, ...over });
}

/** A proposal written by sales and approved by the manager. */
export async function approvedProposal(p: ProposalOrg, over: CreateInput = {}, deps: { now?: Date } = {}) {
  const draft = await draftBy(p, "member", over);
  const pending = await submitForApproval(p.member, draft.id, deps);
  return decideProposal(p.actor("manager"), pending.id, { decision: "approve", version: pending.version }, deps);
}

export { saveProposalSettings };

// ---------------------------------------------------------------------------
// The customer's side
// ---------------------------------------------------------------------------

/** A fixed moment the public-page tests run at, so links, codes and sessions do not depend on the real clock. */
export const NOW = new Date("2026-10-23T12:00:00Z");
export const minutesAfter = (m: number, from: Date = NOW) => new Date(from.getTime() + m * 60_000);

/** A proposal that was written by a team member, approved by the manager and sent by sales, with the customer's link in hand. */
export async function sentWithLink(p: ProposalOrg, over: CreateInput = {}, deps: { now?: Date } = {}) {
  const now = deps.now ?? NOW;
  const email = over.clientEmail === undefined ? `maria-${Math.random().toString(36).slice(2, 10)}@example.test` : over.clientEmail;
  const approved = await approvedProposal(p, { clientEmail: email, ...over }, { now });
  const sent = await sendProposal(p.actor("sales"), approved.id, {}, { now });
  const { url } = await getShareUrl(p.actor("sales"), sent.id, { now });
  return { proposal: sent, token: url.split("/proposal/")[1], url, linkId: (sent.share as { id: string }).id, /** Empty when the proposal was written without an address for the customer. */ email: email ?? "" };
}

/** The code the latest code email to this address carries (read from the outbox, where the capture provider leaves it). */
export async function latestCode(email: string): Promise<string> {
  const row = (await rows<{ body_text: string }>("select body_text from email_outbox where template = 'proposal_code' and to_email = $1 order by created_at desc, id desc limit 1", [email]))[0];
  const m = /Code: (\d{6})/.exec(row?.body_text ?? "");
  if (!m) throw new Error(`no code email for ${email}`);
  return m[1];
}

/** Asks for a code and enters it, returning the customer's session cookie value. */
export async function verifiedSession(token: string, email: string, ctx: { ip?: string; now?: Date } = {}): Promise<string> {
  const { requestEmailCode, verifyEmailCode } = await import("@/server/proposals/public");
  const asked = await requestEmailCode(token, { ip: ctx.ip, now: ctx.now ?? NOW });
  if (asked.outcome !== "sent") throw new Error(`code not sent: ${asked.outcome}`);
  const verified = await verifyEmailCode(token, await latestCode(email), { ip: ctx.ip, now: ctx.now ?? NOW });
  if (verified.outcome !== "verified" || !verified.sessionToken) throw new Error(`not verified: ${verified.outcome}`);
  return verified.sessionToken;
}

let nextIp = 10;
/** An address no other test uses, so the per-address limits of one test never reach another. */
export const freshIp = (): string => `198.51.100.${(nextIp += 1) % 250}-${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------
// AI drafting. The language model is ALWAYS a stub: these fixtures prove the boundaries around a model, never how good a real one is.
// ---------------------------------------------------------------------------

export const AI_CONFIG: LlmConfig = { baseUrl: "https://llm.example.test/v1", format: "openai", model: "stub", apiKey: "stub-key", source: "environment" };

/** A stand-in for the language model. `text` may depend on what it was shown, so a test can make it answer the way a hostile or careless model would. */
export function stubModel(text: string | ((system: string, user: string) => string), usage?: { inputTokens: number | null; outputTokens: number | null }) {
  const calls: Array<{ system: string; user: string }> = [];
  const complete = async (_c: LlmConfig, input: { system: string; user: string }) => {
    calls.push({ system: input.system, user: input.user });
    return { ok: true as const, text: typeof text === "function" ? text(input.system, input.user) : text, ...(usage ? { usage } : {}) };
  };
  return { deps: { complete: complete as never, config: async () => AI_CONFIG }, calls };
}

/** Service credits for the workspace, so the "credits ran out" refusal does not stand in the way of a test about something else. */
export async function grantCredits(orgId: string, userId: string, usd = 20) {
  await withSystem((db) => adjustCredits(db, { orgId, deltaMicros: Math.round(usd * 1_000_000), reason: "seed credit for tests", userId }));
}

/** Switches AI drafting on the way the owner would, and gives the workspace credits. */
export async function enableAi(p: ProposalOrg, opts: { credits?: number } = {}) {
  await saveProposalSettings(p.actor("owner"), { aiDraftsEnabled: true }, 0);
  if ((opts.credits ?? 20) > 0) await grantCredits(p.org.id, p.people.owner.id, opts.credits ?? 20);
}

/** An approved piece of company knowledge, or one held back (`review_status`, `risk`), for the model to be shown or not. */
export const knowledge = (orgId: string, section: string, content: string, over: { review_status?: string; risk?: string[] } = {}) =>
  withSystem((db) => db.query(
    `insert into company_knowledge (org_id, section, content, review_status, risk_flags) values ($1, $2, $3, $4, $5)
     on conflict (org_id, section) do update set content = excluded.content, review_status = excluded.review_status, risk_flags = excluded.risk_flags`,
    [orgId, section, content, over.review_status ?? "approved", over.risk ?? []],
  ));

// ---------------------------------------------------------------------------
// Electronic signing. The signing service is ALWAYS the in-process stand-in or a replaced HTTP layer: these fixtures prove the pipeline around a service, never how a real
// service behaves.
// ---------------------------------------------------------------------------

/** A workspace with proposals AND signing switched on, and the stand-in signing service connected by the owner. */
export async function signingOrg(opts: { connect?: boolean; timezone?: string } = {}): Promise<ProposalOrg> {
  const { simulatedEsign } = await import("@/server/esign/providers/simulated");
  simulatedEsign.reset();
  const p = await proposalOrg({ timezone: opts.timezone });
  await setFeature(p.org.id, true, "esign");
  if (opts.connect !== false) {
    const { connectSimulated } = await import("@/server/esign/connections");
    await connectSimulated(p.actor("owner"));
  }
  return p;
}

/** A proposal that asks for a signature, written, approved and sent, with the customer's link in hand. */
export async function sentForSigning(p: ProposalOrg, over: CreateInput = {}, deps: { now?: Date } = {}) {
  return sentWithLink(p, { requiresSignature: true, ...over }, deps);
}

/** Asks the customer to sign, as the sales rep (who can send). */
export async function askToSign(p: ProposalOrg, proposalId: string, input: { signerName?: string; signerEmail?: string } = {}, deps: { now?: Date } = {}) {
  const { requestSignature } = await import("@/server/esign/requests");
  return requestSignature(p.actor("sales"), proposalId, input, { now: deps.now ?? NOW });
}

export const requestRow = async (id: string) => (await rows<{ status: string; provider_document_id: string | null; provider_state: Record<string, unknown>; attempt: number; last_error: string | null; last_error_kind: string | null; cancel_state: string; applied_at: Date | null; not_applied_reason: string | null; signed_file_id: string | null; certificate_file_id: string | null; copy_attempts: number; copy_gave_up_at: Date | null; run_at: Date; void_reason: string | null }>("select status, provider_document_id, provider_state, attempt, last_error, last_error_kind, cancel_state, applied_at, not_applied_reason, signed_file_id, certificate_file_id, copy_attempts, copy_gave_up_at, run_at, void_reason from signature_requests where id = $1", [id]))[0];

export const sigEvents = (requestId: string) => rows<{ kind: string; source: string; provider_event_id: string | null; detail: Record<string, unknown> }>("select kind, source, provider_event_id, detail from signature_events where request_id = $1 order by id", [requestId]);

/** A signing request that the worker has handed to the stand-in service: the signer has been asked and the service holds a document. */
export async function handedOver(p: ProposalOrg, over: CreateInput = {}, deps: { now?: Date } = {}) {
  const { processDueRequests } = await import("@/server/esign/worker");
  const now = deps.now ?? NOW;
  const sent = await sentForSigning(p, over, { now });
  const { requestId } = await askToSign(p, sent.proposal.id, {}, { now });
  const r = await processDueRequests({ orgId: p.org.id, now: () => now, jitter: () => 0 });
  const row = await requestRow(requestId);
  if (row.status !== "sent" || !row.provider_document_id) throw new Error(`the request was not handed over: ${row.status} ${row.last_error ?? ""} ${JSON.stringify(r)}`);
  return { ...sent, requestId, documentId: row.provider_document_id };
}

/**
 * What the signer does at the stand-in service, then the service's notice about it, signed with the connection's own key and posted to the webhook handler the real route calls.
 * Returns the handler's answer.
 */
export async function signerActs(p: ProposalOrg, requestId: string, action: "view" | "complete" | "decline" | "expire" | "void", opts: { now?: Date; eventId?: string; ip?: string } = {}) {
  const { handleEsignWebhook } = await import("@/server/esign/webhook");
  const { simulatedEsign } = await import("@/server/esign/providers/simulated");
  const row = await requestRow(requestId);
  if (!row.provider_document_id) throw new Error("the request has no document at the service");
  simulatedEsign.signerAction(row.provider_document_id, action);
  const keys = await connectionKeys(p.org.id);
  const d = simulatedEsign.delivery(row.provider_document_id, keys.creds.webhookKey, { eventId: opts.eventId });
  return handleEsignWebhook({ token: keys.token, rawBody: d.rawBody, headers: d.headers, query: d.query, ip: opts.ip ?? freshIp(), now: opts.now ?? NOW });
}

/** The workspace's live connection with its keys opened, for building a signed delivery the way the stand-in service would. */
export async function connectionKeys(orgId: string) {
  const { openCredentials } = await import("@/server/esign/credentials");
  const { tokenForStoredConnection } = await import("@/server/esign/webhook-token");
  const row = (await rows<{ id: string; webhook_token_hash: string; credentials: string }>("select id, webhook_token_hash, credentials from esign_connections where org_id = $1 and status not in ('revoked', 'disconnected')", [orgId]))[0];
  const creds = openCredentials(row.credentials);
  const token = tokenForStoredConnection(row.id, row.webhook_token_hash);
  if (!creds || !token) throw new Error("the connection's keys cannot be opened");
  return { connectionId: row.id, token, creds };
}
