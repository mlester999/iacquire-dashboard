import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "@/server/security/crypto";
import { assertCan, auditActor, crmRead, type CrmActor } from "@/server/crm/actor";
import { openCredentials as openSocialCredentials } from "@/server/social/credentials";
import { REVIEWS_CLIENT_ONLY_MESSAGE, REVIEWS_NOT_ENABLED_MESSAGE, assertExternalReviewsEnabled, externalReviewsEnabledIn } from "@/server/reputation/entitlement";
import { reviewProviderFor, simulatedAllowed, siteEnvironment } from "@/server/reputation/providers";
import { createGoogleProvider, googleReviewProvider } from "@/server/reputation/providers/google";
import { META_READ_SCOPE } from "@/server/reputation/providers/meta-reviews";
import { ProviderError, type LocationRef, type ReviewAdapter, type ReviewCredentials, type ReviewProvider } from "@/server/reputation/providers/types";
import { PROVIDER_LABELS, providerState, type ConnectionStatus, type ProviderStateView, type ReviewProvider as Site } from "@/lib/reputation/external";

// Connecting a review site to a workspace, checking it, and disconnecting it. A connection belongs to the CLIENT: only its owner and managers connect or disconnect it, and
// iAcquire support can look but not change it. A Google refresh token is stored sealed and never returned to a browser; a Facebook connection reads through the Page the
// workspace already connected for Social media and keeps no token of its own. The status is a fact read from the site or a decision a person made, never a guess.

export interface ConnectionView {
  id: string;
  provider: Site;
  adapter: ReviewAdapter;
  simulated: boolean;
  name: string;
  externalAccountId: string | null;
  externalLocationId: string;
  socialAccountId: string | null;
  status: ConnectionStatus;
  statusDetail: string | null;
  canReply: boolean;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastCompleteAt: string | null;
  reportedRating: number | null;
  reportedReviewCount: number | null;
  reportedAt: string | null;
  connectedAt: string;
  disconnectedAt: string | null;
  /** Reviews stored that the site still returns, and reviews stored that it no longer returns. */
  syncedCount: number;
  removedCount: number;
}

export interface PageOption {
  /** The Social media account (the Page) this would read through. */
  socialAccountId: string;
  name: string;
  /** The Page was given permission to read recommendations (always true for the simulated stand-in). */
  hasPermission: boolean;
  connected: boolean;
}

export interface SiteView {
  provider: Site;
  label: string;
  state: ProviderStateView;
  connection: ConnectionView | null;
  /** Connected before and since disconnected, newest first (their reviews stay visible until the retention period ends). */
  past: ConnectionView[];
  /** Reading this site is set up in this environment, and replies can be posted there. */
  environment: { ready: boolean; repliesReady: boolean };
  /** Facebook only: the Pages connected for Social media that a connection could read through. */
  pages: PageOption[];
  /** A made-up test connection may be offered (never in production). */
  simulatedAllowed: boolean;
}

