import "server-only";
import { z } from "zod";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/service";
import {
  DEFAULT_BUSINESS_HOURS, DEFAULT_MAX_ATTACHMENT_MB, DEFAULT_MAX_ATTACHMENTS, DELIVERY_MODES, PRIORITIES, REQUEST_TYPES, SUPPORT_EVENTS, SUPPORT_EVENT_INFO,
  type BusinessHours, type DeliveryMode, type RequestType, type SupportEvent, type TicketPriority,
} from "@/lib/support/lifecycle";
import { describeTarget, isValidTimeZone, normalizeBusinessHours, normalizeHolidays, normalizeTargets, targetFor, type ScheduleConfig, type TargetMinutes } from "@/lib/support/sla";
import { assertAgencySupportPermission } from "@/server/support/access";

export interface SupportSettings {
  timezone: string;
  businessHours: BusinessHours;
  holidays: string[];
  targetsEnabled: boolean;
  showTargetsToClients: boolean;
  businessHoursOnly: boolean;
  firstResponseMinutes: TargetMinutes;
  followUpMinutes: TargetMinutes;
  approachingPercent: number;
  overdueEscalationMinutes: number | null;
  reopenWindowDays: number;
  autoCloseResolvedDays: number | null;
  maxAttachmentMb: number;
  maxAttachmentsPerMessage: number;
  stagedUploadTtlHours: number;
  attachmentRetentionDays: number | null;
  defaultPriority: Record<RequestType, TicketPriority>;
  aiAssistEnabled: boolean;
  revision: number;
  updatedAt: string | null;
}

interface SettingsRow {
  timezone: string;
  business_hours: BusinessHours;
  holidays: string[];
  targets_enabled: boolean;
  show_targets_to_clients: boolean;
  business_hours_only: boolean;
  first_response_minutes: TargetMinutes;
  follow_up_minutes: TargetMinutes;
  approaching_percent: number;
  overdue_escalation_minutes: number | null;
  reopen_window_days: number;
  auto_close_resolved_days: number | null;
  max_attachment_mb: number;
  max_attachments_per_message: number;
  staged_upload_ttl_hours: number;
  attachment_retention_days: number | null;
  default_priority: Record<string, string>;
  ai_assist_enabled: boolean;
  revision: number;
  updated_at: Date | null;
}

export const DEFAULT_SUPPORT_SETTINGS: SupportSettings = {
  timezone: "UTC",
  businessHours: DEFAULT_BUSINESS_HOURS,
  holidays: [],
  targetsEnabled: false,
  showTargetsToClients: false,
  businessHoursOnly: true,
  firstResponseMinutes: {},
  followUpMinutes: {},
  approachingPercent: 80,
  overdueEscalationMinutes: null,
  reopenWindowDays: 14,
  autoCloseResolvedDays: null,
  maxAttachmentMb: DEFAULT_MAX_ATTACHMENT_MB,
  maxAttachmentsPerMessage: DEFAULT_MAX_ATTACHMENTS,
  stagedUploadTtlHours: 24,
  attachmentRetentionDays: null,
  defaultPriority: { support: "normal", issue: "normal", feedback: "low" },
  aiAssistEnabled: true,
  revision: 0,
  updatedAt: null,
};

const asPriority = (v: unknown, fallback: TicketPriority): TicketPriority => ((PRIORITIES as readonly string[]).includes(v as string) ? (v as TicketPriority) : fallback);

