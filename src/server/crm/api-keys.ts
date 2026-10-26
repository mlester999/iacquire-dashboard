import "server-only";
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { randomToken, sha256 } from "@/server/security/crypto";
import { memberAccessColumns, permissionCheckFrom, type PermissionCheck } from "@/server/crm/member-access";
import type { Permission } from "@/lib/permissions";

// Scoped API keys for a client's own integrations (the public CRM API under /api/v1/crm, docs/crm-api.md).
//
//  * A key is shown once when it is created. Only its sha256 is stored, with a short public prefix (iaq_xxxxxx) so people can tell keys
//    apart. The application role can read the prefix, scopes and dates, never the hash.
//  * The organization comes from the key row, never from the request. The request acts as an "api" CRM actor whose permissions are
//    exactly the key's scopes, so every CRM service check (assertCan) applies to it like to a person.
//  * A key never does more than the person who created it may: creating it needs every permission its scopes carry, and on each request
//    a scope the creator no longer holds (a withdrawn permission, or they left the workspace) is suspended until they hold it again.
//  * Each key has its own rate limit; failed authentication is limited per (hashed) client address.

export const API_SCOPES = [
  { scope: "contacts.read", label: "Read contacts", description: "List and look up contacts." },
  { scope: "contacts.write", label: "Create and update contacts", description: "Create contacts and change their details. Includes reading contacts." },
  { scope: "opportunities.read", label: "Read deals", description: "List deals and read pipelines and their stages." },
  { scope: "opportunities.write", label: "Create and move deals", description: "Create deals and move them between stages. Includes reading deals." },
  { scope: "appointments.read", label: "Read appointments", description: "List appointments booked in iAcquire calendars." },
  { scope: "tags.read", label: "Read tags", description: "List the workspace's tags." },
  { scope: "tags.write", label: "Tag contacts", description: "Add tags to and remove tags from contacts. Tags that don't exist yet are created." },
] as const;

export type ApiScope = (typeof API_SCOPES)[number]["scope"];
export const API_SCOPE_IDS = API_SCOPES.map((s) => s.scope) as readonly ApiScope[];
export const isApiScope = (v: unknown): v is ApiScope => typeof v === "string" && (API_SCOPE_IDS as readonly string[]).includes(v);

/** What each scope lets the API actor do, expressed in the CRM's own permissions so the services' checks stay the single source of truth. */
const SCOPE_PERMISSIONS: Record<ApiScope, Permission[]> = {
  "contacts.read": ["crm.view", "contacts.view"],
  "contacts.write": ["crm.view", "contacts.view", "contacts.edit"],
  "opportunities.read": ["crm.view", "sales.view"],
  "opportunities.write": ["crm.view", "sales.view", "opportunities.edit"],
  "appointments.read": ["crm.view", "appointments.view"],
  "tags.read": ["crm.view"],
  "tags.write": ["crm.view"],
};

/** What a person needs to give a key a scope (and keep it working): every permission it carries, and for tag changes, editing contacts. */
const SCOPE_REQUIRES: Record<ApiScope, Permission[]> = { ...SCOPE_PERMISSIONS, "tags.write": ["crm.view", "contacts.edit"] };

/** Whether someone with these permissions may hold this scope on a key. */
export const scopeAllowed = (scope: ApiScope, can: PermissionCheck) => SCOPE_REQUIRES[scope].every((p) => can(p));

export function permissionsForScopes(scopes: readonly string[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const s of scopes) if (isApiScope(s)) for (const p of SCOPE_PERMISSIONS[s]) out.add(p);
  return out;
}

export interface ApiKeyIdentity {
  id: string;
  orgId: string;
  orgName: string;
  timezone: string;
  name: string;
  prefix: string;
  /** The scopes in effect for this request. */
  scopes: ApiScope[];
  /** Scopes the key has but that are suspended because its creator no longer holds what they need. */
  suspendedScopes: ApiScope[];
}

