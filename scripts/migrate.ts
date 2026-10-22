import { runMigrations, closeDb, listMigrationFiles, pendingMigrations, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";
import { describeDatabaseTarget, migrationScope, parseMigrateArgs } from "../src/server/db/migrate-args";

async function main() {
  const args = parseMigrateArgs(process.argv.slice(2));
  const selectedVersions = migrationScope(args, listMigrationFiles());
  const e = env();
  // Said first, every time, so a run against the wrong database is noticed before it changes anything. Never prints a user name or password.
  console.log(`Target: ${describeDatabaseTarget(e.DATABASE_DRIVER, e.DATABASE_URL)}`);
  if (selectedVersions) console.log(`Migration scope: ${args.through ? `through ${args.through} (${selectedVersions.length} migrations)` : selectedVersions.join(", ")}`);
  if (args.dryRun) {
    const pending = await pendingMigrations(selectedVersions);
    console.log(pending.length ? `Would apply, in this order: ${pending.join(", ")}` : "Nothing pending in this scope.");
    // Reading what is applied creates the empty ledger table if the database has never been migrated (the real run would too); nothing else is touched.
    console.log("Dry run: no migration was applied.");
    await closeDb();
    return;
  }
  const ran = await runMigrations(undefined, selectedVersions);
  const pending = await pendingMigrations(selectedVersions);
  const applied = await withSystem((db) =>
    db.query<{ version: string }>("select version from schema_migrations order by version"),
  );
  console.log(ran.length ? `Applied now: ${ran.join(", ")}` : "No new migrations to apply.");
  console.log(`Schema version: ${applied.rows.map((r) => r.version).join(", ")}`);
  if (pending.length) console.log(`Still pending: ${pending.join(", ")}`);
  await closeDb();
}

main().catch((err) => {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
