import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyUser } from "@/server/notifications";
import { consumeRateLimit } from "@/server/security/rate-limit";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "@/server/security/crypto";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner } from "@/server/crm/workspace";
import { isValidTimeZone } from "@/lib/calendars/slots";
import { CalendarProviderError, type AuthSession, type CalendarAdapter, type CalendarCursor, type CalendarProvider, type RemoteCalendar } from "@/server/calendars/adapters/types";
import { authorizeUrl, exchangeCode, GOOGLE_REQUIRED_SCOPES, GOOGLE_WRITE_SCOPE, oauthConfig, pkcePair, refreshAccessToken, revokeToken, type OAuthProvider, type TokenSet } from "@/server/calendars/adapters/oauth";
import { googleAccount, googleAdapter, googleFreeBusy } from "@/server/calendars/adapters/google";
import { microsoftAccount, microsoftAdapter, microsoftCanRead, microsoftSchedule } from "@/server/calendars/adapters/microsoft";
import { caldavAdapter, discoverCalDav, ICLOUD_CALDAV_URL } from "@/server/calendars/adapters/caldav";
import { FEED_CALENDAR_ID, icsAdapter, normalizeFeedUrl, testFeed } from "@/server/calendars/adapters/ics";

// Connected calendars: one person's own Google, Microsoft 365, iCloud/CalDAV calendar or ICS feed, used to keep their busy times out of
// booking pages and (where the provider allows) to add the appointments they host to their calendar.
//
// Who may do what: only the person can connect their own calendar (calendars.connect). Workspace managers (calendars.manage) can see
// everyone's connections and disconnect one, never connect on someone's behalf. iAcquire support sessions never connect a calendar.
// Credentials (OAuth tokens, CalDAV app passwords, private feed links) are stored AES-GCM encrypted in a column the application role
// cannot read, are never logged or returned, and a connection only shows as connected after an authenticated read of the calendar worked.

export type ConnectionStatus = "connected" | "needs_reauth" | "error" | "disconnected";

export const PROVIDER_LABELS: Record<CalendarProvider, string> = { google: "Google Calendar", microsoft: "Microsoft Outlook / 365", caldav: "CalDAV", ics: "ICS feed" };

type OAuthCredentials = { v: 1; kind: "oauth"; accessToken: string; refreshToken: string | null; expiresAt: number; scopes: string[] };
type CalDavCredentials = { v: 1; kind: "caldav"; serverUrl: string; username: string; password: string; principalUrl: string; homeUrl: string };
type IcsCredentials = { v: 1; kind: "ics"; url: string };
type StoredCredentials = OAuthCredentials | CalDavCredentials | IcsCredentials;

const seal = (c: StoredCredentials) => encryptSecret(JSON.stringify(c));
function unseal(payload: string | null): StoredCredentials | null {
  if (!payload) return null;
  try {
    return JSON.parse(decryptSecret(payload)) as StoredCredentials;
  } catch {
    return null;
  }
}

export interface ConnectionView {
  id: string;
  userId: string;
  userName: string | null;
  provider: CalendarProvider;
  accountLabel: string;
  status: ConnectionStatus;
  lastSyncedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  checkConflicts: boolean;
  conflictCalendarIds: string[];
  writeEvents: boolean;
  writeCalendarId: string | null;
  calendars: RemoteCalendar[];
  /** Whether this connection could write events at all (provider and granted permissions). */
  canWriteEvents: boolean;
  nextSyncAt: string | null;
  createdAt: string;
}

export interface SyncRunView {
  id: string;
  connectionId: string;
  kind: "busy" | "write" | "connect" | "disconnect";
  status: "ok" | "partial" | "failed";
  startedAt: string;
  finishedAt: string | null;
  counts: Record<string, number | boolean>;
  error: string | null;
}

export interface ProviderOption {
  key: "google" | "microsoft" | "icloud" | "caldav" | "ics";
  label: string;
  configured: boolean;
  /** Why it can't be used, when it can't. */
  unavailableReason: string | null;
}

export interface CalendarConnectionSettings {
  providers: ProviderOption[];
  syncPaused: boolean;
  syncMinutes: number;
  icsMinutes: number;
}

/** What the connections screen may offer in this deployment. Nothing secret: only whether each provider is configured. */
export function calendarConnectionSettings(): CalendarConnectionSettings {
  const e = env();
  const notSetUp = "Not set up by iAcquire yet. An iAcquire administrator registers the app with the provider and adds its client ID and secret to the server settings.";
  return {
    providers: [
      { key: "google", label: "Google Calendar", configured: !!oauthConfig("google"), unavailableReason: oauthConfig("google") ? null : notSetUp },
      { key: "microsoft", label: "Microsoft Outlook / 365", configured: !!oauthConfig("microsoft"), unavailableReason: oauthConfig("microsoft") ? null : notSetUp },
      { key: "icloud", label: "Apple iCloud", configured: true, unavailableReason: null },
      { key: "caldav", label: "Other CalDAV server", configured: true, unavailableReason: null },
      { key: "ics", label: "ICS feed (read-only)", configured: true, unavailableReason: null },
    ],
    syncPaused: e.CALENDAR_SYNC_DISABLED,
    syncMinutes: e.CALENDAR_SYNC_INTERVAL_MINUTES,
    icsMinutes: e.CALENDAR_ICS_POLL_MINUTES,
  };
}

/** How often a connection is read (ICS feeds are polled less often: they are whole files). */
export function pollMinutesFor(provider: CalendarProvider): number {
  return provider === "ics" ? env().CALENDAR_ICS_POLL_MINUTES : env().CALENDAR_SYNC_INTERVAL_MINUTES;
}

