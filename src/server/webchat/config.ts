import "server-only";
import crypto from "node:crypto";
import { z } from "zod";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { OrgContext } from "@/server/tenancy/context";
import {
  KNOWLEDGE_SECTION_KEYS, LEAD_FORM_MODES, OFFLINE_BEHAVIORS, WIDGET_AI_ROLES, WIDGET_POSITIONS,
  installState, normalizeAllowedHosts, validateQualificationQuestions,
  type InstallState, type KnowledgeSectionKey, type QualificationQuestion,
} from "@/lib/webchat/rules";

export interface WidgetSettings {
  orgId: string;
  publicKey: string;
  enabled: boolean;
  allowedOrigins: string[];
  autoInstallSites: boolean;
  title: string;
  welcomeMessage: string;
  offlineMessage: string;
  brandColor: string;
  position: (typeof WIDGET_POSITIONS)[number];
  launcherLabel: string;
  leadForm: (typeof LEAD_FORM_MODES)[number];
  privacyNotice: string;
  privacyUrl: string | null;
  offerMarketingOptIn: boolean;
  aiEnabled: boolean;
  aiRoleKey: (typeof WIDGET_AI_ROLES)[number];
  offlineBehavior: (typeof OFFLINE_BEHAVIORS)[number];
  knowledgeSections: KnowledgeSectionKey[];
  allowBooking: boolean;
  qualificationQuestions: QualificationQuestion[];
  dailySessionLimit: number;
  sessionMessageLimit: number;
  retentionDays: number;
  anonymousRetentionDays: number;
  lastSeenAt: Date | null;
  lastSeenOrigin: string | null;
  version: number;
}

type Row = {
  org_id: string; public_key: string; enabled: boolean; allowed_origins: string[]; auto_install_sites: boolean; title: string; welcome_message: string; offline_message: string;
  brand_color: string; position: WidgetSettings["position"]; launcher_label: string; lead_form: WidgetSettings["leadForm"]; privacy_notice: string; privacy_url: string | null;
  offer_marketing_opt_in: boolean; ai_enabled: boolean; ai_role_key: WidgetSettings["aiRoleKey"]; offline_behavior: WidgetSettings["offlineBehavior"]; knowledge_sections: string[];
  allow_booking: boolean; qualification_questions: unknown; daily_session_limit: number; session_message_limit: number; retention_days: number; anonymous_retention_days: number;
  last_seen_at: Date | null; last_seen_origin: string | null; version: number;
};

export const WIDGET_COLUMNS = `org_id, public_key, enabled, allowed_origins, auto_install_sites, title, welcome_message, offline_message, brand_color, position, launcher_label, lead_form,
  privacy_notice, privacy_url, offer_marketing_opt_in, ai_enabled, ai_role_key, offline_behavior, knowledge_sections, allow_booking, qualification_questions, daily_session_limit,
  session_message_limit, retention_days, anonymous_retention_days, last_seen_at, last_seen_origin, version`;

function map(r: Row): WidgetSettings {
  const questions = validateQualificationQuestions(r.qualification_questions);
  return {
    orgId: r.org_id, publicKey: r.public_key, enabled: r.enabled, allowedOrigins: r.allowed_origins, autoInstallSites: r.auto_install_sites, title: r.title, welcomeMessage: r.welcome_message,
    offlineMessage: r.offline_message, brandColor: r.brand_color, position: r.position, launcherLabel: r.launcher_label, leadForm: r.lead_form, privacyNotice: r.privacy_notice,
    privacyUrl: r.privacy_url, offerMarketingOptIn: r.offer_marketing_opt_in, aiEnabled: r.ai_enabled, aiRoleKey: r.ai_role_key, offlineBehavior: r.offline_behavior,
    knowledgeSections: r.knowledge_sections.filter((s): s is KnowledgeSectionKey => (KNOWLEDGE_SECTION_KEYS as readonly string[]).includes(s)),
    allowBooking: r.allow_booking, qualificationQuestions: questions.ok ? questions.questions : [], dailySessionLimit: r.daily_session_limit, sessionMessageLimit: r.session_message_limit,
    retentionDays: r.retention_days, anonymousRetentionDays: r.anonymous_retention_days, lastSeenAt: r.last_seen_at, lastSeenOrigin: r.last_seen_origin, version: r.version,
  };
}

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** A public widget key: "wk_" and 24 characters drawn uniformly (rejection sampling, no modulo bias). Not a secret. */
export function newPublicKey(): string {
  let out = "";
  while (out.length < 24) {
    for (const b of crypto.randomBytes(48)) {
      if (b < 248 && out.length < 24) out += BASE62[b % 62];
    }
  }
  return `wk_${out}`;
}

