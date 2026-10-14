import "server-only";
import {
  checkSupabaseConfig,
  databaseMatchesSupabase,
  publishableKeyKind,
  readSupabasePublicConfig,
  supabaseProjectRef,
  type SupabaseConfigProblem,
  type SupabasePublicConfig,
} from "@/lib/supabase-config";

/**
 * Raised when code needs Supabase but the environment is incomplete. The message names the missing
 * variables (never their values) so a developer can fix the problem without reading source.
 */
export class SupabaseConfigError extends Error {
  readonly problems: SupabaseConfigProblem[];
  constructor(problems: SupabaseConfigProblem[]) {
    super(`Supabase is not configured: ${problems.map((p) => p.message).join(" ")}`);
    this.name = "SupabaseConfigError";
    this.problems = problems;
  }
}

export interface SupabaseConfigStatus {
  configured: boolean;
  url: string | null;
  projectRef: string | null;
  publishableKeyKind: "publishable" | "legacy_anon" | null;
  secretKeyPresent: boolean;
  secretKeyKind: "secret" | "legacy_service_role" | "unknown" | null;
  problems: SupabaseConfigProblem[];
}

/** Describes the configuration without ever returning a key. Safe to show to agency admins. */
export function supabaseConfigStatus(source: Record<string, string | undefined> = process.env): SupabaseConfigStatus {
  const problems = checkSupabaseConfig(source, true);
  if (!source.DATABASE_URL?.trim()) problems.push({code:"missing_database_url",message:"DATABASE_URL is not set. Use the same Supabase portal project's PostgreSQL connection."});
  else if (!databaseMatchesSupabase(source)) problems.push({code:"bad_database_project",message:"DATABASE_URL must belong to the configured Supabase portal project, separate from n8n's appointment database."});
  if (source.DATABASE_DRIVER && source.DATABASE_DRIVER!=="postgres") problems.push({code:"bad_database_project",message:"Supabase mode requires DATABASE_DRIVER=postgres. Local demo mode must explicitly use AUTH_PROVIDER=local."});
  const pub = readSupabasePublicConfig(source);
  const secret = source.SUPABASE_SECRET_KEY?.trim() || null;
  return {
    configured: problems.length === 0,
    url: pub?.url ?? null,
    projectRef: pub ? supabaseProjectRef(pub.url) : null,
    publishableKeyKind: pub ? publishableKeyKind(pub.publishableKey) : null,
    secretKeyPresent: Boolean(secret),
    secretKeyKind: secret ? (secret.startsWith("sb_secret_") ? "secret" : secret.split(".").length === 3 ? "legacy_service_role" : "unknown") : null,
    problems,
  };
}

/** URL + publishable key (public values). Throws a clear error when either is missing. */
export function requireSupabasePublic(source: Record<string, string | undefined> = process.env): SupabasePublicConfig {
  const problems = checkSupabaseConfig(source, false);
  const pub = readSupabasePublicConfig(source);
  if (problems.length || !pub) throw new SupabaseConfigError(problems);
  return pub;
}

/** URL + publishable key + secret key, for server-side admin operations only. */
export function requireSupabaseAdmin(source: Record<string, string | undefined> = process.env): SupabasePublicConfig & { secretKey: string } {
  const problems = checkSupabaseConfig(source, true);
  const pub = readSupabasePublicConfig(source);
  const secretKey = source.SUPABASE_SECRET_KEY?.trim();
  if (problems.length || !pub || !secretKey) throw new SupabaseConfigError(problems);
  return { ...pub, secretKey };
}
