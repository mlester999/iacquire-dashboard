import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { appUrl, sendEmail } from "@/server/email";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { hashIp } from "@/server/security/crypto";
import { MAINTENANCE_MONTHLY_USD, SETUP_FEE_USD } from "@/lib/billing";
import { FIELD_COPY, PUBLIC_COPY, type PublicRefusal } from "@/lib/demo/copy";
import { firstNameOf, isBlockedDomain, looksLikeEmail, normalizeProspectEmail, typedEmail } from "@/lib/demo/email";
import { demoIndustryLabel, isDemoIndustry } from "@/lib/demo/industries";
import {
  accessOf, canTransition, chatRefusalFor, cleanLine, cleanUtm, effectiveStatus, MAX_BUSINESS_CHARS, MAX_NAME_CHARS, messagesLeft, messageAllowance, NOTICE_VERSION, REFUSAL_COPY,
  SESSION_DAYS, type AccessState, type ChatRefusal, type ProspectStatus,
} from "@/lib/demo/rules";
import { addEvent, addressKey, factsOf, loadProspect, lockProspect, mailboxKey, maskEmail, PROSPECT_COLUMNS, type ProspectRow } from "@/server/demo/core";
import { notifyProspectTeam, type ProspectNotice } from "@/server/demo/notify";
import { readDemoSettings } from "@/server/demo/settings";
import { demoDeploymentEnabled, demoPublicDisabled } from "@/server/demo/switch";
import { hashDemoToken, looksLikeDemoToken, newDemoToken } from "@/server/demo/tokens";
import { startsLeft, takeStart } from "@/server/demo/usage";

// Everything a stranger can do with the demo, from asking for it to reading their conversation again. There is no portal sign-in anywhere in this file: the prospect holds a link
// from their email (which works once) and then a cookie of their own, and every function says what it did with a value, never an exception.
//
// What each entry point checks, in this order: the emergency stop and DEMO_ENABLED (before any database read), a rate limit per address (before anything is looked up), the shape of
// whatever token was sent, the Super Admin's switch (in the database), and only then the prospect. Nothing here creates a user, a workspace, a membership, an invitation or a
// sign-in: the only way a prospect becomes a client is convertProspect (admin.ts), by a Super Admin, on purpose.
//
// Registering again with the same mailbox never resets the window or the message count. Opening a link's page changes nothing; pressing its button (a POST) uses it up. The answer
// to "ask for a demo" is the same whether or not the address was known, so the form cannot be used to find out who has asked.

export interface DemoContext {
  /** The caller's network address; used only through a keyed hash. */
  ip?: string | null;
  userAgent?: string | null;
  now?: Date;
  /** The prospect's session cookie value, when the browser sent one. */
  sessionToken?: string | null;
  /**
   * Whether there is a language model to ask (generator.ts demoModelState): false makes the room say the AI chat is not available even when the Super Admin has it switched on.
   * A function is asked only when the Super Admin's switch is on and the request got past the pace limit, so a page view costs no model lookup otherwise. Left out, the Super
   * Admin's switch alone decides.
   */
  modelReady?: boolean | (() => Promise<boolean>);
  /**
   * Set only by the signed server-to-server registration route (src/server/demo/registration.ts), after it has verified the marketing backend's HMAC. That caller's network
   * address is the marketing server, not the visitor, so counting it against the public per-address rules would throttle every prospect at once (six starts an hour). The
   * per-mailbox rule still applies. Left out, every rule applies exactly as it does for a browser.
   */
  trustedCaller?: "marketing";
}

async function modelIsReady(ctx: DemoContext): Promise<boolean> {
  const m = ctx.modelReady;
  return m === undefined ? true : typeof m === "function" ? m() : m;
}

export interface Refused {
  ok: false;
  reason: PublicRefusal;
  message: string;
  retryAfterSeconds?: number;
  /** Per-field problems of the form, plain sentences. */
  fields?: Partial<Record<"name" | "email" | "business" | "industry" | "consent", string>>;
}

