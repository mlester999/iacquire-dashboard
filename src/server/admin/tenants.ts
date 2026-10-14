import "server-only";
import { z } from "zod";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { createInvitation, normalizeEmail } from "@/server/auth/service";
import { ensureAgentInstances } from "@/server/workforce/service";
import { ensureSetupInstance } from "@/server/setup/core";
import { saveCredential,assertCredentialAdmin } from "@/server/security/credentials";
import type { SessionUser } from "@/server/auth/service";
import { AGENT_ROLE_KEYS } from "@/lib/agents";

/** GHL locations that must never be mapped to a client tenant. */
export const PROTECTED_GHL_LOCATIONS = {
  asterHomes: "u69CVh0ZlAofUmRoj1zF",
  agencyInternal: "SQvVnld5MBHdMQ1qnSfw",
} as const;

export function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "workspace"
  );
}

export const createTenantSchema = z.object({
  name: z.string().trim().min(2, "Enter the company name.").max(120),
  ownerEmail: z.string().trim().email("Enter a valid email."),
  industry: z.string().trim().max(120).optional().default(""),
  website: z.string().trim().max(300).optional().default(""),
  timezone: z.string().trim().max(64).default("America/New_York"),
  enabledRoles: z.array(z.enum(AGENT_ROLE_KEYS)).min(1, "Enable at least one AI employee.").default([...AGENT_ROLE_KEYS]),
});

export async function createClientTenant(admin: SessionUser, input: z.input<typeof createTenantSchema>) {
  if (admin.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can create client workspaces.");
  const data = createTenantSchema.parse(input);
  return withSystem(async (db) => {
    let slug = slugify(data.name);
    for (let i = 2; ; i++) {
      const { rows } = await db.query("select 1 from organizations where slug = $1", [slug]);
      if (!rows.length) break;
      slug = `${slugify(data.name).slice(0, 36)}-${i}`;
    }
    const { rows } = await db.query<{ id: string }>(
      `insert into organizations (name, slug, kind, status, industry, website, timezone, created_by)
       values ($1, $2, 'client', 'invited', nullif($3, ''), nullif($4, ''), $5, $6) returning id`,
      [data.name, slug, data.industry, data.website, data.timezone, admin.id],
    );
    const orgId = rows[0].id;
    await db.query("insert into company_profiles (org_id) values ($1)", [orgId]);
    await db.query("insert into usage_limits (org_id, updated_by) values ($1, $2)", [orgId, admin.id]);
    await db.query("insert into billing_accounts (org_id, updated_by) values ($1, $2)", [orgId, admin.id]);
    await db.query("insert into onboarding_responses (org_id) values ($1)", [orgId]);
    await ensureAgentInstances(orgId, db);
    await ensureSetupInstance(db, orgId, admin.id);
    await db.query(
      `update agent_instances set enabled = (role_key = any($2::text[])),
         status = case when role_key = any($2::text[]) then 'setup_required' else 'disabled' end
       where org_id = $1`,
      [orgId, data.enabledRoles],
    );
    for (const provider of ["hermes", "ghl", "ghl_calendar"]) {
      await db.query("insert into integration_status (org_id, provider, status) values ($1, $2, 'not_configured')", [orgId, provider]);
    }
    const invite = await createInvitation({ orgId, email: data.ownerEmail, role: "owner", invitedBy: admin.id }, db);
    await recordAudit(
      { orgId, actorUserId: admin.id, actorKind: "agency", action: "tenant.created", targetType: "organization", targetId: orgId, result: "success", metadata: { slug, enabledRoles: data.enabledRoles } },
      db,
    );
    return { orgId, slug, inviteLink: invite.link };
  });
}

export interface TenantListRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  is_demo: boolean;
  created_at: Date;
  onboarding_completed_at: Date | null;
  members: number;
  agents_online: number;
  agents_enabled: number;
  open_tickets: number;
  ghl_status: string | null;
  setup_payment_status: string | null;
  messages_this_month: number;
}

