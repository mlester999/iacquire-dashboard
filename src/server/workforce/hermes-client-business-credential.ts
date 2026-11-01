import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { AGENT_BY_KEY, AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { recordAudit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/service";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { notifyAgency } from "@/server/notifications";
import { sha256 } from "@/server/security/crypto";
import { queueSyncJob } from "@/server/workforce/service";

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
/** The variable the restricted worker writes the credential into in the profile's own .env, and the route the profile's MCP entry points at. The entry names the variable, never a value. */
export const CLIENT_BUSINESS_MCP_TOKEN_ENV_VAR = "IACQUIRE_BUSINESS_MCP_TOKEN";
export const CLIENT_BUSINESS_MCP_PATH = "/api/internal/hermes-business/client/mcp";
/** The warning windows for a credential that is about to lapse, in days before it does: a first notice, then a closer one. */
export const CLIENT_CREDENTIAL_WARNING_DAYS = [30, 7] as const;

export const CLIENT_CREDENTIAL_AUDIT = {
  issued: "hermes.client_business_mcp.credential_issued",
  rotated: "hermes.client_business_mcp.credential_rotated",
  revoked: "hermes.client_business_mcp.credential_revoked",
  expired: "hermes.client_business_mcp.credential_expired",
} as const;

/** What an operator did to a client's business tool access, as opposed to what happened to one credential (CLIENT_CREDENTIAL_AUDIT). */
export const CLIENT_ACCESS_AUDIT = {
  rotationRequested: "hermes.client_business_mcp.rotation_requested",
  accessRevoked: "hermes.client_business_mcp.access_revoked",
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
  enabled: boolean;
  active_config_version_id: string | null;
  is_demo: boolean;
  org_status: string;
}

/** Locks the employee's row (so two rotations of one employee never interleave) and returns it, only if it belongs to this client workspace. */
async function lockClientEmployee(db: Queryable, orgId: string, agentId: string): Promise<EmployeeRow> {
  if (!UUID_ONLY.test(orgId) || !UUID_ONLY.test(agentId)) throw new AppError("invalid_input", "The workspace and the employee must be ids.");
  const { rows } = await db.query<EmployeeRow>(
    `select a.hermes_profile, a.enabled, a.active_config_version_id, o.is_demo, o.status as org_status
       from agent_instances a join organizations o on o.id = a.org_id
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
    orgId, actorUserId: actorUserId ?? null, actorKind: actorUserId ? "agency" : "system", agentInstanceId: agentId, action,
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
export async function revokeClientBusinessCredential(db: Queryable, orgId: string, credentialId: string, reason: string, now: Date = new Date(), actorUserId?: string | null): Promise<boolean> {
  if (!UUID_ONLY.test(orgId) || !UUID_ONLY.test(credentialId)) return false;
  return (await endLive(db, "org_id = $1 and id = $2", [orgId, credentialId], reason, now, actorUserId)).length > 0;
}

/** Ends every credential of one employee (a role removed from the plan, a re-mapped profile, a rotation gone wrong). Returns the ids ended. */
export async function revokeClientBusinessCredentialsForAgent(db: Queryable, orgId: string, agentId: string, reason: string, now: Date = new Date(), actorUserId?: string | null): Promise<string[]> {
  if (!UUID_ONLY.test(orgId) || !UUID_ONLY.test(agentId)) return [];
  return endLive(db, "org_id = $1 and agent_instance_id = $2", [orgId, agentId], reason, now, actorUserId);
}

/** Ends every credential of a workspace (suspension, archival, offboarding). Returns the ids ended. */
export async function revokeClientBusinessCredentialsForOrg(db: Queryable, orgId: string, reason: string, now: Date = new Date(), actorUserId?: string | null): Promise<string[]> {
  if (!UUID_ONLY.test(orgId)) return [];
  return endLive(db, "org_id = $1", [orgId], reason, now, actorUserId);
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

/**
 * Asks for a profile to be re-keyed: allocates the id the next credential will carry (a `pending` row that cannot authenticate yet) and opens one synchronization job for the employee's
 * applied configuration (or finds the one already open), which is how the restricted worker is told. The employee keeps working on its current credential until the worker reports the new secret's hash
 * (completeClientRotation); that credential then stays valid for at most 48 hours more. Asking again while the id waits returns the same id and finds the open job, so a double press makes one.
 * Only an enabled employee of an active, real client workspace whose profile the restricted worker made, and only one that has a live credential to replace. One transaction: pass the caller's.
 */
export async function rotateClientBusinessCredential(
  db: Queryable,
  input: { orgId: string; agentId: string; requestedBy: string | null; now?: Date },
): Promise<{ credentialId: string; syncJobId: string }> {
  const now = input.now ?? new Date();
  const employee = await lockClientEmployee(db, input.orgId, input.agentId);
  if (employee.is_demo || employee.org_status !== "active") throw new AppError("conflict", "Only an active, real client workspace can have a credential rotated.");
  if (!employee.enabled) throw new AppError("conflict", "This employee is not part of the plan, so it has no credential to rotate.");
  if (!employee.hermes_profile?.startsWith("c-")) throw new AppError("conflict", "The employee has no client Hermes profile made by the restricted worker.");
  const live = await db.query("select 1 from agent_business_credentials where org_id = $1 and agent_instance_id = $2 and status = 'active'", [input.orgId, input.agentId]);
  if (!live.rows.length) throw new AppError("conflict", "The employee has no live business tool credential to replace.");
  if (!employee.active_config_version_id) throw new AppError("conflict", "The employee has no applied configuration to synchronize.");

  const credentialId = await allocateClientCredentialId(db, { orgId: input.orgId, agentId: input.agentId, now });
  let syncJobId = await queueSyncJob(db, input.orgId, input.agentId, employee.active_config_version_id, input.requestedBy);
  if (!syncJobId) {
    // A request that is already open will carry the new id, so asking twice finds the same job. Nothing queued and nothing open means the worker cannot be told: refused, and the
    // allocated id is not kept (the caller's transaction ends).
    const open = await db.query<{ id: string }>(
      "select id from agent_provisioning_jobs where org_id = $1 and agent_instance_id = $2 and status in ('requested', 'in_progress', 'awaiting_health_check') order by created_at desc limit 1",
      [input.orgId, input.agentId],
    );
    if (!open.rows[0]) throw new AppError("conflict", "A synchronization cannot be queued for this employee: its profile was not made by the restricted worker, or its gateway is not verified.");
    syncJobId = open.rows[0].id;
  }
  await audit(db, CLIENT_ACCESS_AUDIT.rotationRequested, input.orgId, input.agentId, credentialId, { syncJobId }, input.requestedBy);
  return { credentialId, syncJobId };
}

/**
 * The worker's report that it wrote the new credential: it gives the id it was handed and the hash of the secret it made. The pending row becomes the active credential and the previous
 * one moves to `rotating_out` for at most 48 hours, ending at once on the first honoured use of the new one. The same report again (a retried completion) changes nothing and says so;
 * a different hash for an id already completed is refused.
 */
export async function completeClientRotation(db: Queryable, ledgerId: string, secretSha256: string, now: Date = new Date()): Promise<{ id: string; duplicate: boolean }> {
  if (!UUID_ONLY.test(ledgerId)) throw new AppError("invalid_input", "A credential id is a lowercase uuid.");
  if (!SHA256_HEX.test(secretSha256)) throw new AppError("invalid_input", "The credential's secret hash must be 64 lowercase hexadecimal characters.");
  const { rows } = await db.query<{ org_id: string; agent_instance_id: string; profile: string; status: string; secret_sha256: string | null }>(
    "select org_id, agent_instance_id, profile, status, secret_sha256 from agent_business_credentials where id = $1 for update",
    [ledgerId],
  );
  const row = rows[0];
  if (!row) throw new AppError("not_found", "No waiting credential with that id.");
  if (row.status === "pending") {
    const done = await registerClientBusinessCredential(db, { orgId: row.org_id, agentId: row.agent_instance_id, profile: row.profile, secretSha256, credentialId: ledgerId, now });
    return { id: done.id, duplicate: false };
  }
  if ((row.status === "active" || row.status === "rotating_out") && row.secret_sha256 && equalHashes(row.secret_sha256, secretSha256)) return { id: ledgerId, duplicate: true };
  throw new AppError("conflict", "That credential was already completed or ended.");
}

export interface ExpiringClientCredential {
  id: string;
  orgId: string;
  orgName: string;
  agentId: string;
  role: AgentRoleKey;
  expiresAt: Date;
  /** Whole days left, rounded up: a credential with an hour left has one day. */
  daysLeft: number;
}

/**
 * The live credentials that lapse within `withinDays`, soonest first, for employees that are still enabled in active, real client workspaces. A credential in its rotation overlap is not
 * listed: it ends within 48 hours by design, and its replacement is the one that matters.
 */
export async function expiringClientCredentials(db: Queryable, withinDays: number, now: Date = new Date()): Promise<ExpiringClientCredential[]> {
  if (!Number.isInteger(withinDays) || withinDays < 1 || withinDays > MAX_CLIENT_CREDENTIAL_DAYS) throw new AppError("invalid_input", `Look ahead between 1 and ${MAX_CLIENT_CREDENTIAL_DAYS} days.`);
  const { rows } = await db.query<{ id: string; org_id: string; org_name: string; agent_instance_id: string; role_key: string; expires_at: Date | string }>(
    `select c.id, c.org_id, o.name as org_name, c.agent_instance_id, a.role_key, c.expires_at
       from agent_business_credentials c
       join agent_instances a on a.id = c.agent_instance_id and a.org_id = c.org_id
       join organizations o on o.id = c.org_id
      where c.status = 'active' and c.expires_at > $1::timestamptz and c.expires_at <= $2::timestamptz
        and o.kind = 'client' and not o.is_demo and o.status = 'active' and a.enabled
      order by c.expires_at, c.id`,
    [iso(now), iso(new Date(now.getTime() + withinDays * DAY))],
  );
  return rows.filter((row) => isRole(row.role_key)).map((row) => {
    const expiresAt = new Date(row.expires_at);
    return {
      id: row.id, orgId: row.org_id, orgName: row.org_name, agentId: row.agent_instance_id, role: row.role_key as AgentRoleKey, expiresAt,
      daysLeft: Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY)),
    };
  });
}

/**
 * The scheduled job `clientBusinessCredentialExpiry`: closes the credentials whose time has run out (so the ledger says so), and tells the agency, once per credential and warning window
 * (CLIENT_CREDENTIAL_WARNING_DAYS), that a credential is about to lapse. A credential first seen inside the closer window gets only that notice. In-app notices only: it contacts no
 * customer, rotates nothing and changes no employee. Safe to run on any schedule and to repeat. Returns what it closed and what it announced.
 */
export async function runClientBusinessCredentialExpiry(now: Date = new Date()): Promise<{ closed: number; announced: number }> {
  return withSystem(async (db) => {
    const closed = await expireClientBusinessCredentials(db, now);
    const [wide, near] = CLIENT_CREDENTIAL_WARNING_DAYS;
    let announced = 0;
    for (const credential of await expiringClientCredentials(db, wide, now)) {
      const windowDays = credential.daysLeft <= near ? near : wide;
      const dedupeKey = `client-credential-expiry:${credential.id}:${windowDays}`;
      if ((await db.query("select 1 from notifications where dedupe_key = $1 limit 1", [dedupeKey])).rows.length) continue;
      const who = AGENT_BY_KEY[credential.role].shortName;
      await notifyAgency(db, credential.orgId, {
        kind: "agent_status",
        severity: windowDays === near ? "warning" : "info",
        title: `${who}'s business tool access for ${credential.orgName} ends in ${credential.daysLeft} day${credential.daysLeft === 1 ? "" : "s"}`,
        body: "Rotate it before then. When it lapses this AI employee can no longer read the client's business information. Nothing has changed yet.",
        link: `/admin/clients/${credential.orgId}`,
        dedupeKey,
      });
      // The notice goes to the agency people who can see this client; none may exist, and then nothing was announced.
      if ((await db.query("select 1 from notifications where dedupe_key = $1 limit 1", [dedupeKey])).rows.length) announced += 1;
    }
    return { closed, announced };
  });
}