const refuse = (reason: PublicRefusal, extra: Partial<Refused> = {}): Refused => ({ ok: false, reason, message: PUBLIC_COPY[reason], ...extra });
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The checks that need no database: the emergency stop, the deployment's permission, and the per-address pace. Null to carry on. */
async function entry(ctx: DemoContext): Promise<Refused | null> {
  if (demoPublicDisabled()) return refuse("unavailable", { retryAfterSeconds: 300 });
  if (!demoDeploymentEnabled()) return refuse("not_available");
  // A verified server-to-server call is paced by the registration route (per caller and per marketing address), not by this visitor-shaped rule.
  if (ctx.trustedCaller) return null;
  const pace = await consumeRateLimit(RATE_LIMITS.demoPublicByIp, addressKey(ctx.ip));
  if (!pace.allowed) return refuse("rate_limited", { retryAfterSeconds: pace.retryAfterSeconds });
  return null;
}

/** Tells the team after the work is committed. Best effort: a prospect's request never fails because a notice could not be written. */
async function announce(notices: ProspectNotice[]): Promise<void> {
  for (const n of notices) {
    try {
      await withSystem((db) => notifyProspectTeam(db, n));
    } catch {
      // The funnel keeps working; the timeline has the entry either way.
    }
  }
}

/** Where the team looks at a prospect (the screen is built in a later stage; a notification links to it by id only). */
const prospectLink = (id: string) => `/admin/prospects/${id}`;

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

type LinkPurpose = "verify" | "return";

/** A new link for the prospect. Links of the same kind that were never used are removed first, so only the newest one works. */
async function createLink(db: Queryable, prospectId: string, purpose: LinkPurpose, now: Date): Promise<string> {
  await db.query("delete from demo_verifications where prospect_id = $1 and purpose = $2 and consumed_at is null", [prospectId, purpose]);
  const token = newDemoToken();
  await db.query("insert into demo_verifications (prospect_id, purpose, token_hash, expires_at, created_at) values ($1, $2, $3, $4::timestamptz, $5::timestamptz)", [
    prospectId, purpose, hashDemoToken(token), new Date(now.getTime() + env().DEMO_VERIFICATION_TTL_HOURS * HOUR_MS).toISOString(), now.toISOString(),
  ]);
  return token;
}

/** The email carries nothing the prospect typed (a stranger could otherwise use it to put words in front of someone else), only the link and what it does. */
async function sendLink(to: string, token: string, purpose: LinkPurpose): Promise<boolean> {
  const first = purpose === "verify";
  const delivery = await sendEmail(
    {
      to,
      template: "demo_link",
      subject: first ? "Your iAcquire demo link" : "Your link back to the iAcquire demo",
      text: [
        first ? "Take a quick look at how the iAcquire AI team works with sample data only." : "Continue exploring the iAcquire demo with sample data.",
        `Open your demo: ${appUrl(`/demo/verify?token=${token}`)}`,
        `The link works once and expires in ${env().DEMO_VERIFICATION_TTL_HOURS} hours. If you did not ask for it, you can ignore this email.`,
      ].join("\n\n"),
    },
    undefined,
    { wait: true },
  );
  return delivery.status !== "failed";
}

