import "server-only";
import crypto from "node:crypto";
import { env } from "@/server/env";

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keyLen: 64, maxmem: 128 * 1024 * 1024 };

function scrypt(password: string, salt: Buffer, params = SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize("NFKC"),
      salt,
      params.keyLen,
      { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** Hash format: scrypt$N$r$p$saltB64$hashB64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const key = await scrypt(password, Buffer.from(saltB64, "base64"), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    keyLen: expected.length,
    maxmem: SCRYPT.maxmem,
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/** A precomputed hash used to equalise timing when an account does not exist. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash() {
  dummyHash ??= hashPassword(crypto.randomBytes(18).toString("base64"));
  return dummyHash;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const keyFrom = (material: string): Buffer => crypto.createHash("sha256").update(material).digest();

/**
 * The key a secret is sealed with now, then the retired keys in APP_ENCRYPTION_KEY_PREVIOUS (comma separated, decrypt-only). A rotation is: put the old key in PREVIOUS and the new one
 * in APP_ENCRYPTION_KEY (every sealed secret still opens), run the re-seal (src/server/security/sealed-secrets.ts, `npm run secrets:reseal`), then drop PREVIOUS.
 */
function encryptionKeys(): Buffer[] {
  const e = env();
  // Development only: env() refuses to start production without APP_ENCRYPTION_KEY.
  const current = keyFrom(e.APP_ENCRYPTION_KEY || "iacquire-local-development-only-key");
  const previous = (e.APP_ENCRYPTION_KEY_PREVIOUS ?? "").split(",").map((k) => k.trim()).filter(Boolean).map(keyFrom);
  return [current, ...previous];
}

function encryptionKey(): Buffer {
  return encryptionKeys()[0];
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url). Always sealed with the current key. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

function openWith(key: Buffer, payload: string): string {
  const [version, ivB64, tagB64, ctB64] = payload.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !ctB64) throw new Error("Unsupported secret format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
}

/** Opens a sealed secret with the current key, or with a retired one while it is still listed. A value no listed key opens fails with the current key's error. */
export function decryptSecret(payload: string): string {
  let first: unknown;
  for (const key of encryptionKeys()) {
    try {
      return openWith(key, payload);
    } catch (error) {
      first ??= error;
    }
  }
  throw first;
}

/** Whether the current key (not a retired one) opens this value: false means it still needs the re-seal after a rotation. */
export function sealedWithCurrentKey(payload: string): boolean {
  try {
    openWith(encryptionKey(), payload);
    return true;
  } catch {
    return false;
  }
}

/** The same secret sealed again with the current key. Throws when no listed key opens it, so an unreadable value is never replaced by anything. */
export function resealSecret(payload: string): string {
  return encryptSecret(decryptSecret(payload));
}

/** Non-reversible fingerprint for showing which secret is stored, e.g. "…a1b2". */
export function secretFingerprint(secret: string): string {
  return `sha256:${sha256(secret).slice(0, 12)}`;
}

/** Salted hash so audit logs and sessions can correlate requests without storing raw IPs. */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return crypto.createHmac("sha256", encryptionKey()).update(ip).digest("hex").slice(0, 32);
}
