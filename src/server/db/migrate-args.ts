// Command-line options of scripts/migrate.ts, kept apart so they can be tested without a database.
//
//   --only <version> ...   exactly these migrations (existing behaviour)
//   --through <version>    every migration up to and including this one (to rebuild a database in the state production is in, then apply the rest one by one)
//   --dry-run              say which database would be used and what is pending in scope, and apply nothing (on a database never migrated it creates the empty ledger table)
// Versions are file names without .sql (for example 0083_unified_inbox).

export interface MigrateArgs {
  only?: string[];
  through?: string;
  dryRun: boolean;
}

export const MIGRATE_USAGE = "Usage: npm run db:migrate -- [--dry-run] [--only <exact-migration-version> ... | --through <exact-migration-version>]";

export function parseMigrateArgs(args: string[]): MigrateArgs {
  const out: MigrateArgs = { dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--through") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) throw new Error(MIGRATE_USAGE);
      if (out.through !== undefined) throw new Error("--through was given more than once.");
      out.through = value;
      i += 1;
    } else if (arg === "--only") {
      const versions: string[] = [];
      while (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) {
        versions.push(args[i + 1]);
        i += 1;
      }
      if (!versions.length) throw new Error(MIGRATE_USAGE);
      out.only = [...(out.only ?? []), ...versions];
    } else {
      throw new Error(MIGRATE_USAGE);
    }
  }
  if (out.only && out.through) throw new Error("Use --only or --through, not both.");
  return out;
}

/** The exact versions to act on, or undefined for "everything pending". `files` are the repository's migration file names. */
export function migrationScope(args: MigrateArgs, files: readonly string[]): string[] | undefined {
  if (args.through === undefined) return args.only;
  const versions = files.map((f) => f.replace(/\.sql$/, "")).sort();
  if (!versions.includes(args.through)) throw new Error(`Unknown migration version for --through: ${args.through}. Pass an exact file name without .sql.`);
  return versions.filter((v) => v <= args.through!);
}

/** Which database a run would use, for the line printed before anything happens. Never includes a user name or a password. */
export function describeDatabaseTarget(driver: string | undefined, databaseUrl: string | undefined): string {
  if (!databaseUrl) return driver === "pglite" || driver === "pglite-memory" ? `embedded database (${driver})` : `no DATABASE_URL set (driver ${driver ?? "unset"})`;
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname && url.pathname !== "/" ? url.pathname : ""}`;
  } catch {
    return "a DATABASE_URL that could not be read";
  }
}
