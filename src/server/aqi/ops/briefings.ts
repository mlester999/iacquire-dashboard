import "server-only";
import { z } from "zod";
import { readSystem, withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyUser } from "@/server/notifications";
import { hasDbErrorCode, logSafeServerDiagnostic } from "@/server/diagnostics";
import { isQuietHours } from "@/lib/messaging";
import { composeBriefing, type Briefing } from "@/server/aqi/ops/briefing";
import { iso } from "@/server/aqi/ops/tools/helpers";

/**
 * Proactive briefings. Nothing is generated for an administrator who has not opted in. Daily and
 * weekly briefings run in the administrator's own time zone, are keyed per person and day so they
 * can never be duplicated, wait out quiet hours, and a quiet day is stored but not announced.
 * Critical alerts are event-triggered (one per person per incident) and ignore quiet hours.
 * Scheduled briefings run only when the external scheduler calls the tick endpoint.
 */

export interface BriefingSettings {
  dailyEnabled: boolean;
  weeklyEnabled: boolean;
  criticalAlertsEnabled: boolean;
  timezone: string;
  dailyHour: number;
  weeklyDay: number;
  quietStart: number | null;
  quietEnd: number | null;
  /** Whether the scheduler that makes scheduled briefings possible is configured in this deployment. */
  schedulerConfigured: boolean;
}

export const DEFAULT_BRIEFING_SETTINGS: Omit<BriefingSettings, "schedulerConfigured"> = {
  dailyEnabled: false, weeklyEnabled: false, criticalAlertsEnabled: false, timezone: "UTC", dailyHour: 8, weeklyDay: 1, quietStart: null, quietEnd: null,
};

export function validTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}

export const briefingSettingsSchema = z.object({
  dailyEnabled: z.boolean(),
  weeklyEnabled: z.boolean(),
  criticalAlertsEnabled: z.boolean(),
  timezone: z.string().trim().min(1).max(64).refine(validTimeZone, "Choose a valid time zone, for example Asia/Manila."),
  dailyHour: z.number().int().min(0).max(23),
  weeklyDay: z.number().int().min(0).max(6),
  quietStart: z.number().int().min(0).max(23).nullable(),
  quietEnd: z.number().int().min(0).max(23).nullable(),
}).strict().refine((v) => (v.quietStart === null) === (v.quietEnd === null), "Set both quiet-hours times, or neither.");

function assertSuperAdmin(user: { platformRole: string }) {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "AQi Operations is available to Super Admins only.");
}

interface SettingsRow {
  user_id: string; daily_enabled: boolean; weekly_enabled: boolean; critical_alerts_enabled: boolean; timezone: string; daily_hour: number; weekly_day: number;
  quiet_start: number | null; quiet_end: number | null; last_daily_for: string | null; last_weekly_for: string | null;
}

export async function getBriefingSettings(user: { id: string; platformRole: string }, schedulerConfigured: boolean): Promise<BriefingSettings> {
  assertSuperAdmin(user);
  const { rows } = await readSystem((db) => db.query<SettingsRow>("select * from aqi_ops_briefing_settings where user_id = $1", [user.id]));
  const r = rows[0];
  return r
    ? { dailyEnabled: r.daily_enabled, weeklyEnabled: r.weekly_enabled, criticalAlertsEnabled: r.critical_alerts_enabled, timezone: r.timezone, dailyHour: r.daily_hour, weeklyDay: r.weekly_day, quietStart: r.quiet_start, quietEnd: r.quiet_end, schedulerConfigured }
    : { ...DEFAULT_BRIEFING_SETTINGS, schedulerConfigured };
}

export async function saveBriefingSettings(user: { id: string; platformRole: string }, raw: unknown, schedulerConfigured: boolean): Promise<BriefingSettings> {
  assertSuperAdmin(user);
  const parsed = briefingSettingsSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Check the briefing settings.");
  const v = parsed.data;
  await withSystem(async (db) => {
    await db.query(
      `insert into aqi_ops_briefing_settings (user_id, daily_enabled, weekly_enabled, critical_alerts_enabled, timezone, daily_hour, weekly_day, quiet_start, quiet_end)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (user_id) do update set daily_enabled = excluded.daily_enabled, weekly_enabled = excluded.weekly_enabled, critical_alerts_enabled = excluded.critical_alerts_enabled,
         timezone = excluded.timezone, daily_hour = excluded.daily_hour, weekly_day = excluded.weekly_day, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end`,
      [user.id, v.dailyEnabled, v.weeklyEnabled, v.criticalAlertsEnabled, v.timezone, v.dailyHour, v.weeklyDay, v.quietStart, v.quietEnd],
    );
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: "aqi.ops_briefing_settings_changed", targetType: "user", targetId: user.id, result: "success", metadata: { daily: v.dailyEnabled, weekly: v.weeklyEnabled, critical: v.criticalAlertsEnabled, timezone: v.timezone } }, db);
  });
  return { ...v, schedulerConfigured };
}

