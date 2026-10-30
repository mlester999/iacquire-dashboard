import "server-only";
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { AGENCY_HERMES_PROFILE_IDS, AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { env } from "@/server/env";

/**
 * The credential a Hermes internal profile presents to the first-party business MCP endpoint (D3).
 *
 * It replaces the profile's own API key on that endpoint. The API key is also the credential for the Hermes gateway, so using it here meant one leaked string opened both. This
 * credential is minted from a separate server-only secret (HERMES_BUSINESS_MCP_SECRET), opens nothing but this endpoint, and is bound to one employee:
 *
 *   iamcp1.<role>.<agent id>.<organization id>.<issued at>.<expires at>.<credential id>.<signature>
 *
 *  - The signature is HMAC-SHA256 over every field and the profile id, under a key derived from the secret with HKDF (a fixed salt and a purpose label), so the secret is never used as
 *    a MAC key directly and a signature made for any other purpose cannot be replayed here. The profile id is derived from the role and signed too, so changing the role-to-profile
 *    table ends every credential instead of silently re-pointing it.
 *  - The fields are read only after the signature verifies, and every field is strictly shaped, so there is no parser to confuse and no field an attacker can add.
 *  - A signed credential only says who it was minted for. The endpoint still compares it with the application's records on every request (the employee, its organization, its profile and
 *    whether either is still active) and then requires that employee's own active Chat turn before anything is read. Holding one never selects a run, a person or a workspace.
 *  - It expires (90 days by default, 400 at most), a single credential can be ended by its id, and rotating the secret ends all of them. A previous secret stays verify-only while
 *    new credentials are installed.
 *  - Nothing here is stored in the application's database. The secret lives in the server environment; the credential lives in the Hermes profile's own environment file.
 */

export const BUSINESS_MCP_CREDENTIAL_VERSION = "iamcp1";
/** The variable name the Hermes profile's own .env uses for the credential. The portal never holds the value. */
export const BUSINESS_MCP_CREDENTIAL_ENV_VAR = "IACQUIRE_BUSINESS_MCP_TOKEN";
export const DEFAULT_CREDENTIAL_DAYS = 90;
export const MAX_CREDENTIAL_DAYS = 400;
const MIN_CREDENTIAL_SECONDS = 60;
/** How far into the future an issue time may be before the credential is refused (clock drift between the machine that minted it and this one). */
const CLOCK_SKEW_SECONDS = 300;
const MAX_CREDENTIAL_LENGTH = 400;

const SUBKEY_SALT = Buffer.from("iacquire-os/hermes-business-mcp", "utf8");
const SUBKEY_INFO = Buffer.from("credential-signing/v1", "utf8");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CREDENTIAL_ID = /^[0-9a-f]{16}$/;
const EPOCH_SECONDS = /^[1-9][0-9]{8,10}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

export interface BusinessMcpClaims {
  role: AgentRoleKey;
  /** Derived from the role (AGENCY_HERMES_PROFILE_IDS) and signed with the other fields. */
  profile: string;
  agentId: string;
  orgId: string;
  /** Seconds since the epoch. */
  issuedAt: number;
  expiresAt: number;
  /** 16 lowercase hex characters, random. Identifies one credential in audit entries and in HERMES_BUSINESS_MCP_REVOKED_TOKEN_IDS. */
  credentialId: string;
}

export type BusinessMcpCredentialFailure =
  | "not_configured"
  | "malformed"
  | "bad_signature"
  | "not_yet_valid"
  | "expired"
  | "invalid_lifetime"
  | "revoked";

export type BusinessMcpVerification =
  | { ok: true; claims: BusinessMcpClaims }
  // `claims` is present only when the signature verified (the credential is ours but cannot be honoured), so the fields can be trusted for an audit entry.
  | { ok: false; reason: BusinessMcpCredentialFailure; claims?: BusinessMcpClaims };

export interface IssuedBusinessMcpCredential {
  /** The bearer value. Shown once to the operator and never stored by the application. */
  token: string;
  claims: BusinessMcpClaims;
}

function signingKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), SUBKEY_SALT, SUBKEY_INFO, 32));
}

function canonicalMessage(claims: BusinessMcpClaims): string {
  return [BUSINESS_MCP_CREDENTIAL_VERSION, claims.profile, claims.role, claims.agentId, claims.orgId, String(claims.issuedAt), String(claims.expiresAt), claims.credentialId].join("\n");
}

function sign(secret: string, claims: BusinessMcpClaims): string {
  return createHmac("sha256", signingKey(secret)).update(canonicalMessage(claims), "utf8").digest("base64url");
}