/** Removes a link whose email could not be sent, so the mailbox is not left with a dead one and the next request starts clean. */
async function dropLink(token: string): Promise<void> {
  await withSystem((db) => db.query("delete from demo_verifications where token_hash = $1 and consumed_at is null", [hashDemoToken(token)])).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Asking for a demo
// ---------------------------------------------------------------------------

export interface RegisterInput {
  name: unknown;
  email: unknown;
  business: unknown;
  industry: unknown;
  /** The required tick box beside the notice. */
  consent: unknown;
  marketingOptIn?: unknown;
  utm?: unknown;
  /** A field a person never sees; a bot fills it. */
  trap?: unknown;
}

export type RegisterResult = { ok: true; maskedEmail: string } | Refused;

type Plan =
  | { kind: "closed" }
  | { kind: "blocked_domain" }
  | { kind: "daily_cap" }
  | { kind: "nothing" }
  | { kind: "link"; to: string; token: string; purpose: LinkPurpose };

export async function registerProspect(input: RegisterInput, ctx: DemoContext = {}): Promise<RegisterResult> {
  const now = ctx.now ?? new Date();
  const closed = await entry(ctx);
  if (closed) return closed;
  const ipHashed = addressKey(ctx.ip);
  // Trusted server-to-server calls are paced by the registration route instead: this address is the marketing server, so a per-address start limit would cap all prospects
  // together. The per-mailbox rule below still applies to every caller.
  if (!ctx.trustedCaller) {
    const pace = await consumeRateLimit(RATE_LIMITS.demoStartByIp, ipHashed);
    if (!pace.allowed) return refuse("rate_limited", { retryAfterSeconds: pace.retryAfterSeconds });
  }

  const typed = typedEmail(input.email);
  // A bot that filled the hidden field is told it worked and nothing is stored or sent.
  if (typeof input.trap === "string" && input.trap.trim() !== "") return { ok: true, maskedEmail: maskEmail(typed || "a@b.c") };

  const name = cleanLine(input.name, MAX_NAME_CHARS);
  const business = cleanLine(input.business, MAX_BUSINESS_CHARS);
  const fields: NonNullable<Refused["fields"]> = {};
  if (name.length < 1 || name.length > MAX_NAME_CHARS) fields.name = FIELD_COPY.name;
  if (!looksLikeEmail(input.email)) fields.email = FIELD_COPY.email;
  if (business.length < 1 || business.length > MAX_BUSINESS_CHARS) fields.business = FIELD_COPY.business;
  if (!isDemoIndustry(input.industry)) fields.industry = FIELD_COPY.industry;
  if (input.consent !== true) fields.consent = FIELD_COPY.consent;
  if (Object.keys(fields).length) return refuse("invalid", { fields });

  const normalized = normalizeProspectEmail(typed);
  const mailbox = await consumeRateLimit(RATE_LIMITS.demoStartByEmail, mailboxKey(normalized));
  if (!mailbox.allowed) return refuse("rate_limited", { retryAfterSeconds: mailbox.retryAfterSeconds });

  const industry = input.industry as string;
  const utm = cleanUtm(input.utm);
  const marketing = input.marketingOptIn === true;

  const plan = await withSystem(async (db): Promise<Plan> => {
    const { settings } = await readDemoSettings(db);
    if (!settings.enabled) return { kind: "closed" };
    if (isBlockedDomain(typed, settings.blockedEmailDomains)) return { kind: "blocked_domain" };
    const find = async () => (await db.query<ProspectRow>(`select ${PROSPECT_COLUMNS} from demo_prospects p where p.email_normalized = $1 for update`, [normalized])).rows[0] ?? null;
    let p = await find();
    if (!p) {
      if (!(await startsLeft(db, now, settings.dailyStartCap))) return { kind: "daily_cap" };
      // Matched by address only, so the agency sees one pipeline; the request itself is never changed.
      const request = (await db.query<{ id: string }>("select id from access_requests where email = $1 order by created_at desc limit 1", [typed])).rows[0]?.id ?? null;
      const inserted = await db.query<{ id: string }>(
        `insert into demo_prospects (access_request_id, name, work_email, email_normalized, business_name, industry, ip_hash, utm, consent_at, consent_version, marketing_opt_in, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $10, $11, $9::timestamptz)
         on conflict (email_normalized) do nothing returning id`,
        [request, name, typed, normalized, business, industry, ipHashed, JSON.stringify(utm), now.toISOString(), NOTICE_VERSION, marketing],
      );
      p = await find();
      if (!p) return { kind: "nothing" };
      if (inserted.rows[0]) await addEvent(db, p.id, "registered", { kind: "prospect" }, { marketingOptIn: marketing }, now);
    }
    const access = accessOf(factsOf(p), now);
    if (access === "unverified") {
      // Not confirmed yet: the details they typed this time replace the earlier ones (a typo is fixed), and a fresh link replaces the old one. The address the link goes to is the first one.
      await db.query(
        "update demo_prospects set name = $2, business_name = $3, industry = $4, utm = $5::jsonb, ip_hash = $6, consent_at = $7::timestamptz, consent_version = $8, marketing_opt_in = $9 where id = $1",
        [p.id, name, business, industry, JSON.stringify(utm), ipHashed, now.toISOString(), NOTICE_VERSION, marketing],
      );
      return { kind: "link", to: p.work_email as string, token: await createLink(db, p.id, "verify", now), purpose: "verify" };
    }
    if (access === "open") {
      // They already started: a way back, nothing else. The window and the message count are exactly what they were.
      await addEvent(db, p.id, "return_link", { kind: "prospect" }, {}, now);
      return { kind: "link", to: p.work_email as string, token: await createLink(db, p.id, "return", now), purpose: "return" };
    }
    return { kind: "nothing" };
  });

  if (plan.kind === "closed") return refuse("not_available");
  if (plan.kind === "blocked_domain") return refuse("blocked_domain");
  if (plan.kind === "daily_cap") return refuse("daily_cap");
  if (plan.kind === "link" && !(await sendLink(plan.to, plan.token, plan.purpose))) {
    await dropLink(plan.token);
    return refuse("email_failed");
  }
  return { ok: true, maskedEmail: maskEmail(typed) };
}

/**
 * "Send me a new link": for someone who already confirmed and whose window is still open. The answer is the same whether or not the address is known; an address that never
 * started a demo, whose window has ended, or that was blocked gets nothing.
 */
export async function requestReturnLink(emailInput: unknown, ctx: DemoContext = {}): Promise<RegisterResult> {
  const now = ctx.now ?? new Date();
  const closed = await entry(ctx);
  if (closed) return closed;
  if (!looksLikeEmail(emailInput)) return refuse("invalid", { fields: { email: FIELD_COPY.email } });
  const typed = typedEmail(emailInput);
  const normalized = normalizeProspectEmail(typed);
  const mailbox = await consumeRateLimit(RATE_LIMITS.demoReturnByProspect, mailboxKey(normalized));
  if (!mailbox.allowed) return refuse("rate_limited", { retryAfterSeconds: mailbox.retryAfterSeconds });
  const plan = await withSystem(async (db): Promise<Plan> => {
    const { settings } = await readDemoSettings(db);
    if (!settings.enabled) return { kind: "closed" };
    const p = (await db.query<ProspectRow>(`select ${PROSPECT_COLUMNS} from demo_prospects p where p.email_normalized = $1 for update`, [normalized])).rows[0];
    if (!p || accessOf(factsOf(p), now) !== "open") return { kind: "nothing" };
    await addEvent(db, p.id, "return_link", { kind: "prospect" }, {}, now);
    return { kind: "link", to: p.work_email as string, token: await createLink(db, p.id, "return", now), purpose: "return" };
  });
  if (plan.kind === "closed") return refuse("not_available");
  if (plan.kind === "link" && !(await sendLink(plan.to, plan.token, plan.purpose))) {
    await dropLink(plan.token);
    return refuse("email_failed");
  }
  return { ok: true, maskedEmail: maskEmail(typed) };
}

// ---------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------

export type PeekResult = { ok: true; purpose: LinkPurpose } | Refused;

interface LinkRow {
  id: string;
  prospect_id: string;
  purpose: LinkPurpose;
  expires_at: Date;
  consumed_at: Date | null;
}

const LINK_COLUMNS = "v.id, v.prospect_id, v.purpose, v.expires_at, v.consumed_at";

/**
 * What the link's page shows when it is opened (a GET). It reads and changes nothing: a mail scanner that opens every link in a message must not use the link up, and opening the
 * page is not "confirming" anything. The page then offers a button; pressing it is confirmVerification.
 */
export async function peekVerification(token: unknown, ctx: DemoContext = {}): Promise<PeekResult> {
  const now = ctx.now ?? new Date();
  const closed = await entry(ctx);
  if (closed) return closed;
  const pace = await consumeRateLimit(RATE_LIMITS.demoVerifyByIp, addressKey(ctx.ip));
  if (!pace.allowed) return refuse("rate_limited", { retryAfterSeconds: pace.retryAfterSeconds });
  if (!looksLikeDemoToken(token)) return refuse("link_invalid");
  const hash = hashDemoToken(token);
  return withSystem(async (db): Promise<PeekResult> => {
    if (!(await readDemoSettings(db)).settings.enabled) return refuse("not_available");
    const v = (await db.query<LinkRow>(`select ${LINK_COLUMNS} from demo_verifications v where v.token_hash = $1`, [hash])).rows[0];
    if (!v) return refuse("link_invalid");
    if (v.consumed_at) return refuse("link_used");
    if (new Date(v.expires_at).getTime() <= now.getTime()) return refuse("link_expired");
    return { ok: true, purpose: v.purpose };
  });
}

export type ConfirmResult =
  | { ok: true; sessionToken: string; expiresAt: Date; purpose: LinkPurpose; windowEndsAt: Date | null; firstTime: boolean }
  | Refused;

/**
 * Pressing the link's button (a POST). Uses the link up, opens the demo window if this is the first time (copying the settings' length and message count to the prospect, so a
 * later change of the settings never moves them) and starts the prospect's session. Refused, with the link left alone, while the day's places are taken or the demo is switched off.
 */
export async function confirmVerification(token: unknown, ctx: DemoContext = {}): Promise<ConfirmResult> {
  const now = ctx.now ?? new Date();
  const closed = await entry(ctx);
  if (closed) return closed;
  const pace = await consumeRateLimit(RATE_LIMITS.demoVerifyByIp, addressKey(ctx.ip));
  if (!pace.allowed) return refuse("rate_limited", { retryAfterSeconds: pace.retryAfterSeconds });
  if (!looksLikeDemoToken(token)) return refuse("link_invalid");
  const hash = hashDemoToken(token);
  const notices: ProspectNotice[] = [];
  const result = await withSystem(async (db): Promise<ConfirmResult> => {
    const { settings } = await readDemoSettings(db);
    if (!settings.enabled) return refuse("not_available");
    const v = (await db.query<LinkRow>(`select ${LINK_COLUMNS} from demo_verifications v where v.token_hash = $1 for update`, [hash])).rows[0];
    if (!v) return refuse("link_invalid");
    if (v.consumed_at) return refuse("link_used");
    if (new Date(v.expires_at).getTime() <= now.getTime()) return refuse("link_expired");
    const p = await lockProspect(db, v.prospect_id);
    if (!p || p.erased_at) return refuse("link_invalid");
    const access = accessOf(factsOf(p), now);
    if (access === "blocked" || access === "converted" || access === "erased") return refuse("link_invalid");
    let windowEndsAt = p.window_ends_at ? new Date(p.window_ends_at) : null;
    let firstTime = false;
    if (access === "unverified") {
      // A place for today first: when none is left nothing is written, and the link still works tomorrow (within its configured lifetime).
      if (!(await takeStart(db, now, settings.dailyStartCap))) return refuse("daily_cap");
      windowEndsAt = new Date(now.getTime() + settings.windowHours * HOUR_MS);
      await db.query(
        "update demo_prospects set status = 'active', verified_at = $2::timestamptz, window_ends_at = $3::timestamptz, message_limit = $4, last_seen_at = $2::timestamptz where id = $1",
        [p.id, now.toISOString(), windowEndsAt.toISOString(), settings.messageLimit],
      );
      await addEvent(db, p.id, "verified", { kind: "prospect" }, { windowHours: settings.windowHours, messageLimit: settings.messageLimit }, now);
      notices.push({
        kind: "demo_prospect_verified", severity: "info", title: "A prospect started a demo", body: "A prospect confirmed their email address and opened their demo window.",
        link: prospectLink(p.id), dedupeKey: `demo-verified:${p.id}`,
      });
      firstTime = true;
    }
    const used = await db.query("update demo_verifications set consumed_at = $2::timestamptz where id = $1 and consumed_at is null returning id", [v.id, now.toISOString()]);
    if (!used.rows[0]) return refuse("link_used");
    const sessionToken = newDemoToken();
    const expiresAt = new Date(now.getTime() + SESSION_DAYS * DAY_MS);
    await db.query("insert into demo_sessions (prospect_id, token_hash, user_agent_hash, created_at, last_seen_at, expires_at) values ($1, $2, $3, $4::timestamptz, $4::timestamptz, $5::timestamptz)", [
      p.id, hashDemoToken(sessionToken), hashIp(ctx.userAgent ?? null), now.toISOString(), expiresAt.toISOString(),
    ]);
    await addEvent(db, p.id, "accessed", { kind: "prospect" }, { purpose: v.purpose }, now);
    return { ok: true, sessionToken, expiresAt, purpose: v.purpose, windowEndsAt, firstTime };
  });
  if (result.ok) await announce(notices);
  return result;
}

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
}

