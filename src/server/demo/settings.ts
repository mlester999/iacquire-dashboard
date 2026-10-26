import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { AppError } from "@/server/errors";
import type { SessionUser } from "@/server/auth/service";
import { checkSettingsPatch, DEMO_DEFAULTS, type DemoSettings, type DemoSettingsPatch, type SettingsProblems } from "@/lib/demo/settings";
import { assertProspectsAccess } from "@/server/demo/access";

// The demo's settings: one row, written only by a Super Admin. While no row exists the defaults in src/lib/demo/settings.ts apply, so the demo is off. Every save is checked
// (src/lib/demo/settings.ts), carries the version the person was looking at (a save made from a stale screen is refused, not merged) and is audited with what changed.

interface SettingsRow {
  enabled: boolean;
  ai_enabled: boolean;
  window_hours: number;
  message_limit: number;
  max_extension_hours: number;
  max_extra_messages: number;
  daily_start_cap: number;
  daily_message_cap: number;
  consultation_url: string | null;
  retention_days: number;
  blocked_email_domains: string[];
  version: number;
  updated_by: string | null;
  updated_at: Date;
}

export interface StoredDemoSettings {
  settings: DemoSettings;
  /** 0 until a Super Admin has saved once. */
  version: number;
  updatedAt: Date | null;
  updatedBy: string | null;
}

const fromRow = (r: SettingsRow): StoredDemoSettings => ({
  settings: {
    enabled: r.enabled,
    aiEnabled: r.ai_enabled,
    windowHours: r.window_hours,
    messageLimit: r.message_limit,
    maxExtensionHours: r.max_extension_hours,
    maxExtraMessages: r.max_extra_messages,
    dailyStartCap: r.daily_start_cap,
    dailyMessageCap: r.daily_message_cap,
    consultationUrl: r.consultation_url,
    retentionDays: r.retention_days,
    blockedEmailDomains: r.blocked_email_domains ?? [],
  },
  version: r.version,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

/** The settings in force: the saved row, or the defaults (everything off) when nobody has saved one. */
export async function readDemoSettings(db: Queryable): Promise<StoredDemoSettings> {
  const row = (await db.query<SettingsRow>("select * from demo_settings where id")).rows[0];
  return row ? fromRow(row) : { settings: { ...DEMO_DEFAULTS, blockedEmailDomains: [] }, version: 0, updatedAt: null, updatedBy: null };
}

export async function getDemoSettings(user: Pick<SessionUser, "id" | "platformRole">): Promise<StoredDemoSettings> {
  await assertProspectsAccess(user, "agency.prospects.view");
  return withSystem((db) => readDemoSettings(db));
}

const COLUMN: Record<keyof DemoSettings, string> = {
  enabled: "enabled",
  aiEnabled: "ai_enabled",
  windowHours: "window_hours",
  messageLimit: "message_limit",
  maxExtensionHours: "max_extension_hours",
  maxExtraMessages: "max_extra_messages",
  dailyStartCap: "daily_start_cap",
  dailyMessageCap: "daily_message_cap",
  consultationUrl: "consultation_url",
  retentionDays: "retention_days",
  blockedEmailDomains: "blocked_email_domains",
};

const CAST: Partial<Record<keyof DemoSettings, string>> = { blockedEmailDomains: "::text[]" };

export class SettingsInvalid extends AppError {
  readonly problems: SettingsProblems;
  constructor(problems: SettingsProblems) {
    super("invalid_input", Object.values(problems)[0] ?? "Those settings are not valid.");
    this.problems = problems;
  }
}

/**
 * Saves a change to the settings. `expectedVersion` is the version the person saw (0 when nothing was ever saved): a save made from an older screen is refused so one Super Admin
 * never undoes another's change without knowing. Changing a number never moves a prospect who already started: their window and message limit were copied when they confirmed.
 */
export async function saveDemoSettings(user: SessionUser, patchInput: unknown, expectedVersion: number): Promise<StoredDemoSettings> {
  await assertProspectsAccess(user, "agency.prospects.manage");
  const checked = checkSettingsPatch(patchInput);
  if (!checked.ok) throw new SettingsInvalid(checked.problems);
  const patch: DemoSettingsPatch = checked.value;
  const keys = Object.keys(patch) as Array<keyof DemoSettings>;
  if (!keys.length) throw new AppError("invalid_input", "Nothing was changed.");
  return withSystem(async (db) => {
    const current = await db.query<SettingsRow>("select * from demo_settings where id for update");
    const before = current.rows[0] ? fromRow(current.rows[0]) : null;
    if ((before?.version ?? 0) !== expectedVersion) throw new AppError("conflict", "The settings were changed by someone else. Reload the page and look again before saving.");
    const merged: DemoSettings = { ...(before?.settings ?? DEMO_DEFAULTS), ...patch };
    const changed = keys.filter((k) => JSON.stringify(merged[k]) !== JSON.stringify((before?.settings ?? DEMO_DEFAULTS)[k]));
    if (before && !changed.length) throw new AppError("invalid_input", "Nothing was changed.");
    const columns = Object.keys(COLUMN) as Array<keyof DemoSettings>;
    const values = columns.map((k) => merged[k]);
    if (before) {
      await db.query(
        `update demo_settings set ${columns.map((k, i) => `${COLUMN[k]} = $${i + 1}${CAST[k] ?? ""}`).join(", ")}, version = version + 1, updated_by = $${columns.length + 1} where id`,
        [...values, user.id],
      );
    } else {
      await db.query(
        `insert into demo_settings (${columns.map((k) => COLUMN[k]).join(", ")}, version, updated_by) values (${columns.map((k, i) => `$${i + 1}${CAST[k] ?? ""}`).join(", ")}, 1, $${columns.length + 1})`,
        [...values, user.id],
      );
    }
    // The values changed are recorded, except the list of blocked domains and the link, which are recorded by name only (they can be long, and are the Super Admin's own words).
    const detail: Record<string, unknown> = {};
    for (const k of changed) detail[k] = k === "blockedEmailDomains" ? `${merged.blockedEmailDomains.length} domains` : k === "consultationUrl" ? (merged.consultationUrl ? "set" : "cleared") : merged[k];
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: "demo.settings_saved", targetType: "demo_settings", result: "success", metadata: { changed: detail } }, db);
    return readDemoSettings(db);
  });
}
