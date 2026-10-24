import "server-only";
import { z } from "zod";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { createInvitation, normalizeEmail } from "@/server/auth/service";
import { createConfigVersion, currentSettings } from "@/server/workforce/service";
import { sanitizeClientText } from "@/server/workforce/compiler";
import { lockOnboardingRow, syncProfileToAnswers } from "@/server/onboarding/profile-sync";
import { onRoleChanged } from "@/server/staff/service";
import { aiPreferencesSchema } from "@/lib/agent-settings";
import { PROFILE_KEYS, PROFILE_LIMITS, type ProfileKey, type ProfileValues } from "@/lib/onboarding/business-profile";
import { configAttribution } from "@/lib/config-review";
import { scanInstructionText } from "@/lib/instruction-risk";
import { grantableRoles, type OrgRole } from "@/lib/permissions";
import { NOTIFICATION_GROUPS, type NotificationPrefsView } from "@/lib/notification-groups";
import { parseEmailPreference } from "@/lib/ops";
import { parseProactivePrefs, proactivePrefsFrom } from "@/lib/proactive";
import type { OrgContext } from "@/server/tenancy/context";

// ---------------------------------------------------------------------------
// Business profile
// ---------------------------------------------------------------------------

export const profileSchema = z.object({
  name: z.string().trim().min(2, "Add your company name.").max(120),
  industry: z.string().trim().max(120).default(""),
  website: z.string().trim().max(300).default(""),
  region: z.string().trim().max(200).default(""),
  timezone: z.string().trim().max(64),
  description: z.string().trim().max(4000).default(""),
  services: z.string().trim().max(4000).default(""),
  idealCustomers: z.string().trim().max(4000).default(""),
  brandColor: z.union([z.literal(""), z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #2C5BFF.")]).default(""),
});

export function isValidTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function getProfile(ctx: OrgContext) {
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{
      name: string;
      industry: string | null;
      website: string | null;
      region: string | null;
      timezone: string;
      description: string | null;
      services: string | null;
      ideal_customers: string | null;
      brand_color: string | null;
      ai_preferences: unknown;
    }>(
      `select o.name, o.industry, o.website, o.region, o.timezone, p.description, p.services, p.ideal_customers, p.brand_color, p.ai_preferences
       from organizations o left join company_profiles p on p.org_id = o.id where o.id = $1`,
      [ctx.org.orgId],
    );
    return rows[0];
  });
}

export async function updateProfile(ctx: OrgContext, input: z.input<typeof profileSchema>) {
  if (!ctx.can("workspace.manage_profile")) throw new AppError("forbidden", "Only owners and admins can edit the business profile.");
  const d = profileSchema.parse(input);
  if (!isValidTimeZone(d.timezone)) throw new AppError("invalid_input", "Choose a valid time zone.");
  // One writer for the business profile (also used by onboarding), then the questionnaire's answers follow in the same transaction so nobody is asked the same thing twice.
  const written = await withUser(ctx.user.id, async (db) => {
    // The questionnaire's row first, as a submission takes it, so the two can never each hold what the other is waiting for.
    await lockOnboardingRow(db, ctx.org.orgId);
    const res = await writeBusinessProfile(db, ctx, {
      name: d.name, industry: d.industry, website: d.website, region: d.region, timezone: d.timezone,
      description: d.description, services: d.services, idealCustomers: d.idealCustomers, brandColor: d.brandColor,
    });
    await syncProfileToAnswers(db, ctx, { changed: res.changed, values: res.values });
    return res;
  });
  await recordAudit({
    orgId: ctx.org.orgId,
    actorUserId: ctx.user.id,
    actorKind: ctx.user.platformRole !== "none" ? "agency" : "user",
    action: "settings.profile_updated",
    result: "success",
    metadata: { riskFlags: written.riskFlags, changed: written.changed },
  });
}