export interface FoundSession {
  sessionId: string;
  prospect: ProspectRow;
}

/** The prospect a session cookie belongs to, or null. A session ended by a block or a conversion, an expired one, and one of an erased prospect all read as nothing. */
export async function findSession(db: Queryable, token: unknown, now: Date, opts: { lock?: boolean } = {}): Promise<FoundSession | null> {
  if (!looksLikeDemoToken(token)) return null;
  const s = (await db.query<SessionRow & { prospect_id: string }>(
    "select s.id, s.prospect_id from demo_sessions s where s.token_hash = $1 and s.revoked_at is null and s.expires_at > $2::timestamptz",
    [hashDemoToken(token), now.toISOString()],
  )).rows[0];
  if (!s) return null;
  const p = opts.lock ? await lockProspect(db, s.prospect_id) : await loadProspect(db, s.prospect_id);
  if (!p || p.erased_at) return null;
  const access = accessOf(factsOf(p), now);
  if (access === "blocked" || access === "converted" || access === "unverified") return null;
  // Seen at most once a minute, so reading the room does not write on every request.
  await db.query("update demo_sessions set last_seen_at = $2::timestamptz where id = $1 and last_seen_at < $2::timestamptz - interval '1 minute'", [s.id, now.toISOString()]);
  await db.query("update demo_prospects set last_seen_at = $2::timestamptz where id = $1 and (last_seen_at is null or last_seen_at < $2::timestamptz - interval '1 minute')", [p.id, now.toISOString()]);
  return { sessionId: s.id, prospect: p };
}

