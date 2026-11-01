import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { recordAudit } from "@/server/audit";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { sha256 } from "@/server/security/crypto";

/**
 * The credential a CLIENT's Hermes profile presents to the client tier of the business tools. Nothing here is wired to a route.
 *
 *   iamcpc1.<ledger row id: a lowercase uuid>.<secret: 43 base64url characters, 32 random bytes>
 *
 * It carries no claims. The row id finds one row of agent_business_credentials; the workspace, the employee, its role and its Hermes profile are read from the application's own
 * records on every request, never from the credential. Only the sha256 of the secret is stored, so reading the database does not give a credential, and the application itself
 * never holds the secret: the worker that writes it into the profile reports the hash (registerClientBusinessCredential). Unlike the internal tier's signed credential this one is
 * stored, so it can be ended at once, for one credential, one employee or a whole workspace, without a deployment.
 *
 *  - An unknown id, a wrong secret, a malformed value and a row that is not live yet (pending: its hash is not known) all take the same work and answer the same refusal, so the
 *    answer reveals nothing about which ids exist. Only a value whose secret matched is told why it was refused (expired, revoked, re-mapped).
 *  - A rotation keeps the previous credential for at most 48 hours (`rotating_out`) and ends it on the first successful use of the new one, so a profile can be re-keyed without a gap.
 *  - Audit rows carry the credential's id (as `jti`, like the internal tier) and a short reason code. Never the secret, the hash, or free text.
 */

export const CLIENT_CREDENTIAL_PREFIX = "iamcpc1";
export const DEFAULT_CLIENT_CREDENTIAL_DAYS = 180;
export const MAX_CLIENT_CREDENTIAL_DAYS = 400;
export const CLIENT_CREDENTIAL_ROTATION_OVERLAP_HOURS = 48;
/** How long an allocated id waits for the worker to report its hash before it must be allocated again. */
export const CLIENT_CREDENTIAL_PENDING_HOURS = 72;
export const MAX_CLIENT_CREDENTIAL_LENGTH = 100;

export const CLIENT_CREDENTIAL_AUDIT = {
  issued: "hermes.client_business_mcp.credential_issued",
  rotated: "hermes.client_business_mcp.credential_rotated",
  revoked: "hermes.client_business_mcp.credential_revoked",
  expired: "hermes.client_business_mcp.credential_expired",
} as const;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CREDENTIAL = new RegExp(`^${CLIENT_CREDENTIAL_PREFIX}\\.(${UUID})\\.([A-Za-z0-9_-]{43})$`);
const UUID_ONLY = new RegExp(`^${UUID}$`);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{1,59}$/;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type ClientCredentialFailure = "malformed" | "invalid" | "revoked" | "expired" | "profile_changed";

export interface ClientCredentialClaims {
  credentialId: string;
  orgId: string;
  agentId: string;
  role: AgentRoleKey;
  profile: string;
  orgSlug: string;
  displayName: string;
  /** `rotating_out` means a newer credential exists and this one is in its overlap window. */
  status: "active" | "rotating_out";
}

export type ClientCredentialVerification =
  | { ok: true; claims: ClientCredentialClaims }
  // `claims` is present only when the secret matched (the credential is ours but cannot be honoured), so the fields can be trusted for an audit entry.
  | { ok: false; reason: ClientCredentialFailure; claims?: Omit<ClientCredentialClaims, "status"> };

/** Splits and shapes a presented value without trusting any part of it. Null for anything that is not exactly the format above. */
export function parseClientCredential(presented: string | null | undefined): { id: string; secret: string } | null {
  if (typeof presented !== "string" || presented.length > MAX_CLIENT_CREDENTIAL_LENGTH) return null;
  const match = CREDENTIAL.exec(presented);
  return match ? { id: match[1], secret: match[2] } : null;
}

export const hashClientSecret = (secret: string): string => sha256(secret);

export const formatClientCredential = (id: string, secret: string): string => `${CLIENT_CREDENTIAL_PREFIX}.${id}.${secret}`;

/** 32 random bytes as 43 base64url characters. The application never calls this: the worker makes the real one. It is here so tests and operator tooling make the same shape. */
export const generateClientCredentialSecret = (): string => randomBytes(32).toString("base64url");

