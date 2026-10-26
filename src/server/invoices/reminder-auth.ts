import "server-only";
import type { Queryable } from "@/server/db";
import { PERMISSION_MATRIX } from "@/lib/permissions";
import { authorizationProblem, type AuthorizationProblem } from "@/lib/invoices/reminder-rules";
import { reminderAuthorizationHash } from "@/lib/invoices/reminder-hash";
import type { SettingsRow } from "@/server/invoices/core";

// Whether the owner's authorization of the invoice reminders still covers what would be sent. Kept apart from the reminders themselves (which pull in the whole send chain)
// so a read-only look at it, such as the receivables review, stays small.

export const setupOf = (s: SettingsRow) => ({ offsetsDays: s.reminderOffsetsDays, max: s.reminderMax, channels: s.reminderChannels });

/** The person who authorized still holds the owner's permission in the workspace (the only role that may change invoice settings). */
export async function authorizerIsOwner(db: Queryable, orgId: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const roles = [...PERMISSION_MATRIX["invoices.settings"]];
  const { rows } = await db.query("select 1 from organization_memberships where org_id = $1 and user_id = $2 and status = 'active' and role = any($3::text[])", [orgId, userId, roles]);
  return rows.length > 0;
}

/** Why the stored authorization does not cover what would be sent now, or null when it does. */
export async function currentAuthorizationProblem(db: Queryable, orgId: string, s: SettingsRow, now: Date): Promise<AuthorizationProblem | null> {
  return authorizationProblem({
    enabled: s.remindersEnabled, authorizedAt: s.remindersAuthorizedAt ? new Date(s.remindersAuthorizedAt) : null, storedHash: s.remindersBodyHash, currentHash: reminderAuthorizationHash(setupOf(s)),
    authorizerIsOwner: await authorizerIsOwner(db, orgId, s.remindersAuthorizedBy), now,
  });
}