export interface TranscriptLine {
  id: string;
  seq: number;
  role: "user" | "assistant";
  employeeRole: string | null;
  body: string;
  /** A prospect's own message: waiting for its answer, answered, or not counted because no answer came. Null for an answer. */
  state: "pending" | "answered" | "failed" | null;
  at: string;
}

export interface RoomView {
  firstName: string;
  business: string | null;
  industry: string | null;
  industryLabel: string | null;
  status: ProspectStatus;
  access: AccessState;
  windowEndsAt: string | null;
  /** Messages left to send, and the allowance they came from. */
  messagesLeft: number;
  messageAllowance: number;
  extended: boolean;
  consultationRequested: boolean;
  purchaseStarted: boolean;
  transcript: TranscriptLine[];
  chat: {
    /** Whether the AI chat can answer right now: the Super Admin's switch is on AND a model was found (ctx.modelReady). Off: the guided tour is what the room offers, and it says so. */
    aiEnabled: boolean;
    canSend: boolean;
    /** Why a message cannot be sent now, in the words to show; null when one can. */
    refusal: ChatRefusal | "ai_off" | null;
    refusalMessage: string | null;
  };
  consultationUrl: string | null;
  /** The published prices, from the one place they live. The monthly plan is optional. */
  pricing: { setupFeeUsd: number; monthlyPlanUsd: number; monthlyPlanOptional: true };
}

