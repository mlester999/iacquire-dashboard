import "server-only";
import { z } from "zod";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError, toPublicError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { createInvitation, deliverInvitation, normalizeEmail } from "@/server/auth/service";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { sha256 } from "@/server/security/crypto";
import { ensureAgentInstances } from "@/server/workforce/service";
import { ensureSetupInstance } from "@/server/setup/core";
import { saveCredential,assertCredentialAdmin } from "@/server/security/credentials";
import type { SessionUser } from "@/server/auth/service";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { canBlueprint, canDoBlueprint, needBlueprint, needBlueprintAction } from "@/server/crm/blueprints/access";
import { installStarter, listBlueprints, listStarters } from "@/server/crm/blueprints/library";
import { applyBlueprint, planApplication } from "@/server/crm/blueprints/apply";
import type { ApplicationPlan, ApplyOptions, PlanAction, RequirementKey } from "@/lib/crm/blueprints/types";
import type { BlueprintSummary, StarterView } from "@/lib/crm/blueprints/views";

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

/** The CRM a new client starts on. Hybrid (some capabilities in each system) is set up later, deliberately, in the client's CRM settings. */
export const ONBOARDING_CRM_MODES = ["native", "ghl"] as const;
export type OnboardingCrmMode = (typeof ONBOARDING_CRM_MODES)[number];

/** Why a GoHighLevel client can't start from a Blueprint: shown in the dialog and returned by the server. */
export const GHL_BLUEPRINT_REASON =
  "GoHighLevel clients keep their pipelines, tags, fields, calendars and workflows in GoHighLevel, so a Blueprint can only be applied to iAcquire Native CRM.";

/** The CRM setup chosen when a client is created: a published library Blueprint, an iAcquire starter not yet in the library, or none. */
export const onboardingBlueprintSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("blueprint"), blueprintId: z.string().uuid("Choose a Blueprint from the list.") }),
    z.object({ kind: z.literal("starter"), starterKey: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/, "Choose a starter from the list.") }),
  ])
  .nullable();
export type OnboardingBlueprintChoice = z.infer<typeof onboardingBlueprintSchema>;

export const createTenantSchema = z
  .object({
    name: z.string().trim().min(2, "Enter the company name.").max(120),
    ownerEmail: z.string().trim().email("Enter a valid email."),
    // The industry's label ("Real Estate"), as organizations.industry has always stored it.
    industry: z.string().trim().max(120).optional().default(""),
    website: z.string().trim().max(300).optional().default(""),
    timezone: z.string().trim().max(64).default("America/New_York"),
    enabledRoles: z.array(z.enum(AGENT_ROLE_KEYS)).min(1, "Enable at least one AI employee.").default([...AGENT_ROLE_KEYS]),
    crmMode: z.enum(ONBOARDING_CRM_MODES).default("native"),
    blueprint: onboardingBlueprintSchema.optional().default(null),
  })
  .superRefine((d, ctx) => {
    if (d.crmMode === "ghl" && d.blueprint) ctx.addIssue({ code: "custom", path: ["blueprint"], message: GHL_BLUEPRINT_REASON });
  });

/** What happened to the Blueprint chosen at creation. The client and its invitation exist whatever this says. */
export interface OnboardingBlueprintResult {
  status: "applied" | "partially_applied" | "failed";
  blueprintId: string | null;
  blueprintName: string | null;
  version: number | null;
  applicationId?: string;
  /** Safe to show: why nothing (or not everything) was applied. */
  error?: string;
  /** What the client's workspace still has to connect, map, fill in or approve (the setup checklist). */
  requirements?: RequirementKey[];
  counts?: Partial<Record<PlanAction, number>>;
  /** Where the agency reviews and applies it again (the library's apply flow for this client). */
  retryPath: string;
}

/**
 * One confirmation per client and Blueprint version ("onboarding-<org>-<version>", the ids without dashes so the key stays within the
 * 16 to 80 URL-safe characters a confirmation key may have), so a repeated onboarding apply returns the first application instead of
 * applying twice.
 */
export function onboardingIdempotencyKey(orgId: string, versionId: string): string {
  return `onboarding-${orgId.replace(/-/g, "")}-${versionId.replace(/-/g, "")}`;
}

