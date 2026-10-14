import { runMigrations, closeDb, pendingMigrations, withSystem } from "../src/server/db/index";

async function main() {
  const ran = await runMigrations();
  const pending = await pendingMigrations();
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