interface MessageRow {
  id: string;
  seq: number;
  role: "user" | "assistant";
  employee_role: string | null;
  body: string;
  state: "pending" | "answered" | "failed" | null;
  created_at: Date;
}

export async function transcriptOf(db: Queryable, prospectId: string): Promise<TranscriptLine[]> {
  const { rows } = await db.query<MessageRow>(
    "select id::text as id, seq, role, employee_role, body, state, created_at from demo_messages where prospect_id = $1 and role <> 'system' order by seq limit 400",
    [prospectId],
  );
  return rows.map((m) => ({ id: m.id, seq: m.seq, role: m.role, employeeRole: m.employee_role, body: m.body, state: m.state, at: new Date(m.created_at).toISOString() }));
}

/**
 * What the demo room shows for the session cookie: the prospect's own window and message count, and their stored conversation, which stays readable after the window ends.
 * Nothing about any other prospect or any workspace is in it, and neither the prospect's email address nor their id.
 */
export async function getRoom(ctx: DemoContext): Promise<{ ok: true; room: RoomView } | Refused> {
  const now = ctx.now ?? new Date();
  const closed = await entry(ctx);
  if (closed) return closed;
  const out = await withSystem(async (db) => {
    const { settings } = await readDemoSettings(db);
    if (!settings.enabled) return refuse("not_available");
    const found = await findSession(db, ctx.sessionToken, now);
    if (!found) return refuse("no_session");
    const p = found.prospect;
    const facts = factsOf(p);
    const access = accessOf(facts, now);
    const aiAvailable = settings.aiEnabled;
    const refusal = chatRefusalFor(facts, now) ?? (aiAvailable ? null : "ai_off");
    const room: RoomView = {
      firstName: firstNameOf(p.name),
      business: p.business_name,
      industry: p.industry,
      industryLabel: demoIndustryLabel(p.industry),
      status: effectiveStatus(facts, now),
      access,
      windowEndsAt: p.window_ends_at ? new Date(p.window_ends_at).toISOString() : null,
      messagesLeft: messagesLeft(facts),
      messageAllowance: messageAllowance(facts),
      extended: p.extended_count > 0,
      consultationRequested: p.consultation_requested_at !== null,
      purchaseStarted: p.purchase_started_at !== null,
      transcript: await transcriptOf(db, p.id),
      chat: { aiEnabled: aiAvailable, canSend: refusal === null, refusal, refusalMessage: refusal ? REFUSAL_COPY[refusal] : null },
      consultationUrl: settings.consultationUrl,
      pricing: { setupFeeUsd: SETUP_FEE_USD, monthlyPlanUsd: MAINTENANCE_MONTHLY_USD, monthlyPlanOptional: true },
    };
    return { ok: true as const, room };
  });
  // The model is looked for after the transaction (it uses the database itself) and only when the Super Admin's switch is on: with no model the AI chat is not available, whatever
  // the switch says, and the room says so before anyone types.
  if (out.ok && out.room.chat.aiEnabled && !(await modelIsReady(ctx))) {
    const chat = out.room.chat;
    const refusal = chat.refusal ?? "ai_off";
    out.room.chat = { aiEnabled: false, canSend: false, refusal, refusalMessage: REFUSAL_COPY[refusal] };
  }
  return out;
}