export interface BriefingSummary { id: string; kind: string; title: string; summary: string; status: string; suppressedReason: string | null; periodStart: string; periodEnd: string; createdAt: string }

export async function listBriefings(user: { id: string; platformRole: string }, limit = 8): Promise<BriefingSummary[]> {
  assertSuperAdmin(user);
  const { rows } = await readSystem((db) => db.query<{ id: string; kind: string; title: string; summary: string; status: string; suppressed_reason: string | null; period_start: Date; period_end: Date; created_at: Date }>(
    "select id, kind, title, summary, status, suppressed_reason, period_start, period_end, created_at from aqi_ops_briefings where recipient_user_id = $1 order by created_at desc limit $2",
    [user.id, Math.min(20, Math.max(1, limit))],
  ));
  return rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, summary: r.summary, status: r.status, suppressedReason: r.suppressed_reason, periodStart: iso(r.period_start)!, periodEnd: iso(r.period_end)!, createdAt: iso(r.created_at)! }));
}

export async function getBriefing(user: { id: string; platformRole: string }, id: string): Promise<Briefing & { id: string; status: string }> {
  assertSuperAdmin(user);
  const { rows } = await readSystem((db) => db.query<{ id: string; title: string; summary: string; sections: Briefing["sections"]; sources: string[]; period_start: Date; period_end: Date; created_at: Date; status: string }>(
    "select id, title, summary, sections, sources, period_start, period_end, created_at, status from aqi_ops_briefings where id = $1 and recipient_user_id = $2",
    [id, user.id],
  ));
  const r = rows[0];
  if (!r) throw new AppError("not_found", "Briefing not found.");
  const hours = Math.round((new Date(r.period_end).getTime() - new Date(r.period_start).getTime()) / 3_600_000);
  const all = Array.isArray(r.sections) ? r.sections : [];
  const sections = all.filter((s) => s.key !== "recommended");
  return {
    id: r.id, status: r.status, title: r.title, summary: r.summary, sections, sources: r.sources ?? [], generatedAt: iso(r.created_at)!,
    period: { from: iso(r.period_start)!, to: iso(r.period_end)!, hours }, recommended: all.find((s) => s.key === "recommended")?.items ?? [],
    noteworthy: sections.some((s) => s.state === "degraded" || s.state === "unavailable"),
  };
}

async function store(userId: string, briefing: Briefing, kind: "daily" | "weekly" | "critical" | "on_demand", dedupeKey: string, status: "generated" | "suppressed", reason: string | null): Promise<{ id: string } | null> {
  // The recommended steps are kept as the final section so one column holds the whole briefing.
  const sections = briefing.recommended.length ? [...briefing.sections, { key: "recommended", title: "Recommended next steps", state: "healthy" as const, items: briefing.recommended }] : briefing.sections;
  const { rows } = await withSystem((db) => db.query<{ id: string }>(
    `insert into aqi_ops_briefings (recipient_user_id, kind, period_start, period_end, dedupe_key, title, summary, sections, sources, status, suppressed_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11) on conflict (dedupe_key) do nothing returning id`,
    [userId, kind, briefing.period.from, briefing.period.to, dedupeKey, briefing.title.slice(0, 200), briefing.summary.slice(0, 2000), JSON.stringify(sections), JSON.stringify(briefing.sources), status, reason],
  ));
  return rows[0] ?? null;
}

async function deliver(userId: string, id: string, briefing: Briefing, severity: "info" | "warning" | "critical", dedupeKey: string): Promise<void> {
  await withSystem(async (db) => {
    await notifyUser(db, userId, null, { kind: "system", severity, title: briefing.title, body: briefing.summary, link: `/admin/operations?briefing=${id}`, dedupeKey });
    await db.query("update aqi_ops_briefings set status = 'delivered', delivered_at = now() where id = $1", [id]);
  });
}

/** On demand: composed and stored for the requesting administrator, never announced by notification. */
export async function generateBriefingNow(user: { id: string; platformRole: string }, hours = 24): Promise<{ id: string; briefing: Briefing }> {
  assertSuperAdmin(user);
  const now = new Date();
  const briefing = await composeBriefing({ userId: user.id, now, hours, kind: "on_demand" });
  const stored = await store(user.id, briefing, "on_demand", `ondemand:${user.id}:${now.getTime()}`, "generated", null);
  if (!stored) throw new AppError("conflict", "A briefing was just generated. Try again in a moment.");
  return { id: stored.id, briefing };
}