/**
 * The one place the business profile is written, for Settings and for onboarding. Writes only the facts it is given, and only those that differ from what the workspace has,
 * in the caller's transaction (it runs as the signed-in person under row-level security, or as trusted server code). Text reaches every AI prompt as quoted context, so it is
 * cleaned and checked here, whoever writes it: instruction-like text is refused rather than let past the configuration review gate. Returns the facts that changed, the codes of
 * every risk the scan found (blocking ones throw), and the profile as it stands now.
 */
export async function writeBusinessProfile(
  db: Queryable,
  ctx: { org: { orgId: string }; user: { id: string } },
  fields: Partial<ProfileValues>,
): Promise<{ changed: ProfileKey[]; riskFlags: string[]; values: ProfileValues }> {
  const clean: Partial<ProfileValues> = {};
  for (const key of PROFILE_KEYS) {
    const raw = fields[key];
    if (raw === undefined) continue;
    clean[key] = key === "timezone" || key === "brandColor" ? String(raw).trim() : sanitizeClientText(String(raw), PROFILE_LIMITS[key]);
  }
  if (clean.name !== undefined && !clean.name) throw new AppError("invalid_input", "Add your company name.");
  if (clean.timezone !== undefined && !isValidTimeZone(clean.timezone)) throw new AppError("invalid_input", "Choose a valid time zone.");
  if (clean.brandColor && !/^#[0-9a-fA-F]{6}$/.test(clean.brandColor)) throw new AppError("invalid_input", "Use a hex color like #2C5BFF.");
  const findings = (["name", "industry", "region", "description", "services", "idealCustomers"] as const).flatMap((key) => scanInstructionText(clean[key]));
  const blocked = findings.filter((finding) => finding.severity === "block");
  if (blocked.length) {
    throw new AppError("invalid_input", `The business profile can't include text that conflicts with AI safety policy (${blocked[0].code.replaceAll("_", " ")}). Remove or rephrase that sentence.`);
  }

  const orgId = ctx.org.orgId;
  const { rows } = await db.query<{
    name: string; industry: string | null; website: string | null; region: string | null; timezone: string;
    description: string | null; services: string | null; ideal_customers: string | null; operating_area: string | null; brand_color: string | null;
  }>(
    `select o.name, o.industry, o.website, o.region, o.timezone, p.description, p.services, p.ideal_customers, p.operating_area, p.brand_color
     from organizations o left join company_profiles p on p.org_id = o.id where o.id = $1`,
    [orgId],
  );
  const cur = rows[0];
  if (!cur) throw new AppError("not_found", "Workspace not found.");
  const now: ProfileValues = {
    name: cur.name, industry: cur.industry ?? "", website: cur.website ?? "", region: cur.operating_area || cur.region || "", timezone: cur.timezone,
    description: cur.description ?? "", services: cur.services ?? "", idealCustomers: cur.ideal_customers ?? "", brandColor: cur.brand_color ?? "",
  };
  const changed = PROFILE_KEYS.filter((key) => {
    const next = clean[key];
    if (next === undefined) return false;
    if (key === "brandColor") return next.toLowerCase() !== now.brandColor.toLowerCase();
    // The area is kept in two columns (the short one on the workspace, the long one in the profile); either being out of step counts as a change.
    if (key === "region") return next !== (cur.operating_area ?? "") || next.slice(0, 200) !== (cur.region ?? "");
    return next !== now[key];
  });
  const has = (key: ProfileKey) => changed.includes(key);

  const orgSets: string[] = [];
  const orgParams: unknown[] = [orgId];
  const setOrg = (fragment: string, value: unknown) => {
    orgParams.push(value);
    orgSets.push(fragment.replace("?", `$${orgParams.length}`));
  };
  if (has("name")) setOrg("name = ?", clean.name);
  if (has("industry")) setOrg("industry = nullif(?, '')", clean.industry);
  if (has("website")) setOrg("website = nullif(?, '')", clean.website);
  if (has("region")) setOrg("region = nullif(?, '')", (clean.region ?? "").slice(0, 200));
  if (has("timezone")) setOrg("timezone = ?", clean.timezone);
  if (orgSets.length) await db.query(`update organizations set ${orgSets.join(", ")} where id = $1`, orgParams);

  const cols: string[] = [];
  const marks: string[] = [];
  const values: unknown[] = [orgId];
  const setProfile = (column: string, mark: string, value: unknown) => {
    cols.push(column);
    values.push(value);
    marks.push(mark.replace("?", `$${values.length}`));
  };
  if (has("description")) setProfile("description", "?", clean.description);
  if (has("services")) setProfile("services", "?", clean.services);
  if (has("idealCustomers")) setProfile("ideal_customers", "?", clean.idealCustomers);
  if (has("region")) setProfile("operating_area", "?", clean.region);
  if (has("brandColor")) setProfile("brand_color", "nullif(?, '')", clean.brandColor);
  if (cols.length) {
    values.push(ctx.user.id);
    await db.query(
      `insert into company_profiles (org_id, ${cols.join(", ")}, updated_by) values ($1, ${marks.join(", ")}, $${values.length})
       on conflict (org_id) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}, updated_by = excluded.updated_by`,
      values,
    );
  }
  return { changed, riskFlags: [...new Set(findings.map((finding) => finding.code))], values: { ...now, ...Object.fromEntries(changed.map((key) => [key, clean[key]])) } as ProfileValues };
}

// ---------------------------------------------------------------------------
// Company-wide AI preferences
// ---------------------------------------------------------------------------

export const aiPrefsInputSchema = aiPreferencesSchema.extend({
  chatRetentionDays: z.enum(["forever", "30", "90", "365"]).default("forever"),
  applyToEmployees: z.boolean().default(false),
});

export async function updateAiPreferences(ctx: OrgContext, input: z.input<typeof aiPrefsInputSchema>) {
  if (!ctx.can("agents.configure")) throw new AppError("forbidden", "Only owners and admins can change AI preferences.");
  const d = aiPrefsInputSchema.parse(input);
  const { applyToEmployees, chatRetentionDays, ...prefs } = d;
  const stored = { ...prefs, chatRetentionDays: chatRetentionDays === "forever" ? null : Number(chatRetentionDays) };
  await withUser(ctx.user.id, (db) =>
    db.query(
      `insert into company_profiles (org_id, ai_preferences, updated_by) values ($1, $2, $3)
       on conflict (org_id) do update set ai_preferences = excluded.ai_preferences, updated_by = excluded.updated_by`,
      [ctx.org.orgId, JSON.stringify(stored), ctx.user.id],
    ),
  );
  let updated = 0;
  if (applyToEmployees) {
    await withSystem(async (db) => {
      const { rows } = await db.query<{ id: string }>("select id from agent_instances where org_id = $1 and active_config_version_id is not null", [ctx.org.orgId]);
      for (const a of rows) {
        const { settings } = await currentSettings(db, a.id, ctx.org.orgId);
        const attribution = configAttribution({ orgKind: ctx.org.kind, platformRole: ctx.user.platformRole });
        await createConfigVersion(db, {
          orgId: ctx.org.orgId,
          agentId: a.id,
          settings: { ...settings, tone: prefs.tone, replyLength: prefs.replyLength, language: prefs.language, companyRules: prefs.companyRules, neverPromise: prefs.neverPromise, escalateWhen: prefs.escalateWhen },
          source: attribution.source,
          actorKind: attribution.actorKind,
          changeRequest: "Company-wide AI preferences applied",
          userId: ctx.user.id,
          apply: true,
        });
        updated++;
      }
    });
  }
  await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "settings.ai_preferences_updated", result: "success", metadata: { applyToEmployees, updated } });
  return { updated };
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export async function getTeam(ctx: OrgContext) {
  const members = await withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ user_id: string; full_name: string; email: string; role: OrgRole; status: string; last_login_at: Date | null; created_at: Date }>(
      `select u.id as user_id, u.full_name, u.email, m.role, m.status, u.last_login_at, m.created_at
       from organization_memberships m join users u on u.id = m.user_id
       where m.org_id = $1 and m.status = 'active' order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, u.full_name`,
      [ctx.org.orgId],
    );
    return rows;
  });
  const invites = ctx.can("team.manage")
    ? (
        await withSystem((db) =>
          db.query<{ id: string; email: string; role: OrgRole; expires_at: Date; created_at: Date }>(
            "select id, email, role, expires_at, created_at from invitations where org_id = $1 and accepted_at is null and revoked_at is null and expires_at > now() order by created_at desc",
            [ctx.org.orgId],
          ),
        )
      ).rows
    : [];
  return { members, invites };
}