export interface FormView {
  /** Days the notice says details are kept: the settings' retention period. */
  retentionDays: number;
  /** Today's places are all taken: the form is not shown, the page says so. */
  full: boolean;
  /** This browser already holds a demo session that is still good. */
  hasSession: boolean;
  /** What a new demo gets, from the settings in force: hours open, and the AI messages (only when the AI chat can answer; otherwise the guided tour is what is offered). */
  windowHours: number;
  messageLimit: number;
  aiChat: boolean;
}

/**
 * What the request page needs: whether the demo is open at all (a refusal says why), the retention period for the notice under the form, whether today still has places, and
 * whether this browser already has a demo. It reads; it records nothing about the visitor.
 */
export async function getFormView(ctx: DemoContext): Promise<{ ok: true; form: FormView } | Refused> {
  const now = ctx.now ?? new Date();
  const closed = await entry(ctx);
  if (closed) return closed;
  const out = await withSystem(async (db) => {
    const { settings } = await readDemoSettings(db);
    if (!settings.enabled) return refuse("not_available");
    const found = looksLikeDemoToken(ctx.sessionToken) ? await findSession(db, ctx.sessionToken, now) : null;
    return {
      ok: true as const,
      form: {
        retentionDays: settings.retentionDays,
        full: !(await startsLeft(db, now, settings.dailyStartCap)),
        hasSession: found !== null,
        windowHours: settings.windowHours,
        messageLimit: settings.messageLimit,
        aiChat: settings.aiEnabled,
      },
    };
  });
  if (out.ok && out.form.aiChat && !(await modelIsReady(ctx))) out.form.aiChat = false;
  return out;
}