// ---------------------------------------------------------------------------
// The one-time notice shown after a sign-in comes back (a short-lived cookie, so nothing lands in the URL)
// ---------------------------------------------------------------------------

export const CALENDAR_NOTICE_COOKIE = "iaq_calendar_notice";

export interface CalendarNotice {
  kind: "success" | "info" | "error";
  provider: string;
  message: string;
}

export function encodeCalendarNotice(n: CalendarNotice): string {
  return encodeURIComponent(JSON.stringify({ kind: n.kind, provider: n.provider.slice(0, 20), message: n.message.slice(0, 300) }));
}

export function decodeCalendarNotice(raw: string | undefined | null): CalendarNotice | null {
  if (!raw || raw.length > 2000) return null;
  try {
    const v = JSON.parse(decodeURIComponent(raw)) as Partial<CalendarNotice>;
    if (!v || !["success", "info", "error"].includes(v.kind ?? "") || typeof v.message !== "string") return null;
    return { kind: v.kind as CalendarNotice["kind"], provider: String(v.provider ?? "").slice(0, 20), message: v.message.slice(0, 300) };
  } catch {
    return null;
  }
}

/** Cookie options for the notice: readable only by the server, sent only to CRM pages, gone after a minute. */
export const CALENDAR_NOTICE_COOKIE_OPTIONS = { httpOnly: true, sameSite: "lax" as const, path: "/crm", maxAge: 60, secure: process.env.NODE_ENV === "production" };

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/** Connecting is always for oneself: a signed-in member with calendars.connect. Agency support, AI employees and integrations never can. */
function assertConnector(actor: CrmActor): string {
  if (actor.kind !== "member" || !actor.userId) {
    throw new AppError("forbidden", actor.kind === "agency" ? "iAcquire support can't connect anyone's personal calendar. Each person connects their own." : "Only a person can connect their own calendar.");
  }
  assertCan(actor, "calendars.connect", "Your role doesn't include connecting a calendar. Ask a workspace owner for access.");
  return actor.userId;
}

async function connectRateLimit(userId: string) {
  const r = await consumeRateLimit({ name: "calendar:connect", limit: 12, windowSeconds: 900 }, userId);
  if (!r.allowed) throw new AppError("rate_limited", "Too many connection attempts in a short time. Wait a few minutes and try again.", { retryAfterSeconds: r.retryAfterSeconds });
}