function equalHashes(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(presented, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// A well-formed id and secret that no real row has, used when the presented value is malformed so that every refusal costs the same lookup and the same comparison.
const DECOY_ID = "00000000-0000-4000-8000-000000000000";
const DECOY_SECRET = "A".repeat(43);
const DECOY_HASH = sha256("client-business-credential-decoy");

const isRole = (value: string): value is AgentRoleKey => (AGENT_ROLE_KEYS as readonly string[]).includes(value);
const iso = (at: Date) => at.toISOString();

interface CredentialRow {
  id: string;
  org_id: string;
  agent_instance_id: string;
  profile: string;
  secret_sha256: string | null;
  status: string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  role_key: string;
  display_name: string;
  hermes_profile: string | null;
  org_slug: string;
}

/**
 * Checks a presented credential against the ledger. Reads only (use `recordClientCredentialUse` after a call is honoured). This answers whether the credential is genuine and live and
 * which employee it was issued to; whether that employee, its workspace and the rest may be served is the caller's check, made against the application's records every time.
 */
export async function verifyClientCredential(db: Queryable, presented: string | null | undefined, now: Date = new Date()): Promise<ClientCredentialVerification> {
  const parsed = parseClientCredential(presented);
  const { rows } = await db.query<CredentialRow>(
    `select c.id, c.org_id, c.agent_instance_id, c.profile, c.secret_sha256, c.status, c.expires_at, c.revoked_at,
            a.role_key, a.display_name, a.hermes_profile, o.slug as org_slug
     from agent_business_credentials c
     join agent_instances a on a.id = c.agent_instance_id and a.org_id = c.org_id
     join organizations o on o.id = c.org_id
     where c.id = $1`,
    [parsed?.id ?? DECOY_ID],
  );
  const row = rows[0];
  const same = equalHashes(row?.secret_sha256 ?? DECOY_HASH, hashClientSecret(parsed?.secret ?? DECOY_SECRET));
  if (!parsed) return { ok: false, reason: "malformed" };
  if (!row || !row.secret_sha256 || !same || !isRole(row.role_key)) return { ok: false, reason: "invalid" };

  const claims = { credentialId: row.id, orgId: row.org_id, agentId: row.agent_instance_id, role: row.role_key, profile: row.profile, orgSlug: row.org_slug, displayName: row.display_name };
  if (row.status === "revoked" || row.revoked_at) return { ok: false, reason: "revoked", claims };
  if (new Date(row.expires_at).getTime() <= now.getTime()) return { ok: false, reason: "expired", claims };
  const status = row.status === "active" || row.status === "rotating_out" ? row.status : null;
  if (!status) return { ok: false, reason: "invalid" };
  // The profile the credential was issued for must still be the employee's own: a re-mapped employee ends its credentials at once.
  if (row.hermes_profile !== row.profile) return { ok: false, reason: "profile_changed", claims };
  return { ok: true, claims: { ...claims, status } };
}

function assertReason(reason: string): void {
  if (!REASON_CODE.test(reason)) throw new AppError("invalid_input", "A revocation reason is a short code such as org_suspended.");
}

interface EmployeeRow {
  hermes_profile: string | null;
}

/** Locks the employee's row (so two rotations of one employee never interleave) and returns it, only if it belongs to this client workspace. */
async function lockClientEmployee(db: Queryable, orgId: string, agentId: string): Promise<EmployeeRow> {
  if (!UUID_ONLY.test(orgId) || !UUID_ONLY.test(agentId)) throw new AppError("invalid_input", "The workspace and the employee must be ids.");
  const { rows } = await db.query<EmployeeRow>(
    `select a.hermes_profile from agent_instances a join organizations o on o.id = a.org_id
     where a.id = $1 and a.org_id = $2 and o.kind = 'client' for update of a`,
    [agentId, orgId],
  );
  if (!rows[0]) throw new AppError("not_found", "Employee not found.");
  return rows[0];
}

/**
 * Hands out the id a worker embeds in the credential it writes into a client employee's profile, before the secret exists. The row is `pending` and cannot authenticate (it has no hash)
 * until registerClientBusinessCredential completes it. Asking again while an unexpired id is waiting returns the same id, so a retried job never leaves two behind.
 */
export async function allocateClientCredentialId(db: Queryable, input: { orgId: string; agentId: string; now?: Date }): Promise<string> {
  const now = input.now ?? new Date();
  const employee = await lockClientEmployee(db, input.orgId, input.agentId);
  if (!employee.hermes_profile) throw new AppError("conflict", "The employee has no Hermes profile yet.");
  // An id issued for a profile the employee no longer has can never be completed (registration requires the employee's current profile), so it is ended now instead of being handed out
  // again until it lapses.
  await endLive(db, "org_id = $1 and agent_instance_id = $2 and status = 'pending' and profile <> $3", [input.orgId, input.agentId, employee.hermes_profile], "profile_changed", now);
  const waiting = await db.query<{ id: string }>(
    `select id from agent_business_credentials where org_id = $1 and agent_instance_id = $2 and profile = $4 and status = 'pending' and expires_at > $3::timestamptz order by issued_at desc limit 1`,
    [input.orgId, input.agentId, iso(now), employee.hermes_profile],
  );
  if (waiting.rows[0]) return waiting.rows[0].id;
  const created = await db.query<{ id: string }>(
    `insert into agent_business_credentials (org_id, agent_instance_id, profile, status, issued_at, expires_at)
     values ($1, $2, $3, 'pending', $4::timestamptz, $5::timestamptz) returning id`,
    [input.orgId, input.agentId, employee.hermes_profile, iso(now), iso(new Date(now.getTime() + CLIENT_CREDENTIAL_PENDING_HOURS * HOUR))],
  );
  return created.rows[0].id;
}

/**
 * Makes a credential live from the sha256 of its secret, which is all the application ever learns. With `credentialId` it completes the id handed out by allocateClientCredentialId;
 * without it a new row is created. The employee's previous credential moves to `rotating_out` for at most 48 hours (an even older one still in that state is ended), so the profile
 * can be re-keyed without a gap. One transaction: pass the caller's.
 */
export async function registerClientBusinessCredential(
  db: Queryable,
  input: { orgId: string; agentId: string; profile: string; secretSha256: string; credentialId?: string; expiresInDays?: number; issuedBy?: string | null; now?: Date },
): Promise<{ id: string }> {
  const now = input.now ?? new Date();
  const days = input.expiresInDays ?? DEFAULT_CLIENT_CREDENTIAL_DAYS;
  if (!SHA256_HEX.test(input.secretSha256)) throw new AppError("invalid_input", "The credential's secret hash must be 64 lowercase hexadecimal characters.");
  if (!Number.isInteger(days) || days < 1 || days > MAX_CLIENT_CREDENTIAL_DAYS) throw new AppError("invalid_input", `A credential lasts between 1 and ${MAX_CLIENT_CREDENTIAL_DAYS} days.`);
  if (input.credentialId !== undefined && !UUID_ONLY.test(input.credentialId)) throw new AppError("invalid_input", "A credential id is a lowercase uuid.");

  const employee = await lockClientEmployee(db, input.orgId, input.agentId);
  if (!employee.hermes_profile || employee.hermes_profile !== input.profile) throw new AppError("conflict", "The profile is not the employee's own Hermes profile.");

  if (input.credentialId) {
    const pending = await db.query<{ id: string }>(
      `select id from agent_business_credentials
       where id = $1 and org_id = $2 and agent_instance_id = $3 and profile = $4 and status = 'pending' and expires_at > $5::timestamptz for update`,
      [input.credentialId, input.orgId, input.agentId, input.profile, iso(now)],
    );
    if (!pending.rows[0]) throw new AppError("not_found", "No waiting credential with that id for this employee.");
  }

  // Order matters: the unique indexes allow one active and one rotating_out row, so the old overlap row goes first, then the active one steps aside.
  await endLive(db, "org_id = $1 and agent_instance_id = $2 and status = 'rotating_out'", [input.orgId, input.agentId], "superseded", now, input.issuedBy);
  const overlapEnds = iso(new Date(now.getTime() + CLIENT_CREDENTIAL_ROTATION_OVERLAP_HOURS * HOUR));
  const stepped = await db.query<{ id: string }>(
    `update agent_business_credentials set status = 'rotating_out', expires_at = least(expires_at, $3::timestamptz)
     where org_id = $1 and agent_instance_id = $2 and status = 'active' returning id`,
    [input.orgId, input.agentId, overlapEnds],
  );
  for (const old of stepped.rows) {
    await audit(db, CLIENT_CREDENTIAL_AUDIT.rotated, input.orgId, input.agentId, old.id, {}, input.issuedBy);
  }

  const expiresAt = iso(new Date(now.getTime() + days * DAY));
  let id: string;
  if (input.credentialId) {
    // The lifetime counts from now, but never past 400 days after the id was allocated (the table's own limit).
    const done = await db.query<{ id: string }>(
      `update agent_business_credentials set secret_sha256 = $2, status = 'active', expires_at = least($3::timestamptz, issued_at + interval '400 days')
       where id = $1 returning id`,
      [input.credentialId, input.secretSha256, expiresAt],
    );
    id = done.rows[0].id;
  } else {
    const created = await db.query<{ id: string }>(
      `insert into agent_business_credentials (org_id, agent_instance_id, profile, secret_sha256, status, issued_at, expires_at, created_by)
       values ($1, $2, $3, $4, 'active', $5::timestamptz, $6::timestamptz, $7) returning id`,
      [input.orgId, input.agentId, input.profile, input.secretSha256, iso(now), expiresAt, input.issuedBy ?? null],
    );
    id = created.rows[0].id;
  }
  await audit(db, CLIENT_CREDENTIAL_AUDIT.issued, input.orgId, input.agentId, id, {}, input.issuedBy);
  return { id };
}

async function audit(db: Queryable, action: string, orgId: string, agentId: string, credentialId: string, metadata: Record<string, unknown>, actorUserId?: string | null) {
  await recordAudit({
    orgId, actorUserId: actorUserId ?? null, actorKind: "system", agentInstanceId: agentId, action,
    targetType: "client_business_credential", targetId: credentialId, result: "success", metadata: { jti: credentialId, ...metadata },
  }, db);
}

/** Ends every not-yet-revoked row matching `where` (parameters from $1; the time is added as the next one) and audits each by id and reason code. Returns the ids ended. */
async function endLive(db: Queryable, where: string, params: unknown[], reason: string, now: Date, actorUserId?: string | null): Promise<string[]> {
  assertReason(reason);
  const at = params.length + 1;
  const { rows } = await db.query<{ id: string; org_id: string; agent_instance_id: string }>(
    `update agent_business_credentials set status = 'revoked', revoked_at = $${at}::timestamptz, revoked_reason = $${at + 1}
     where ${where} and status <> 'revoked' returning id, org_id, agent_instance_id`,
    [...params, iso(now), reason],
  );
  for (const row of rows) {
    await audit(db, reason === "expired" ? CLIENT_CREDENTIAL_AUDIT.expired : CLIENT_CREDENTIAL_AUDIT.revoked, row.org_id, row.agent_instance_id, row.id, { reason }, actorUserId);
  }
  return rows.map((row) => row.id);
}

/** Ends one credential. The workspace is named too, so an id from another workspace is simply not found. Returns whether a live credential was ended. */
export async function revokeClientBusinessCredential(db: Queryable, orgId: string, credentialId: string, reason: string, now: Date = new Date()): Promise<boolean> {
  if (!UUID_ONLY.test(orgId) || !UUID_ONLY.test(credentialId)) return false;
  return (await endLive(db, "org_id = $1 and id = $2", [orgId, credentialId], reason, now)).length > 0;
}

/** Ends every credential of one employee (a role removed from the plan, a re-mapped profile, a rotation gone wrong). Returns the ids ended. */
export async function revokeClientBusinessCredentialsForAgent(db: Queryable, orgId: string, agentId: string, reason: string, now: Date = new Date()): Promise<string[]> {
  if (!UUID_ONLY.test(orgId) || !UUID_ONLY.test(agentId)) return [];
  return endLive(db, "org_id = $1 and agent_instance_id = $2", [orgId, agentId], reason, now);
}

/** Ends every credential of a workspace (suspension, archival, offboarding). Returns the ids ended. */
export async function revokeClientBusinessCredentialsForOrg(db: Queryable, orgId: string, reason: string, now: Date = new Date()): Promise<string[]> {
  if (!UUID_ONLY.test(orgId)) return [];
  return endLive(db, "org_id = $1", [orgId], reason, now);
}

/** Closes rows whose time has run out, so the ledger says `revoked` (reason `expired`) rather than leaving them live. Safe to run on any schedule. Returns how many were closed. */
export async function expireClientBusinessCredentials(db: Queryable, now: Date = new Date()): Promise<number> {
  return (await endLive(db, "expires_at <= $1::timestamptz", [iso(now)], "expired", now)).length;
}

/**
 * Records that a credential was honoured: when it was last used and how often. The first honoured use of an employee's active credential also ends the previous one still in its
 * overlap window (`rotation_complete`): the profile has the new credential, so the old one has done its job. Returns the ids of the credentials that ended that way.
 */
export async function recordClientCredentialUse(db: Queryable, orgId: string, credentialId: string, now: Date = new Date()): Promise<string[]> {
  if (!UUID_ONLY.test(orgId) || !UUID_ONLY.test(credentialId)) return [];
  const { rows } = await db.query<{ agent_instance_id: string; status: string }>(
    `update agent_business_credentials set last_used_at = $3::timestamptz, use_count = use_count + 1
     where id = $1 and org_id = $2 and status in ('active', 'rotating_out') returning agent_instance_id, status`,
    [credentialId, orgId, iso(now)],
  );
  const used = rows[0];
  if (!used || used.status !== "active") return [];
  return endLive(db, "org_id = $1 and agent_instance_id = $2 and status = 'rotating_out'", [orgId, used.agent_instance_id], "rotation_complete", now);
}