function localParts(now: Date, timeZone: string): { date: string; hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24, weekday };
}

const pad = (n: number) => `${String(n).padStart(2, "0")}:00`;

export interface BriefingRunResult { generated: number; suppressed: number; alerts: number; deferred: number; failed: number }

/**
 * The scheduler entry point. Bounded: at most five administrators per run, and each briefing is
 * composed once per person per local day (or ISO week) through a unique key, so overlapping ticks or
 * a retry can never send twice.
 */
export async function runDueBriefings(now = new Date()): Promise<BriefingRunResult> {
  const result: BriefingRunResult = { generated: 0, suppressed: 0, alerts: 0, deferred: 0, failed: 0 };
  let rows: SettingsRow[];
  try {
    rows = (await readSystem((db) => db.query<SettingsRow>(
      `select s.* from aqi_ops_briefing_settings s join users u on u.id = s.user_id and u.status = 'active' and u.platform_role = 'agency_super_admin'
        where s.daily_enabled or s.weekly_enabled or s.critical_alerts_enabled order by s.user_id limit 5`,
    ))).rows;
  } catch (err) {
    // The code can be deployed before migration 0068 is applied; until then there is nothing to run, and that is not a job failure.
    if (hasDbErrorCode(err, "42P01")) return result;
    throw err;
  }
  for (const s of rows) {
    try {
      const local = localParts(now, s.timezone);
      const quiet = s.quiet_start !== null && s.quiet_end !== null && isQuietHours(pad(s.quiet_start), pad(s.quiet_end), now, s.timezone);

      if (s.critical_alerts_enabled) {
        const { rows: crit } = await readSystem((db) => db.query<{ id: string; title: string }>(
          "select id, title from incidents where status = 'open' and severity = 'critical' and detected_at > now() - interval '24 hours' order by detected_at desc limit 3",
        ));
        for (const incident of crit) {
          const key = `critical:${s.user_id}:${incident.id}`;
          const exists = await readSystem((db) => db.query("select 1 from aqi_ops_briefings where dedupe_key = $1", [key]));
          if (exists.rows[0]) continue;
          const briefing = await composeBriefing({ userId: s.user_id, now, hours: 6, kind: "critical" });
          briefing.title = `Critical alert: ${incident.title.slice(0, 120)}`;
          const stored = await store(s.user_id, briefing, "critical", key, "generated", null);
          if (stored) { await deliver(s.user_id, stored.id, briefing, "critical", key); result.alerts += 1; }
        }
      }

      if (s.daily_enabled && local.hour >= s.daily_hour && s.last_daily_for !== local.date) {
        if (quiet) { result.deferred += 1; }
        else {
          const key = `daily:${s.user_id}:${local.date}`;
          const briefing = await composeBriefing({ userId: s.user_id, now, hours: 24, kind: "daily" });
          const stored = await store(s.user_id, briefing, "daily", key, briefing.noteworthy ? "generated" : "suppressed", briefing.noteworthy ? null : "nothing_noteworthy");
          await withSystem((db) => db.query("update aqi_ops_briefing_settings set last_daily_for = $2 where user_id = $1", [s.user_id, local.date]));
          if (stored && briefing.noteworthy) { await deliver(s.user_id, stored.id, briefing, "warning", key); result.generated += 1; }
          else if (stored) result.suppressed += 1;
        }
      }

      if (s.weekly_enabled && local.weekday === s.weekly_day && local.hour >= s.daily_hour && s.last_weekly_for !== local.date) {
        if (quiet) { result.deferred += 1; }
        else {
          const key = `weekly:${s.user_id}:${local.date}`;
          const briefing = await composeBriefing({ userId: s.user_id, now, hours: 168, kind: "weekly" });
          const stored = await store(s.user_id, briefing, "weekly", key, "generated", null);
          await withSystem((db) => db.query("update aqi_ops_briefing_settings set last_weekly_for = $2 where user_id = $1", [s.user_id, local.date]));
          if (stored) { await deliver(s.user_id, stored.id, briefing, briefing.noteworthy ? "warning" : "info", key); result.generated += 1; }
        }
      }
    } catch (err) {
      result.failed += 1;
      logSafeServerDiagnostic("aqi.ops_briefing_failed", err, "aqi.ops.briefings");
    }
  }
  return result;
}
