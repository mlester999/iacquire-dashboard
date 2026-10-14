// Supabase configuration helpers that are safe to import from the proxy and from client code:
// nothing here reads or returns the secret key.

export type AuthProviderName = "local" | "supabase";

export interface SupabasePublicConfig {
  url: string;
  publishableKey: string;
}

type EnvSource = Record<string, string | undefined>;

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

/** Decodes the payload of a legacy JWT-style key without verifying it (inspection only). */
function jwtRole(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json) as { role?: unknown };
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

/** True when a key is a secret/service-role key and must never reach a browser. */
export function looksLikeSecretKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  const role = jwtRole(key);
  return role === "service_role" || role === "supabase_admin";
}

export type PublishableKeyKind = "publishable" | "legacy_anon";

export function publishableKeyKind(key: string): PublishableKeyKind | null {
  if (key.startsWith("sb_publishable_")) return "publishable";
  if (jwtRole(key) === "anon") return "legacy_anon";
  return null;
}

/** The two values that are intentionally public. Returns null when either is missing. */
export function readSupabasePublicConfig(source: EnvSource = process.env): SupabasePublicConfig | null {
  const url = clean(source.NEXT_PUBLIC_SUPABASE_URL);
  const publishableKey = clean(source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  if (!url || !publishableKey) return null;
  return { url: url.replace(/\/+$/, ""), publishableKey };
}

/** Local identity is opt-in for synthetic demos/tests. Missing Supabase config fails visibly. */
export function resolveAuthProvider(source: EnvSource = process.env): AuthProviderName {
  const explicit = clean(source.AUTH_PROVIDER);
  if (explicit === "local" || explicit === "supabase") return explicit;
  return "supabase";
}

/** Bind the portal SQL connection to the configured Supabase project, never the n8n database. */
export function databaseMatchesSupabase(source: EnvSource): boolean {
  try {
    const api = new URL(source.NEXT_PUBLIC_SUPABASE_URL ?? "");
    const db = new URL(source.DATABASE_URL ?? "");
    if (!["postgres:", "postgresql:"].includes(db.protocol)) return false;
    const local = ["localhost", "127.0.0.1", "[::1]"];
    if (local.includes(api.hostname)) return local.includes(db.hostname);
    const ref = supabaseProjectRef(api.toString());
    if (!ref) return false;
    const direct = db.hostname === `db.${ref}.supabase.co` || db.hostname === `db.${ref}.supabase.in`;
    const pooled = (db.hostname.endsWith(".pooler.supabase.com") || db.hostname.endsWith(".pooler.supabase.co")) && decodeURIComponent(db.username).endsWith(`.${ref}`);
    return direct || pooled;
  } catch { return false; }
}

/** The project reference is the first label of the API host (https://<ref>.supabase.co). */
export function supabaseProjectRef(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    const ref = host.split(".")[0];
    return host.endsWith(".supabase.co") || host.endsWith(".supabase.in") ? ref : null;
  } catch {
    return null;
  }
}

/** Names of environment variables that would leak a Supabase secret to browsers if set. */
const FORBIDDEN_PUBLIC_VARS = [
  "NEXT_PUBLIC_SUPABASE_SECRET_KEY",
  "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_SERVICE_KEY",
];

export interface SupabaseConfigProblem {
  code: "missing_url" | "missing_publishable_key" | "missing_secret_key" | "secret_in_public_var" | "bad_url" | "bad_publishable_key" | "bad_secret_key" | "missing_database_url" | "bad_database_project";
  message: string;
}

/**
 * Validates the Supabase variables. `needsSecret` is true for anything that performs admin
 * operations (creating users, generating links, Realtime publishing).
 */
export function checkSupabaseConfig(source: EnvSource = process.env, needsSecret = true): SupabaseConfigProblem[] {
  const problems: SupabaseConfigProblem[] = [];
  const url = clean(source.NEXT_PUBLIC_SUPABASE_URL);
  const publishable = clean(source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  const secret = clean(source.SUPABASE_SECRET_KEY);

  for (const name of FORBIDDEN_PUBLIC_VARS) {
    if (clean(source[name])) {
      problems.push({
        code: "secret_in_public_var",
        message: `${name} is set. Variables starting with NEXT_PUBLIC_ are shipped to every browser. Remove it and use SUPABASE_SECRET_KEY (server only).`,
      });
    }
  }
  if (!url) {
    problems.push({ code: "missing_url", message: "NEXT_PUBLIC_SUPABASE_URL is not set (Project Settings → API in your Supabase dashboard)." });
  } else {
    try {
      const parsed = new URL(url);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
      if ((parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        problems.push({ code: "bad_url", message: "NEXT_PUBLIC_SUPABASE_URL must use https:// (http is only accepted for a local Supabase stack)." });
      }
    } catch {
      problems.push({ code: "bad_url", message: "NEXT_PUBLIC_SUPABASE_URL is not a valid URL." });
    }
  }
  if (!publishable) {
    problems.push({
      code: "missing_publishable_key",
      message: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set (the sb_publishable_… key from Project Settings → API Keys).",
    });
  } else if (looksLikeSecretKey(publishable)) {
    problems.push({
      code: "secret_in_public_var",
      message: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY contains a secret/service-role key. It would be sent to browsers. Replace it with the sb_publishable_… key and rotate the exposed secret key.",
    });
  } else if (!publishableKeyKind(publishable)) {
    problems.push({ code:"bad_publishable_key",message:"NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be a publishable key or legacy anon key." });
  }
  if (needsSecret && !secret) {
    problems.push({
      code: "missing_secret_key",
      message: "SUPABASE_SECRET_KEY is not set (the sb_secret_… key; server only, never in a NEXT_PUBLIC_ variable).",
    });
  } else if (needsSecret && secret && !looksLikeSecretKey(secret)) {
    problems.push({ code:"bad_secret_key",message:"SUPABASE_SECRET_KEY must be a server secret key or legacy service-role key." });
  }
  return problems;
}