export function blueprintRetryPath(orgId: string, blueprintId: string | null): string {
  return blueprintId ? `/admin/crm-blueprints/${blueprintId}/apply?client=${orgId}` : `/admin/crm-blueprints?client=${orgId}`;
}

/**
 * Checks the chosen Blueprint before anything is created, so an impossible choice (archived, never published, an unknown starter, a role that
 * can't apply) refuses the whole request instead of leaving a client behind with a Blueprint that was never going to apply.
 */
async function assertBlueprintChoice(admin: SessionUser, choice: NonNullable<OnboardingBlueprintChoice>): Promise<void> {
  needBlueprintAction(admin, "apply");
  if (choice.kind === "blueprint") return assertPublishedBlueprint(choice.blueprintId);
  needBlueprint(admin, "crm.blueprints.publish");
  const starter = (await listStarters(admin)).find((s) => s.key === choice.starterKey);
  if (!starter) throw new AppError("not_found", "That starter isn't available. Choose another one or start with a blank CRM.");
  // Already in the library: installing returns that Blueprint, so it must still be published.
  if (starter.installedId) await assertPublishedBlueprint(starter.installedId);
}

async function assertPublishedBlueprint(blueprintId: string): Promise<void> {
  const { rows } = await withSystem((db) =>
    db.query<{ status: string; current_version: number | null }>("select status, current_version from crm_blueprints where id = $1", [blueprintId]),
  );
  const bp = rows[0];
  if (!bp) throw new AppError("not_found", "That Blueprint no longer exists. Choose another one or start with a blank CRM.");
  if (bp.status !== "published" || bp.current_version === null) {
    throw new AppError("conflict", bp.status === "archived" ? "That Blueprint was archived. Choose another one or start with a blank CRM." : "That Blueprint has no published version yet. Publish it first, or choose another one.");
  }
}

export async function createClientTenant(admin: SessionUser, input: z.input<typeof createTenantSchema>) {
  const { rows: permissionRows } = await withSystem((db) => db.query<{ allowed: boolean }>(
    "select coalesce(app.user_has_agency_permission($1, 'agency.clients.create'), false) as allowed",
    [admin.id],
  ));
  if (!permissionRows[0]?.allowed) throw new AppError("forbidden", "Your role does not allow creating client workspaces.");
  const data = createTenantSchema.parse(input);
  if (data.blueprint) await assertBlueprintChoice(admin, data.blueprint);
  const created = await withSystem(async (db) => {
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
    // A staff member who creates a client gets access through an explicit assignment,
    // keeping their default client scope assigned-only.
    if (admin.platformRole === "agency_staff") {
      await db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [orgId, admin.id]);
    }
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
    // A native client has no GoHighLevel connection to track: only GoHighLevel clients start with its two "not connected" rows.
    for (const provider of data.crmMode === "native" ? ["hermes"] : ["hermes", "ghl", "ghl_calendar"]) {
      await db.query("insert into integration_status (org_id, provider, status) values ($1, $2, 'not_configured')", [orgId, provider]);
    }
    // A new client's CRM workspace is created native by the organizations trigger; a GoHighLevel client records that choice here. Its
    // location is mapped afterwards (Integrations), so nothing about GoHighLevel is assumed to be connected.
    await db.query(
      `insert into crm_workspaces (org_id, mode, updated_by) values ($1, $2, $3)
       on conflict (org_id) do update set mode = excluded.mode, updated_by = excluded.updated_by`,
      [orgId, data.crmMode, admin.id],
    );
    const invite = await createInvitation({ orgId, email: data.ownerEmail, role: "owner", invitedBy: admin.id }, db);
    await recordAudit(
      {
        orgId, actorUserId: admin.id, actorKind: "agency", action: "tenant.created", targetType: "organization", targetId: orgId, result: "success",
        metadata: { slug, enabledRoles: data.enabledRoles, crmMode: data.crmMode, blueprint: data.blueprint ? (data.blueprint.kind === "blueprint" ? { blueprintId: data.blueprint.blueprintId } : { starterKey: data.blueprint.starterKey }) : null },
      },
      db,
    );
    return { orgId, slug, invite };
  });
  // The owner email goes out only after the workspace and invitation are committed, and the real outcome is returned.
  const emailDelivery = await deliverInvitation(created.invite.message);
  // The Blueprint is applied after the client is committed, in its own transaction: whatever happens to it, the client and the invitation stay.
  const blueprint = data.blueprint ? await applyOnboardingBlueprint(admin, created.orgId, data.blueprint) : null;
  return { orgId: created.orgId, slug: created.slug, inviteLink: created.invite.link, emailDelivery, crmMode: data.crmMode, blueprint };
}