/** The widget row for a workspace, created with safe defaults (off, no sites) the first time it is needed. */
export async function ensureWidget(db: Queryable, orgId: string): Promise<WidgetSettings> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const found = await db.query<Row>(`select ${WIDGET_COLUMNS} from web_chat_widgets where org_id = $1`, [orgId]);
    if (found.rows[0]) return map(found.rows[0]);
    // A key collision (astronomically unlikely) or a concurrent create both end in a retry that reads the row.
    await db.query("insert into web_chat_widgets (org_id, public_key) values ($1, $2) on conflict do nothing", [orgId, newPublicKey()]).catch(() => undefined);
  }
  throw new AppError("conflict", "The chat widget could not be set up. Try again.");
}

export async function getWidgetByKey(db: Queryable, key: string): Promise<WidgetSettings | null> {
  const { rows } = await db.query<Row>(`select ${WIDGET_COLUMNS} from web_chat_widgets where public_key = $1`, [key]);
  return rows[0] ? map(rows[0]) : null;
}

export async function getWidgetByOrg(db: Queryable, orgId: string): Promise<WidgetSettings | null> {
  const { rows } = await db.query<Row>(`select ${WIDGET_COLUMNS} from web_chat_widgets where org_id = $1`, [orgId]);
  return rows[0] ? map(rows[0]) : null;
}

/** The hosts of this workspace's own Website Studio sites (their addresses, verified or not: a visitor can only reach a published one). */
export async function siteHostsFor(db: Queryable, orgId: string): Promise<string[]> {
  const { rows } = await db.query<{ hostname: string }>("select hostname from website_domains where org_id = $1 and removed_at is null", [orgId]);
  return rows.map((r) => r.hostname.toLowerCase());
}

export interface WidgetView {
  settings: WidgetSettings;
  siteHosts: string[];
  install: { state: InstallState; autoInstalledSites: number };
  canEdit: boolean;
  /** Why the chat cannot work for this workspace at all (for example the CRM is owned by another system), or null. */
  unavailableReason: string | null;
}