function equalSignatures(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const isRole = (value: string): value is AgentRoleKey => (AGENT_ROLE_KEYS as readonly string[]).includes(value);

interface ParsedCredential {
  claims: BusinessMcpClaims;
  signature: string;
}

/** Splits and shapes a presented value without trusting any field. Returns null for anything that is not exactly the format above. */
function parse(presented: string | null | undefined): ParsedCredential | null {
  if (typeof presented !== "string" || presented.length > MAX_CREDENTIAL_LENGTH) return null;
  const parts = presented.split(".");
  if (parts.length !== 8) return null;
  const [version, role, agentId, orgId, issuedAt, expiresAt, credentialId, signature] = parts;
  if (version !== BUSINESS_MCP_CREDENTIAL_VERSION || !isRole(role) || !UUID.test(agentId) || !UUID.test(orgId)) return null;
  if (!EPOCH_SECONDS.test(issuedAt) || !EPOCH_SECONDS.test(expiresAt) || !CREDENTIAL_ID.test(credentialId) || !SIGNATURE.test(signature)) return null;
  return {
    claims: { role, profile: AGENCY_HERMES_PROFILE_IDS[role], agentId, orgId, issuedAt: Number(issuedAt), expiresAt: Number(expiresAt), credentialId },
    signature,
  };
}

// A fixed, well-formed shape that no real credential can match, signed when the presented value is malformed so that malformed and well-formed-but-wrong values take the same work.
const DECOY: BusinessMcpClaims = {
  role: "operations_manager", profile: AGENCY_HERMES_PROFILE_IDS.operations_manager, agentId: "00000000-0000-4000-8000-000000000000", orgId: "00000000-0000-4000-8000-000000000001",
  issuedAt: 1_700_000_000, expiresAt: 1_700_000_060, credentialId: "0000000000000000",
};

/**
 * Checks a presented credential against the given secrets (the current one, then the verify-only previous one) and the revoked ids. Pure: no clock but `now`, no database, no
 * environment. The signature is compared against every secret in constant time and the claims are returned only when it matched.
 */
export function verifyBusinessMcpCredential(
  presented: string | null | undefined,
  options: { secrets: readonly string[]; revokedIds?: ReadonlySet<string>; now?: Date },
): BusinessMcpVerification {
  if (!options.secrets.length) return { ok: false, reason: "not_configured" };
  const parsed = parse(presented);
  const subject = parsed?.claims ?? DECOY;
  let matched = false;
  for (const secret of options.secrets) {
    const equal = equalSignatures(sign(secret, subject), parsed?.signature ?? "A".repeat(43));
    matched = matched || equal;
  }
  if (!parsed) return { ok: false, reason: "malformed" };
  if (!matched) return { ok: false, reason: "bad_signature" };

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const { claims } = parsed;
  if (claims.expiresAt <= nowSeconds) return { ok: false, reason: "expired", claims };
  if (claims.issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) return { ok: false, reason: "not_yet_valid", claims };
  if (claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > MAX_CREDENTIAL_DAYS * 86_400) return { ok: false, reason: "invalid_lifetime", claims };
  if (options.revokedIds?.has(claims.credentialId)) return { ok: false, reason: "revoked", claims };
  return { ok: true, claims };
}

/** Mints a credential under `secret`. The caller (the operator script, or a test) decides where the value goes; this never stores or logs it. */
export function issueBusinessMcpCredentialWithSecret(
  secret: string,
  input: { role: AgentRoleKey; agentId: string; orgId: string; issuedAt?: Date; ttlSeconds?: number; credentialId?: string },
): IssuedBusinessMcpCredential {
  if (!/^\S{32,512}$/.test(secret)) throw new Error("The business MCP signing secret must be 32-512 characters without whitespace.");
  if (!isRole(input.role)) throw new Error("Unknown AI employee role.");
  if (!UUID.test(input.agentId) || !UUID.test(input.orgId)) throw new Error("The employee and organization ids must be lowercase UUIDs.");
  const ttl = input.ttlSeconds ?? DEFAULT_CREDENTIAL_DAYS * 86_400;
  if (!Number.isInteger(ttl) || ttl < MIN_CREDENTIAL_SECONDS || ttl > MAX_CREDENTIAL_DAYS * 86_400) {
    throw new Error(`A business MCP credential lasts between ${MIN_CREDENTIAL_SECONDS} seconds and ${MAX_CREDENTIAL_DAYS} days.`);
  }
  const credentialId = input.credentialId ?? randomBytes(8).toString("hex");
  if (!CREDENTIAL_ID.test(credentialId)) throw new Error("A credential id is 16 lowercase hexadecimal characters.");
  const issuedAt = Math.floor((input.issuedAt ?? new Date()).getTime() / 1000);
  const claims: BusinessMcpClaims = {
    role: input.role, profile: AGENCY_HERMES_PROFILE_IDS[input.role], agentId: input.agentId, orgId: input.orgId, issuedAt, expiresAt: issuedAt + ttl, credentialId,
  };
  const token = [BUSINESS_MCP_CREDENTIAL_VERSION, claims.role, claims.agentId, claims.orgId, claims.issuedAt, claims.expiresAt, claims.credentialId, sign(secret, claims)].join(".");
  return { token, claims };
}

/** The secrets the endpoint accepts, current first. Empty when none is configured (every credential is then refused). */
export function configuredBusinessMcpSecrets(): string[] {
  const e = env();
  return [e.HERMES_BUSINESS_MCP_SECRET, e.HERMES_BUSINESS_MCP_SECRET_PREVIOUS].filter((secret): secret is string => Boolean(secret));
}

export function configuredRevokedCredentialIds(): Set<string> {
  return new Set((env().HERMES_BUSINESS_MCP_REVOKED_TOKEN_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}

/** Verifies against the server's configuration. */
export function verifyConfiguredBusinessMcpCredential(presented: string | null | undefined, now?: Date): BusinessMcpVerification {
  return verifyBusinessMcpCredential(presented, { secrets: configuredBusinessMcpSecrets(), revokedIds: configuredRevokedCredentialIds(), now });
}

/** Mints under the current configured secret. Used by tests and by trusted server code that needs a credential for a synthetic profile; the application itself never calls it. */
export function issueConfiguredBusinessMcpCredential(input: Parameters<typeof issueBusinessMcpCredentialWithSecret>[1]): IssuedBusinessMcpCredential {
  const [current] = configuredBusinessMcpSecrets();
  if (!current) throw new Error("HERMES_BUSINESS_MCP_SECRET is not configured.");
  return issueBusinessMcpCredentialWithSecret(current, input);
}