export async function listTenants(user: SessionUser): Promise<TenantListRow[]> {
  return withUser(user.id, async (db) => {
    const { rows } = await db.query<TenantListRow>(
      `select o.id, o.name, o.slug, o.status, o.is_demo, o.created_at, o.onboarding_completed_at,
         (select count(*)::int from organization_memberships m where m.org_id = o.id and m.status = 'active') as members,
         (select count(*)::int from agent_instances a where a.org_id = o.id and a.status in ('online', 'busy')) as agents_online,
         (select count(*)::int from agent_instances a where a.org_id = o.id and a.enabled) as agents_enabled,
         (select count(*)::int from support_tickets t where t.org_id = o.id and t.status in ('open', 'in_progress')) as open_tickets,
         (select g.status from ghl_location_mappings g where g.org_id = o.id) as ghl_status,
         (select b.setup_payment_status from billing_accounts b where b.org_id = o.id) as setup_payment_status,
         (select coalesce(sum(u.quantity), 0)::int from usage_events u where u.org_id = o.id and u.kind = 'agent_message'
            and u.created_at >= date_trunc('month', now())) as messages_this_month
       from organizations o where o.kind = 'client' order by o.created_at desc`,
    );
    return rows;
  });
}

export async function setTenantStatus(admin: SessionUser, orgId: string, status: "active" | "suspended", reason?: string) {
  if (admin.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can suspend or reactivate workspaces.");
  await withSystem(async (db) => {
    const { rows } = await db.query<{ kind: string; status: string }>("select kind, status from organizations where id = $1", [orgId]);
    const org = rows[0];
    if (!org || org.kind !== "client") throw new AppError("not_found", "Client workspace not found.");
    if (status === "suspended" && !reason?.trim()) throw new AppError("invalid_input", "Add a reason for the suspension.");
    const nextStatus = status === "active" ? (org.status === "suspended" ? "active" : org.status) : "suspended";
    await db.query("update organizations set status = $2, suspended_reason = $3 where id = $1", [orgId, nextStatus, status === "suspended" ? reason!.trim().slice(0, 500) : null]);
    if (status === "suspended") {
      // End client sessions' access immediately: memberships are ignored for suspended tenants.
      await db.query("update billing_accounts set activation_status = 'suspended' where org_id = $1", [orgId]);
    }
    await recordAudit(
      { orgId, actorUserId: admin.id, actorKind: "agency", action: status === "suspended" ? "tenant.suspended" : "tenant.reactivated", targetType: "organization", targetId: orgId, result: "success" },
      db,
    );
  });
}

export async function setAgentEnabled(admin: SessionUser, orgId: string, agentId: string, enabled: boolean) {
  if (admin.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can change plan features.");
  await withSystem(async (db) => {
    const res = await db.query(
      `update agent_instances set enabled = $3,
         status = case when $3 then case when hermes_profile is null then 'setup_required' else 'provisioning' end else 'disabled' end
       where id = $1 and org_id = $2`,
      [agentId, orgId, enabled],
    );
    if (!res.rowCount) throw new AppError("not_found", "AI employee not found.");
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", agentInstanceId: agentId, action: enabled ? "agent.enabled" : "agent.disabled", targetType: "agent_instance", targetId: agentId, result: "success" }, db);
  });
}

export const usageLimitsSchema = z.object({
  monthlyAgentMessages: z.coerce.number().int().min(0).max(1_000_000),
  monthlyTokens: z.union([z.literal(""), z.coerce.number().int().min(0).max(10_000_000_000)]).optional(),
  dailyLeadResearch: z.coerce.number().int().min(0).max(1000),
  monthlyHelpRequests: z.coerce.number().int().min(0).max(100_000),
  warnAtPercent: z.coerce.number().int().min(1).max(100),
  hardStop: z.coerce.boolean(),
  fairUseNote: z.string().trim().max(1000).optional().default(""),
});

export async function updateUsageLimits(admin: SessionUser, orgId: string, input: z.input<typeof usageLimitsSchema>) {
  if (admin.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can change usage limits.");
  const d = usageLimitsSchema.parse(input);
  await withSystem(async (db) => {
    await db.query(
      `insert into usage_limits (org_id, monthly_agent_messages, monthly_tokens, daily_lead_research, monthly_help_requests,
         warn_at_percent, hard_stop, fair_use_note, updated_by, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, nullif($8, ''), $9, now())
       on conflict (org_id) do update set monthly_agent_messages = excluded.monthly_agent_messages, monthly_tokens = excluded.monthly_tokens,
         daily_lead_research = excluded.daily_lead_research, monthly_help_requests = excluded.monthly_help_requests,
         warn_at_percent = excluded.warn_at_percent, hard_stop = excluded.hard_stop, fair_use_note = excluded.fair_use_note,
         updated_by = excluded.updated_by, updated_at = now()`,
      [orgId, d.monthlyAgentMessages, d.monthlyTokens === "" || d.monthlyTokens === undefined ? null : d.monthlyTokens, d.dailyLeadResearch, d.monthlyHelpRequests, d.warnAtPercent, d.hardStop, d.fairUseNote, admin.id],
    );
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "tenant.usage_limits_updated", targetType: "organization", targetId: orgId, result: "success", metadata: { ...d } }, db);
  });
}

export const billingSchema = z.object({
  setupPaymentStatus: z.enum(["not_invoiced", "invoiced", "paid", "waived", "refunded"]),
  activationStatus: z.enum(["pending", "active", "suspended"]),
  invoiceUrl: z.union([z.literal(""), z.string().url().startsWith("https://")]).default(""),
  receiptUrl: z.union([z.literal(""), z.string().url().startsWith("https://")]).default(""),
  serviceTerms: z.string().trim().max(4000).default(""),
});

export async function updateBilling(admin: SessionUser, orgId: string, input: z.input<typeof billingSchema>) {
  if (admin.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can update billing.");
  const d = billingSchema.parse(input);
  await withSystem(async (db) => {
    await db.query(
      `update billing_accounts set setup_payment_status = $2, activation_status = $3, invoice_url = nullif($4, ''),
         receipt_url = nullif($5, ''), service_terms = nullif($6, ''), updated_by = $7, updated_at = now(),
         paid_at = case when $2 = 'paid' then coalesce(paid_at, now()) else paid_at end
       where org_id = $1`,
      [orgId, d.setupPaymentStatus, d.activationStatus, d.invoiceUrl, d.receiptUrl, d.serviceTerms, admin.id],
    );
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "tenant.billing_updated", targetType: "organization", targetId: orgId, result: "success", metadata: { setup: d.setupPaymentStatus, activation: d.activationStatus } }, db);
  });
}

