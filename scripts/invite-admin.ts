/**
 * Bootstraps the first agency super admin by printing a one-time invitation link.
 * No password is ever passed on the command line or written to logs.
 *
 *   npm run admin:invite -- --email you@iacquire.ai
 */
import { closeDb, withSystem } from "../src/server/db/index";
import { createInvitation } from "../src/server/auth/service";

async function main() {
  const idx = process.argv.indexOf("--email");
  const email = idx >= 0 ? process.argv[idx + 1] : undefined;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("Usage: npm run admin:invite -- --email you@company.com");
    process.exit(1);
  }
  const role = process.argv.includes("--staff") ? "agency_staff" : "agency_super_admin";
  const existing = await withSystem((db) => db.query<{ platform_role: string }>("select platform_role from users where email = $1", [email.toLowerCase()]));
  if (existing.rows[0]?.platform_role === role) {
    console.log(`${email} already has ${role}.`);
    await closeDb();
    return;
  }
  const invite = await createInvitation({ orgId: null, email, platformRole: role, invitedBy: null });
  console.log(`Invitation for ${email} (${role}) created. It expires in 7 days and works once:\n\n  ${invite.link}\n`);
  await closeDb();
}

main().catch(async (err) => {
  console.error("Failed:", err instanceof Error ? err.message : err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