/**
 * Applies the Blueprint chosen while creating a client, after the client was committed: installs a starter into the library when one was
 * picked, plans the latest published version against the new workspace (add missing only), and applies exactly that plan, recorded as an
 * onboarding application. Calendars and workflows arrive as drafts; nothing is connected, published or sent. Never throws: a failure is
 * returned (and audited) so the caller can show it with a way to retry, and it never undoes the client or its invitation.
 */
export async function applyOnboardingBlueprint(admin: SessionUser, orgId: string, choice: NonNullable<OnboardingBlueprintChoice>): Promise<OnboardingBlueprintResult> {
  let blueprintId: string | null = choice.kind === "blueprint" ? choice.blueprintId : null;
  let plan: ApplicationPlan | null = null;
  try {
    if (choice.kind === "starter") blueprintId = (await installStarter(admin, choice.starterKey)).id;
    const options: ApplyOptions = { strategy: "add_missing" };
    const planned: ApplicationPlan = await planApplication(admin, orgId, { blueprintId: blueprintId!, options });
    plan = planned;
    const res = await applyBlueprint(
      admin,
      orgId,
      { blueprintId: blueprintId!, version: planned.version, options, planDigest: planned.digest, idempotencyKey: onboardingIdempotencyKey(orgId, planned.versionId) },
      { via: "onboarding" },
    );
    const app = res.application;
    const status = app.status === "applied" || app.status === "partially_applied" ? app.status : "failed";
    return {
      status,
      blueprintId,
      blueprintName: app.blueprintName,
      version: app.version,
      applicationId: app.id,
      requirements: planned.requirements,
      counts: app.counts,
      retryPath: blueprintRetryPath(orgId, blueprintId),
      ...(status === "failed" ? { error: "The Blueprint couldn't be applied. Review it and apply it again." } : {}),
    };
  } catch (err) {
    const e = toPublicError(err);
    await recordAudit({
      orgId, actorUserId: admin.id, actorKind: "agency", action: "tenant.blueprint_apply_failed", targetType: "organization", targetId: orgId, result: "failure",
      metadata: { blueprintId, starterKey: choice.kind === "starter" ? choice.starterKey : null, code: e.code },
    }).catch(() => undefined);
    return {
      status: "failed",
      blueprintId,
      blueprintName: null,
      version: plan?.version ?? null,
      error: e.message,
      requirements: plan?.requirements,
      retryPath: blueprintRetryPath(orgId, blueprintId),
    };
  }
}

/** What the create-client dialog offers: published Blueprints, and iAcquire starters not yet in the library (installing one needs publish). */
export interface OnboardingBlueprintChoices {
  blueprints: BlueprintSummary[];
  starters: StarterView[];
  canApply: boolean;
  canInstallStarters: boolean;
}

