/**
 * Moves every app-sealed secret (calendar, webhook, Automation Studio, social, e-signature, payment, review-site and legacy credentials) from a retired APP_ENCRYPTION_KEY to the
 * current one. Dry run by default: it prints counts and row ids only, never a secret or a sealed value. Nothing is changed without --apply, and with --apply a value that no listed key
 * opens is left exactly as it is.
 *
 *   APP_ENCRYPTION_KEY=<new> APP_ENCRYPTION_KEY_PREVIOUS=<old> npm run secrets:reseal              (counts)
 *   APP_ENCRYPTION_KEY=<new> APP_ENCRYPTION_KEY_PREVIOUS=<old> npm run secrets:reseal -- --apply   (re-seal)
 *
 * Run it against a hosted database only with the founder's approval, after a verified backup. The procedure is in docs/credential-security.md.
 */
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";
import { resealSealedSecrets } from "../src/server/security/sealed-secrets";

const apply = process.argv.slice(2).includes("--apply");
try {
  const config = env();
  if (!config.APP_ENCRYPTION_KEY) throw new Error("APP_ENCRYPTION_KEY (the new key) is not set.");
  const hasPrevious = Boolean((config.APP_ENCRYPTION_KEY_PREVIOUS ?? "").trim());
  const reports = await withSystem((db) => resealSealedSecrets(db, { apply }));
  const retired = reports.reduce((n, r) => n + r.onRetiredKey, 0);
  const unreadable = reports.reduce((n, r) => n + r.unreadable, 0);
  for (const r of reports) {
    console.log(`${r.table}.${r.column}: ${r.total} sealed, ${r.onCurrentKey} on the current key, ${r.onRetiredKey} on a retired key${apply ? ` (${r.resealed} re-sealed)` : ""}, ${r.unreadable} unreadable${r.unreadableIds.length ? ` (ids: ${r.unreadableIds.join(", ")})` : ""}`);
  }
  if (!hasPrevious && retired === 0 && unreadable > 0) console.log("Some values are unreadable and APP_ENCRYPTION_KEY_PREVIOUS is empty: if a key was rotated without listing the old one, list it and run this again.");
  if (!apply) console.log(retired ? `Dry run: ${retired} value(s) are still on a retired key. Run again with --apply to re-seal them.` : "Dry run: nothing is on a retired key. APP_ENCRYPTION_KEY_PREVIOUS can be removed once unreadable values (if any) are understood.");
  else console.log(`Re-sealed ${reports.reduce((n, r) => n + r.resealed, 0)} value(s). Run the dry run again; when it shows none on a retired key, remove APP_ENCRYPTION_KEY_PREVIOUS.`);
  if (unreadable) process.exitCode = 2;
} catch (error) {
  console.error(`Re-seal stopped: ${error instanceof Error ? error.message : "unknown error"}. No secret values are logged.`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