export async function inviteMember(ctx: OrgContext, emailInput: string, role: OrgRole) {
  if (!ctx.can("team.manage")) throw new AppError("forbidden", "Only owners and admins can invite teammates.");
  if (!grantableRoles(ctx.role).includes(role)) throw new AppError("forbidden", "Your role can't grant that access level.");
  const email = normalizeEmail(emailInput);
  if (!z.string().email().safeParse(email).success) throw new AppError("invalid_input", "Enter a valid email address.");
  const { rows } = await withSystem((db) =>
    db.query("select 1 from organization_memberships m join users u on u.id = m.user_id where m.org_id = $1 and u.email = $2 and m.status = 'active'", [ctx.org.orgId, email]),
  );
  if (rows.length) throw new AppError("conflict", "That person is already on your team.");
  const invite = await createInvitation({ orgId: ctx.org.orgId, email, role, invitedBy: ctx.user.id });
  await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "team.invited", targetType: "invitation", targetId: invite.id, result: "success", metadata: { role } });
  return invite;
}

async function ownerCount(orgId: string) {
  const { rows } = await withSystem((db) =>
    db.query<{ n: number }>("select count(*)::int as n from organization_memberships where org_id = $1 and role = 'owner' and status = 'active'", [orgId]),
  );
  return rows[0].n;
}