/** The CRM actor for a request authenticated with an API key. Its permissions are exactly the key's scopes. */
export function apiActor(key: ApiKeyIdentity): CrmActor {
  const allowed = permissionsForScopes(key.scopes);
  return {
    kind: "api",
    orgId: key.orgId,
    orgName: key.orgName,
    timezone: key.timezone,
    userId: null,
    agentId: null,
    apiKeyId: key.id,
    supportSessionId: null,
    supportMode: null,
    label: `API key “${key.name}” (${key.prefix})`,
    can: (p) => allowed.has(p),
  };
}

// ---------------------------------------------------------------------------
// Key format
// ---------------------------------------------------------------------------

/** iaq_ + six lower-case letters or digits (the public prefix) + _ + 43 characters of base64url (256 random bits). */
export const API_KEY_PATTERN = /^iaq_[a-z0-9]{6}_[A-Za-z0-9_-]{43}$/;
const PREFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const bytes = crypto.randomBytes(6);
  let prefix = "iaq_";
  for (const b of bytes) prefix += PREFIX_ALPHABET[b % PREFIX_ALPHABET.length];
  const key = `${prefix}_${randomToken(32)}`;
  return { key, prefix, hash: sha256(key) };
}

export const MAX_ACTIVE_KEYS = 25;
export const KEY_EXPIRY_CHOICES = [30, 90, 365] as const;

// ---------------------------------------------------------------------------
// Management (Settings → API & Webhooks)
// ---------------------------------------------------------------------------

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  state: "active" | "expired" | "revoked";
}

type KeyRow = { id: string; name: string; key_prefix: string; scopes: string[]; created_at: Date; expires_at: Date | null; revoked_at: Date | null; last_used_at: Date | null };
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

function toView(r: KeyRow, now = Date.now()): ApiKeyView {
  const state = r.revoked_at ? "revoked" : r.expires_at && new Date(r.expires_at).getTime() <= now ? "expired" : "active";
  return {
    id: r.id, name: r.name, prefix: r.key_prefix, scopes: r.scopes.filter(isApiScope), createdAt: new Date(r.created_at).toISOString(),
    expiresAt: iso(r.expires_at), revokedAt: iso(r.revoked_at), lastUsedAt: iso(r.last_used_at), state,
  };
}

/** Every key in the workspace, newest first. Members read under row-level security, which never exposes the key hash. */
export async function listApiKeys(actor: CrmActor): Promise<ApiKeyView[]> {
  assertCan(actor, "crm.api.manage");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<KeyRow>(
      "select id, name, key_prefix, scopes, created_at, expires_at, revoked_at, last_used_at from crm_api_keys where org_id = $1 order by revoked_at is not null, created_at desc limit 200",
      [actor.orgId],
    );
    return rows.map((r) => toView(r));
  });
}

export interface CreateApiKeyInput {
  name: string;
  scopes: string[];
  /** Days until the key stops working, or null for a key that lasts until revoked. */
  expiresInDays?: number | null;
}

