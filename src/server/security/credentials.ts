import "server-only";
import crypto from "node:crypto";
import { env } from "@/server/env";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { decryptSecret, secretFingerprint } from "@/server/security/crypto";
import { recordAudit } from "@/server/audit";

// Explicit synthetic test adapter. Never enabled outside NODE_ENV=test; nothing persists.
const testSecrets = new Map<string, string>();
function testStore() { return process.env.NODE_ENV === "test" && process.env.SECRET_STORE === "test-memory"; }

export async function assertCredentialAdmin(db:Queryable,actorId:string) {
  const { rows: actors } = await db.query<{ platform_role:string }>("select platform_role from users where id=$1 and status='active'",[actorId]);
  if (actors[0]?.platform_role !== "agency_super_admin") throw new AppError("forbidden","Only agency super admins can manage credentials.");
}

export async function credentialStoreReady(db: Queryable): Promise<boolean> {
  if (testStore()) return true;
  const { rows } = await db.query<{ ready: boolean }>("select to_regclass('vault.decrypted_secrets') is not null and to_regprocedure('vault.create_secret(text,text,text,uuid)') is not null as ready");
  return rows[0]?.ready === true;
}

/** Providers whose secrets the vault holds. resend, twilio and meta_whatsapp are per-workspace messaging senders (migration 0031). */
export type CredentialProvider = "hermes" | "ghl" | "n8n" | "llm" | "resend" | "twilio" | "meta_whatsapp" | "vapi" | "retell";

/**
 * A secret made of several parts (Twilio account SID and auth token, a Meta access token with its app secret) is stored as one vault
 * secret: a single-line JSON object of strings. The transport that uses it parses it back with parseCredentialSecret.
 */
export function encodeCredentialSecret(parts: Record<string, string>): string {
  const entries = Object.entries(parts).map(([k, v]) => [k, typeof v === "string" ? v.trim() : ""] as const);
  if (!entries.length || entries.some(([k, v]) => !/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k) || !v || /[\r\n]/.test(v))) {
    throw new AppError("invalid_input", "Enter every part of the service credential.");
  }
  return JSON.stringify(Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))));
}

/** Reads a multi-part secret back. Returns null (never the raw secret) when it is not the expected shape. */
export function parseCredentialSecret<K extends string>(secret: string | null | undefined, keys: readonly K[]): Record<K, string> | null {
  if (!secret) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(secret); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out = {} as Record<K, string>;
  for (const k of keys) {
    const v = (parsed as Record<string, unknown>)[k];
    if (typeof v !== "string" || !v.trim()) return null;
    out[k] = v.trim();
  }
  return out;
}

/** Uses Supabase's managed encryption, not application-defined cryptography. */
export async function saveCredential(db: Queryable, input: { orgId: string | null; provider: CredentialProvider; label: string; secret: string; scopes?: string[]; actorId: string; replaces?: string | null }) {
  await assertCredentialAdmin(db,input.actorId);
  const secret = input.secret.trim();
  if (secret.length < 16 || secret.length > 4096 || /[\r\n]/.test(secret)) throw new AppError("invalid_input", "Enter a valid service credential.");
  if (!await credentialStoreReady(db)) throw new AppError("integration_unavailable", "Secure credential storage is unavailable. Enable Supabase Vault in the approved development project before saving credentials.");
  // Do not return database errors here: driver errors may include secret query parameters.
  let vaultId: string;
  try {
    if (testStore()) { vaultId = crypto.randomUUID(); testSecrets.set(vaultId, secret); }
    else {
      const { rows } = await db.query<{ id: string }>("select vault.create_secret($1,$2,$3) as id", [secret, `iacquire-${crypto.randomUUID()}`, "iAcquire managed integration credential"]);
      vaultId = rows[0].id;
    }
  } catch { throw new AppError("integration_unavailable", "Secure credential storage rejected the save. Check Vault configuration."); }
  const fingerprint = secretFingerprint(secret);
  const { rows: refs } = await db.query<{ id: string }>(
    "insert into credential_references (org_id,provider,store,vault_secret_id,label,fingerprint,scopes,created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
    [input.orgId,input.provider,testStore() ? "test_memory" : "supabase_vault",vaultId,input.label,fingerprint,input.scopes ?? [],input.actorId],
  );
  const { rows } = await db.query<{ id: string }>(
    "insert into integration_credentials (org_id,provider,label,ciphertext,fingerprint,scopes,created_by,credential_reference_id) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
    [input.orgId,input.provider,input.label,`vault-ref:${refs[0].id}`,fingerprint,input.scopes ?? [],input.actorId,refs[0].id],
  );
  if (input.replaces) {
    await revokeCredential(db,input.replaces,input.orgId,input.provider,input.actorId);
    await db.query("update credential_references set rotated_at=now() where id=$1",[refs[0].id]);
  }
  await recordAudit({ orgId:input.orgId,actorUserId:input.actorId,actorKind:"agency",action:input.replaces ? "credential.rotated" : "credential.saved",targetType:"integration",targetId:rows[0].id,result:"success",metadata:{provider:input.provider,store:testStore() ? "test_memory" : "supabase_vault"} },db);
  return { id:rows[0].id,fingerprint };
}

