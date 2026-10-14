import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { roleHasPermission, type OrgRole } from "@/lib/permissions";
import {
  AVAILABILITY,
  OWNER_PRIORITY_MODES,
  RESPONSIBILITIES,
  ROLE_DEFAULT_CATEGORIES,
  isEscalationCategory,
  type Availability,
  type EscalationCategory,
  type OwnerPriorityMode,
  type Responsibility,
} from "@/lib/escalation";
import type { OrgContext } from "@/server/tenancy/context";

export interface StaffProfile {
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  availability: Availability;
  availabilityNote: string | null;
  availabilityUntil: string | null;
  responsibilities: Responsibility[];
  escalationCategories: EscalationCategory[];
  notifyEmail: boolean;
  notifySms: boolean;
  notifyWhatsapp: boolean;
  ownerPriorityMode: OwnerPriorityMode;
}

interface ProfileRow {
  user_id: string;
  full_name: string;
  email: string;
  role: OrgRole;
  availability: Availability;
  availability_note: string | null;
  availability_until: Date | null;
  responsibilities: Responsibility[];
  escalation_categories: EscalationCategory[];
  notify_email: boolean;
  notify_sms: boolean;
  notify_whatsapp: boolean;
  owner_priority_mode: OwnerPriorityMode;
}

// Availability that has expired counts as available again, so "away until Friday" cannot get stuck.
const EFFECTIVE_AVAILABILITY = "case when p.availability_until is not null and p.availability_until <= now() then 'available' else p.availability end";

const PROFILE_SELECT = `
  select m.user_id, u.full_name, u.email::text as email, m.role,
         ${EFFECTIVE_AVAILABILITY} as availability, p.availability_note, p.availability_until, p.responsibilities,
         p.escalation_categories, p.notify_email, p.notify_sms, p.notify_whatsapp, p.owner_priority_mode
  from organization_memberships m
  join users u on u.id = m.user_id
  join staff_profiles p on p.org_id = m.org_id and p.user_id = m.user_id`;

function toProfile(r: ProfileRow): StaffProfile {
  return {
    userId: r.user_id,
    name: r.full_name,
    email: r.email,
    role: r.role,
    availability: r.availability,
    availabilityNote: r.availability_note,
    availabilityUntil: r.availability_until ? new Date(r.availability_until).toISOString() : null,
    responsibilities: r.responsibilities,
    escalationCategories: r.escalation_categories,
    notifyEmail: r.notify_email,
    notifySms: r.notify_sms,
    notifyWhatsapp: r.notify_whatsapp,
    ownerPriorityMode: r.owner_priority_mode,
  };
}

/** Creates the profile rows for members who do not have one yet, using sensible defaults for their role. */
export async function ensureOrgProfiles(db: Queryable, orgId: string) {
  const { rows } = await db.query<{ user_id: string; role: OrgRole }>(
    `select m.user_id, m.role from organization_memberships m
     where m.org_id = $1 and m.status = 'active'
       and not exists (select 1 from staff_profiles p where p.org_id = m.org_id and p.user_id = m.user_id)`,
    [orgId],
  );
  for (const member of rows) {
    await db.query(
      "insert into staff_profiles (org_id, user_id, escalation_categories) values ($1, $2, $3) on conflict do nothing",
      [orgId, member.user_id, [...ROLE_DEFAULT_CATEGORIES[member.role]]],
    );
  }
}

/**
 * When someone changes role, move their escalation categories to the new role's defaults, but only if
 * the manager had not customized them. Customized lists are kept, trimmed of anything the new role cannot do.
 */
export async function onRoleChanged(db: Queryable, orgId: string, userId: string, from: OrgRole, to: OrgRole) {
  await ensureOrgProfiles(db, orgId);
  const { rows } = await db.query<{ escalation_categories: EscalationCategory[] }>("select escalation_categories from staff_profiles where org_id = $1 and user_id = $2", [orgId, userId]);
  if (!rows[0]) return;
  const current = [...rows[0].escalation_categories].sort();
  const wasDefault = JSON.stringify(current) === JSON.stringify([...ROLE_DEFAULT_CATEGORIES[from]].sort());
  const next = !roleHasPermission(to, "escalations.respond") ? [] : wasDefault ? [...ROLE_DEFAULT_CATEGORIES[to]] : current;
  await db.query("update staff_profiles set escalation_categories = $3 where org_id = $1 and user_id = $2", [orgId, userId, next]);
}