export async function assignStaff(admin: SessionUser, orgId: string, staffUserId: string, assign: boolean) {
  if (admin.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can assign staff.");
  await withSystem(async (db) => {
    const { rows } = await db.query<{ platform_role: string }>("select platform_role from users where id = $1", [staffUserId]);
    if (rows[0]?.platform_role !== "agency_staff") throw new AppError("invalid_input", "Only agency staff can be assigned.");
    if (assign) await db.query("insert into staff_assignments (org_id, user_id, assigned_by) values ($1, $2, $3) on conflict do nothing", [orgId, staffUserId, admin.id]);
    else await db.query("delete from staff_assignments where org_id = $1 and user_id = $2", [orgId, staffUserId]);
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: assign ? "tenant.staff_assigned" : "tenant.staff_unassigned", targetType: "user", targetId: staffUserId, result: "success" }, db);
  });
}

// ---------------------------------------------------------------------------
// GoHighLevel location mapping (server-side only; never accepted from client requests)
// ---------------------------------------------------------------------------

export const ghlMappingSchema = z.object({
  locationId: z.string().trim().regex(/^[A-Za-z0-9]{10,40}$/, "Enter the GHL location ID."),
  locationName: z.string().trim().max(120).optional().default(""),
  pipelineId: z.union([z.literal(""), z.string().trim().regex(/^[A-Za-z0-9]{10,40}$/)]).default(""),
  calendarIds: z.string().trim().max(500).default(""),
  token: z.string().trim().max(500).optional().default(""),
});