interface Row {
  id: string; provider: Site; adapter: ReviewAdapter; external_account_id: string | null; external_location_id: string; name: string; social_account_id: string | null;
  status: ConnectionStatus; status_detail: string | null; can_reply: boolean; last_sync_at: Date | null; last_success_at: Date | null; last_complete_at: Date | null;
  reported_rating: string | null; reported_review_count: number | null; reported_at: Date | null; connected_at: Date; disconnected_at: Date | null; synced: string; removed: string;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const VIEW_SELECT = `c.id, c.provider, c.adapter, c.external_account_id, c.external_location_id, c.name, c.social_account_id, c.status, c.status_detail, c.can_reply, c.last_sync_at, c.last_success_at,
  c.last_complete_at, c.reported_rating::text as reported_rating, c.reported_review_count, c.reported_at, c.connected_at, c.disconnected_at,
  (select count(*) from external_reviews r where r.connection_id = c.id and r.org_id = c.org_id and r.removed_at is null)::text as synced,
  (select count(*) from external_reviews r where r.connection_id = c.id and r.org_id = c.org_id and r.removed_at is not null)::text as removed`;

const toView = (r: Row): ConnectionView => ({
  id: r.id, provider: r.provider, adapter: r.adapter, simulated: r.adapter === "simulated", name: r.name, externalAccountId: r.external_account_id, externalLocationId: r.external_location_id,
  socialAccountId: r.social_account_id, status: r.status, statusDetail: r.status_detail, canReply: r.can_reply, lastSyncAt: iso(r.last_sync_at), lastSuccessAt: iso(r.last_success_at),
  lastCompleteAt: iso(r.last_complete_at), reportedRating: r.reported_rating === null ? null : Number(r.reported_rating), reportedReviewCount: r.reported_review_count, reportedAt: iso(r.reported_at),
  connectedAt: new Date(r.connected_at).toISOString(), disconnectedAt: iso(r.disconnected_at), syncedCount: Number(r.synced), removedCount: Number(r.removed),
});

/** Who may look: anyone who can see private feedback, and an iAcquire support session. */
export function assertViewReviews(actor: CrmActor) {
  if (!actor.can("reviews.view") && !actor.can("contacts.view")) assertCan(actor, "contacts.view");
}

/** Who may connect, check and disconnect a site: the client's own owners and managers. */
export function assertManageSites(actor: CrmActor): string {
  assertCan(actor, "reviews.manage", "Only owners and managers can connect review sites.");
  if (actor.kind !== "member" || !actor.userId) throw new AppError("forbidden", "Review sites belong to the client's own workspace. iAcquire support can look but not connect, check or disconnect them.");
  return actor.userId;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The Pages connected for Social media in this workspace, with whether each could be read for recommendations. */
async function pageOptions(db: Queryable, orgId: string): Promise<PageOption[]> {
  const { rows } = await db.query<{ id: string; name: string; adapter: string; scopes: string[]; connected: boolean }>(
    `select a.id, a.name, a.adapter, a.scopes,
            exists (select 1 from review_connections c where c.org_id = a.org_id and c.social_account_id = a.id and c.status <> 'disconnected') as connected
     from social_accounts a where a.org_id = $1 and a.platform = 'facebook' and a.status = 'connected' order by a.connected_at desc`,
    [orgId],
  );
  return rows.map((a) => ({ socialAccountId: a.id, name: a.name, hasPermission: a.adapter === "simulated" || (a.scopes ?? []).includes(META_READ_SCOPE), connected: a.connected }));
}

export async function listConnections(actor: CrmActor, opts: { includePast?: boolean } = {}): Promise<ConnectionView[]> {
  assertViewReviews(actor);
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<Row>(`select ${VIEW_SELECT} from review_connections c where c.org_id = $1 ${opts.includePast ? "" : "and c.status <> 'disconnected'"} order by c.connected_at desc`, [actor.orgId]);
    return rows.map(toView);
  });
}

/** Each review site's honest state for this workspace, with its live connection and what could be connected. */
export async function getSites(actor: CrmActor): Promise<SiteView[]> {
  assertViewReviews(actor);
  const { all, pages } = await crmRead(actor, async (db) => {
    const { rows } = await db.query<Row>(`select ${VIEW_SELECT} from review_connections c where c.org_id = $1 order by c.connected_at desc`, [actor.orgId]);
    // Social media accounts are readable by those who can see social media; for anyone else the list is simply empty.
    const p = await pageOptions(db, actor.orgId).catch(() => [] as PageOption[]);
    return { all: rows.map(toView), pages: p };
  });
  return (["google", "facebook"] as const).map((provider): SiteView => {
    const env = siteEnvironment(provider);
    const mine = all.filter((c) => c.provider === provider);
    const live = mine.find((c) => c.status !== "disconnected") ?? null;
    const sitePages = provider === "facebook" ? pages : [];
    const state = providerState({
      provider, environmentReady: env.ready || simulatedAllowed() && Boolean(live?.simulated), missing: env.missing, simulatedAllowed: simulatedAllowed(),
      pageConnected: provider === "facebook" ? sitePages.length > 0 : undefined,
      pageLacksPermission: provider === "facebook" ? sitePages.length > 0 && sitePages.every((x) => !x.hasPermission) : undefined,
      connection: live && live.status !== "disconnected" ? { status: live.status, statusDetail: live.statusDetail, name: live.name, simulated: live.simulated } : null,
    });
    return { provider, label: PROVIDER_LABELS[provider], state, connection: live, past: mine.filter((c) => c.status === "disconnected"), environment: { ready: env.ready, repliesReady: env.repliesReady }, pages: sitePages, simulatedAllowed: simulatedAllowed() };
  });
}