/** Creates a key and returns it once. Only its hash is kept, so a lost key is revoked and replaced, never shown again. */
export async function createApiKey(actor: CrmActor, input: CreateApiKeyInput): Promise<{ key: ApiKeyView; secret: string }> {
  assertCan(actor, "crm.api.manage");
  if (actor.kind !== "member") throw new AppError("forbidden", "Only people in this workspace can create API keys.");
  const name = (input.name ?? "").replace(/\s+/g, " ").trim();
  if (!name || name.length > 80) throw new AppError("invalid_input", "Name the key (up to 80 characters), for example the app that will use it.");
  const scopes = [...new Set(input.scopes ?? [])];
  if (!scopes.length) throw new AppError("invalid_input", "Choose at least one permission for the key.");
  const unknown = scopes.find((s) => !isApiScope(s));
  if (unknown) throw new AppError("invalid_input", `"${String(unknown).slice(0, 40)}" isn't a permission an API key can have.`);
  // A key can't do more than the person creating it (the same rule as granting a permission to a teammate).
  const beyond = API_SCOPES.filter((s) => scopes.includes(s.scope) && !scopeAllowed(s.scope, (p) => actor.can(p)));
  if (beyond.length) {
    throw new AppError("forbidden", `A key can only have permissions you have yourself. You can't give it: ${beyond.map((s) => s.label.toLowerCase()).join(", ")}.`);
  }
  const days = input.expiresInDays ?? null;
  if (days !== null && !(KEY_EXPIRY_CHOICES as readonly number[]).includes(days)) throw new AppError("invalid_input", "Choose when the key expires.");
  const generated = generateApiKey();
  return crmWrite(actor, async (db) => {
    const active = await db.query<{ n: string }>("select count(*)::text as n from crm_api_keys where org_id = $1 and revoked_at is null and (expires_at is null or expires_at > now())", [actor.orgId]);
    if (Number(active.rows[0].n) >= MAX_ACTIVE_KEYS) throw new AppError("conflict", `A workspace can have up to ${MAX_ACTIVE_KEYS} active keys. Revoke one you no longer use first.`);
    const ordered = API_SCOPE_IDS.filter((s) => scopes.includes(s));
    const { rows } = await db.query<KeyRow>(
      `insert into crm_api_keys (org_id, name, key_hash, key_prefix, scopes, created_by, expires_at)
       values ($1, $2, $3, $4, $5, $6, case when $7::int is null then null else now() + make_interval(days => $7::int) end)
       returning id, name, key_prefix, scopes, created_at, expires_at, revoked_at, last_used_at`,
      [actor.orgId, name, generated.hash, generated.prefix, ordered, actor.userId, days],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.api_key_created", targetType: "crm_api_key", targetId: rows[0].id, result: "success", metadata: { prefix: generated.prefix, scopes: ordered, expiresInDays: days } }, db);
    return { key: toView(rows[0]), secret: generated.key };
  });
}

/** Revokes a key at once: the next request made with it is refused. Revoking twice changes nothing. */
export async function revokeApiKey(actor: CrmActor, id: string): Promise<void> {
  assertCan(actor, "crm.api.manage");
  await crmWrite(actor, async (db) => {
    const { rows } = await db.query<{ key_prefix: string; revoked_at: Date | null }>("select key_prefix, revoked_at from crm_api_keys where id = $1 and org_id = $2 for update", [id, actor.orgId]);
    if (!rows[0]) throw new AppError("not_found", "API key not found.");
    if (rows[0].revoked_at) return;
    await db.query("update crm_api_keys set revoked_at = now() where id = $1 and org_id = $2", [id, actor.orgId]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.api_key_revoked", targetType: "crm_api_key", targetId: id, result: "success", metadata: { prefix: rows[0].key_prefix } }, db);
  });
}

/** Revokes every live key of a workspace that is being closed (offboarding), so no request made with one is accepted again. No signed-in member is involved. */
export async function revokeWorkspaceApiKeys(orgId: string, actorUserId: string): Promise<{ revoked: number; failed: boolean }> {
  try {
    return await withSystem(async (db) => {
      const { rows } = await db.query<{ id: string; key_prefix: string }>("update crm_api_keys set revoked_at = now() where org_id = $1 and revoked_at is null returning id, key_prefix", [orgId]);
      for (const r of rows) {
        await recordAudit({ orgId, actorUserId, actorKind: "agency", action: "crm.api_key_revoked", targetType: "crm_api_key", targetId: r.id, result: "success", metadata: { prefix: r.key_prefix, why: "workspace_closed" } }, db);
      }
      return { revoked: rows.length, failed: false };
    });
  } catch {
    return { revoked: 0, failed: true };
  }
}

// ---------------------------------------------------------------------------
// Authentication (every /api/v1/crm request)
// ---------------------------------------------------------------------------

export type ApiAuthFailure = { ok: false; status: 401 | 403 | 429; code: "unauthorized" | "workspace_inactive" | "rate_limited"; message: string; retryAfterSeconds?: number };
export type ApiAuthSuccess = { ok: true; actor: CrmActor; key: ApiKeyIdentity; rateLimit: { limit: number; remaining: number; resetSeconds: number } };

const UNAUTHORIZED = "Send a valid API key as “Authorization: Bearer iaq_…”. Keys are created in CRM Settings → API & Webhooks.";

async function failed(ipHash: string | null, message: string): Promise<ApiAuthFailure> {
  // Bad keys are counted per client address, so guessing at keys is slowed down without letting one caller lock out another's key.
  const rl = await consumeRateLimit(RATE_LIMITS.crmApiAuthFailureByIp, ipHash ?? "unknown");
  if (!rl.allowed) return { ok: false, status: 429, code: "rate_limited", message: "Too many requests with invalid API keys. Wait and try again.", retryAfterSeconds: rl.retryAfterSeconds };
  return { ok: false, status: 401, code: "unauthorized", message };
}

/**
 * Authenticates an Authorization header. Only the key decides the organization. Revoked and expired keys, keys of inactive workspaces and
 * malformed headers are refused; a valid key is rate limited and its last use recorded (at most once a minute).
 */
export async function authenticateApiKey(authorization: string | null, opts: { ipHash?: string | null } = {}): Promise<ApiAuthSuccess | ApiAuthFailure> {
  const ipHash = opts.ipHash ?? null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  if (!match) return failed(ipHash, UNAUTHORIZED);
  const token = match[1];
  if (!API_KEY_PATTERN.test(token)) return failed(ipHash, "That API key isn't in the right format. Copy the whole key, starting with iaq_.");
  const hash = sha256(token);
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; org_id: string; name: string; key_prefix: string; scopes: string[]; expired: boolean; revoked: boolean; org_name: string; timezone: string; org_kind: string; org_status: string; member_role: string | null; member_overrides: Record<string, unknown> | null }>(
      `select k.id, k.org_id, k.name, k.key_prefix, k.scopes, (k.expires_at is not null and k.expires_at <= now()) as expired, k.revoked_at is not null as revoked,
              o.name as org_name, o.timezone, o.kind as org_kind, o.status as org_status, ${memberAccessColumns("k.org_id", "k.created_by")}
       from crm_api_keys k join organizations o on o.id = k.org_id where k.key_hash = $1`,
      [hash],
    ),
  );
  const k = rows[0];
  if (!k) return failed(ipHash, "This API key isn't recognised. It may have been deleted, or copied incompletely.");
  if (k.revoked) return failed(ipHash, "This API key was revoked. Create a new key in CRM Settings → API & Webhooks.");
  if (k.expired) return failed(ipHash, "This API key has expired. Create a new key in CRM Settings → API & Webhooks.");
  if (k.org_kind !== "client" || ["suspended", "archived"].includes(k.org_status)) return { ok: false, status: 403, code: "workspace_inactive", message: "This workspace isn't active, so its API is unavailable." };
  const rl = await consumeRateLimit(RATE_LIMITS.crmApiByKey, k.id);
  if (!rl.allowed) return { ok: false, status: 429, code: "rate_limited", message: `This key made more than ${RATE_LIMITS.crmApiByKey.limit} requests in a minute. Wait and try again.`, retryAfterSeconds: rl.retryAfterSeconds };
  await withSystem((db) => db.query("update crm_api_keys set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')", [k.id]));
  // What the creator may do now bounds what the key does: a withdrawn permission (or a creator who left) suspends the scopes that need it.
  const creator = permissionCheckFrom(k.member_role, k.member_overrides);
  const granted = k.scopes.filter(isApiScope);
  const scopes = granted.filter((s) => creator !== null && scopeAllowed(s, creator));
  const key: ApiKeyIdentity = {
    id: k.id, orgId: k.org_id, orgName: k.org_name, timezone: k.timezone || "UTC", name: k.name, prefix: k.key_prefix, scopes, suspendedScopes: granted.filter((s) => !scopes.includes(s)),
  };
  return { ok: true, actor: apiActor(key), key, rateLimit: { limit: RATE_LIMITS.crmApiByKey.limit, remaining: rl.remaining, resetSeconds: rl.retryAfterSeconds } };
}