async function targetRole(orgId: string, userId: string): Promise<OrgRole | null> {
  const { rows } = await withSystem((db) =>
    db.query<{ role: OrgRole }>("select role from organization_memberships where org_id = $1 and user_id = $2 and status = 'active'", [orgId, userId]),
  );
  return rows[0]?.role ?? null;
}

export async function changeMemberRole(ctx: OrgContext, userId: string, role: OrgRole) {
  if (!ctx.can("team.manage")) throw new AppError("forbidden", "Only owners and admins can change roles.");
  const current = await targetRole(ctx.org.orgId, userId);
  if (!current) throw new AppError("not_found", "Teammate not found.");
  const allowed = grantableRoles(ctx.role);
  // Admins can't change owners, and nobody can grant a role above their own.
  if (!allowed.includes(role) || !allowed.includes(current)) throw new AppError("forbidden", "Your role can't make that change.");
  if (current === "owner" && role !== "owner" && (await ownerCount(ctx.org.orgId)) <= 1) {
    throw new AppError("conflict", "Every workspace needs at least one owner. Make someone else an owner first.");
  }
  await withSystem(async (db) => {
    await db.query("update organization_memberships set role = $3 where org_id = $1 and user_id = $2", [ctx.org.orgId, userId, role]);
    await onRoleChanged(db, ctx.org.orgId, userId, current, role);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "team.role_changed", targetType: "user", targetId: userId, result: "success", metadata: { from: current, to: role } }, db);
  });
}

export async function revokeMember(ctx: OrgContext, userId: string) {
  if (!ctx.can("team.manage")) throw new AppError("forbidden", "Only owners and admins can remove teammates.");
  const current = await targetRole(ctx.org.orgId, userId);
  if (!current) throw new AppError("not_found", "Teammate not found.");
  if (!grantableRoles(ctx.role).includes(current)) throw new AppError("forbidden", "Your role can't remove that teammate.");
  if (current === "owner" && (await ownerCount(ctx.org.orgId)) <= 1) throw new AppError("conflict", "You can't remove the only owner.");
  await withSystem(async (db) => {
    await db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [ctx.org.orgId, userId]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "team.access_revoked", targetType: "user", targetId: userId, result: "success" }, db);
  });
}

