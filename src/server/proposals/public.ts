import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { sendEmail } from "@/server/email";
import { systemActor } from "@/server/crm/actor";
import { hashIp } from "@/server/security/crypto";
import { consumeRateLimit, consumeRateLimitInTx, RATE_LIMITS, type RateLimitRule } from "@/server/security/rate-limit";
import { contentHash } from "@/lib/proposals/hash";
import { acknowledgementText, PROPOSAL_ACKNOWLEDGEMENT_VERSION } from "@/lib/proposals/ack";
import {
  CHANGE_REQUESTS_PER_DAY, CODE_COOLDOWN_SECONDS, CODE_MAX_ATTEMPTS, CODE_TTL_MINUTES, SESSION_MAX_HOURS, SESSION_SLIDE_MINUTES, cleanCode, maskEmail,
  type CodeOutcome, type DecideOutcome, type PublicSigning, type PublicState,
} from "@/lib/proposals/share";
import { PROVIDER_LABELS } from "@/lib/esign/state";
import type { ProposalSnapshot } from "@/lib/proposals/snapshot";
import { validityOn, type Validity } from "@/lib/proposals/validity";
import { addEvent, loadProposalRow, loadVersionRow, readSettings, type ProposalRow, type VersionRow } from "@/server/proposals/core";
import { applyEffects } from "@/server/proposals/crm-effects";
import { voidLiveRequestsInTx } from "@/server/esign/lifecycle";
import { readVersionPdf, type PdfDeps } from "@/server/proposals/documents";
import { ESIGN_FEATURE, featureOn, PROPOSALS_FEATURE, proposalsPublicDisabled } from "@/server/proposals/features";
import { hashCode, hashLinkToken, hashSession, looksLikeProposalToken, newCode, newSessionToken, sameDigest, SESSION_TOKEN_RE } from "@/server/proposals/link-token";

// Everything a customer can do with the link they were given. There is no sign-in: the token in the address is the credential, and the workspace, the proposal and the version are
// always read from the link's own row, never from anything the request says. Every entry point checks, in this order: the platform switch (before any database read), a rate limit
// per address (before any token is looked up, so guessing tokens costs the guesser), the shape of the token, a rate limit per token, and only then the database.
//
// Honest by construction. "Opened" is a request for the page and may be a link scanner. "Viewed" is a browser beacon after the page was used. "Verified" is the emailed code. An
// answer is recorded only from a verified session, for the exact frozen version whose hash was shown, once; it is described everywhere as a recorded answer and never as a signature.
//
// Lock order, to keep customers and staff from deadlocking: the proposal row first, then the link row.

export interface PublicContext {
  /** The caller's network address; used only through a keyed hash. */
  ip?: string | null;
  userAgent?: string | null;
  now?: Date;
  /** The customer's session cookie value, if the browser sent one. */
  sessionToken?: string | null;
  /** Tests replace the PDF writer. */
  pdf?: PdfDeps;
}

const MINUTE = 60_000;
const ipKey = (ip: string | null | undefined): string => hashIp(ip) ?? "unknown";
/** Rate-limit keys are a hash of the token's hash, never the token. */
const limitKey = (token: string): string => crypto.createHash("sha256").update(`proposal-rl:${hashLinkToken(token)}`).digest("hex").slice(0, 40);

/** The checks that come before the database: null to carry on, or the state to answer with. The address limit counts every request, valid token or not. */
async function gate(token: string, ctx: PublicContext, perToken?: RateLimitRule): Promise<PublicState | null> {
  if (proposalsPublicDisabled()) return "disabled";
  if (!(await consumeRateLimit(RATE_LIMITS.proposalPublicByIp, ipKey(ctx.ip))).allowed) return "rate_limited";
  if (!looksLikeProposalToken(token)) return "invalid";
  if (perToken && !(await consumeRateLimit(perToken, limitKey(token))).allowed) return "rate_limited";
  return null;
}

// ---------------------------------------------------------------------------
// Finding the link
// ---------------------------------------------------------------------------

