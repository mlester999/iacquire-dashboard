import "server-only";
import type { Queryable } from "@/server/db";
import type { SessionUser } from "@/server/auth/service";

/**
 * The agency person a standing automation acts for, read again at the moment it runs. A person's decision does not outlive their access: an account that is no longer active, or
 * no longer holds an agency role, gets nothing back and the automation stops and tells the team. The caller still checks the permission its own step needs (the services it calls
 * re-read the role under a lock as well). `automation` only names the run on the returned session; it is not a login.
 */
export async function authorizerOf(db: Queryable, userId: string, automation = "purchase-intent-automation"): Promise<SessionUser | null> {
  const u = (await db.query<{ id: string; email: string; full_name: string | null; platform_role: SessionUser["platformRole"]; timezone: string | null; preferences: Record<string, unknown> | null; verified: boolean }>(
    "select id, email, full_name, platform_role, timezone, preferences, email_verified_at is not null as verified from users where id = $1 and status = 'active'", [userId],
  )).rows[0];
  if (!u || u.platform_role === "none") return null;
  return { sessionId: automation, id: u.id, email: u.email, fullName: u.full_name ?? "", platformRole: u.platform_role, timezone: u.timezone ?? "UTC", preferences: u.preferences ?? {}, emailVerified: u.verified };
}
