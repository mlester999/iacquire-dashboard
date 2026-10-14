/** Run manually only after authorization of a dedicated development Supabase project. */
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";
import { databaseMatchesSupabase } from "../src/lib/supabase-config";
import { ensureAuthUserForProfile, queueMigrationRecoveryNotice } from "../src/server/auth/supabase";
import { requireSupabaseAdmin } from "../src/server/supabase/config";

async function main() {
  const apply = process.argv.includes("--apply");
  const notices = process.argv.includes("--send-notices");
  const args = process.argv.filter((a) => a.startsWith("--"));
  if (args.some((a) => !["--apply","--send-notices","--dry-run"].includes(a))) throw new Error("Use --dry-run, --apply, and optional --send-notices only.");
  if (notices && !apply) throw new Error("--send-notices requires --apply and an authorized email provider.");
  const config = env();
  if (config.DATABASE_DRIVER !== "postgres" || !databaseMatchesSupabase(process.env)) {
    throw new Error("Account migration requires DATABASE_URL for the configured Supabase portal project. It never migrates the embedded source in place.");
  }
  requireSupabaseAdmin();
  if (notices && (config.EMAIL_PROVIDER !== "resend" || !config.RESEND_API_KEY)) {
    throw new Error("Configure the authorized email provider before sending migration notices. Capture mode is not delivery.");
  }
  const profiles = await withSystem(async (db) => (await db.query<{ id:string; email:string; auth_user_id:string|null; status:string }>(
    "select id,email,auth_user_id,status from users order by created_at,id",
  )).rows);
  const candidates = profiles.filter((p) => p.status === "active" && !p.auth_user_id);
  console.log(`Account plan: ${candidates.length} active accounts need linking; ${profiles.filter((p) => p.auth_user_id).length} already linked; ${profiles.filter((p) => p.status !== "active").length} disabled accounts retained.`);
  if (!apply) {
    console.log("Dry run only. No Auth users, notices, credentials or application records changed. Existing hashes cannot be imported; migrated owners use an emailed password reset.");
    return;
  }
  let migrated = 0;
  let failed = 0;
  for (const profile of candidates) {
    const result = await ensureAuthUserForProfile(profile.id);
    if (!result.ok) {
      failed++;
      // No raw remote response or PII is logged. The ledger contains only a safe operator summary.
      await withSystem((db) => db.query(
        "insert into auth_account_migrations(user_id,status,last_error,attempted_at) values($1,'failed','Account linking requires operator review.',now()) on conflict(user_id) do update set status='failed',last_error=excluded.last_error,attempted_at=now()",
        [profile.id],
      ));
      continue;
    }
    migrated++;
  }
  let noticesQueued = 0;
  if (notices) {
    const pending = await withSystem(async (db) => (await db.query<{ id:string; email:string }>(
      "select u.id,u.email from users u join auth_account_migrations m on m.user_id=u.id where u.status='active' and m.auth_user_id is not null and m.notice_sent_at is null and m.status<>'failed'",
    )).rows);
    for (const profile of pending) {
      if (!await queueMigrationRecoveryNotice(profile.id)) continue;
      await withSystem((db) => db.query("update auth_account_migrations set notice_sent_at=now() where user_id=$1", [profile.id]));
      noticesQueued++;
    }
  }
  console.log(`Migration: ${migrated} linked; ${failed} need review; ${noticesQueued} notices queued (verify email_outbox delivery). All legacy profiles and business records retained.`);
  if (failed) process.exitCode = 1;
}
main().catch(() => {
  console.error("Account migration stopped. Check the safe account migration ledger and Supabase configuration; no credentials are printed.");
  process.exitCode = 1;
}).finally(closeDb);