export async function listOnboardingBlueprintChoices(admin: SessionUser): Promise<OnboardingBlueprintChoices> {
  if (admin.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can create client workspaces.");
  const canApply = canDoBlueprint(admin, "apply");
  if (!canApply) return { blueprints: [], starters: [], canApply, canInstallStarters: false };
  const canInstallStarters = canBlueprint(admin, "crm.blueprints.publish");
  const [all, starters] = await Promise.all([listBlueprints(admin, { collection: "published", sort: "name" }), canInstallStarters ? listStarters(admin) : Promise.resolve([] as StarterView[])]);
  return {
    blueprints: all.filter((b) => b.status === "published" && b.currentVersion !== null),
    starters: starters.filter((s) => !s.installedId),
    canApply,
    canInstallStarters,
  };
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
         (select count(*)::int from support_tickets t where t.org_id = o.id and t.status in ('new', 'open', 'in_progress')) as open_tickets,
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
    } else if (org.status === "suspended") {
      // Reactivating restores what the setup implies: active for a setup that was activated (whatever happened to the fee since: a refund never pauses a running client),
      // pending for one that never was. Without this the billing page kept saying "Activation: Suspended" for a workspace that was back in use.
      await db.query(
        `update billing_accounts b set activation_status = case when exists (select 1 from client_setup_instances i where i.org_id = b.org_id and i.state = 'activated') then 'active' else 'pending' end,
           updated_at = now() where b.org_id = $1 and b.activation_status = 'suspended'`,
        [orgId],
      );
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
  /** Blank means no cap on AI replies to customers; a number is a hard stop once hard stop is on. */
  monthlyCustomerReplies: z.union([z.literal(""), z.coerce.number().int().min(0).max(1_000_000)]).optional(),
  warnAtPercent: z.coerce.number().int().min(1).max(100),
  hardStop: z.coerce.boolean(),
  fairUseNote: z.string().trim().max(1000).optional().default(""),
});

