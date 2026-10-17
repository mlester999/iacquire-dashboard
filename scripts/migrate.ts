import { runMigrations, closeDb, pendingMigrations, withSystem } from "../src/server/db/index";

function selectedVersionsFromArgs(args: string[]): string[] | undefined {
  if (!args.length) return undefined;
  if (args[0] !== "--only" || args.length < 2 || args.slice(1).some((arg) => arg.startsWith("--"))) {
    throw new Error("Usage: npm run db:migrate -- [--only <exact-migration-version> ...]");
  }
  return args.slice(1);
}

async function main() {
  const selectedVersions = selectedVersionsFromArgs(process.argv.slice(2));
  const ran = await runMigrations(undefined, selectedVersions);
  const pending = await pendingMigrations(selectedVersions);
  const applied = await withSystem((db) =>
    db.query<{ version: string }>("select version from schema_migrations order by version"),
  );
  if (selectedVersions) console.log(`Migration scope: ${selectedVersions.join(", ")}`);
  console.log(ran.length ? `Applied now: ${ran.join(", ")}` : "No new migrations to apply.");
  console.log(`Schema version: ${applied.rows.map((r) => r.version).join(", ")}`);
  if (pending.length) console.log(`Still pending: ${pending.join(", ")}`);
  await closeDb();
}

main().catch((err) => {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