interface LinkFacts {
  id: string;
  org_id: string;
  proposal_id: string;
  version: number;
  recipient_email: string | null;
  recipient_name: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  first_opened_at: Date | null;
  first_viewed_at: Date | null;
  verified_at: Date | null;
  org_name: string;
  org_timezone: string;
  org_status: string;
  /** iAcquire's pause for the workspace (set by a shutdown, or while it is reviewed). */
  agency_paused: boolean;
  brand_color: string | null;
  contact_email: string | null;
  contact_phone: string | null;
}

interface Found {
  link: LinkFacts;
  row: ProposalRow;
  version: VersionRow | null;
}

const LINK_SQL = `select l.id, l.org_id, l.proposal_id, l.version, l.recipient_email::text as recipient_email, l.recipient_name, l.expires_at, l.revoked_at, l.first_opened_at, l.first_viewed_at,
       l.verified_at, o.name as org_name, o.timezone as org_timezone, o.status as org_status,
       exists (select 1 from automation_pauses ap join organizations apo on apo.id = ap.org_id where ap.active and ap.scope = 'agency' and (ap.org_id = l.org_id or apo.kind = 'agency')) as agency_paused,
       cp.brand_color, cp.contact_email, cp.contact_phone
     from proposal_share_links l join organizations o on o.id = l.org_id left join company_profiles cp on cp.org_id = l.org_id`;

/** The link a token opens, its proposal and the frozen version. With `lock`, the proposal row and then the link row are locked until the transaction ends. */
async function find(db: Queryable, token: string, lock: boolean): Promise<Found | null> {
  const hash = hashLinkToken(token);
  let link = (await db.query<LinkFacts>(`${LINK_SQL} where l.token_hash = $1`, [hash])).rows[0];
  if (!link) return null;
  const row = await loadProposalRow(db, link.org_id, link.proposal_id, lock);
  if (!row) return null;
  if (lock) link = (await db.query<LinkFacts>(`${LINK_SQL} where l.token_hash = $1 for update of l`, [hash])).rows[0] ?? link;
  return { link, row, version: await loadVersionRow(db, link.org_id, link.proposal_id, link.version) };
}

interface AnswerRow {
  decision: "accepted" | "declined" | "changes_requested";
  method: "verified_acknowledgement" | "provider_signature" | "recorded_by_staff";
  decided_email: string | null;
  decided_at: Date;
}

async function finalAnswer(db: Queryable, f: Found): Promise<AnswerRow | null> {
  return (await db.query<AnswerRow>(
    "select decision, method, decided_email::text as decided_email, decided_at from proposal_decisions where proposal_id = $1 and org_id = $2 and version = $3 and decision in ('accepted', 'declined')",
    [f.link.proposal_id, f.link.org_id, f.link.version],
  )).rows[0] ?? null;
}

/**
 * What the link can do right now. Expiry is checked first: once the date has passed, the page says so even if the job that closes proposals has not run yet. A link that was
 * withdrawn, replaced by a newer version or closed by staff shows one message that names none of those, so it cannot be used to learn what happened inside the business.
 */
async function stateOf(db: Queryable, f: Found, now: Date): Promise<PublicState> {
  const { link, row } = f;
  // A suspended or archived workspace, or one iAcquire has paused (a client that has been shut down is), takes no answers and sends no codes.
  if (link.org_status === "suspended" || link.org_status === "archived" || link.agency_paused) return "unavailable";
  if (!(await featureOn(link.org_id, PROPOSALS_FEATURE, db))) return "unavailable";
  if (row.status === "expired" || (row.status === "sent" && validityOn(row.valid_until, now, link.org_timezone) === "expired")) return "expired";
  if (row.status === "withdrawn" || link.revoked_at) return "withdrawn";
  if (new Date(link.expires_at).getTime() <= now.getTime()) return "link_expired";
  if (row.status === "sent" && row.sent_version === link.version && row.version === link.version) return "open";
  if ((row.status === "accepted" || row.status === "declined") && row.version === link.version && (await finalAnswer(db, f))) return "answered";
  return "unavailable";
}

/** The version's snapshot must still hash to what was recorded; a row changed behind the application's back is never shown or answered. */
const intact = (v: VersionRow | null): v is VersionRow => Boolean(v) && contentHash((v as VersionRow).snapshot) === (v as VersionRow).content_hash;