/** What the settings screen shows. Reading needs website access; a person who can edit gets the row created on first look. */
export async function readWidgetView(ctx: OrgContext): Promise<WidgetView> {
  if (!ctx.can("website.view")) throw new AppError("forbidden", "You don't have access to the website.");
  const canEdit = ctx.can("website.edit");
  const view = await withSystem(async (db) => {
    const settings = canEdit ? await ensureWidget(db, ctx.org.orgId) : await getWidgetByOrg(db, ctx.org.orgId);
    const siteHosts = await siteHostsFor(db, ctx.org.orgId);
    return { settings, siteHosts };
  });
  if (!view.settings) {
    // A viewer who cannot edit and a workspace that never opened this screen: nothing is configured, and nothing is created on their behalf.
    throw new AppError("not_found", "Website chat has not been set up yet. Ask a team member who can edit the website to open this page.");
  }
  const autoInstalledSites = view.settings.autoInstallSites ? view.siteHosts.length : 0;
  return {
    settings: view.settings,
    siteHosts: view.siteHosts,
    install: { state: installState({ enabled: view.settings.enabled, allowedHostCount: view.settings.allowedOrigins.length, autoInstalledSites, lastSeenAt: view.settings.lastSeenAt }), autoInstalledSites },
    canEdit,
    unavailableReason: null,
  };
}

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #2563eb.");
const line = (min: number, max: number, what: string) => z.string().transform((s) => s.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim()).pipe(z.string().min(min, `${what} is required.`).max(max, `${what} is too long.`));
const block = (min: number, max: number, what: string) => z.string().transform((s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim()).pipe(z.string().min(min, `${what} is required.`).max(max, `${what} is too long.`));

const PatchSchema = z.object({
  enabled: z.boolean(),
  allowedOrigins: z.array(z.string().max(300)).max(40),
  autoInstallSites: z.boolean(),
  title: line(1, 60, "The title"),
  welcomeMessage: block(1, 300, "The welcome message"),
  offlineMessage: block(1, 300, "The offline message"),
  brandColor: hex,
  position: z.enum(WIDGET_POSITIONS),
  launcherLabel: line(1, 24, "The button label"),
  leadForm: z.enum(LEAD_FORM_MODES),
  privacyNotice: block(1, 600, "The privacy notice"),
  privacyUrl: z.string().max(300).nullable(),
  offerMarketingOptIn: z.boolean(),
  aiEnabled: z.boolean(),
  aiRoleKey: z.enum(WIDGET_AI_ROLES),
  offlineBehavior: z.enum(OFFLINE_BEHAVIORS),
  knowledgeSections: z.array(z.enum(KNOWLEDGE_SECTION_KEYS)).max(KNOWLEDGE_SECTION_KEYS.length),
  allowBooking: z.boolean(),
  qualificationQuestions: z.array(z.unknown()).max(3),
  dailySessionLimit: z.number().int().min(1).max(5000),
  sessionMessageLimit: z.number().int().min(5).max(300),
  retentionDays: z.number().int().min(7).max(730),
  anonymousRetentionDays: z.number().int().min(1).max(365),
}).partial();

export type WidgetPatch = z.input<typeof PatchSchema>;

/**
 * Saves the widget's settings. The caller names the version they started from (a stale save is refused, so two people cannot silently overwrite each
 * other). Switching the widget on needs at least one allowed website or an installed Website Studio site, so it can never be on with nowhere to run.
 */
export async function saveWidgetSettings(ctx: OrgContext, rawPatch: WidgetPatch, expectedVersion: number): Promise<WidgetSettings> {
  if (!ctx.can("website.edit")) throw new AppError("forbidden", "Your role can't change the website chat.");
  const parsed = PatchSchema.safeParse(rawPatch);
  if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Those settings are not valid.");
  const p = parsed.data;
  const sets: string[] = [];
  const params: unknown[] = [ctx.org.orgId];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (p.allowedOrigins !== undefined) {
    const hosts = normalizeAllowedHosts(p.allowedOrigins);
    if (!hosts.ok) throw new AppError("invalid_input", hosts.error);
    set("allowed_origins", hosts.hosts);
  }
  if (p.privacyUrl !== undefined) {
    const url = p.privacyUrl?.trim() || null;
    if (url && !/^https:\/\/[^\s]+$/.test(url)) throw new AppError("invalid_input", "The privacy page address must start with https://.");
    set("privacy_url", url);
  }
  if (p.qualificationQuestions !== undefined) {
    const q = validateQualificationQuestions(p.qualificationQuestions);
    if (!q.ok) throw new AppError("invalid_input", q.error);
    set("qualification_questions", JSON.stringify(q.questions));
  }
  if (p.knowledgeSections !== undefined) set("knowledge_sections", [...new Set(p.knowledgeSections)]);
  const simple: Array<[keyof typeof p, string]> = [
    ["enabled", "enabled"], ["autoInstallSites", "auto_install_sites"], ["title", "title"], ["welcomeMessage", "welcome_message"], ["offlineMessage", "offline_message"], ["brandColor", "brand_color"],
    ["position", "position"], ["launcherLabel", "launcher_label"], ["leadForm", "lead_form"], ["privacyNotice", "privacy_notice"], ["offerMarketingOptIn", "offer_marketing_opt_in"],
    ["aiEnabled", "ai_enabled"], ["aiRoleKey", "ai_role_key"], ["offlineBehavior", "offline_behavior"], ["allowBooking", "allow_booking"], ["dailySessionLimit", "daily_session_limit"],
    ["sessionMessageLimit", "session_message_limit"], ["retentionDays", "retention_days"], ["anonymousRetentionDays", "anonymous_retention_days"],
  ];
  for (const [key, column] of simple) if (p[key] !== undefined) set(column, p[key]);
  if (!sets.length) throw new AppError("invalid_input", "Nothing to save.");

  return withSystem(async (db) => {
    const current = await ensureWidget(db, ctx.org.orgId);
    if (current.version !== expectedVersion) throw new AppError("conflict", "Someone else changed these settings. Reload to see their changes, then try again.");
    const switchingOn = p.enabled === true && !current.enabled;
    if (switchingOn) {
      const hostCount = p.allowedOrigins !== undefined ? (normalizeAllowedHosts(p.allowedOrigins) as { hosts: string[] }).hosts.length : current.allowedOrigins.length;
      const sites = (p.autoInstallSites ?? current.autoInstallSites) ? (await siteHostsFor(db, ctx.org.orgId)).length : 0;
      if (hostCount === 0 && sites === 0) throw new AppError("invalid_input", "Add the website the chat will run on before switching it on.");
    }
    params.push(ctx.user.id, expectedVersion);
    const { rows } = await db.query<Row>(
      `update web_chat_widgets set ${sets.join(", ")}, version = version + 1, updated_by = $${params.length - 1} where org_id = $1 and version = $${params.length} returning ${WIDGET_COLUMNS}`,
      params,
    );
    if (!rows[0]) throw new AppError("conflict", "Someone else changed these settings. Reload to see their changes, then try again.");
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "webchat.settings_saved", targetType: "web_chat_widget", targetId: ctx.org.orgId, result: "success", metadata: { fields: sets.length, enabled: rows[0].enabled } }, db);
    return map(rows[0]);
  });
}