// ---------------------------------------------------------------------------
// What the server needs to talk to a site
// ---------------------------------------------------------------------------

export interface ConnectionRow {
  id: string;
  org_id: string;
  provider: Site;
  adapter: ReviewAdapter;
  external_account_id: string | null;
  external_location_id: string;
  name: string;
  social_account_id: string | null;
  credentials: string | null;
  status: ConnectionStatus;
  can_reply: boolean;
  sync_cursor: { pageToken?: string | null; passStartedAt?: string; pages?: number };
  last_complete_at: Date | null;
}

export const CONNECTION_COLUMNS = "id, org_id, provider, adapter, external_account_id, external_location_id, name, social_account_id, credentials, status, can_reply, sync_cursor, last_complete_at";

export async function loadConnection(db: Queryable, orgId: string, id: string, lock = false): Promise<ConnectionRow | null> {
  const { rows } = await db.query<ConnectionRow>(`select ${CONNECTION_COLUMNS} from review_connections where id = $1 and org_id = $2${lock ? " for update" : ""}`, [id, orgId]);
  return rows[0] ?? null;
}

export const locationOf = (c: Pick<ConnectionRow, "provider" | "external_account_id" | "external_location_id">): LocationRef => ({ provider: c.provider, accountId: c.external_account_id, locationId: c.external_location_id });

/**
 * Whether a reply can be posted from here through this connection right now, and if not, why in plain words. Three things must hold: the connection works, posting replies is
 * switched on for iAcquire (an environment switch, off by default) and the access that was granted lets it post. A reply that cannot be posted from here can still be written and
 * approved, and a person can then post it on the review site themselves and say so.
 */
export function replyPostable(c: Pick<ConnectionRow, "adapter" | "provider" | "status" | "can_reply">): { ok: true } | { ok: false; reason: string } {
  if (c.status !== "connected") return { ok: false, reason: "The connection to the review site needs attention. Reconnect it in Settings first." };
  let provider: ReviewProvider;
  try {
    provider = reviewProviderFor(c.adapter);
  } catch {
    return { ok: false, reason: "This kind of connection can't post replies here." };
  }
  const support = provider.replySupport();
  if (!support.ok) return support;
  if (!c.can_reply) return { ok: false, reason: `The access given to ${PROVIDER_LABELS[c.provider]} doesn't let iAcquire post replies. Reconnect it and allow replies, or post the reply there yourself.` };
  return { ok: true };
}

const sealReview = (c: ReviewCredentials): string => encryptSecret(JSON.stringify(c));
function openReview(sealed: string | null): ReviewCredentials | null {
  if (!sealed) return null;
  try {
    const j = JSON.parse(decryptSecret(sealed)) as ReviewCredentials;
    return typeof j.refreshToken === "string" && j.refreshToken ? { refreshToken: j.refreshToken } : null;
  } catch {
    return null;
  }
}

/**
 * The credentials to use for a connection, or a reason there are none. A Google connection holds its own sealed refresh token. A Facebook connection borrows the Page's
 * token from the Social media account it was made through, so disconnecting the Page there ends this connection's ability to read.
 */