// ---------------------------------------------------------------------------
// Sessions (the customer who entered the code)
// ---------------------------------------------------------------------------

export interface VerifiedSession {
  email: string;
  expiresAt: Date;
}

/** The session this cookie value opens for THIS link, slid forward on use but never past its maximum. */
async function sessionFor(db: Queryable, linkId: string, token: string | null | undefined, now: Date): Promise<VerifiedSession | null> {
  if (!token || !SESSION_TOKEN_RE.test(token)) return null;
  const s = (await db.query<{ id: string; email: string; expires_at: Date; max_expires_at: Date }>(
    "select id, verified_email::text as email, expires_at, max_expires_at from proposal_link_sessions where session_hash = $1 and link_id = $2", [hashSession(token), linkId],
  )).rows[0];
  if (!s || new Date(s.expires_at) <= now || new Date(s.max_expires_at) <= now) return null;
  const slid = new Date(Math.min(new Date(s.max_expires_at).getTime(), now.getTime() + SESSION_SLIDE_MINUTES * MINUTE));
  if (slid.getTime() > new Date(s.expires_at).getTime()) await db.query("update proposal_link_sessions set expires_at = $2 where id = $1", [s.id, slid.toISOString()]);
  return { email: s.email, expiresAt: slid };
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export interface PublicProposalView {
  state: PublicState;
  business: { name: string; brandColor: string | null; contactEmail: string | null; contactPhone: string | null; timezone: string } | null;
  /** The frozen version, for a link that is open or answered. */
  proposal: { number: string; title: string; version: number; contentHash: string; snapshot: ProposalSnapshot; validity: Validity; requiresSignature: boolean } | null;
  answer: { decision: "accepted" | "declined"; method: AnswerRow["method"]; decidedAt: string; emailMasked: string | null } | null;
  /** How many times the customer asked for changes to this version. */
  changeRequests: number;
  /** The customer can ask for a code (the business has an address to send it to). */
  recipient: { maskedEmail: string | null };
  /** Set when the browser holds a valid session: the address that was verified, masked. */
  verified: { emailMasked: string; expiresAt: string } | null;
  /** The sentence to tick before accepting; null when accepting is not offered. */
  acknowledgement: { version: number; text: string } | null;
  /** Only for a proposal that asks for a signature: where the signing document stands. */
  signing: PublicSigning | null;
}

const blank = (state: PublicState): PublicProposalView => ({ state, business: null, proposal: null, answer: null, changeRequests: 0, recipient: { maskedEmail: null }, verified: null, acknowledgement: null, signing: null });

const SIGNING_STATE: Record<string, PublicSigning["state"]> = { queued: "preparing", sending: "preparing", unknown: "preparing", sent: "sent", viewed: "viewed" };

/** The newest signing request for this very version, as much of it as the customer may see. */
async function signingFor(db: Queryable, f: Found): Promise<PublicSigning> {
  const none: PublicSigning = { state: "none", providerLabel: null, signerEmailMasked: null, simulated: false };
  // Signing is a separate switch (and a separate migration): until a Super Admin turns it on for the workspace there is nothing to look up.
  if (!(await featureOn(f.row.org_id, ESIGN_FEATURE, db))) return none;
  const r = (await db.query<{ status: string; signer_email: string; provider: "pandadoc" | "simulated"; mode: string }>(
    "select status, signer_email::text as signer_email, provider, mode from signature_requests where proposal_id = $1 and org_id = $2 and proposal_version = $3 order by created_at desc, id desc limit 1",
    [f.row.id, f.row.org_id, f.link.version],
  )).rows[0];
  if (!r) return none;
  return { state: SIGNING_STATE[r.status] ?? "ended", providerLabel: PROVIDER_LABELS[r.provider], signerEmailMasked: maskEmail(r.signer_email), simulated: r.mode === "simulated" };
}

const businessOf = (l: LinkFacts) => ({ name: l.org_name, brandColor: l.brand_color, contactEmail: l.contact_email, contactPhone: l.contact_phone, timezone: l.org_timezone });

/**
 * What the customer's page shows for a token, recording that the link was opened. Opening is a request for the page: it can be an email security scanner or a link preview, so
 * it is counted as "opened" and nothing more. A link that cannot be used shows only the business and a plain message, never the proposal.
 */
export async function loadPublicProposal(token: string, ctx: PublicContext = {}): Promise<PublicProposalView> {
  const refused = await gate(token, ctx, RATE_LIMITS.proposalPageByToken);
  if (refused) return blank(refused);
  const now = ctx.now ?? new Date();
  return withSystem(async (db): Promise<PublicProposalView> => {
    const f = await find(db, token, true);
    if (!f) return blank("invalid");
    const business = businessOf(f.link);
    let state = await stateOf(db, f, now);
    if ((state === "open" || state === "answered") && !intact(f.version)) {
      const seen = await db.query("select 1 from proposal_events where proposal_id = $1 and org_id = $2 and kind = 'integrity_failed' and version = $3 limit 1", [f.row.id, f.row.org_id, f.link.version]);
      if (!seen.rows[0]) await addEvent(db, f.row.org_id, f.row.id, f.link.version, "integrity_failed", { id: null, kind: "system" }, { where: "customer_page" });
      state = "unavailable";
    }
    if (state !== "open" && state !== "answered") return { ...blank(state), business };
    const version = f.version as VersionRow;
    const first = !f.link.first_opened_at;
    await db.query(
      "update proposal_share_links set open_count = open_count + 1, first_opened_at = coalesce(first_opened_at, $2::timestamptz), last_opened_at = $2::timestamptz where id = $1",
      [f.link.id, now.toISOString()],
    );
    if (first) await addEvent(db, f.row.org_id, f.row.id, f.link.version, "link_opened", { id: null, kind: "recipient" }, { note: "The link was requested. This can be a link scanner." });
    const session = await sessionFor(db, f.link.id, ctx.sessionToken, now);
    const answer = state === "answered" ? await finalAnswer(db, f) : null;
    const asks = (await db.query<{ n: string }>("select count(*)::text as n from proposal_decisions where proposal_id = $1 and org_id = $2 and version = $3 and decision = 'changes_requested'", [f.row.id, f.row.org_id, f.link.version])).rows[0];
    const canAccept = state === "open" && !f.row.requires_signature && Boolean(session);
    return {
      state,
      business,
      proposal: { number: f.row.number, title: version.snapshot.title, version: version.version, contentHash: version.content_hash, snapshot: version.snapshot, validity: validityOn(f.row.valid_until, now, f.link.org_timezone), requiresSignature: f.row.requires_signature },
      answer: answer && (answer.decision === "accepted" || answer.decision === "declined")
        ? { decision: answer.decision, method: answer.method, decidedAt: new Date(answer.decided_at).toISOString(), emailMasked: answer.decided_email ? maskEmail(answer.decided_email) : null } : null,
      changeRequests: Number(asks?.n ?? 0),
      recipient: { maskedEmail: f.link.recipient_email ? maskEmail(f.link.recipient_email) : null },
      verified: session && state === "open" ? { emailMasked: maskEmail(session.email), expiresAt: session.expiresAt.toISOString() } : null,
      acknowledgement: canAccept ? { version: PROPOSAL_ACKNOWLEDGEMENT_VERSION, text: acknowledgementText(f.row.number, version.version) } : null,
      signing: state === "open" && f.row.requires_signature ? await signingFor(db, f) : null,
    };
  });
}

/**
 * The page stayed open in a browser and was used (the page's beacon). Counted per request, first time only announced: an event on the proposal, a note to its owner and the
 * "proposal.viewed" trigger for Automation Studio. This is a stronger sign than an open but it is still only a browser, never proof that anyone read the proposal.
 */
export async function recordProposalView(token: string, ctx: PublicContext = {}): Promise<"recorded" | "ignored" | "rate_limited" | "unavailable"> {
  const refused = await gate(token, ctx, RATE_LIMITS.proposalViewByToken);
  if (refused === "rate_limited") return "rate_limited";
  if (refused) return "unavailable";
  const now = ctx.now ?? new Date();
  return withSystem(async (db) => {
    const f = await find(db, token, true);
    if (!f) return "unavailable" as const;
    const state = await stateOf(db, f, now);
    if ((state !== "open" && state !== "answered") || !intact(f.version)) return "ignored" as const;
    const first = !f.link.first_viewed_at;
    await db.query(
      "update proposal_share_links set viewed_count = viewed_count + 1, first_viewed_at = coalesce(first_viewed_at, $2::timestamptz), first_opened_at = coalesce(first_opened_at, $2::timestamptz), open_count = greatest(open_count, 1) where id = $1",
      [f.link.id, now.toISOString()],
    );
    if (first && state === "open") {
      await addEvent(db, f.row.org_id, f.row.id, f.link.version, "viewed", { id: null, kind: "recipient" }, { level: "viewed" });
      await applyEffects(db, systemActor({ id: f.row.org_id, name: f.link.org_name, timezone: f.link.org_timezone }, "Customer"), f.row, "viewed", await readSettings(db, f.row.org_id), { byCustomer: true });
    }
    return "recorded" as const;
  });
}

// ---------------------------------------------------------------------------
// The emailed code
// ---------------------------------------------------------------------------

export interface CodeResult {
  outcome: CodeOutcome;
  maskedEmail?: string;
  retryAfterSeconds?: number;
}

/**
 * Emails a six-digit code to the address the business has for the customer: never to an address typed on the page. A new code replaces any earlier one. A code works for ten
 * minutes and five tries; a link may ask for five an hour, one a minute; one address is mailed at most ten an hour across every link.
 */
export async function requestEmailCode(token: string, ctx: PublicContext = {}): Promise<CodeResult> {
  const refused = await gate(token, ctx);
  if (refused === "rate_limited") return { outcome: "rate_limited" };
  if (refused) return { outcome: refused === "invalid" ? "invalid" : "unavailable" };
  const now = ctx.now ?? new Date();
  const made = await withSystem(async (db): Promise<{ result: CodeResult } | { code: string; challengeId: string; email: string; number: string; business: string }> => {
    const f = await find(db, token, true);
    if (!f || (await stateOf(db, f, now)) !== "open") return { result: { outcome: "unavailable" } };
    const email = f.link.recipient_email;
    if (!email) return { result: { outcome: "no_email" } };
    const last = (await db.query<{ created_at: Date }>("select created_at from proposal_link_challenges where link_id = $1 and org_id = $2 order by created_at desc limit 1", [f.link.id, f.link.org_id])).rows[0];
    if (last) {
      const wait = Math.ceil((new Date(last.created_at).getTime() + CODE_COOLDOWN_SECONDS * 1000 - now.getTime()) / 1000);
      if (wait > 0) return { result: { outcome: "cooldown", retryAfterSeconds: wait } };
    }
    const perLink = await consumeRateLimitInTx(db, RATE_LIMITS.proposalCodeByLink, f.link.id);
    const perEmail = await consumeRateLimitInTx(db, RATE_LIMITS.proposalCodeByEmail, crypto.createHash("sha256").update(email.toLowerCase()).digest("hex"));
    if (!perLink.allowed || !perEmail.allowed) return { result: { outcome: "rate_limited", retryAfterSeconds: Math.max(perLink.retryAfterSeconds, perEmail.retryAfterSeconds) } };
    // Only the newest code works.
    await db.query("update proposal_link_challenges set consumed_at = $3::timestamptz where link_id = $1 and org_id = $2 and consumed_at is null", [f.link.id, f.link.org_id, now.toISOString()]);
    const challengeId = crypto.randomUUID();
    const code = newCode();
    await db.query(
      "insert into proposal_link_challenges (id, link_id, org_id, code_hash, expires_at, created_at) values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)",
      [challengeId, f.link.id, f.link.org_id, hashCode(challengeId, code), new Date(now.getTime() + CODE_TTL_MINUTES * MINUTE).toISOString(), now.toISOString()],
    );
    await addEvent(db, f.row.org_id, f.row.id, f.link.version, "code_requested", { id: null, kind: "recipient" }, { emailMasked: maskEmail(email) });
    return { code, challengeId, email, number: f.row.number, business: f.link.org_name };
  });
  if ("result" in made) return made.result;
  // Sent after the challenge is saved, outside its transaction. The code lives in the outbox row until the daily clean-up removes it (an hour at most).
  const delivery = await sendEmail({
    to: made.email,
    template: "proposal_code",
    subject: `Your code for proposal ${made.number}`,
    text: [
      `Your code for proposal ${made.number}`,
      `Code: ${made.code}\nProposal: ${made.number} from ${made.business}`,
      `It works for ${CODE_TTL_MINUTES} minutes and only once. Never share it with anyone. If you didn't ask for it, you can ignore this email.`,
    ].join("\n\n"),
  }, undefined, { wait: true });
  if (delivery.status === "failed") {
    await withSystem((db) => db.query("update proposal_link_challenges set consumed_at = $2::timestamptz where id = $1", [made.challengeId, now.toISOString()]));
    return { outcome: "email_failed" };
  }
  return { outcome: "sent", maskedEmail: maskEmail(made.email) };
}

export interface VerifyResult {
  outcome: CodeOutcome;
  sessionToken?: string;
  sessionExpiresAt?: Date;
  attemptsLeft?: number;
}

/**
 * Checks the code. Five wrong entries lock that code. A right one is used up at once and opens a session for this link only (the browser keeps it in a cookie): thirty minutes
 * from its last use, eight hours at most. The code proves control of the mailbox the business has on file. It does not prove who is typing.
 */
export async function verifyEmailCode(token: string, codeInput: unknown, ctx: PublicContext = {}): Promise<VerifyResult> {
  const refused = await gate(token, ctx);
  if (refused === "rate_limited") return { outcome: "rate_limited" };
  if (refused) return { outcome: refused === "invalid" ? "invalid" : "unavailable" };
  const code = cleanCode(codeInput);
  if (!code) return { outcome: "invalid" };
  if (!(await consumeRateLimit(RATE_LIMITS.proposalVerifyByIp, ipKey(ctx.ip))).allowed) return { outcome: "rate_limited" };
  const now = ctx.now ?? new Date();
  return withSystem(async (db): Promise<VerifyResult> => {
    const f = await find(db, token, true);
    if (!f || (await stateOf(db, f, now)) !== "open" || !f.link.recipient_email) return { outcome: "unavailable" };
    const c = (await db.query<{ id: string; code_hash: string; attempts: number }>(
      "select id, code_hash, attempts from proposal_link_challenges where link_id = $1 and org_id = $2 and consumed_at is null and expires_at > $3::timestamptz order by created_at desc limit 1 for update",
      [f.link.id, f.link.org_id, now.toISOString()],
    )).rows[0];
    if (!c) return { outcome: "no_code" };
    if (c.attempts >= CODE_MAX_ATTEMPTS) return { outcome: "locked", attemptsLeft: 0 };
    // The try is counted before it is judged, so concurrent guesses cannot get more than five.
    await db.query("update proposal_link_challenges set attempts = attempts + 1 where id = $1", [c.id]);
    if (!sameDigest(hashCode(c.id, code), c.code_hash)) {
      const left = CODE_MAX_ATTEMPTS - (c.attempts + 1);
      return { outcome: left > 0 ? "wrong" : "locked", attemptsLeft: left };
    }
    await db.query("update proposal_link_challenges set consumed_at = $2::timestamptz where id = $1", [c.id, now.toISOString()]);
    const sessionToken = newSessionToken();
    const expires = new Date(now.getTime() + SESSION_SLIDE_MINUTES * MINUTE);
    await db.query(
      `insert into proposal_link_sessions (link_id, org_id, session_hash, verified_email, expires_at, max_expires_at, ip_hash, ua_hash, created_at)
       values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9::timestamptz)`,
      [f.link.id, f.link.org_id, hashSession(sessionToken), f.link.recipient_email, expires.toISOString(), new Date(now.getTime() + SESSION_MAX_HOURS * 3_600_000).toISOString(), hashIp(ctx.ip), hashIp(ctx.userAgent), now.toISOString()],
    );
    if (!f.link.verified_at) {
      await db.query("update proposal_share_links set verified_at = $2::timestamptz where id = $1", [f.link.id, now.toISOString()]);
      await addEvent(db, f.row.org_id, f.row.id, f.link.version, "verified", { id: null, kind: "recipient" }, { level: "verified", emailMasked: maskEmail(f.link.recipient_email) });
    }
    return { outcome: "verified", sessionToken, sessionExpiresAt: expires };
  });
}

// ---------------------------------------------------------------------------
// The customer's answer
// ---------------------------------------------------------------------------

export interface DecideInput {
  decision: unknown;
  /** The customer's message: required with a request for changes, optional with a decline. */
  note?: unknown;
  /** The box next to the acknowledgement sentence, ticked. Required to accept. */
  acknowledged?: unknown;
  /** The content hash of the version the page showed. */
  contentHash?: unknown;
}

const DECISIONS = { accept: "accepted", decline: "declined", request_changes: "changes_requested" } as const;

/** Plain text a customer typed: control characters out, line breaks kept, at most 2,000 characters. */
export function cleanNote(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, "").trim();
  return s ? s.slice(0, 2000) : null;
}