export async function revokeInvite(ctx: OrgContext, inviteId: string) {
  if (!ctx.can("team.manage")) throw new AppError("forbidden", "Only owners and admins can manage invitations.");
  const res = await withSystem((db) => db.query("update invitations set revoked_at = now() where id = $1 and org_id = $2 and accepted_at is null", [inviteId, ctx.org.orgId]));
  if (!res.rowCount) throw new AppError("not_found", "Invitation not found.");
}

// ---------------------------------------------------------------------------
// Notification preferences
// ---------------------------------------------------------------------------

export { NOTIFICATION_GROUPS, type NotificationPrefsView };

export async function getNotificationPrefs(ctx: OrgContext): Promise<NotificationPrefsView> {
  const { rows } = await withUser(ctx.user.id, (db) =>
    db.query<{ prefs: Record<string, unknown> }>("select prefs from notification_preferences where user_id = $1 and org_id = $2", [ctx.user.id, ctx.org.orgId]),
  );
  const prefs = rows[0]?.prefs ?? {};
  return {
    groups: Object.fromEntries(NOTIFICATION_GROUPS.map((g) => [g.key, prefs[g.key] !== false])),
    setupEmails: prefs.setupEmails === true,
    email: parseEmailPreference(prefs),
    proactive: parseProactivePrefs(prefs),
  };
}

const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time such as 21:00.");
const proactivePatchSchema = z.object({
  enabled: z.boolean().optional(),
  minimumSeverity: z.enum(["info", "warning", "critical"]).optional(),
  delivery: z.enum(["immediate", "daily_digest"]).optional(),
  dailyBriefing: z.boolean().optional(),
  weeklySummary: z.boolean().optional(),
  briefingHour: z.number().int().min(0).max(23).optional(),
  quietStart: TIME.nullable().optional(),
  quietEnd: TIME.nullable().optional(),
  autoCreateTasks: z.boolean().optional(),
}).optional();

export const notificationPrefsSchema = z.object({
  groups: z.record(z.string(), z.boolean()).optional(),
  setupEmails: z.boolean().optional(),
  email: z.enum(["important", "all", "off"]).optional(),
  proactive: proactivePatchSchema,
});

/** Changes only what was sent; everything else the person already chose is kept. */
export async function saveNotificationPrefs(ctx: OrgContext, input: z.input<typeof notificationPrefsSchema>) {
  const patch = notificationPrefsSchema.parse(input);
  const current = await getNotificationPrefs(ctx);
  const groups = Object.fromEntries(NOTIFICATION_GROUPS.map((g) => [g.key, patch.groups ? patch.groups[g.key] !== false : current.groups[g.key]]));
  const proactive = { ...current.proactive, ...(patch.proactive ?? {}) };
  if ((proactive.quietStart === null) !== (proactive.quietEnd === null)) {
    throw new AppError("invalid_input", "Set both quiet-hour times, or neither.");
  }
  const clean = {
    ...groups,
    setupEmails: patch.setupEmails ?? current.setupEmails,
    email: patch.email ?? current.email,
    proactive: proactivePrefsFrom(proactive),
  };
  await withUser(ctx.user.id, (db) =>
    db.query(
      `insert into notification_preferences (user_id, org_id, prefs) values ($1, $2, $3)
       on conflict (user_id, org_id) do update set prefs = excluded.prefs, updated_at = now()`,
      [ctx.user.id, ctx.org.orgId, JSON.stringify(clean)],
    ),
  );
}

export const userProfileSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your name.").max(120),
  timezone: z.string().trim().max(64),
});

export async function updateUserProfile(ctx: OrgContext, input: z.input<typeof userProfileSchema>) {
  const d = userProfileSchema.parse(input);
  if (!isValidTimeZone(d.timezone)) throw new AppError("invalid_input", "Choose a valid time zone.");
  await withUser(ctx.user.id, (db) => db.query(
    `update users set full_name = $2, timezone = $3,
       preferences = case when timezone is distinct from $3
         then coalesce(preferences, '{}'::jsonb) || '{"preferredDisplayTimezoneConfigured": true}'::jsonb
         else coalesce(preferences, '{}'::jsonb) end
     where id = $1`,
    [ctx.user.id, d.fullName, d.timezone],
  ));
}