export function assertAssignableLocation(locationId: string, orgKind: "agency" | "client") {
  if (locationId === PROTECTED_GHL_LOCATIONS.asterHomes) {
    throw new AppError("forbidden", "This location is protected and can't be connected to the portal.");
  }
  if (locationId === PROTECTED_GHL_LOCATIONS.agencyInternal && orgKind !== "agency") {
    throw new AppError("forbidden", "iAcquire's internal location can't be assigned to a client workspace.");
  }
}

export async function setGhlMapping(admin: SessionUser, orgId: string, input: z.input<typeof ghlMappingSchema>) {
  if (admin.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can assign CRM locations.");
  const d = ghlMappingSchema.parse(input);
  const calendarIds = d.calendarIds.split(/[\s,]+/).filter(Boolean);
  if (calendarIds.some((c) => !/^[A-Za-z0-9]{10,40}$/.test(c))) throw new AppError("invalid_input", "Calendar IDs must be GHL calendar identifiers.");
  await withSystem(async (db) => {
    await assertCredentialAdmin(db,admin.id);
    const { rows } = await db.query<{ kind: "agency" | "client" }>("select kind from organizations where id = $1", [orgId]);
    if (!rows[0]) throw new AppError("not_found", "Workspace not found.");
    assertAssignableLocation(d.locationId, rows[0].kind);
    const { rows: taken } = await db.query("select 1 from ghl_location_mappings where location_id = $1 and org_id <> $2", [d.locationId, orgId]);
    if (taken.length) throw new AppError("conflict", "That location is already mapped to another workspace.");
    let credentialId: string | null = null;
    if (d.token) {
      const {rows:old}=await db.query<{credential_id:string|null}>("select credential_id from ghl_location_mappings where org_id=$1",[orgId]);
      const cred=await saveCredential(db,{orgId,provider:"ghl",label:`GHL location ${d.locationId}`,secret:d.token,scopes:["locations.readonly","opportunities.readonly","calendars.readonly","calendars/events.readonly"],actorId:admin.id,replaces:old[0]?.credential_id});
      credentialId = cred.id;
    }
    await db.query(
      `insert into ghl_location_mappings (org_id, location_id, location_name, pipeline_id, calendar_ids, credential_id, status, created_by)
       values ($1, $2, nullif($3, ''), nullif($4, ''), $5, $6, 'pending', $7)
       on conflict (org_id) do update set location_id = excluded.location_id, location_name = excluded.location_name,
         pipeline_id = excluded.pipeline_id, calendar_ids = excluded.calendar_ids,
         credential_id = coalesce(excluded.credential_id, ghl_location_mappings.credential_id), status = 'pending', verified_at = null`,
      [orgId, d.locationId, d.locationName, d.pipelineId, calendarIds, credentialId, admin.id],
    );
    await setIntegrationStatus(db, orgId, "ghl", "pending", "Mapped. Run a verification to confirm access.");
    await recordAudit(
      { orgId, actorUserId: admin.id, actorKind: "agency", action: "tenant.ghl_mapped", targetType: "ghl_location", targetId: d.locationId, result: "success", metadata: { credentialStored: Boolean(credentialId), calendars: calendarIds.length } },
      db,
    );
  });
}

export async function setIntegrationStatus(db: Queryable, orgId: string | null, provider: string, status: string, detail: string | null) {
  await db.query(
    `insert into integration_status (org_id, provider, status, detail, last_checked_at)
     values ($1, $2, $3, $4, now())
     on conflict (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), provider)
     do update set status = excluded.status, detail = excluded.detail, last_checked_at = now(), updated_at = now()`,
    [orgId, provider, status, detail],
  );
}

export async function inviteOrgUser(actor: SessionUser, orgId: string, email: string, role: "owner" | "admin" | "member") {
  return createInvitation({ orgId, email: normalizeEmail(email), role, invitedBy: actor.id });
}