/**
 * Records the customer's answer: accept, decline or ask for changes. Only from a verified session of this very link, only while the proposal is sent and this link is its current
 * one and it has not passed its date, and only for the version whose hash the page showed. The answer is one append-only row bound to that hash. A second tap or a replay records
 * nothing new; a different final answer after the first is refused. Everything runs under the proposal's row lock.
 */
export async function decideOnProposal(token: string, input: DecideInput, ctx: PublicContext = {}): Promise<{ outcome: DecideOutcome }> {
  const refused = await gate(token, ctx, RATE_LIMITS.proposalDecideByLink);
  if (refused === "rate_limited") return { outcome: "rate_limited" };
  if (refused) return { outcome: refused === "invalid" ? "invalid" : "unavailable" };
  const want = typeof input.decision === "string" && Object.hasOwn(DECISIONS, input.decision) ? DECISIONS[input.decision as keyof typeof DECISIONS] : null;
  if (!want) return { outcome: "invalid" };
  const note = cleanNote(input.note);
  if (want === "changes_requested" && (!note || note.length < 3)) return { outcome: "needs_note" };
  const now = ctx.now ?? new Date();
  return withSystem(async (db): Promise<{ outcome: DecideOutcome }> => {
    const f = await find(db, token, true);
    if (!f) return { outcome: "invalid" };
    const state = await stateOf(db, f, now);
    if (state === "expired") return { outcome: "expired" };
    if (state !== "open" && state !== "answered") return { outcome: "unavailable" };
    if (!intact(f.version)) {
      await addEvent(db, f.row.org_id, f.row.id, f.link.version, "integrity_failed", { id: null, kind: "system" }, { where: "customer_answer" });
      return { outcome: "unavailable" };
    }
    const session = await sessionFor(db, f.link.id, ctx.sessionToken, now);
    if (!session || !f.link.recipient_email || session.email.toLowerCase() !== f.link.recipient_email.toLowerCase()) return { outcome: "not_verified" };
    if (typeof input.contentHash === "string" && input.contentHash !== f.version.content_hash) return { outcome: "stale" };
    if (state === "answered") {
      const done = await finalAnswer(db, f);
      return { outcome: done?.decision === want ? "already" : "conflict" };
    }
    if (want === "accepted") {
      if (f.row.requires_signature) return { outcome: "needs_signature" };
      if (input.acknowledged !== true && input.acknowledged !== "1" && input.acknowledged !== "on" && input.acknowledged !== "true") return { outcome: "ack_required" };
    }
    if (want === "changes_requested") {
      const since = new Date(now.getTime() - 86_400_000).toISOString();
      const n = (await db.query<{ n: string }>(
        "select count(*)::text as n from proposal_decisions where proposal_id = $1 and org_id = $2 and version = $3 and decision = 'changes_requested' and decided_at > $4::timestamptz", [f.row.id, f.row.org_id, f.link.version, since],
      )).rows[0];
      if (Number(n?.n ?? 0) >= CHANGE_REQUESTS_PER_DAY) return { outcome: "rate_limited" };
    }
    const ack = want === "accepted" ? { version: PROPOSAL_ACKNOWLEDGEMENT_VERSION, text: acknowledgementText(f.row.number, f.version.version) } : null;
    const { rows } = await db.query<{ id: string }>(
      `insert into proposal_decisions (org_id, proposal_id, version, content_hash, decision, method, decided_name, decided_email, acknowledgement_version, acknowledgement_text, note, ip_hash, ua_hash, decided_at)
       values ($1, $2, $3, $4, $5, 'verified_acknowledgement', $6, $7, $8, $9, $10, $11, $12, $13::timestamptz)
       on conflict (proposal_id, version) where decision in ('accepted', 'declined') do nothing returning id`,
      [f.row.org_id, f.row.id, f.link.version, f.version.content_hash, want, f.link.recipient_name ?? (f.row.client_name || null), session.email, ack?.version ?? null, ack?.text ?? null, note, hashIp(ctx.ip), hashIp(ctx.userAgent), now.toISOString()],
    );
    if (!rows[0]) return { outcome: "conflict" };
    if (want !== "changes_requested") {
      await db.query("update proposals set status = $3, closed_at = $4::timestamptz where id = $1 and org_id = $2", [f.row.id, f.row.org_id, want, now.toISOString()]);
      // The customer's own answer replaces a signing request still out (they declined on the page): it ends, and a signature that arrives afterwards is not applied.
      await voidLiveRequestsInTx(db, f.row.org_id, f.row.id, "voided", `The customer ${want === "declined" ? "declined" : "answered"} on the proposal page.`, { userId: null, now });
    }
    await addEvent(db, f.row.org_id, f.row.id, f.link.version, want, { id: null, kind: "recipient" }, { method: "verified_acknowledgement", emailMasked: maskEmail(session.email), hasNote: Boolean(note) });
    await recordAudit({ orgId: f.row.org_id, actorKind: "system", actorUserId: null, agentInstanceId: null, action: `proposals.customer_${want}`, targetType: "proposal", targetId: f.row.id, result: "success", metadata: { version: f.link.version, method: "verified_acknowledgement" } }, db);
    const after = (await loadProposalRow(db, f.row.org_id, f.row.id)) as ProposalRow;
    await applyEffects(db, systemActor({ id: f.row.org_id, name: f.link.org_name, timezone: f.link.org_timezone }, "Customer"), after, want, await readSettings(db, f.row.org_id), {
      byCustomer: true, occurrence: want === "changes_requested" ? rows[0].id : undefined,
    });
    return { outcome: want };
  });
}