function fromRow(r: SettingsRow): SupportSettings {
  const d = DEFAULT_SUPPORT_SETTINGS.defaultPriority;
  return {
    timezone: isValidTimeZone(r.timezone) ? r.timezone : "UTC",
    businessHours: r.business_hours ?? {},
    holidays: Array.isArray(r.holidays) ? r.holidays : [],
    targetsEnabled: r.targets_enabled,
    showTargetsToClients: r.show_targets_to_clients,
    businessHoursOnly: r.business_hours_only,
    firstResponseMinutes: r.first_response_minutes ?? {},
    followUpMinutes: r.follow_up_minutes ?? {},
    approachingPercent: r.approaching_percent,
    overdueEscalationMinutes: r.overdue_escalation_minutes,
    reopenWindowDays: r.reopen_window_days,
    autoCloseResolvedDays: r.auto_close_resolved_days,
    maxAttachmentMb: r.max_attachment_mb,
    maxAttachmentsPerMessage: r.max_attachments_per_message,
    stagedUploadTtlHours: r.staged_upload_ttl_hours,
    attachmentRetentionDays: r.attachment_retention_days,
    defaultPriority: { support: asPriority(r.default_priority?.support, d.support), issue: asPriority(r.default_priority?.issue, d.issue), feedback: asPriority(r.default_priority?.feedback, d.feedback) },
    aiAssistEnabled: r.ai_assist_enabled,
    revision: r.revision,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

let cached: { at: number; value: SupportSettings } | null = null;
const TTL_MS = 5_000;
export function invalidateSupportSettings() {
  cached = null;
}

/** The agency-wide support configuration. Read on every request action, so it is cached for a few seconds and cleared on every change. */
export async function loadSupportSettings(db?: Queryable): Promise<SupportSettings> {
  if (!db && cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const run = async (q: Queryable) => (await q.query<SettingsRow>("select * from support_settings where id")).rows[0];
  const row = db ? await run(db) : await withSystem(run);
  const value = row ? fromRow(row) : DEFAULT_SUPPORT_SETTINGS;
  if (!db) cached = { at: Date.now(), value };
  return value;
}

export function scheduleOf(s: SupportSettings): ScheduleConfig {
  return { timezone: s.timezone, hours: s.businessHours, holidays: s.holidays, businessHoursOnly: s.businessHoursOnly };
}

/** Minutes for the next response of a request, or null when response targets are off or none is set for that priority. */
export function responseTargetMinutes(s: SupportSettings, kind: "first" | "follow_up", priority: string): number | null {
  if (!s.targetsEnabled) return null;
  return targetFor(kind === "first" ? s.firstResponseMinutes : s.followUpMinutes, priority);
}

/**
 * The sentence a client may be shown about response times, or null. It exists only when the Super Admin turned targets on, chose to
 * show them to clients, and configured a target for this priority: nothing is invented, and an acknowledgement is never worded as a reply.
 */
export function clientExpectationText(s: SupportSettings, kind: "first" | "follow_up", priority: string): string | null {
  if (!s.targetsEnabled || !s.showTargetsToClients) return null;
  const minutes = targetFor(kind === "first" ? s.firstResponseMinutes : s.followUpMinutes, priority);
  if (!minutes) return null;
  return `We aim to reply ${describeTarget(minutes, scheduleOf(s))}.`;
}

// ---------------------------------------------------------------------------
// Updating the settings (Super Admin)
// ---------------------------------------------------------------------------

const minutesField = z.union([z.record(z.string(), z.union([z.number(), z.null()]))]);

export const supportSettingsPatchSchema = z.object({
  timezone: z.string().trim().min(1).max(64).refine(isValidTimeZone, "Choose a valid time zone.").optional(),
  businessHours: z.unknown().optional(),
  holidays: z.unknown().optional(),
  targetsEnabled: z.boolean().optional(),
  showTargetsToClients: z.boolean().optional(),
  businessHoursOnly: z.boolean().optional(),
  firstResponseMinutes: minutesField.optional(),
  followUpMinutes: minutesField.optional(),
  approachingPercent: z.number().int().min(50).max(95).optional(),
  overdueEscalationMinutes: z.number().int().min(1).max(43200).nullable().optional(),
  reopenWindowDays: z.number().int().min(0).max(365).optional(),
  autoCloseResolvedDays: z.number().int().min(1).max(90).nullable().optional(),
  maxAttachmentMb: z.number().int().min(1).max(10).optional(),
  maxAttachmentsPerMessage: z.number().int().min(1).max(10).optional(),
  stagedUploadTtlHours: z.number().int().min(1).max(168).optional(),
  attachmentRetentionDays: z.number().int().min(30).max(3650).nullable().optional(),
  defaultPriority: z.record(z.string(), z.string()).optional(),
  aiAssistEnabled: z.boolean().optional(),
});
export type SupportSettingsPatch = z.input<typeof supportSettingsPatchSchema>;

/** Super Admin only. `expectedRevision` makes two people editing at once safe: the second save is refused instead of overwriting. */
export async function updateSupportSettings(user: SessionUser, patch: SupportSettingsPatch, expectedRevision: number): Promise<SupportSettings> {
  await assertAgencySupportPermission(user, null, "agency.support.settings");
  const parsed = supportSettingsPatchSchema.safeParse(patch);
  if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Check the settings and try again.");
  const p = parsed.data;
  const sets: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown, cast = "") => {
    values.push(value);
    sets.push(`${column} = $${values.length}${cast}`);
  };
  if (p.timezone !== undefined) add("timezone", p.timezone);
  if (p.businessHours !== undefined) {
    const n = normalizeBusinessHours(p.businessHours);
    if (!n.ok) throw new AppError("invalid_input", n.error);
    add("business_hours", JSON.stringify(n.hours), "::jsonb");
  }
  if (p.holidays !== undefined) {
    const n = normalizeHolidays(p.holidays);
    if (!n.ok) throw new AppError("invalid_input", n.error);
    add("holidays", JSON.stringify(n.holidays), "::jsonb");
  }
  for (const [key, column] of [["firstResponseMinutes", "first_response_minutes"], ["followUpMinutes", "follow_up_minutes"]] as const) {
    if (p[key] === undefined) continue;
    const n = normalizeTargets(p[key]);
    if (!n.ok) throw new AppError("invalid_input", n.error);
    add(column, JSON.stringify(n.targets), "::jsonb");
  }
  if (p.defaultPriority !== undefined) {
    const out: Record<string, string> = {};
    for (const type of REQUEST_TYPES) {
      const v = p.defaultPriority[type];
      if (v !== undefined) {
        if (!(PRIORITIES as readonly string[]).includes(v)) throw new AppError("invalid_input", "Choose a valid default priority.");
        out[type] = v;
      }
    }
    const current = await loadSupportSettings();
    add("default_priority", JSON.stringify({ ...current.defaultPriority, ...out }), "::jsonb");
  }
  const simple: Array<[keyof typeof p, string]> = [
    ["targetsEnabled", "targets_enabled"], ["showTargetsToClients", "show_targets_to_clients"], ["businessHoursOnly", "business_hours_only"],
    ["approachingPercent", "approaching_percent"], ["overdueEscalationMinutes", "overdue_escalation_minutes"], ["reopenWindowDays", "reopen_window_days"],
    ["autoCloseResolvedDays", "auto_close_resolved_days"], ["maxAttachmentMb", "max_attachment_mb"], ["maxAttachmentsPerMessage", "max_attachments_per_message"],
    ["stagedUploadTtlHours", "staged_upload_ttl_hours"], ["attachmentRetentionDays", "attachment_retention_days"], ["aiAssistEnabled", "ai_assist_enabled"],
  ];
  for (const [key, column] of simple) if (p[key] !== undefined) add(column, p[key]);
  if (!sets.length) return loadSupportSettings();
  const changed = [...simple.filter(([k]) => p[k] !== undefined).map(([k]) => k), ...(["timezone", "businessHours", "holidays", "firstResponseMinutes", "followUpMinutes", "defaultPriority"] as const).filter((k) => p[k] !== undefined)];

  const next = await withSystem(async (db) => {
    values.push(user.id, expectedRevision);
    const res = await db.query<SettingsRow>(
      `update support_settings set ${sets.join(", ")}, revision = revision + 1, updated_by = $${values.length - 1}, updated_at = now()
       where id and revision = $${values.length} returning *`,
      values,
    );
    if (!res.rows[0]) throw new AppError("conflict", "Someone else changed these settings. Reload to see their changes, then try again.");
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: "support.settings_updated", targetType: "support_settings", targetId: "singleton", result: "success", metadata: { fields: changed } }, db);
    return fromRow(res.rows[0]);
  });
  invalidateSupportSettings();
  return next;
}