export async function getMyStaffProfile(ctx: OrgContext): Promise<StaffProfile> {
  return withSystem(async (db) => {
    await ensureOrgProfiles(db, ctx.org.orgId);
    const { rows } = await db.query<ProfileRow>(`${PROFILE_SELECT} where m.org_id = $1 and m.user_id = $2 and m.status = 'active'`, [ctx.org.orgId, ctx.user.id]);
    if (!rows[0]) throw new AppError("not_found", "Your staff profile was not found.");
    return toProfile(rows[0]);
  });
}

export async function listStaffProfiles(ctx: OrgContext): Promise<StaffProfile[]> {
  if (!ctx.can("team.view")) throw new AppError("forbidden", "You can't view the team.");
  await withSystem((db) => ensureOrgProfiles(db, ctx.org.orgId));
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<ProfileRow>(`${PROFILE_SELECT} where m.org_id = $1 and m.status = 'active' order by m.role, u.full_name`, [ctx.org.orgId]);
    return rows.map(toProfile);
  });
}

/** Away and Busy skip the owner's priority window, so people can step out without delaying customers. */
export async function setAvailability(ctx: OrgContext, input: { availability: Availability; note?: string; until?: Date | null }) {
  if (!ctx.can("staff.availability")) throw new AppError("forbidden", "Your role doesn't take escalations.");
  if (!(AVAILABILITY as readonly string[]).includes(input.availability)) throw new AppError("invalid_input", "Choose Available, Busy or Away.");
  const until = input.availability === "available" ? null : (input.until ?? null);
  if (until && (Number.isNaN(until.getTime()) || until.getTime() <= Date.now())) throw new AppError("invalid_input", "Choose a time in the future.");
  await withSystem(async (db) => {
    await ensureOrgProfiles(db, ctx.org.orgId);
    await db.query(
      "update staff_profiles set availability = $3, availability_note = nullif($4, ''), availability_until = $5 where org_id = $1 and user_id = $2",
      [ctx.org.orgId, ctx.user.id, input.availability, (input.note ?? "").trim().slice(0, 200), until],
    );
  });
}

export interface NotificationPreferenceInput {
  notifyEmail: boolean;
  notifySms: boolean;
  notifyWhatsapp: boolean;
  alertPhone?: string;
  /** The person confirmed they understand personal SMS or WhatsApp alerts are chargeable usage. */
  acknowledgeCosts?: boolean;
}

const E164 = /^\+[1-9][0-9]{6,14}$/;

/** In-app alerts are always on. Email is on by default. SMS and WhatsApp need a phone number and a recorded cost acknowledgement. */
export async function setNotificationPreferences(ctx: OrgContext, input: NotificationPreferenceInput) {
  if (!ctx.can("staff.availability")) throw new AppError("forbidden", "Your role doesn't take escalations.");
  const wantsOptional = input.notifySms || input.notifyWhatsapp;
  const phone = input.alertPhone?.replace(/[\s()-]/g, "") ?? "";
  if (input.alertPhone && !E164.test(phone)) throw new AppError("invalid_input", "Enter your mobile number with country code, for example +639171234567.");
  await withSystem(async (db) => {
    await ensureOrgProfiles(db, ctx.org.orgId);
    const { rows } = await db.query<{ alert_phone: string | null; optional_alerts_opt_in_at: Date | null }>(
      "select alert_phone, optional_alerts_opt_in_at from staff_profiles where org_id = $1 and user_id = $2 for update",
      [ctx.org.orgId, ctx.user.id],
    );
    const existing = rows[0];
    const nextPhone = phone || existing?.alert_phone || null;
    if (wantsOptional && !nextPhone) throw new AppError("invalid_input", "Add a mobile number to receive SMS or WhatsApp alerts.");
    // The cost acknowledgement is recorded once and kept while any optional alert stays on.
    if (wantsOptional && !existing?.optional_alerts_opt_in_at && !input.acknowledgeCosts) {
      throw new AppError("invalid_input", "Confirm that you understand SMS and WhatsApp alerts are billed as usage.");
    }
    await db.query(
      `update staff_profiles set notify_email = $3, notify_sms = $4, notify_whatsapp = $5, alert_phone = $6,
         optional_alerts_opt_in_at = case when $7 then coalesce(optional_alerts_opt_in_at, now()) else null end
       where org_id = $1 and user_id = $2`,
      [ctx.org.orgId, ctx.user.id, input.notifyEmail, input.notifySms, input.notifyWhatsapp, nextPhone, wantsOptional],
    );
    await recordAudit(
      { orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "staff.notifications_changed", targetType: "staff_profile", targetId: ctx.user.id, result: "success", metadata: { email: input.notifyEmail, sms: input.notifySms, whatsapp: input.notifyWhatsapp } },
      db,
    );
  });
}