/** Maps a provider failure during connect to a message for the person. Unknown errors are left alone so they surface as bugs. */
function connectError(err: unknown, provider: string): never {
  if (err instanceof CalendarProviderError) {
    if (err.kind === "rate_limited") throw new AppError("rate_limited", `${provider} asked us to slow down. Try again in a few minutes.`);
    if (err.kind === "unavailable") throw new AppError("upstream_error", `${provider} couldn't be reached. Try again in a minute.`);
    throw new AppError("invalid_input", `${err.message} The calendar wasn't connected.`);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface ConnectionRow {
  id: string;
  org_id: string;
  user_id: string;
  provider: CalendarProvider;
  account_label: string;
  status: ConnectionStatus;
  last_synced_at: Date | null;
  last_success_at: Date | null;
  last_error: string | null;
  consecutive_failures: number;
  check_conflicts: boolean;
  conflict_calendar_ids: string[];
  write_events: boolean;
  external_calendar_id: string | null;
  available_calendars: RemoteCalendar[];
  scopes: string[];
  next_sync_at: Date | null;
  created_at: Date;
  user_name?: string | null;
}

const VIEW_COLUMNS = `c.id, c.org_id, c.user_id, c.provider, c.account_label, c.status, c.last_synced_at, c.last_success_at, c.last_error, c.consecutive_failures,
  c.check_conflicts, c.conflict_calendar_ids, c.write_events, c.external_calendar_id, c.available_calendars, c.scopes, c.next_sync_at, c.created_at`;

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export function canWriteEvents(provider: CalendarProvider, scopes: string[]): boolean {
  if (provider === "ics") return false;
  if (provider === "google") return scopes.includes(GOOGLE_WRITE_SCOPE);
  return true;
}

function toView(r: ConnectionRow): ConnectionView {
  return {
    id: r.id, userId: r.user_id, userName: r.user_name ?? null, provider: r.provider, accountLabel: r.account_label, status: r.status,
    lastSyncedAt: iso(r.last_synced_at), lastSuccessAt: iso(r.last_success_at), lastError: r.last_error, consecutiveFailures: r.consecutive_failures,
    checkConflicts: r.check_conflicts, conflictCalendarIds: r.conflict_calendar_ids ?? [], writeEvents: r.write_events, writeCalendarId: r.external_calendar_id,
    calendars: Array.isArray(r.available_calendars) ? r.available_calendars : [], canWriteEvents: canWriteEvents(r.provider, r.scopes ?? []),
    nextSyncAt: iso(r.next_sync_at), createdAt: new Date(r.created_at).toISOString(),
  };
}

/** The signed-in person's own calendar connections (disconnected ones are not listed). */
export async function listMyConnections(actor: CrmActor): Promise<ConnectionView[]> {
  assertCan(actor, "appointments.view");
  if (!actor.userId || actor.kind !== "member") return [];
  const { rows } = await crmRead(actor, (db) =>
    db.query<ConnectionRow>(`select ${VIEW_COLUMNS} from crm_calendar_connections c where c.org_id = $1 and c.user_id = $2 and c.status <> 'disconnected' order by c.created_at`, [actor.orgId, actor.userId]),
  );
  return rows.map(toView);
}

/** Everyone's connections, for workspace managers: who has connected what, and whether it's working. Never any credential. */
export async function listTeamConnections(actor: CrmActor): Promise<ConnectionView[]> {
  assertCan(actor, "calendars.manage");
  // Trusted read after the check: names come from the users table, which members can't read for one another.
  const { rows } = await withSystem((db) =>
    db.query<ConnectionRow>(
      `select ${VIEW_COLUMNS}, coalesce(nullif(u.full_name, ''), u.email::text) as user_name
       from crm_calendar_connections c join users u on u.id = c.user_id
       where c.org_id = $1 and c.status <> 'disconnected' order by user_name, c.created_at`,
      [actor.orgId],
    ),
  );
  return rows.map(toView);
}

/** Recent sync history for the person's own connections (or one of them). Only counts and short errors are kept, never event details. */
export async function listSyncRuns(actor: CrmActor, opts: { connectionId?: string | null; limit?: number } = {}): Promise<SyncRunView[]> {
  assertCan(actor, "appointments.view");
  if (!actor.userId || actor.kind !== "member") return [];
  const { rows } = await crmRead(actor, (db) =>
    db.query<{ id: string; connection_id: string; kind: SyncRunView["kind"]; status: SyncRunView["status"]; started_at: Date; finished_at: Date | null; counts: Record<string, number | boolean>; error: string | null }>(
      `select r.id::text, r.connection_id, r.kind, r.status, r.started_at, r.finished_at, r.counts, r.error
       from crm_calendar_sync_runs r join crm_calendar_connections c on c.id = r.connection_id and c.org_id = r.org_id
       where r.org_id = $1 and c.user_id = $2 and ($3::uuid is null or r.connection_id = $3::uuid)
       order by r.started_at desc, r.id desc limit $4`,
      [actor.orgId, actor.userId, opts.connectionId ?? null, Math.min(100, Math.max(1, opts.limit ?? 20))],
    ),
  );
  return rows.map((r) => ({ id: r.id, connectionId: r.connection_id, kind: r.kind, status: r.status, startedAt: new Date(r.started_at).toISOString(), finishedAt: iso(r.finished_at), counts: r.counts ?? {}, error: r.error }));
}

// ---------------------------------------------------------------------------
// Opening a connection for sync (trusted server code only)
// ---------------------------------------------------------------------------

export interface ConnectionHandle {
  id: string;
  orgId: string;
  userId: string;
  provider: CalendarProvider;
  accountLabel: string;
  status: ConnectionStatus;
  timeZone: string;
  checkConflicts: boolean;
  conflictCalendarIds: string[];
  writeEvents: boolean;
  writeCalendarId: string | null;
  calendars: RemoteCalendar[];
  state: SyncState;
  scopes: string[];
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  createdAt: Date;
  adapter: CalendarAdapter;
  auth: AuthSession;
}

/** What crm_calendar_connections.sync_cursors holds: per-calendar cursors plus the sync and write-back bookkeeping. */
export interface SyncState {
  calendars?: Record<string, CalendarCursor>;
  /** The conflict calendars at the last full read, newline-joined, so a changed choice forces a full read. */
  fullSet?: string;
  fullAt?: string;
  writeLeaseUntil?: string | null;
  writeRetryAt?: string | null;
  writeFailures?: number;
}

export const NO_AUTH: AuthSession = { headers: async () => ({}), refresh: async () => false };

/** Bearer-token session that refreshes ahead of expiry and once after a 401, saving the new tokens encrypted. */
export function oauthSession(connectionId: string, provider: OAuthProvider, creds: OAuthCredentials, now: () => number = Date.now): AuthSession {
  let current = creds;
  const doRefresh = async (): Promise<boolean> => {
    const cfg = oauthConfig(provider);
    if (!cfg || !current.refreshToken) return false;
    const t = await refreshAccessToken(cfg, current.refreshToken, now());
    current = { ...current, accessToken: t.accessToken, refreshToken: t.refreshToken ?? current.refreshToken, expiresAt: t.expiresAt, scopes: t.scopes.length ? t.scopes : current.scopes };
    await withSystem((db) => db.query("update crm_calendar_connections set credentials = $2, token_expires_at = $3 where id = $1 and status <> 'disconnected'", [connectionId, seal(current), new Date(current.expiresAt)]));
    return true;
  };
  return {
    async headers() {
      if (current.expiresAt - 60_000 <= now() && current.refreshToken) await doRefresh();
      return { Authorization: `Bearer ${current.accessToken}` };
    },
    refresh: doRefresh,
  };
}

/** A transient session from a fresh token exchange (used only during the connect test, before anything is saved). */
function tokenSession(t: TokenSet): AuthSession {
  return { headers: async () => ({ Authorization: `Bearer ${t.accessToken}` }), refresh: async () => false };
}

export async function hostTimeZone(db: Queryable, orgId: string, userId: string): Promise<string> {
  const { rows } = await db.query<{ tz: string | null }>(
    "select coalesce(h.timezone, o.timezone) as tz from organizations o left join crm_host_settings h on h.org_id = o.id and h.user_id = $2 where o.id = $1",
    [orgId, userId],
  );
  const tz = rows[0]?.tz ?? "UTC";
  return isValidTimeZone(tz) ? tz : "UTC";
}

/** Loads a connection with its decrypted credentials and the adapter that speaks its provider. Null when it can't be used. */
export async function openConnection(id: string): Promise<ConnectionHandle | null> {
  const loaded = await withSystem(async (db) => {
    const { rows } = await db.query<ConnectionRow & { credentials: string | null; sync_cursors: SyncState | null }>(
      `select ${VIEW_COLUMNS}, c.credentials, c.sync_cursors from crm_calendar_connections c where c.id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    return { r, tz: await hostTimeZone(db, r.org_id, r.user_id) };
  });
  if (!loaded) return null;
  const { r, tz } = loaded;
  if (r.status === "disconnected") return null;
  const creds = unseal(r.credentials);
  if (!creds) {
    // Saved credentials that can't be decrypted (for example after an encryption key change) can never work again: say so.
    if (r.credentials) {
      await withSystem((db) => markNeedsReauth(db, { id: r.id, orgId: r.org_id, userId: r.user_id, provider: r.provider, accountLabel: r.account_label, lastSuccessAt: r.last_success_at, createdAt: r.created_at }, "iAcquire can no longer read the saved sign-in for this calendar."));
    }
    return null;
  }
  let adapter: CalendarAdapter;
  let auth: AuthSession = NO_AUTH;
  if (creds.kind === "oauth" && (r.provider === "google" || r.provider === "microsoft")) {
    adapter = r.provider === "google" ? googleAdapter : microsoftAdapter;
    auth = oauthSession(r.id, r.provider, creds);
  } else if (creds.kind === "caldav" && r.provider === "caldav") {
    adapter = caldavAdapter({ serverUrl: creds.serverUrl, username: creds.username, password: creds.password, principalUrl: creds.principalUrl, homeUrl: creds.homeUrl });
  } else if (creds.kind === "ics" && r.provider === "ics") {
    adapter = icsAdapter(creds.url, r.account_label);
  } else return null;
  return {
    id: r.id, orgId: r.org_id, userId: r.user_id, provider: r.provider, accountLabel: r.account_label, status: r.status, timeZone: tz,
    checkConflicts: r.check_conflicts, conflictCalendarIds: r.conflict_calendar_ids ?? [], writeEvents: r.write_events, writeCalendarId: r.external_calendar_id,
    calendars: Array.isArray(r.available_calendars) ? r.available_calendars : [], state: r.sync_cursors ?? {}, scopes: r.scopes ?? [],
    consecutiveFailures: r.consecutive_failures, lastSuccessAt: r.last_success_at, createdAt: r.created_at, adapter, auth,
  };
}

/**
 * Marks a connection as needing the person to sign in again, and tells them once per break (the notification is keyed to the last time
 * it worked). Busy times from it stop counting until they reconnect.
 */
export async function markNeedsReauth(db: Queryable, h: Pick<ConnectionHandle, "id" | "orgId" | "userId" | "provider" | "accountLabel" | "lastSuccessAt" | "createdAt">, message: string) {
  const { rowCount } = await db.query(
    "update crm_calendar_connections set status = 'needs_reauth', last_error = $2, next_sync_at = null where id = $1 and status in ('connected', 'error')",
    [h.id, message.slice(0, 300)],
  );
  if (!rowCount) return;
  const since = new Date(h.lastSuccessAt ?? h.createdAt).getTime();
  await notifyUser(db, h.userId, h.orgId, {
    kind: "crm_calendar_sync",
    severity: "warning",
    title: `Reconnect your ${PROVIDER_LABELS[h.provider]}`,
    body: `${h.accountLabel}: ${message.slice(0, 200)} Until you reconnect it, busy times from this calendar aren't checked when people book you.`,
    link: "/crm/calendar-connections",
    dedupeKey: `crm-cal-reauth:${h.id}:${since}`,
  });
  await recordAudit({ orgId: h.orgId, actorKind: "system", action: "crm.calendar_reauth_required", targetType: "crm_calendar_connection", targetId: h.id, result: "failure", metadata: { provider: h.provider } }, db);
}

// ---------------------------------------------------------------------------
// Saving a tested connection
// ---------------------------------------------------------------------------

interface SaveInput {
  orgId: string;
  userId: string;
  provider: CalendarProvider;
  accountLabel: string;
  providerAccountId: string;
  credentials: StoredCredentials;
  tokenExpiresAt: Date | null;
  scopes: string[];
  calendars: RemoteCalendar[];
  /** Write by default to the primary calendar (OAuth providers whose consent included writing). */
  writeByDefault: boolean;
}

/**
 * Inserts a connection or, for the same provider account (a reconnect), updates the existing row: new credentials and calendar list,
 * the person's earlier choices kept where those calendars still exist.
 */
async function saveConnection(db: Queryable, s: SaveInput, actorForAudit: { userId: string }): Promise<{ id: string; reconnected: boolean }> {
  const primary = s.calendars.find((c) => c.primary) ?? s.calendars[0];
  const ids = new Set(s.calendars.map((c) => c.id));
  const existing = await db.query<{ id: string; conflict_calendar_ids: string[]; external_calendar_id: string | null; write_events: boolean; status: ConnectionStatus; check_conflicts: boolean }>(
    `select id, conflict_calendar_ids, external_calendar_id, write_events, status, check_conflicts from crm_calendar_connections
     where org_id = $1 and user_id = $2 and provider = $3 and (provider_account_id = $4 or account_label = $5)
     order by (provider_account_id = $4) desc, created_at limit 1 for update`,
    [s.orgId, s.userId, s.provider, s.providerAccountId, s.accountLabel],
  );
  const prev = existing.rows[0];
  const writable = (id: string | null | undefined) => !!id && s.calendars.some((c) => c.id === id && c.canWrite);
  const keptConflicts = (prev?.conflict_calendar_ids ?? []).filter((id) => ids.has(id));
  const conflictIds = keptConflicts.length ? keptConflicts : primary ? [primary.id] : [];
  const reconnecting = prev && prev.status !== "disconnected";
  const writeCalendar = reconnecting && writable(prev.external_calendar_id) ? prev.external_calendar_id : s.writeByDefault && writable(primary?.id) ? primary!.id : null;
  const writeEvents = canWriteEvents(s.provider, s.scopes) && !!writeCalendar && (reconnecting ? prev.write_events || !prev.external_calendar_id : s.writeByDefault);
  const values = [
    s.accountLabel.slice(0, 200), s.providerAccountId.slice(0, 300), seal(s.credentials), s.tokenExpiresAt, s.scopes.slice(0, 20), JSON.stringify(s.calendars.slice(0, 200)),
    conflictIds, writeCalendar, writeEvents,
  ];
  let id: string;
  if (prev) {
    // A reconnect of the same account, or a fresh connect after a disconnect: same row, so history and written events stay linked.
    try {
      await db.query(
        `update crm_calendar_connections set account_label = $2, provider_account_id = $3, credentials = $4, token_expires_at = $5, scopes = $6, available_calendars = $7::jsonb,
           conflict_calendar_ids = $8::text[], external_calendar_id = $9, write_events = $10, check_conflicts = case when status = 'disconnected' then true else check_conflicts end,
           status = 'connected', last_error = null, consecutive_failures = 0, disconnected_at = null, next_sync_at = now(), sync_cursors = '{}'::jsonb
         where id = $1`,
        [prev.id, ...values],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new AppError("conflict", "You already have a calendar connected under that name. Choose a different name.");
      throw err;
    }
    id = prev.id;
  } else {
    try {
      const ins = await db.query<{ id: string }>(
        `insert into crm_calendar_connections (org_id, user_id, provider, account_label, provider_account_id, credentials, token_expires_at, scopes, available_calendars,
           conflict_calendar_ids, external_calendar_id, write_events, check_conflicts, status, next_sync_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::text[], $11, $12, true, 'connected', now()) returning id`,
        [s.orgId, s.userId, s.provider, ...values],
      );
      id = ins.rows[0].id;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new AppError("conflict", "You already have a calendar connected under that name. Choose a different name.");
      throw err;
    }
  }
  await db.query(
    "insert into crm_calendar_sync_runs (org_id, connection_id, kind, status, finished_at, counts) values ($1, $2, 'connect', 'ok', now(), $3::jsonb)",
    [s.orgId, id, JSON.stringify({ calendars: s.calendars.length, reconnected: !!prev })],
  );
  await recordAudit({ orgId: s.orgId, actorUserId: actorForAudit.userId, actorKind: "user", action: prev ? "crm.calendar_reconnected" : "crm.calendar_connected", targetType: "crm_calendar_connection", targetId: id, result: "success", metadata: { provider: s.provider, calendars: s.calendars.length, writeEvents } }, db);
  return { id, reconnected: !!prev };
}

// ---------------------------------------------------------------------------
// Google and Microsoft (OAuth)
// ---------------------------------------------------------------------------

const RETURN_PATH = /^\/crm\/[A-Za-z0-9/_?=&.-]*$|^\/crm$/;
export const DEFAULT_RETURN_PATH = "/crm/calendar-connections";

export function safeReturnPath(raw: string | null | undefined): string {
  return raw && raw.length <= 300 && RETURN_PATH.test(raw) && !raw.includes("//") ? raw : DEFAULT_RETURN_PATH;
}

/**
 * Starts a Google or Microsoft sign-in for the person's own calendar. The state is random, stored only as its hash, single-use, bound to
 * this person and valid for ten minutes; the PKCE verifier is stored encrypted. Returns the provider URL to send the browser to.
 */
export async function startCalendarOAuth(actor: CrmActor, provider: OAuthProvider, opts: { returnPath?: string | null } = {}): Promise<{ url: string }> {
  const userId = assertConnector(actor);
  const cfg = oauthConfig(provider);
  if (!cfg) throw new AppError("integration_unavailable", `${PROVIDER_LABELS[provider]} isn't set up by iAcquire yet.`);
  await connectRateLimit(userId);
  const state = randomToken(32);
  const { verifier, challenge } = pkcePair();
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "calendars");
    await db.query("delete from crm_calendar_oauth_states where user_id = $1 and (used_at is not null or expires_at < now())", [userId]);
    await db.query(
      `insert into crm_calendar_oauth_states (org_id, user_id, provider, state_hash, code_verifier, return_path, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')`,
      [actor.orgId, userId, provider, sha256(state), encryptSecret(verifier), safeReturnPath(opts.returnPath)],
    );
  });
  return { url: authorizeUrl(cfg, state, challenge) };
}

export interface OAuthOutcome {
  returnPath: string;
  connectionId: string | null;
  outcome: "connected" | "denied";
}

/**
 * Finishes a sign-in. The state is consumed first (so it can never be replayed, even by a failed attempt), must belong to the person now
 * signed in, and must be unexpired. Then the code is exchanged, the account identified, its calendars listed and one availability read
 * made. Only when all of that worked are the tokens saved (encrypted) and the connection marked connected.
 */
export async function completeCalendarOAuth(user: { id: string }, provider: OAuthProvider, input: { state?: string | null; code?: string | null; error?: string | null }, opts: { now?: Date } = {}): Promise<OAuthOutcome> {
  const now = opts.now ?? new Date();
  const state = input.state?.trim();
  if (!state || state.length > 200) throw new AppError("invalid_input", "This sign-in link is incomplete. Start again from Calendar connections.");
  const consumed = await withSystem(async (db) => {
    const { rows } = await db.query<{ org_id: string; user_id: string; code_verifier: string; return_path: string | null; expired: boolean }>(
      `update crm_calendar_oauth_states set used_at = now() where state_hash = $1 and provider = $2 and used_at is null
       returning org_id, user_id, code_verifier, return_path, expires_at <= now() as expired`,
      [sha256(state), provider],
    );
    return rows[0] ?? null;
  });
  if (!consumed) throw new AppError("invalid_input", "This sign-in was already used or has expired. Start again from Calendar connections.");
  if (consumed.user_id !== user.id) throw new AppError("forbidden", "This sign-in was started by a different person. Sign in as yourself and start again.");
  if (consumed.expired) throw new AppError("invalid_input", "This sign-in took longer than ten minutes and expired. Start again from Calendar connections.");
  const returnPath = safeReturnPath(consumed.return_path);
  if (input.error) return { returnPath, connectionId: null, outcome: "denied" };
  if (!input.code || input.code.length > 4000) throw new AppError("invalid_input", "The provider didn't return a sign-in code. Start again from Calendar connections.");

  // Still a member who may connect a calendar in that workspace, on a native calendar setup.
  const allowed = await withUser(user.id, (db) => db.query<{ ok: boolean }>("select app.has_permission($1::uuid, 'calendars.connect') as ok", [consumed.org_id]));
  if (!allowed.rows[0]?.ok) throw new AppError("forbidden", "Your access in that workspace no longer includes connecting a calendar.");
  await withSystem((db) => assertNativeOwner(db, consumed.org_id, "calendars"));

  const cfg = oauthConfig(provider);
  if (!cfg) throw new AppError("integration_unavailable", `${PROVIDER_LABELS[provider]} isn't set up by iAcquire yet.`);
  const label = PROVIDER_LABELS[provider];
  let tokens: TokenSet;
  try {
    tokens = await exchangeCode(cfg, input.code, decryptSecret(consumed.code_verifier), now.getTime());
  } catch (err) {
    connectError(err, label);
  }
  const revokeNew = () => (tokens.refreshToken ? revokeToken(provider, tokens.refreshToken) : revokeToken(provider, tokens.accessToken)).catch(() => false);
  if (provider === "google" && tokens.scopes.length && !GOOGLE_REQUIRED_SCOPES.every((s) => tokens.scopes.includes(s))) {
    await revokeNew();
    throw new AppError("invalid_input", "Google didn't grant permission to see your calendars and availability, so nothing was connected. Start again and leave those boxes ticked.");
  }
  if (!tokens.refreshToken) {
    await revokeNew();
    throw new AppError("invalid_input", `${label} didn't allow ongoing access (no refresh token), so the calendar wasn't connected. Start again and approve offline access.`);
  }
  const session = tokenSession(tokens);
  let account: { id: string; email: string };
  let calendars: RemoteCalendar[];
  try {
    account = provider === "google" ? await googleAccount(session) : await microsoftAccount(session);
    calendars = await (provider === "google" ? googleAdapter : microsoftAdapter).listCalendars(session);
    const primary = calendars.find((c) => c.primary) ?? calendars[0];
    if (!primary) throw new CalendarProviderError("not_found", `${label} returned no calendars for this account.`);
    // The capability test: an authenticated availability read of the main calendar.
    const dayLater = new Date(now.getTime() + 86_400_000);
    if (provider === "google") {
      const fb = await googleFreeBusy(session, [primary.id], now, dayLater);
      const err = fb.get(primary.id)?.error;
      if (err) throw new CalendarProviderError("forbidden", `Google couldn't read availability for your main calendar (${err}).`);
    } else {
      try {
        await microsoftSchedule(session, account.email, now, dayLater);
      } catch (err) {
        // getSchedule isn't available to personal Microsoft accounts; reading the calendar itself proves the same access.
        if (err instanceof CalendarProviderError && err.kind === "auth") throw err;
        await microsoftCanRead(session, primary.id, now);
      }
    }
  } catch (err) {
    await revokeNew();
    connectError(err, label);
  }
  const scopes = tokens.scopes.length ? tokens.scopes : [...cfg.scopes];
  const saved = await withSystem((db) =>
    saveConnection(db, {
      orgId: consumed.org_id, userId: user.id, provider, accountLabel: account.email, providerAccountId: account.id,
      credentials: { v: 1, kind: "oauth", accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, scopes },
      tokenExpiresAt: new Date(tokens.expiresAt), scopes, calendars, writeByDefault: true,
    }, { userId: user.id }),
  );
  return { returnPath, connectionId: saved.id, outcome: "connected" };
}

// ---------------------------------------------------------------------------
// iCloud and other CalDAV servers
// ---------------------------------------------------------------------------

export interface CalDavInput {
  preset: "icloud" | "caldav";
  serverUrl?: string | null;
  username: string;
  password: string;
  label?: string | null;
}

/** Connects a CalDAV account after discovery and an authenticated read; the password is stored encrypted, never shown again. */
export async function connectCalDav(actor: CrmActor, input: CalDavInput, opts: { now?: Date } = {}): Promise<{ id: string; calendars: number }> {
  const userId = assertConnector(actor);
  const username = input.username.trim();
  const password = input.password.trim();
  if (!username || username.length > 200) throw new AppError("invalid_input", input.preset === "icloud" ? "Enter your Apple ID email." : "Enter the username for the calendar server.");
  if (!password || password.length > 200) throw new AppError("invalid_input", input.preset === "icloud" ? "Enter an app-specific password from appleid.apple.com." : "Enter the password for the calendar server.");
  let serverUrl = ICLOUD_CALDAV_URL;
  if (input.preset === "caldav") {
    try {
      const u = new URL((input.serverUrl ?? "").trim());
      if (u.protocol !== "https:") throw new Error("not https");
      u.hash = "";
      u.search = "";
      serverUrl = u.toString();
    } catch {
      throw new AppError("invalid_input", "Enter the server's https:// address, for example https://caldav.example.com/.");
    }
  }
  await withSystem((db) => assertNativeOwner(db, actor.orgId, "calendars"));
  await connectRateLimit(userId);
  const service = input.preset === "icloud" ? "iCloud" : "The calendar server";
  const now = opts.now ?? new Date();
  const tz = await withSystem((db) => hostTimeZone(db, actor.orgId, userId));
  let discovered: Awaited<ReturnType<typeof discoverCalDav>>;
  try {
    discovered = await discoverCalDav({ serverUrl, username, password });
    if (!discovered.calendars.length) throw new CalendarProviderError("not_found", `${service} has no calendars that hold events for this account.`);
    const primary = discovered.calendars.find((c) => c.primary) ?? discovered.calendars[0];
    await caldavAdapter({ serverUrl, username, password, principalUrl: discovered.principalUrl, homeUrl: discovered.homeUrl })
      .readBusy(NO_AUTH, { calendarIds: [primary.id], from: now, to: new Date(now.getTime() + 86_400_000), cursors: {}, forceFull: true, isOwnEvent: () => false, timeZone: tz });
  } catch (err) {
    connectError(err, service);
  }
  const label = (input.label?.trim() || username).slice(0, 200);
  const saved = await crmWrite(actor, (db) =>
    saveConnection(db, {
      orgId: actor.orgId, userId, provider: "caldav", accountLabel: label, providerAccountId: discovered.principalUrl,
      credentials: { v: 1, kind: "caldav", serverUrl, username, password, principalUrl: discovered.principalUrl, homeUrl: discovered.homeUrl },
      tokenExpiresAt: null, scopes: [], calendars: discovered.calendars, writeByDefault: false,
    }, { userId }),
  );
  return { id: saved.id, calendars: discovered.calendars.length };
}

// ---------------------------------------------------------------------------
// ICS feeds (read-only)
// ---------------------------------------------------------------------------

/** Subscribes to a read-only ICS feed after fetching and reading it once. The address is stored encrypted (it is often a private link). */
export async function connectIcsFeed(actor: CrmActor, input: { url: string; label?: string | null }, opts: { now?: Date } = {}): Promise<{ id: string; events: number }> {
  const userId = assertConnector(actor);
  let url: string;
  try {
    url = normalizeFeedUrl(input.url);
  } catch (err) {
    connectError(err, "The calendar feed");
  }
  if (url.length > 2000) throw new AppError("invalid_input", "That calendar address is too long.");
  await withSystem((db) => assertNativeOwner(db, actor.orgId, "calendars"));
  await connectRateLimit(userId);
  const tz = await withSystem((db) => hostTimeZone(db, actor.orgId, userId));
  let tested: { events: number; name: string | null };
  try {
    tested = await testFeed(url, tz, opts.now ?? new Date());
  } catch (err) {
    connectError(err, "The calendar feed");
  }
  const label = (input.label?.trim() || tested.name || `${new URL(url).hostname} feed`).slice(0, 200);
  const saved = await crmWrite(actor, (db) =>
    saveConnection(db, {
      orgId: actor.orgId, userId, provider: "ics", accountLabel: label, providerAccountId: sha256(url),
      credentials: { v: 1, kind: "ics", url }, tokenExpiresAt: null, scopes: [],
      calendars: [{ id: FEED_CALENDAR_ID, name: label, primary: true, canWrite: false, timezone: null, meetings: [] }], writeByDefault: false,
    }, { userId }),
  );
  return { id: saved.id, events: tested.events };
}

// ---------------------------------------------------------------------------
// Options and disconnecting
// ---------------------------------------------------------------------------

export interface ConnectionOptionsInput {
  checkConflicts?: boolean;
  conflictCalendarIds?: string[];
  writeEvents?: boolean;
  writeCalendarId?: string | null;
}

/** The person's own choices for a connection: which calendars make them busy, and whether (and where) their appointments are added. */
export async function updateConnectionOptions(actor: CrmActor, id: string, input: ConnectionOptionsInput): Promise<ConnectionView> {
  const userId = assertConnector(actor);
  return crmWrite(actor, async (db) => {
    const { rows } = await db.query<ConnectionRow>(`select ${VIEW_COLUMNS} from crm_calendar_connections c where c.id = $1 and c.org_id = $2 for update`, [id, actor.orgId]);
    const c = rows[0];
    if (!c || c.status === "disconnected") throw new AppError("not_found", "That calendar connection no longer exists.");
    if (c.user_id !== userId) throw new AppError("forbidden", "Only the person whose calendar it is can change these settings.");
    const calendars = Array.isArray(c.available_calendars) ? c.available_calendars : [];
    const ids = new Set(calendars.map((x) => x.id));
    const checkConflicts = input.checkConflicts ?? c.check_conflicts;
    let conflictIds = c.conflict_calendar_ids ?? [];
    if (input.conflictCalendarIds) {
      const wanted = [...new Set(input.conflictCalendarIds)];
      if (wanted.length > 50) throw new AppError("invalid_input", "Choose at most 50 calendars.");
      if (wanted.some((x) => !ids.has(x))) throw new AppError("invalid_input", "One of those calendars isn't in this account any more. Refresh the page.");
      conflictIds = wanted;
    }
    if (checkConflicts && !conflictIds.length) throw new AppError("invalid_input", "Choose at least one calendar to check for conflicts, or turn conflict checking off.");
    let writeEvents = input.writeEvents ?? c.write_events;
    let writeCalendar = input.writeCalendarId !== undefined ? input.writeCalendarId : c.external_calendar_id;
    if (writeEvents) {
      if (c.provider === "ics") throw new AppError("invalid_input", "An ICS feed is read-only, so appointments can't be added to it.");
      if (!canWriteEvents(c.provider, c.scopes ?? [])) throw new AppError("invalid_input", "This connection wasn't given permission to add events. Reconnect it and allow calendar access.");
      writeCalendar ??= calendars.find((x) => x.primary && x.canWrite)?.id ?? null;
      if (!writeCalendar || !calendars.some((x) => x.id === writeCalendar && x.canWrite)) throw new AppError("invalid_input", "Choose a calendar you can add events to.");
    } else if (writeCalendar && !calendars.some((x) => x.id === writeCalendar)) writeCalendar = null;
    if (c.provider === "ics") {
      writeEvents = false;
      writeCalendar = null;
    }
    const conflictsChanged = checkConflicts !== c.check_conflicts || conflictIds.join("\n") !== (c.conflict_calendar_ids ?? []).join("\n");
    await db.query(
      `update crm_calendar_connections set check_conflicts = $2, conflict_calendar_ids = $3::text[], write_events = $4, external_calendar_id = $5,
         next_sync_at = case when $6 then now() else next_sync_at end where id = $1`,
      [id, checkConflicts, conflictIds, writeEvents, writeCalendar, conflictsChanged],
    );
    // Busy times that no longer count aren't kept.
    if (!checkConflicts) await db.query("delete from crm_external_busy where connection_id = $1", [id]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.calendar_options_updated", targetType: "crm_calendar_connection", targetId: id, result: "success", metadata: { checkConflicts, conflictCalendars: conflictIds.length, writeEvents } }, db);
    const after = await db.query<ConnectionRow>(`select ${VIEW_COLUMNS} from crm_calendar_connections c where c.id = $1`, [id]);
    return toView(after.rows[0]);
  });
}

/**
 * Disconnects a calendar: its credentials are deleted (and, for Google, the grant revoked), its busy times stop counting and are deleted,
 * and nothing more is written to it. Events already added to the calendar stay there, and the record of them is kept. The owner can do
 * this, and so can a workspace manager (who can't reconnect it for them).
 */
export async function disconnectCalendar(actor: CrmActor, id: string): Promise<{ revoked: boolean }> {
  const captured = await crmWrite(actor, async (db) => {
    const { rows } = await db.query<{ user_id: string; provider: CalendarProvider; account_label: string; status: ConnectionStatus; credentials: string | null }>(
      "select user_id, provider, account_label, status, credentials from crm_calendar_connections where id = $1 and org_id = $2 for update",
      [id, actor.orgId],
    );
    const c = rows[0];
    if (!c || c.status === "disconnected") throw new AppError("not_found", "That calendar connection no longer exists.");
    const own = actor.kind === "member" && actor.userId === c.user_id;
    if (!own) assertCan(actor, "calendars.manage", "Only the person whose calendar it is, or a workspace manager, can disconnect it.");
    await db.query(
      `update crm_calendar_connections set status = 'disconnected', credentials = null, token_expires_at = null, write_events = false, next_sync_at = null,
         disconnected_at = now(), sync_cursors = '{}'::jsonb, last_error = null, consecutive_failures = 0 where id = $1`,
      [id],
    );
    const busy = await db.query("delete from crm_external_busy where connection_id = $1", [id]);
    await db.query("insert into crm_calendar_sync_runs (org_id, connection_id, kind, status, finished_at, counts) values ($1, $2, 'disconnect', 'ok', now(), $3::jsonb)", [actor.orgId, id, JSON.stringify({ busyRemoved: busy.rowCount ?? 0, byOwner: own })]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.calendar_disconnected", targetType: "crm_calendar_connection", targetId: id, result: "success", metadata: { provider: c.provider, byOwner: own } }, db);
    if (!own) {
      await notifyUser(db, c.user_id, actor.orgId, {
        kind: "crm_calendar_sync", severity: "info", title: `Your ${PROVIDER_LABELS[c.provider]} was disconnected`,
        body: `${actor.label} disconnected ${c.account_label} from this workspace. Connect it again from Calendar connections if you still want it checked.`,
        link: "/crm/calendar-connections", dedupeKey: `crm-cal-disconnected:${id}:${Date.now()}`,
      });
    }
    return { provider: c.provider, creds: unseal(c.credentials) };
  });
  // Revoking talks to the provider, so it happens after the commit; the connection is already gone either way.
  let revoked = false;
  if (captured.creds?.kind === "oauth" && captured.provider === "google") revoked = await revokeToken("google", captured.creds.refreshToken ?? captured.creds.accessToken).catch(() => false);
  return { revoked };
}

/** Checks that a connection is the acting person's own (for "Sync now"): nobody runs another person's calendar sync. */
export async function assertConnectionOwner(actor: CrmActor, id: string): Promise<{ userId: string; provider: CalendarProvider }> {
  const userId = assertConnector(actor);
  const { rows } = await withSystem((db) => db.query<{ user_id: string; provider: CalendarProvider; status: ConnectionStatus }>("select user_id, provider, status from crm_calendar_connections where id = $1 and org_id = $2", [id, actor.orgId]));
  const c = rows[0];
  if (!c || c.status === "disconnected") throw new AppError("not_found", "That calendar connection no longer exists.");
  if (c.user_id !== userId) throw new AppError("forbidden", "Only the person whose calendar it is can do that.");
  return { userId: c.user_id, provider: c.provider };
}