// ---------------------------------------------------------------------------
// Notification rules
// ---------------------------------------------------------------------------

export interface NotificationRule { event: SupportEvent; mode: DeliveryMode; updatedAt: string | null }

export async function loadNotificationModes(db?: Queryable): Promise<Record<SupportEvent, DeliveryMode>> {
  const run = async (q: Queryable) => (await q.query<{ event_kind: SupportEvent; mode: DeliveryMode }>("select event_kind, mode from support_notification_rules")).rows;
  const rows = db ? await run(db) : await withSystem(run);
  const out = Object.fromEntries(SUPPORT_EVENTS.map((e) => [e, SUPPORT_EVENT_INFO[e].defaultMode])) as Record<SupportEvent, DeliveryMode>;
  for (const r of rows) if ((SUPPORT_EVENTS as readonly string[]).includes(r.event_kind) && (DELIVERY_MODES as readonly string[]).includes(r.mode)) out[r.event_kind] = r.mode;
  return out;
}

export async function listNotificationRules(user: SessionUser): Promise<NotificationRule[]> {
  await assertAgencySupportPermission(user, null, "agency.support.view");
  const rows = await withUser(user.id, async (db) => (await db.query<{ event_kind: SupportEvent; mode: DeliveryMode; updated_at: Date }>("select event_kind, mode, updated_at from support_notification_rules")).rows);
  const by = new Map(rows.map((r) => [r.event_kind, r]));
  return SUPPORT_EVENTS.map((event) => {
    const r = by.get(event);
    return { event, mode: r?.mode ?? SUPPORT_EVENT_INFO[event].defaultMode, updatedAt: r ? new Date(r.updated_at).toISOString() : null };
  });
}

export async function setNotificationRule(user: SessionUser, event: string, mode: string): Promise<void> {
  await assertAgencySupportPermission(user, null, "agency.support.settings");
  if (!(SUPPORT_EVENTS as readonly string[]).includes(event)) throw new AppError("invalid_input", "Unknown notification event.");
  if (!(DELIVERY_MODES as readonly string[]).includes(mode)) throw new AppError("invalid_input", "Choose in-app, email, both or off.");
  await withSystem(async (db) => {
    const before = await db.query<{ mode: string }>("select mode from support_notification_rules where event_kind = $1", [event]);
    await db.query(
      `insert into support_notification_rules (event_kind, mode, updated_by, updated_at) values ($1, $2, $3, now())
       on conflict (event_kind) do update set mode = excluded.mode, updated_by = excluded.updated_by, updated_at = now()`,
      [event, mode, user.id],
    );
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: "support.notification_rule_updated", targetType: "support_notification_rule", targetId: event, result: "success", metadata: { from: before.rows[0]?.mode ?? SUPPORT_EVENT_INFO[event as SupportEvent].defaultMode, to: mode } }, db);
  });
}