// ---------------------------------------------------------------------------
// The PDF
// ---------------------------------------------------------------------------

export type PublicPdf = { ok: true; bytes: Buffer; filename: string } | { ok: false; state: PublicState };

/** The PDF of the version this link is for, while the link is open or the proposal was answered. The file is the link's own version's, never one named by the request. */
export async function loadPublicPdf(token: string, ctx: PublicContext = {}): Promise<PublicPdf> {
  const refused = await gate(token, ctx, RATE_LIMITS.proposalPdfByToken);
  if (refused) return { ok: false, state: refused };
  const now = ctx.now ?? new Date();
  const found = await withSystem(async (db): Promise<{ ok: false; state: PublicState } | { ok: true; orgId: string; proposalId: string; version: number }> => {
    const f = await find(db, token, false);
    if (!f) return { ok: false, state: "invalid" };
    const state = await stateOf(db, f, now);
    if (state !== "open" && state !== "answered") return { ok: false, state };
    if (!intact(f.version)) return { ok: false, state: "unavailable" };
    await db.query("update proposal_share_links set downloaded_at = coalesce(downloaded_at, $2::timestamptz) where id = $1", [f.link.id, now.toISOString()]);
    return { ok: true, orgId: f.link.org_id, proposalId: f.link.proposal_id, version: f.link.version };
  });
  if (!found.ok) return { ok: false, state: found.state };
  const pdf = await readVersionPdf(found.orgId, found.proposalId, found.version, ctx.pdf);
  if (!pdf) return { ok: false, state: "unavailable" };
  return { ok: true, bytes: pdf.bytes, filename: pdf.filename };
}