/** Scope is validated before touching Vault. References are never accepted from the browser. */
export async function resolveCredential(db: Queryable, credentialId: string, orgId: string | null, provider: string): Promise<string | null> {
  const { rows } = await db.query<{ org_id:string|null; provider:string; ciphertext:string; revoked_at:Date|null; reference_id:string|null; store:string|null; vault_secret_id:string|null; reference_revoked_at:Date|null; reference_org_id:string|null; reference_provider:string|null }>(
    `select c.org_id,c.provider,c.ciphertext,c.revoked_at,r.id as reference_id,r.store,r.vault_secret_id,r.revoked_at as reference_revoked_at,r.org_id as reference_org_id,r.provider as reference_provider
     from integration_credentials c left join credential_references r on r.id=c.credential_reference_id where c.id=$1`,[credentialId],
  );
  const r=rows[0];
  if (!r || r.revoked_at) return null;
  if (r.org_id !== orgId || r.provider !== provider) throw new AppError("forbidden","Credential ownership does not match the connection.");
  if (!r.reference_id) {
    // Explicit migration-only compatibility. Never falls back silently in production.
    if (env().NODE_ENV === "production" || !env().ALLOW_LEGACY_CREDENTIAL_READS) throw new AppError("integration_unavailable","This legacy credential must be rotated into Supabase Vault.");
    let secret:string;
    try { secret=decryptSecret(r.ciphertext); } catch { throw new AppError("integration_unavailable","The legacy credential cannot be read. Rotate it securely."); }
    await recordAudit({orgId,actorKind:"system",action:"credential.resolved",targetType:"integration",targetId:credentialId,result:"success",metadata:{provider,store:"legacy_migration_only"}},db);
    return secret;
  }
  if (r.reference_org_id !== orgId || r.reference_provider !== provider || r.reference_revoked_at || !r.vault_secret_id) throw new AppError("forbidden","Credential reference ownership does not match the connection.");
  let secret:string|null;
  if (r.store === "test_memory") {
    if (!testStore()) throw new AppError("integration_unavailable","Synthetic test credentials cannot be used in this environment.");
    secret=testSecrets.get(r.vault_secret_id) ?? null;
  } else {
    try {
      const { rows: secrets } = await db.query<{ decrypted_secret:string }>("select decrypted_secret from vault.decrypted_secrets where id=$1",[r.vault_secret_id]);
      secret=secrets[0]?.decrypted_secret ?? null;
    } catch { throw new AppError("integration_unavailable","Secure credential storage could not resolve this credential."); }
  }
  await recordAudit({orgId,actorKind:"system",action:"credential.resolved",targetType:"integration",targetId:credentialId,result:secret?"success":"failure",metadata:{provider,store:r.store}},db);
  return secret;
}

/** Portal revocation blocks resolution immediately; upstream token revocation remains a provider action. */
export async function revokeCredential(db:Queryable,id:string,orgId:string|null,provider:string,actorId:string) {
  await assertCredentialAdmin(db,actorId);
  const { rows }=await db.query<{ credential_reference_id:string|null }>("update integration_credentials set revoked_at=coalesce(revoked_at,now()) where id=$1 and org_id is not distinct from $2::uuid and provider=$3 returning credential_reference_id",[id,orgId,provider]);
  if (!rows[0]) throw new AppError("forbidden","Credential ownership does not match the connection.");
  if (rows[0].credential_reference_id) await db.query("update credential_references set revoked_at=coalesce(revoked_at,now()) where id=$1",[rows[0].credential_reference_id]);
  await recordAudit({orgId,actorUserId:actorId,actorKind:"agency",action:"credential.revoked",targetType:"integration",targetId:id,result:"success",metadata:{provider}},db);
}