/**
 * Issues a new public key. Every page that still carries the old key stops working at once (the old key opens nothing), so the owner replaces
 * the snippet. Used when a key was pasted somewhere it should not be.
 */
export async function rotatePublicKey(ctx: OrgContext): Promise<WidgetSettings> {
  if (!ctx.can("website.edit")) throw new AppError("forbidden", "Your role can't change the website chat.");
  return withSystem(async (db) => {
    await ensureWidget(db, ctx.org.orgId);
    const { rows } = await db.query<Row>(`update web_chat_widgets set public_key = $2, version = version + 1, updated_by = $3, last_seen_at = null, last_seen_origin = null where org_id = $1 returning ${WIDGET_COLUMNS}`, [ctx.org.orgId, newPublicKey(), ctx.user.id]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "webchat.key_rotated", targetType: "web_chat_widget", targetId: ctx.org.orgId, result: "success" }, db);
    return map(rows[0]);
  });
}

/** Evidence that the widget loaded from an allowed site. Written at most every five minutes so a busy site does not write on every page view. */
export async function recordWidgetSeen(db: Queryable, orgId: string, host: string): Promise<void> {
  await db.query(
    "update web_chat_widgets set last_seen_at = now(), last_seen_origin = $2 where org_id = $1 and (last_seen_at is null or last_seen_at < now() - interval '5 minutes' or last_seen_origin is distinct from $2)",
    [orgId, host.slice(0, 253)],
  );
}