export async function connectionCredentials(db: Queryable, c: ConnectionRow): Promise<{ ok: true; creds: ReviewCredentials } | { ok: false; reason: string }> {
  if (c.provider === "google") {
    const creds = openReview(c.credentials);
    return creds ? { ok: true, creds } : { ok: false, reason: "The saved Google sign-in can no longer be used. Reconnect your Google location." };
  }
  // A test connection made without a Social media Page has nothing to borrow; a real one always has a Page, and without it there is nothing to read with.
  if (!c.social_account_id) return c.adapter === "simulated" ? { ok: true, creds: { accessToken: "sim_valid" } } : { ok: false, reason: "The Facebook Page is no longer connected in Social media. Reconnect it there, then connect it here again." };
  const { rows } = await db.query<{ credentials: string | null; status: string }>("select credentials, status from social_accounts where id = $1 and org_id = $2", [c.social_account_id, c.org_id]);
  const social = rows[0];
  const token = social && social.status === "connected" ? openSocialCredentials(social.credentials)?.accessToken : null;
  return token ? { ok: true, creds: { accessToken: token } } : { ok: false, reason: "The Facebook Page is no longer connected in Social media. Reconnect it there, then connect it here again." };
}

/**
 * A site refused or could not answer. Only an answer changes what a connection is shown as: a sign-in the site rejects needs reconnecting (and the owner is told once a day),
 * a refusal it means is an error; silence, a limit or a server error leave the status as it was and say why the last read did not happen.
 */