// ---------------------------------------------------------------------------
// Calls to action
// ---------------------------------------------------------------------------

export type CtaKind = "consultation" | "buy";

/**
 * "Book a free consultation" and "Buy now": recorded once each on the prospect (a second press changes nothing), the latest one is the status, and the team is told. Works while the
 * window is over too: asking to talk to a person is what a prospect with no messages left is offered. Buying online is not built yet; pressing Buy only records that they asked.
 */
export async function recordCta(kind: CtaKind, ctx: DemoContext): Promise<{ ok: true; consultationUrl: string | null; alreadyRecorded: boolean } | Refused> {
  const now = ctx.now ?? new Date();
  const closed = await entry(ctx);
  if (closed) return closed;
  if (!looksLikeDemoToken(ctx.sessionToken)) return refuse("no_session");
  const pace = await consumeRateLimit(RATE_LIMITS.demoActionByProspect, hashDemoToken(ctx.sessionToken as string).slice(0, 40));
  if (!pace.allowed) return refuse("rate_limited", { retryAfterSeconds: pace.retryAfterSeconds });
  const notices: ProspectNotice[] = [];
  const result = await withSystem(async (db) => {
    const { settings } = await readDemoSettings(db);
    if (!settings.enabled) return refuse("not_available");
    const found = await findSession(db, ctx.sessionToken, now, { lock: true });
    if (!found) return refuse("no_session");
    const p = found.prospect;
    const first = kind === "consultation" ? p.consultation_requested_at === null : p.purchase_started_at === null;
    const target: ProspectStatus = kind === "consultation" ? "consultation_requested" : "purchase_started";
    if (first) {
      const column = kind === "consultation" ? "consultation_requested_at" : "purchase_started_at";
      const status = canTransition(p.status, target) ? target : p.status;
      await db.query(`update demo_prospects set ${column} = $2::timestamptz, status = $3 where id = $1`, [p.id, now.toISOString(), status]);
      await addEvent(db, p.id, kind === "consultation" ? "cta_consultation" : "cta_buy", { kind: "prospect" }, {}, now);
      notices.push(
        kind === "consultation"
          ? { kind: "demo_consultation_requested", severity: "info", title: "A prospect asked for a consultation", body: "A prospect asked to talk to a person after their demo.", link: prospectLink(p.id), dedupeKey: `demo-consultation:${p.id}` }
          : { kind: "demo_purchase_started", severity: "info", title: "A prospect pressed Buy now", body: "A prospect pressed Buy now in the demo. Nothing was charged and no workspace was created.", link: prospectLink(p.id), dedupeKey: `demo-buy:${p.id}` },
      );
    } else if (canTransition(p.status, target) && p.status !== target) {
      // The latest thing they asked for is the status.
      await db.query("update demo_prospects set status = $2 where id = $1", [p.id, target]);
    }
    return { ok: true as const, consultationUrl: settings.consultationUrl, alreadyRecorded: !first };
  });
  if (result.ok) await announce(notices);
  return result;
}

/** Ends the prospect's session (leave the demo on this device). The conversation stays; a new link brings them back. */
export async function endSession(ctx: DemoContext): Promise<void> {
  if (!looksLikeDemoToken(ctx.sessionToken)) return;
  await withSystem((db) => db.query("update demo_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null", [hashDemoToken(ctx.sessionToken as string)]));
}