/**
 * The Super Admin's emergency lever: ends one credential, one employee's credentials, or all of a workspace's, at once and with a reason a person wrote (5 to 500 characters, kept in the
 * audit trail only). Never for an agency or a demo workspace, and then nothing is written. An id from another workspace is simply not found. Returns how many credentials it ended.
 */
export async function revokeClientBusinessAccessAsAdmin(
  user: Pick<SessionUser, "id" | "platformRole">,
  input: { orgId: string; agentId?: string; credentialId?: string; reason: string },
): Promise<{ revoked: number }> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can end a client's business tool access.");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 5) throw new AppError("invalid_input", "Say why this access is being ended (at least 5 characters).");
  if (reason.length > 500) throw new AppError("invalid_input", "Keep the reason under 500 characters.");
  if (!UUID_ONLY.test(input.orgId) || (input.agentId !== undefined && !UUID_ONLY.test(input.agentId)) || (input.credentialId !== undefined && !UUID_ONLY.test(input.credentialId))) {
    throw new AppError("invalid_input", "The workspace, the employee and the credential must be ids.");
  }
  if (input.agentId !== undefined && input.credentialId !== undefined) throw new AppError("invalid_input", "End one credential or one employee's credentials, not both.");
  return withSystem(async (db) => {
    const { rows } = await db.query<{ kind: string; is_demo: boolean }>("select kind, is_demo from organizations where id = $1", [input.orgId]);
    if (!rows[0]) throw new AppError("not_found", "Workspace not found.");
    if (rows[0].kind !== "client" || rows[0].is_demo) throw new AppError("conflict", "Business tool access exists only for a real client workspace, never an agency's or a demo.");
    const now = new Date();
    let ended: string[];
    let scope: "credential" | "employee" | "workspace";
    if (input.credentialId !== undefined) {
      scope = "credential";
      ended = (await revokeClientBusinessCredential(db, input.orgId, input.credentialId, "operator_request", now, user.id)) ? [input.credentialId] : [];
      if (!ended.length) throw new AppError("not_found", "No live credential with that id in this workspace.");
    } else if (input.agentId !== undefined) {
      scope = "employee";
      ended = await revokeClientBusinessCredentialsForAgent(db, input.orgId, input.agentId, "operator_request", now, user.id);
    } else {
      scope = "workspace";
      ended = await revokeClientBusinessCredentialsForOrg(db, input.orgId, "operator_request", now, user.id);
    }
    await recordAudit({
      orgId: input.orgId, actorUserId: user.id, actorKind: "agency", agentInstanceId: input.agentId ?? null, action: CLIENT_ACCESS_AUDIT.accessRevoked,
      targetType: "workspace", targetId: input.orgId, result: "success", metadata: { scope, count: ended.length, reason },
    }, db);
    return { revoked: ended.length };
  });
}