export async function updateUsageLimits(admin: SessionUser, orgId: string, input: z.input<typeof usageLimitsSchema>) {
  if (admin.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can change usage limits.");
  const d = usageLimitsSchema.parse(input);
  await withSystem(async (db) => {
    await db.query(
      `insert into usage_limits (org_id, monthly_agent_messages, monthly_tokens, daily_lead_research, monthly_help_requests, monthly_customer_replies,
         warn_at_percent, hard_stop, fair_use_note, updated_by, updated_at)
       values ($1, $2, $3, $4, $5, $10, $6, $7, nullif($8, ''), $9, now())
       on conflict (org_id) do update set monthly_agent_messages = excluded.monthly_agent_messages, monthly_tokens = excluded.monthly_tokens,
         daily_lead_research = excluded.daily_lead_research, monthly_help_requests = excluded.monthly_help_requests, monthly_customer_replies = excluded.monthly_customer_replies,
         warn_at_percent = excluded.warn_at_percent, hard_stop = excluded.hard_stop, fair_use_note = excluded.fair_use_note,
         updated_by = excluded.updated_by, updated_at = now()`,
      [orgId, d.monthlyAgentMessages, d.monthlyTokens === "" || d.monthlyTokens === undefined ? null : d.monthlyTokens, d.dailyLeadResearch, d.monthlyHelpRequests, d.warnAtPercent, d.hardStop, d.fairUseNote, admin.id,
        d.monthlyCustomerReplies === "" || d.monthlyCustomerReplies === undefined ? null : d.monthlyCustomerReplies],
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

/**
 * Invoice and receipt links, the service terms and the activation label. It no longer moves the setup payment to "paid", "waived" or "refunded": those are a recorded
 * payment (src/server/billing/manual.ts or a verified provider event), a waiver with a reason, or a recorded refund, each with its own audit entry. The only status change
 * left here is between "not invoiced" and "invoiced", which clears nothing. "Active" activation also needs the setup payment cleared.
 */
export async function updateBilling(admin: SessionUser, orgId: string, input: z.input<typeof billingSchema>) {
  if (admin.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can update billing.");
  const d = billingSchema.parse(input);
  await withSystem(async (db) => {
    const cur = (await db.query<{ setup_payment_status: string; activation_status: string; cleared: boolean }>("select setup_payment_status, activation_status, app.setup_payment_cleared(org_id) as cleared from billing_accounts where org_id = $1 for update", [orgId])).rows[0];
    if (!cur) throw new AppError("not_found", "This client has no billing account.");
    const invoicing = ["not_invoiced", "invoiced"];
    if (d.setupPaymentStatus !== cur.setup_payment_status && !(invoicing.includes(d.setupPaymentStatus) && invoicing.includes(cur.setup_payment_status))) {
      throw new AppError("invalid_input", "The setup payment can't be changed by editing its status. Record the payment, waive the setup fee with a reason, or record a refund.");
    }
    if (d.activationStatus === "active" && cur.activation_status !== "active" && !cur.cleared) throw new AppError("invalid_input", "Activation can't be marked active while the setup payment is not confirmed.");
    await db.query(
      `update billing_accounts set setup_payment_status = $2, activation_status = $3, invoice_url = nullif($4, ''),
         receipt_url = nullif($5, ''), service_terms = nullif($6, ''), updated_by = $7, updated_at = now()
       where org_id = $1`,
      [orgId, d.setupPaymentStatus, d.activationStatus, d.invoiceUrl, d.receiptUrl, d.serviceTerms, admin.id],
    );
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "tenant.billing_updated", targetType: "organization", targetId: orgId, result: "success", metadata: { setup: d.setupPaymentStatus, activation: d.activationStatus } }, db);
  });
}

export async function assignStaff(admin: SessionUser, orgId: string, staffUserId: string, assign: boolean, expectedRevision?: string) {
  if (admin.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can assign staff.");
  await withSystem(async (db) => {
    const activeAdmin = await db.query("select 1 from users where id=$1 and status='active' and platform_role='agency_super_admin'", [admin.id]);
    if (!activeAdmin.rows.length) throw new AppError("forbidden", "Only active agency super admins can assign staff.");
    const { rows } = await db.query<{ platform_role: string; status: string }>("select platform_role,status from users where id = $1 for update", [staffUserId]);
    if (!rows[0] || !["agency_staff", "agency_manager"].includes(rows[0].platform_role)) throw new AppError("invalid_input", "Only Agency Managers and Agency Staff can be assigned.");
    if (assign && rows[0].status !== "active") throw new AppError("invalid_input", "Reactivate this team member before assigning clients.");
    await db.query("insert into agency_team_member_versions(user_id) values($1) on conflict(user_id) do nothing", [staffUserId]);
    const version = await db.query<{ revision: string }>("select revision::text as revision from agency_team_member_versions where user_id=$1 for update", [staffUserId]);
    if (expectedRevision !== undefined && expectedRevision !== (version.rows[0]?.revision ?? "0")) throw new AppError("conflict", "This team member changed in another session. Reload the page and review the latest settings.");
    if (assign) await db.query("insert into staff_assignments (org_id, user_id, assigned_by) values ($1, $2, $3) on conflict do nothing", [orgId, staffUserId, admin.id]);
    else await db.query("delete from staff_assignments where org_id = $1 and user_id = $2", [orgId, staffUserId]);
    await db.query("update agency_team_member_versions set revision=revision+1,updated_by=$2,updated_at=now() where user_id=$1", [staffUserId, admin.id]);
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

/**
 * Sends a pending client invitation again. The stored token is a hash, so this issues a fresh link and
 * revokes the previous one rather than re-sending the old link. Expired invitations can be resent;
 * accepted or deliberately revoked ones cannot.
 */
export async function resendOrgInvitation(admin: SessionUser, orgId: string, inviteId: string) {
  if (admin.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can resend invitations.");
  const { rows } = await withSystem((db) =>
    db.query<{ email: string; role: "owner" | "admin" | "member" | null; accepted_at: Date | null; revoked_at: Date | null }>(
      "select email::text as email, role, accepted_at, revoked_at from invitations where id = $1 and org_id = $2",
      [inviteId, orgId],
    ),
  );
  const invite = rows[0];
  if (!invite) throw new AppError("not_found", "Invitation not found.");
  if (invite.accepted_at) throw new AppError("conflict", "This invitation was already accepted.");
  if (invite.revoked_at) throw new AppError("conflict", "This invitation was revoked or replaced. Send a new invitation from Team & staff instead.");
  const limit = await consumeRateLimit(RATE_LIMITS.invitationResend, `${orgId}:${sha256(normalizeEmail(invite.email))}`);
  if (!limit.allowed) throw new AppError("rate_limited", `This invitation was resent several times already. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`);
  const resent = await createInvitation({ orgId, email: invite.email, role: invite.role ?? "member", invitedBy: admin.id });
  await recordAudit({
    orgId,
    actorUserId: admin.id,
    actorKind: "agency",
    action: "team.invitation_resent",
    targetType: "invitation",
    targetId: resent.id,
    result: resent.delivery?.status === "failed" ? "failure" : "success",
    metadata: { role: invite.role, emailStatus: resent.delivery?.status ?? null },
  });
  return { id: resent.id, email: normalizeEmail(invite.email), link: resent.link, delivery: resent.delivery };
}
