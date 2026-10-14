import "server-only";

/**
 * How the app talks TLS to PostgreSQL.
 *
 * node-postgres treats `sslmode=require` as full certificate verification, and Supabase's database
 * certificates chain to Supabase's own root CA (not a public one), so `?sslmode=require` fails with
 * "self-signed certificate in certificate chain" unless that CA is supplied. The app therefore takes
 * control of TLS: it strips libpq-style SSL parameters from the URL and decides here.
 *
 * - With the Supabase root CA (`DATABASE_SSL_CA_FILE` / `DATABASE_SSL_CA`): encrypted and verified.
 * - Remote host, no CA, development/test: encrypted but NOT verified (a warning is logged once).
 *   This is better than plaintext and never allowed in production (see `env.ts`).
 * - Local host (a local Supabase stack, CI): no TLS.
 */
export interface TlsPlan {
  connectionString: string;
  ssl: false | undefined | { rejectUnauthorized: boolean; ca?: string };
  /** True only when the server certificate is verified against a supplied CA. */
  verified: boolean;
  /** Human-readable note for the startup log when TLS is weaker than recommended. */
  warning?: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const SSL_PARAMS = ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"];

export function isLocalDatabaseHost(connectionString: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(connectionString).hostname);
  } catch {
    return false;
  }
}

/** Accepts a PEM pasted into an environment variable with literal `\n` sequences. */
export function normalizePem(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

export function planPostgresTls(input: { connectionString: string; caPem?: string | null; requireVerified?: boolean }): TlsPlan {
  const url = new URL(input.connectionString);
  const requested = url.searchParams.get("sslmode");
  for (const key of SSL_PARAMS) url.searchParams.delete(key);
  const connectionString = url.toString();
  const ca = input.caPem?.trim() ? normalizePem(input.caPem.trim()) : null;

  if (ca) return { connectionString, ssl: { ca, rejectUnauthorized: true }, verified: true };
  if (LOCAL_HOSTS.has(url.hostname)) return { connectionString, ssl: undefined, verified: false };
  // Check the loaded certificate, not merely a configured path. An empty CA file must never
  // downgrade production to unverified TLS after the environment validation has passed.
  if (input.requireVerified) {
    throw new Error("Production requires a nonempty database root CA certificate in DATABASE_SSL_CA_FILE or DATABASE_SSL_CA.");
  }
  if (requested === "disable") {
    return { connectionString, ssl: false, verified: false, warning: "sslmode=disable was requested: database traffic is NOT encrypted." };
  }
  return {
    connectionString,
    ssl: { rejectUnauthorized: false },
    verified: false,
    warning:
      "Database TLS is encrypted but the server certificate is not verified. Download Supabase's root certificate " +
      "(Project Settings → Database → SSL configuration) and set DATABASE_SSL_CA_FILE. Production requires it.",
  };
}