/**
 * Managers decide which kinds of escalation each person may see. People whose role cannot respond to
 * escalations (viewers) can never be given categories, so customer details stay inside their authorization.
 */
export async function setEscalationAuthorization(ctx: OrgContext, userId: string, input: { categories: string[]; responsibilities?: string[] }) {
  if (!ctx.can("escalations.configure")) throw new AppError("forbidden", "Only owners and managers can decide who handles which escalations.");
  const categories = [...new Set(input.categories)];
  if (!categories.every(isEscalationCategory)) throw new AppError("invalid_input", "Unknown escalation type.");
  const responsibilities = [...new Set(input.responsibilities ?? [])];
  if (!responsibilities.every((r): r is Responsibility => (RESPONSIBILITIES as readonly string[]).includes(r))) throw new AppError("invalid_input", "Unknown responsibility.");
  await withSystem(async (db) => {
    const { rows } = await db.query<{ role: OrgRole }>("select role from organization_memberships where org_id = $1 and user_id = $2 and status = 'active'", [ctx.org.orgId, userId]);
    const target = rows[0];
    if (!target) throw new AppError("not_found", "That person is not on your team.");
    if (categories.length && !roleHasPermission(target.role, "escalations.respond")) throw new AppError("invalid_input", "This role can't take escalations. Change their role first.");
    await ensureOrgProfiles(db, ctx.org.orgId);
    await db.query(
      "update staff_profiles set escalation_categories = $3, responsibilities = coalesce($4::text[], responsibilities) where org_id = $1 and user_id = $2",
      [ctx.org.orgId, userId, categories, input.responsibilities ? responsibilities : null],
    );
    await recordAudit(
      { orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "staff.escalation_authorization_changed", targetType: "staff_profile", targetId: userId, result: "success", metadata: { categories, responsibilities } },
      db,
    );
  });
}

export async function setOwnerPriorityMode(ctx: OrgContext, mode: string) {
  if (ctx.role !== "owner") throw new AppError("forbidden", "Only the business owner can change how escalations reach them.");
  if (!(OWNER_PRIORITY_MODES as readonly string[]).includes(mode)) throw new AppError("invalid_input", "Choose a valid notification preference.");
  await withSystem(async (db) => {
    await ensureOrgProfiles(db, ctx.org.orgId);
    await db.query("update staff_profiles set owner_priority_mode = $3 where org_id = $1 and user_id = $2", [ctx.org.orgId, ctx.user.id, mode]);
    await recordAudit(
      { orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "staff.owner_priority_changed", targetType: "staff_profile", targetId: ctx.user.id, result: "success", metadata: { mode } },
      db,
    );
  });
}

export interface EligibleStaff {
  userId: string;
  role: OrgRole;
  name: string;
  email: string;
  availability: Availability;
  notifyEmail: boolean;
  notifySms: boolean;
  notifyWhatsapp: boolean;
  ownerPriorityMode: OwnerPriorityMode;
}

/**
 * People who may receive an escalation of this category: active members whose role can respond to
 * escalations and who were authorized for this category. Anyone else never hears about the customer.
 */
export async function eligibleStaff(db: Queryable, orgId: string, category: EscalationCategory): Promise<EligibleStaff[]> {
  await ensureOrgProfiles(db, orgId);
  const { rows } = await db.query<ProfileRow>(
    `${PROFILE_SELECT}
     where m.org_id = $1 and m.status = 'active' and u.status = 'active' and $2 = any(p.escalation_categories)
       and exists (select 1 from role_permissions rp where rp.role = m.role and rp.permission = 'escalations.respond')
     order by m.role, u.full_name`,
    [orgId, category],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    role: r.role,
    name: r.full_name,
    email: r.email,
    availability: r.availability,
    notifyEmail: r.notify_email,
    notifySms: r.notify_sms,
    notifyWhatsapp: r.notify_whatsapp,
    ownerPriorityMode: r.owner_priority_mode,
  }));
}

/** The business owner's profile, which controls the priority window. */
export async function getOwnerProfile(db: Queryable, orgId: string): Promise<EligibleStaff | null> {
  await ensureOrgProfiles(db, orgId);
  const { rows } = await db.query<ProfileRow>(
    `${PROFILE_SELECT} where m.org_id = $1 and m.status = 'active' and m.role = 'owner' and u.status = 'active' order by m.created_at limit 1`,
    [orgId],
  );
  const r = rows[0];
  return r
    ? { userId: r.user_id, role: r.role, name: r.full_name, email: r.email, availability: r.availability, notifyEmail: r.notify_email, notifySms: r.notify_sms, notifyWhatsapp: r.notify_whatsapp, ownerPriorityMode: r.owner_priority_mode }
    : null;
}