export async function recordProviderFailure(db: Queryable, c: Pick<ConnectionRow, "id" | "org_id" | "name" | "status">, err: unknown, now: Date): Promise<void> {
  const e = err instanceof ProviderError ? err : new ProviderError("transient", "The review site could not be reached. It is tried again automatically.");
  const reauth = e.needsReauth || e.kind === "auth" || e.kind === "permission";
  const definite = e.kind === "invalid_content";
  const status: ConnectionStatus = reauth ? "needs_reauth" : definite ? "error" : c.status;
  await db.query(
    "update review_connections set status = $3, status_detail = $4, last_sync_at = $5, sync_lease_until = null, can_reply = case when $6 then false else can_reply end where id = $1 and org_id = $2 and status <> 'disconnected'",
    [c.id, c.org_id, status, e.message.slice(0, 400), now, reauth],
  );
  if (reauth && c.status !== "needs_reauth") {
    await notifyOrgRoles(db, c.org_id, ["owner", "admin"], {
      kind: "review_connection_attention", severity: "warning", title: `${c.name} needs to be reconnected`, body: `${e.message} Reviews are not being read until it is reconnected.`,
      link: "/crm/reviews?tab=settings", dedupeKey: `review-conn:${c.id}:${now.toISOString().slice(0, 10)}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

async function insertConnection(
  db: Queryable, actor: CrmActor, userId: string,
  input: { provider: Site; adapter: ReviewAdapter; accountId: string | null; locationId: string; name: string; socialAccountId?: string | null; sealed?: string | null; scopes?: string[]; canReply: boolean },
): Promise<string> {
  try {
    const { rows } = await db.query<{ id: string }>(
      `insert into review_connections (org_id, provider, adapter, external_account_id, external_location_id, name, social_account_id, credentials, scopes, status, can_reply, connected_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'connected', $10, $11) returning id`,
      [actor.orgId, input.provider, input.adapter, input.accountId, input.locationId, input.name.slice(0, 200), input.socialAccountId ?? null, input.sealed ?? null, input.scopes ?? [], input.canReply, userId],
    );
    return rows[0].id;
  } catch (e) {
    if (String((e as Error).message).match(/review_connections_(location|simulated)_idx|duplicate key/)) {
      throw new AppError("conflict", input.adapter === "simulated" ? "That test connection already exists." : `That ${PROVIDER_LABELS[input.provider]} location is already connected to a workspace in iAcquire, so it can't be connected again. Disconnect it there first.`);
    }
    throw e;
  }
}

const clientOnly = async (db: Queryable, orgId: string) => {
  const kind = (await db.query<{ kind: string }>("select kind from organizations where id = $1", [orgId])).rows[0]?.kind;
  if (kind !== "client") throw new AppError("forbidden", "Public reviews belong to a client's own workspace. They are not available in an agency workspace.");
};

/** A made-up connection for trying the screens in a test workspace. Reads sample reviews that carry a "Simulated" badge, reaches nothing, and is refused in production. */
export async function connectSimulatedSite(actor: CrmActor, input: { provider: Site; name?: string }): Promise<ConnectionView> {
  const userId = assertManageSites(actor);
  if (!simulatedAllowed()) throw new AppError("forbidden", "Test review sites are not available here.");
  const name = (input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || `${PROVIDER_LABELS[input.provider]} test location`;
  const id = await withSystem(async (db) => {
    await clientOnly(db, actor.orgId);
    await assertExternalReviewsEnabled(db, actor.orgId);
    const locationId = `sim-${randomToken(6)}`;
    const connectionId = await insertConnection(db, actor, userId, {
      provider: input.provider, adapter: "simulated", accountId: input.provider === "google" ? "accounts/sim" : null, locationId, name,
      sealed: input.provider === "google" ? sealReview({ refreshToken: "sim_valid" }) : null, scopes: ["simulated.reviews"], canReply: true,
    });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.connection_added", targetType: "review_connection", targetId: connectionId, result: "success", metadata: { provider: input.provider, adapter: "simulated" } }, db);
    return connectionId;
  });
  return (await listConnections(actor)).find((c) => c.id === id) as ConnectionView;
}

/** Reads a connected Facebook Page's recommendations too: the connection reuses the Page the workspace connected for Social media, with no second sign-in. */
export async function connectFacebookPage(actor: CrmActor, socialAccountId: string, deps: { provider?: ReviewProvider } = {}): Promise<ConnectionView> {
  const userId = assertManageSites(actor);
  const id = await withSystem(async (db) => {
    await clientOnly(db, actor.orgId);
    await assertExternalReviewsEnabled(db, actor.orgId);
    const social = (await db.query<{ id: string; name: string; external_id: string; adapter: string; scopes: string[]; credentials: string | null; status: string }>(
      "select id, name, external_id, adapter, scopes, credentials, status from social_accounts where id = $1 and org_id = $2 and platform = 'facebook'", [socialAccountId, actor.orgId],
    )).rows[0];
    if (!social || social.status !== "connected") throw new AppError("not_found", "That Facebook Page isn't connected in Social media. Connect it there first.");
    const simulated = social.adapter === "simulated";
    if (simulated && !simulatedAllowed()) throw new AppError("forbidden", "Test review sites are not available here.");
    if (!simulated) {
      const env = siteEnvironment("facebook");
      if (!env.ready) throw new AppError("unavailable", env.missing ?? "Reading Facebook recommendations isn't set up yet.");
      if (!(social.scopes ?? []).includes(META_READ_SCOPE)) throw new AppError("forbidden", "Your Facebook Page hasn't been given permission to read recommendations. Reconnect the Page in Social media and allow the extra access.");
      // The Page is asked once, with its own token, whether recommendations can be read at all, before anything is saved as connected.
      const token = openSocialCredentials(social.credentials)?.accessToken;
      if (!token) throw new AppError("forbidden", "The Facebook Page's sign-in can't be used. Reconnect the Page in Social media.");
      const health = await (deps.provider ?? reviewProviderFor("meta")).health({ accessToken: token }, { provider: "facebook", accountId: null, locationId: social.external_id });
      if (health.status !== "connected") throw new AppError("forbidden", health.detail);
    }
    const connectionId = await insertConnection(db, actor, userId, {
      provider: "facebook", adapter: simulated ? "simulated" : "meta", accountId: null, locationId: social.external_id, name: social.name, socialAccountId: social.id, scopes: social.scopes ?? [], canReply: false,
    });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.connection_added", targetType: "review_connection", targetId: connectionId, result: "success", metadata: { provider: "facebook", adapter: simulated ? "simulated" : "meta" } }, db);
    return connectionId;
  });
  return (await listConnections(actor)).find((c) => c.id === id) as ConnectionView;
}

// --- Google sign-in ---------------------------------------------------------

export const STATE_MINUTES = 10;
export const DEFAULT_RETURN = "/crm/reviews?tab=settings";
export const safeReturn = (raw: string | null | undefined) => (raw && /^\/crm\/reviews(\?tab=[a-z]{3,20})?$/.test(raw) ? raw : DEFAULT_RETURN);

type GoogleProvider = ReturnType<typeof createGoogleProvider>;

/** Records a single-use sign-in state for this person and returns the address to send the browser to. */
export async function startGoogleConnect(actor: CrmActor, returnPath?: string | null, deps: { google?: GoogleProvider } = {}): Promise<{ url: string }> {
  const userId = assertManageSites(actor);
  const env = siteEnvironment("google");
  if (!env.ready) throw new AppError("unavailable", env.missing ?? "Connecting Google isn't set up yet.");
  await withSystem(async (db) => {
    await clientOnly(db, actor.orgId);
    await assertExternalReviewsEnabled(db, actor.orgId);
  });
  const state = randomToken(32);
  const verifier = randomToken(48);
  const challenge = (await import("node:crypto")).createHash("sha256").update(verifier).digest("base64url");
  await withSystem(async (db) => {
    await db.query("delete from review_oauth_states where user_id = $1 and (used_at is not null or expires_at < now())", [userId]);
    await db.query(
      "insert into review_oauth_states (org_id, user_id, provider, state_hash, code_verifier, return_path, expires_at) values ($1, $2, 'google', $3, $4, $5, now() + make_interval(mins => $6))",
      [actor.orgId, userId, sha256(state), encryptSecret(verifier), safeReturn(returnPath), STATE_MINUTES],
    );
  });
  return { url: (deps.google ?? googleReviewProvider).authorizeUrl(state, challenge) };
}

export interface LocationChoice {
  accountId: string;
  locationId: string;
  title: string;
  alreadyConnected: boolean;
}

/**
 * Google sent the person back with a code. Valid only for the person who started it, within ten minutes, once. The code is exchanged, the locations the person manages are
 * read, and they are stored SEALED (with the refresh token) for the choice screen: nothing is connected until the person picks. Returns where to go next.
 */
export async function completeGoogleConnect(
  user: { id: string },
  input: { state?: string | null; code?: string | null; error?: string | null },
  deps: { google?: GoogleProvider } = {},
): Promise<{ outcome: "choose" | "denied"; stateId: string | null; returnPath: string }> {
  if (!input.state) throw new AppError("invalid_input", "That sign-in did not start from iAcquire, so it was ignored.");
  const row = await withSystem(async (db) => (await db.query<{ id: string; org_id: string; user_id: string; return_path: string; expires_at: Date; used_at: Date | null; code_verifier: string | null; exchanged: boolean }>(
    "select id, org_id, user_id, return_path, expires_at, used_at, code_verifier, (pending is not null) as exchanged from review_oauth_states where state_hash = $1", [sha256(input.state as string)],
  )).rows[0] ?? null);
  // A sign-in comes back once: after its code was exchanged (its choices are waiting) the same address does nothing more.
  if (!row || row.user_id !== user.id || row.used_at || row.exchanged || new Date(row.expires_at).getTime() < Date.now()) throw new AppError("invalid_input", "That sign-in expired or was not started by you. Start the connection again.");
  const used = () => withSystem((db) => db.query("update review_oauth_states set used_at = now(), pending = null where id = $1", [row.id]));
  const workspace = await withSystem(async (db) => {
    const kind = (await db.query<{ kind: string }>("select kind from organizations where id = $1", [row.org_id])).rows[0]?.kind;
    return { client: kind === "client", on: await externalReviewsEnabledIn(db, row.org_id) };
  });
  // The person's own permission, asked under their own session (row-level security), as the social sign-in does.
  const may = await withUser(user.id, async (db) => (await db.query<{ ok: boolean }>("select app.has_permission($1, 'reviews.manage') as ok", [row.org_id])).rows[0]?.ok === true);
  if (!workspace.client || !workspace.on || !may) {
    await used();
    throw new AppError("forbidden", !workspace.client ? REVIEWS_CLIENT_ONLY_MESSAGE : !workspace.on ? REVIEWS_NOT_ENABLED_MESSAGE : "Only the business owner or a manager can connect review sites.");
  }
  if (input.error || !input.code) {
    await used();
    return { outcome: "denied", stateId: null, returnPath: row.return_path };
  }
  const google = deps.google ?? googleReviewProvider;
  try {
    const verifier = row.code_verifier ? decryptSecret(row.code_verifier) : "";
    const tokens = await google.exchangeCode(input.code, verifier);
    const locations = await google.listLocations(tokens.refreshToken);
    const sealed = encryptSecret(JSON.stringify({ refreshToken: tokens.refreshToken, locations }));
    await withSystem((db) => db.query("update review_oauth_states set pending = $2 where id = $1 and used_at is null", [row.id, sealed]));
  } catch (e) {
    await used();
    throw new AppError("upstream_error", e instanceof ProviderError ? e.message : "Google could not complete the sign-in. Start again.");
  }
  return { outcome: "choose", stateId: row.id, returnPath: row.return_path };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function openPending(db: Queryable, actor: CrmActor, userId: string, stateId: string): Promise<{ refreshToken: string; locations: Array<{ accountId: string; locationId: string; title: string }> }> {
  if (!UUID.test(stateId)) throw new AppError("not_found", "That connection expired. Start it again.");
  const r = (await db.query<{ org_id: string; user_id: string; pending: string | null; expires_at: Date; used_at: Date | null }>("select org_id, user_id, pending, expires_at, used_at from review_oauth_states where id = $1", [stateId])).rows[0];
  if (!r || r.org_id !== actor.orgId || r.user_id !== userId || r.used_at || !r.pending || new Date(r.expires_at).getTime() < Date.now()) throw new AppError("not_found", "That connection expired. Start it again.");
  try {
    return JSON.parse(decryptSecret(r.pending));
  } catch {
    throw new AppError("not_found", "That connection expired. Start it again.");
  }
}

/** The locations the person may choose from, without the token. */
export async function pendingLocations(actor: CrmActor, stateId: string): Promise<LocationChoice[]> {
  const userId = assertManageSites(actor);
  return withSystem(async (db) => {
    const p = await openPending(db, actor, userId, stateId);
    const live = new Set((await db.query<{ id: string }>("select external_location_id as id from review_connections where provider = 'google' and adapter = 'google' and status <> 'disconnected'")).rows.map((r) => r.id));
    return p.locations.map((l) => ({ ...l, alreadyConnected: live.has(l.locationId) }));
  });
}

/** Connects the location the person chose. It is tested with Google first and saved only if it can be read. */
export async function connectChosenLocation(actor: CrmActor, stateId: string, pick: { accountId: string; locationId: string }, deps: { google?: GoogleProvider } = {}): Promise<ConnectionView> {
  const userId = assertManageSites(actor);
  const google = deps.google ?? googleReviewProvider;
  const pending = await withSystem((db) => openPending(db, actor, userId, stateId));
  const loc = pending.locations.find((l) => l.accountId === pick.accountId && l.locationId === pick.locationId);
  if (!loc) throw new AppError("invalid_input", "That location was not in your list.");
  try {
    await withSystem((db) => assertExternalReviewsEnabled(db, actor.orgId));
    const health = await google.health({ refreshToken: pending.refreshToken }, { provider: "google", accountId: loc.accountId, locationId: loc.locationId });
    if (health.status !== "connected") throw new AppError("forbidden", health.detail);
    const id = await withSystem(async (db) => {
      const connectionId = await insertConnection(db, actor, userId, {
        provider: "google", adapter: "google", accountId: loc.accountId, locationId: loc.locationId, name: loc.title, sealed: sealReview({ refreshToken: pending.refreshToken }), scopes: health.scopes, canReply: health.canReply,
      });
      await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.connection_added", targetType: "review_connection", targetId: connectionId, result: "success", metadata: { provider: "google", adapter: "google" } }, db);
      return connectionId;
    });
    return (await listConnections(actor)).find((c) => c.id === id) as ConnectionView;
  } catch (e) {
    if (e instanceof ProviderError) throw new AppError("upstream_error", e.message);
    throw e;
  } finally {
    // The sealed token has done its job, or the attempt failed: either way it is not kept. (The expiry sweep clears it within minutes of the ten the sign-in lasts if this fails.)
    await withSystem((db) => db.query("update review_oauth_states set used_at = coalesce(used_at, now()), pending = null where id = $1", [stateId])).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Checking and disconnecting
// ---------------------------------------------------------------------------

/** Asks the site now whether the connection works, for the person looking at it. Only the answer changes the status; a site that cannot be reached leaves it as it was. */
export async function checkConnection(actor: CrmActor, id: string, deps: { provider?: ReviewProvider; now?: Date } = {}): Promise<ConnectionStatus> {
  assertManageSites(actor);
  const now = deps.now ?? new Date();
  const c = await withSystem(async (db) => {
    const row = await loadConnection(db, actor.orgId, id);
    if (!row || row.status === "disconnected") throw new AppError("not_found", "That connection was not found.");
    return row;
  });
  const got = await withSystem((db) => connectionCredentials(db, c));
  if (!got.ok) {
    await withSystem((db) => recordProviderFailure(db, c, new ProviderError("auth", got.reason, { needsReauth: true }), now));
    return "needs_reauth";
  }
  const provider = deps.provider ?? reviewProviderFor(c.adapter);
  try {
    const h = await provider.health(got.creds, locationOf(c));
    await withSystem(async (db) => {
      const connected = h.status === "connected";
      await db.query(
        `update review_connections set status = $3, status_detail = $4, can_reply = $5, scopes = case when cardinality($6::text[]) > 0 then $6::text[] else scopes end, last_sync_at = coalesce(last_sync_at, $7)
         where id = $1 and org_id = $2 and status <> 'disconnected'`,
        [c.id, c.org_id, connected ? "connected" : "needs_reauth", connected ? null : h.detail.slice(0, 400), connected && h.canReply, h.scopes, now],
      );
    });
    return h.status === "connected" ? "connected" : "needs_reauth";
  } catch (e) {
    if (e instanceof ProviderError && e.kind === "blocked") throw new AppError("unavailable", e.message);
    await withSystem((db) => recordProviderFailure(db, c, e, now));
    if (e instanceof ProviderError && (e.needsReauth || e.kind === "auth" || e.kind === "permission")) return "needs_reauth";
    throw new AppError("upstream_error", "The review site could not be reached just now, so the connection could not be checked. Nothing about it has changed. Try again in a few minutes.");
  }
}

/** What disconnecting does to a connection, whoever asks: the saved sign-in is deleted and nothing more is read. The reviews already read stay until the retention period ends. */
async function disconnectRow(db: Queryable, orgId: string, id: string, detail: string): Promise<void> {
  await db.query(
    "update review_connections set status = 'disconnected', credentials = null, can_reply = false, sync_cursor = '{}'::jsonb, sync_lease_until = null, status_detail = $3, disconnected_at = now() where id = $1 and org_id = $2",
    [id, orgId, detail],
  );
}

export async function disconnectConnection(actor: CrmActor, id: string): Promise<void> {
  assertManageSites(actor);
  await withSystem(async (db) => {
    const c = await loadConnection(db, actor.orgId, id, true);
    if (!c || c.status === "disconnected") throw new AppError("not_found", "That connection was not found.");
    await disconnectRow(db, actor.orgId, id, "Disconnected by a person.");
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.connection_removed", targetType: "review_connection", targetId: id, result: "success", metadata: { provider: c.provider, adapter: c.adapter } }, db);
  });
}

/** Disconnects every connection of a workspace that is being closed (offboarding): no signed-in member is involved. One failing does not stop the others. */
export async function disconnectWorkspaceReviewConnections(orgId: string, actorUserId: string): Promise<{ disconnected: number; failed: string[] }> {
  const live = (await withSystem((db) => db.query<{ id: string; name: string; provider: Site }>("select id, name, provider from review_connections where org_id = $1 and status <> 'disconnected' order by connected_at", [orgId]))).rows;
  let disconnected = 0;
  const failed: string[] = [];
  for (const c of live) {
    try {
      await withSystem(async (db) => {
        await disconnectRow(db, orgId, c.id, "The workspace was closed.");
        await recordAudit({ orgId, actorUserId, actorKind: "agency", action: "reputation.connection_removed", targetType: "review_connection", targetId: c.id, result: "success", metadata: { provider: c.provider, why: "workspace_closed" } }, db);
      });
      disconnected += 1;
    } catch {
      failed.push(c.name);
    }
  }
  return { disconnected, failed };
}
