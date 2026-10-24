import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { STAFF_MESSAGES_FEATURE, RETENTION_DAYS_MAX, RETENTION_DAYS_MIN } from "@/lib/staff-messages/limits";
import type { StaffUser } from "@/server/staff-messages/access";

// Staff Messages is dormant until a Super Admin switches it on for the agency workspace (org_features, feature "staff_messages"; no row means off). Switching it on
// connects nothing and sends nothing. Switching it off hides the screens and refuses every request; it deletes nothing, and the messages are there again when it is switched on.
// The one other setting is the retention period: none by default, so nothing is ever deleted by age unless a Super Admin chose a number of days.

const SUPER_ONLY = "Only a Super Admin can change staff Messages settings.";

export async function staffMessagesEnabled(): Promise<boolean> {
  const { rows } = await withSystem((db) =>
    db.query<{ enabled: boolean }>(
      `select exists (select 1 from org_features f join organizations o on o.id = f.org_id where o.kind = 'agency' and f.feature = $1 and f.enabled) as enabled`,
      [STAFF_MESSAGES_FEATURE],
    ),
  );
  return rows[0]?.enabled === true;
}

/** A Super Admin switches staff Messages on or off. Audited. */
export async function setStaffMessagesEnabled(user: StaffUser, enabled: boolean): Promise<void> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", SUPER_ONLY);
  await withSystem(async (db) => {
    const who = (await db.query<{ ok: boolean }>("select (status = 'active' and platform_role = 'agency_super_admin') as ok from users where id = $1", [user.id])).rows[0];
    if (!who?.ok) throw new AppError("forbidden", SUPER_ONLY);
    const org = (await db.query<{ id: string }>("select id from organizations where kind = 'agency'")).rows[0];
    if (!org) throw new AppError("unavailable", "The agency workspace does not exist yet.");
    await db.query(
      `insert into org_features (org_id, feature, enabled, updated_by) values ($1, $2, $3, $4)
       on conflict (org_id, feature) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()`,
      [org.id, STAFF_MESSAGES_FEATURE, enabled, user.id],
    );
    await recordAudit({ orgId: org.id, actorUserId: user.id, actorKind: "agency", action: enabled ? "staff_messages.enabled" : "staff_messages.disabled", targetType: "organization", targetId: org.id, result: "success" }, db);
  });
}

export interface StaffMessageSettings {
  retentionDays: number | null;
}

export async function loadStaffMessageSettings(): Promise<StaffMessageSettings> {
  const { rows } = await withSystem((db) =>
    db.query<{ retention_days: number | null }>("select s.retention_days from staff_message_settings s join organizations o on o.id = s.org_id where o.kind = 'agency'"),
  );
  return { retentionDays: rows[0]?.retention_days ?? null };
}

/**
 * The retention period in days, or null for none (the default: nothing is deleted by age). A Super Admin only, audited. The first run of the maintenance job after a period is
 * set deletes every message older than it, for good, so the period is the one number here that cannot be undone.
 */
export async function setRetentionDays(user: StaffUser, days: number | null): Promise<StaffMessageSettings> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", SUPER_ONLY);
  if (days !== null && (!Number.isInteger(days) || days < RETENTION_DAYS_MIN || days > RETENTION_DAYS_MAX)) {
    throw new AppError("invalid_input", `Choose a whole number of days from ${RETENTION_DAYS_MIN} to ${RETENTION_DAYS_MAX}, or none.`);
  }
  await withSystem(async (db) => {
    const who = (await db.query<{ ok: boolean }>("select (status = 'active' and platform_role = 'agency_super_admin') as ok from users where id = $1", [user.id])).rows[0];
    if (!who?.ok) throw new AppError("forbidden", SUPER_ONLY);
    const org = (await db.query<{ id: string }>("select id from organizations where kind = 'agency'")).rows[0];
    if (!org) throw new AppError("unavailable", "The agency workspace does not exist yet.");
    await db.query(
      `insert into staff_message_settings (org_id, retention_days, updated_by) values ($1, $2, $3)
       on conflict (org_id) do update set retention_days = excluded.retention_days, updated_by = excluded.updated_by`,
      [org.id, days, user.id],
    );
    await recordAudit({ orgId: org.id, actorUserId: user.id, actorKind: "agency", action: "staff_messages.retention_changed", targetType: "organization", targetId: org.id, result: "success", metadata: { retentionDays: days } }, db);
  });
  return { retentionDays: days };
}
