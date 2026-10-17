"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withSystem } from "@/server/db";
import { actionError, AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { requireAgencyOrThrow, requireAgencyOrgAccessOrThrow, requireAgencyOrgPermissionOrThrow, requireAgencyPermissionOrThrow } from "@/server/tenancy/context";
import {
  assignStaff,
  billingSchema,
  createClientTenant,
  createTenantSchema,
  ghlMappingSchema,
  inviteOrgUser,
  resendOrgInvitation,
  setAgentEnabled,
  setGhlMapping,
  setTenantStatus,
  updateBilling,
  updateUsageLimits,
  usageLimitsSchema,
} from "@/server/admin/tenants";
import { connectHermesProfile, decideHeldVersion, runHealthCheck } from "@/server/workforce/service";
import {
  connectAgencyHermesProfile,
  getAgencyProfileHistory,
  reviewAgencyHermesToolPermissions,
  testAgencyHermesProfile,
  testAllAgencyHermesProfiles,
} from "@/server/workforce/agency";
import { getProvisioningBundle, updateProvisioningJob } from "@/server/workforce/provisioning";
import { syncGhl, verifyGhlConnection } from "@/server/integrations/ghl";
import { agencyReply, updateTicket, TICKET_STATUSES, type TicketStatus } from "@/server/support/service";
import { createInvitation } from "@/server/auth/service";
import { copyAgencyUserPermissions, updateAgencyTeamMember, updateAgencyUserPermission, updateAgencyUserPermissions } from "@/server/admin/team";
import { AGENCY_TEAM_MANAGED_PERMISSIONS, isAgencyTeamPermission, type AgencyPermissionOverrides, type AgencyTeamPermission } from "@/lib/permissions";
import { acknowledgeInternalFullCapabilities, resetHermesToolPolicy, saveHermesToolPolicy, type HermesBlockableToolset, type HermesPolicyCapability } from "@/server/workforce/tool-policies";
import { notifyOrgRoles } from "@/server/notifications";

async function agentOrg(agentId: string) {
  const { rows } = await withSystem((db) => db.query<{ org_id: string }>("select org_id from agent_instances where id = $1", [agentId]));
  if (!rows[0]) throw new AppError("not_found", "AI employee not found.");
  return rows[0].org_id;
}

async function agentKind(agentId: string) {
  const { rows } = await withSystem((db) => db.query<{ kind: string }>(
    "select o.kind from agent_instances a join organizations o on o.id=a.org_id where a.id=$1",
    [agentId],
  ));
  if (!rows[0]) throw new AppError("not_found", "AI employee not found.");
  return rows[0].kind;
}

export async function createClientAction(input: z.input<typeof createTenantSchema>) {
  try {
    const admin = await requireAgencyPermissionOrThrow("agency.clients.create");
    const res = await createClientTenant(admin, input);
    revalidatePath("/admin/clients");
    return { ok: true as const, data: res };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false as const, error: err.issues[0]?.message ?? "Check the form.", code: "invalid_input" as const };
    return actionError(err);
  }
}

export async function inviteClientUserAction(orgId: string, email: string, role: "owner" | "admin" | "member") {
  try {
    const admin = await requireAgencyPermissionOrThrow("agency.clients.invite_users");
    await requireAgencyOrgAccessOrThrow(orgId);
    if (!z.string().email().safeParse(email).success) throw new AppError("invalid_input", "Enter a valid email.");
    const res = await inviteOrgUser(admin, orgId, email, role);
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "team.invited", targetType: "invitation", targetId: res.id, result: "success", metadata: { role } });
    revalidatePath(`/admin/clients/${orgId}`);
    return { ok: true as const, data: { link: res.link, delivery: publicDelivery(res.delivery) } };
  } catch (err) {
    return actionError(err);
  }
}

/** Sends a pending client invitation again with a fresh link; reports whether the email was really delivered. */
export async function resendInvitationAction(orgId: string, inviteId: string) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    const res = await resendOrgInvitation(admin, orgId, inviteId);
    revalidatePath(`/admin/clients/${orgId}`);
    revalidatePath("/admin/clients");
    return { ok: true as const, data: { email: res.email, link: res.link, delivery: publicDelivery(res.delivery) } };
  } catch (err) {
    return actionError(err);
  }
}

function publicDelivery(delivery: { status: string; error?: string | null } | null) {
  return { status: delivery?.status ?? "queued", error: delivery?.error ?? null };
}

export async function setTenantStatusAction(orgId: string, status: "active" | "suspended", reason?: string) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    await setTenantStatus(admin, orgId, status, reason);
    revalidatePath(`/admin/clients/${orgId}`);
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function setAgentEnabledAction(orgId: string, agentId: string, enabled: boolean) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    await setAgentEnabled(admin, orgId, agentId, enabled);
    revalidatePath(`/admin/clients/${orgId}`);
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function connectHermesAction(agentId: string, input: { baseUrl?: string; gatewayId?: string; profile: string; apiKey: string }) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    if (await agentKind(agentId) === "agency") throw new AppError("forbidden", "Map iAcquire employees from the Internal Workforce page so their existing profile identity is confirmed.");
    const orgId = await agentOrg(agentId);
    await connectHermesProfile({ agentId, ...input, agencyUserId: admin.id });
    const health = await runHealthCheck(agentId, { userId: admin.id, kind: "agency" });
    revalidatePath(`/admin/clients/${orgId}`);
    revalidatePath("/admin/workforce");
    revalidatePath("/admin/integrations");
    return { ok: true as const, data: health };
  } catch (err) {
    return actionError(err);
  }
}

export async function connectAgencyHermesProfileAction(agentId: string, input: { gatewayId: string; profile: string; apiKey: string; confirmedExistingProfile: boolean }) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    const health = await connectAgencyHermesProfile(admin, { agentId, ...input });
    revalidatePath("/admin/workforce");
    revalidatePath("/admin/integrations");
    return { ok: true as const, data: health };
  } catch (err) {
    return actionError(err);
  }
}

export async function testAgencyHermesProfileAction(agentId: string) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    const health = await testAgencyHermesProfile(admin, agentId);
    revalidatePath("/admin/workforce");
    revalidatePath("/admin/integrations");
    return { ok: true as const, data: health };
  } catch (err) {
    return actionError(err);
  }
}

export async function getAgencyProfileHistoryAction(agentId: string) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    return { ok: true as const, data: await getAgencyProfileHistory(admin, agentId) };
  } catch (err) {
    return actionError(err);
  }
}

export async function reviewAgencyHermesToolsAction(agentId: string) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    return { ok: true as const, data: await reviewAgencyHermesToolPermissions(admin, agentId) };
  } catch (err) {
    return actionError(err);
  }
}

export async function testAllAgencyProfilesAction() {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    const result = await testAllAgencyHermesProfiles(admin);
    revalidatePath("/admin/workforce");
    revalidatePath("/admin/integrations");
    return { ok: true as const, data: result };
  } catch (err) {
    return actionError(err);
  }
}

export async function healthCheckAction(agentId: string) {
  try {
    const orgId = await agentOrg(agentId);
    const user = await requireAgencyOrgPermissionOrThrow(orgId, "agency.workforce.view");
    const health = await runHealthCheck(agentId, { userId: user.id, kind: "agency" });
    revalidatePath(`/admin/clients/${orgId}`);
    revalidatePath("/admin/workforce");
    return { ok: true as const, data: health };
  } catch (err) {
    return actionError(err);
  }
}

export async function provisioningBundleAction(agentId: string) {
  try {
    const orgId = await agentOrg(agentId);
    await requireAgencyOrgPermissionOrThrow(orgId, "agency.workforce.view");
    return { ok: true as const, data: await getProvisioningBundle(agentId) };
  } catch (err) {
    return actionError(err);
  }
}

export async function updateProvisioningJobAction(orgId: string, jobId: string, status: "in_progress" | "failed" | "cancelled", detail?: string) {
  try {
    const user = await requireAgencyOrgPermissionOrThrow(orgId, "agency.workforce.manage");
    await updateProvisioningJob(user.id, orgId, jobId, status, detail);
    revalidatePath(`/admin/clients/${orgId}`);
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function decideHeldVersionAction(orgId: string, versionId: string, approve: boolean) {
  try {
    const user = await requireAgencyOrgPermissionOrThrow(orgId, "agency.workforce.manage");
    await withSystem((db) => decideHeldVersion(db, { orgId, versionId, approve, agencyUserId: user.id }));
    revalidatePath(`/admin/clients/${orgId}`);
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function decideHeldKnowledgeAction(orgId: string, section: string, approve: boolean) {
  try {
    const user = await requireAgencyOrgPermissionOrThrow(orgId, "agency.workforce.manage");
    await withSystem(async (db) => {
      const res = await db.query(
        approve
          ? "update company_knowledge set review_status = 'approved', risk_flags = '{}', applied_at = now() where org_id = $1 and section = $2 and review_status = 'pending_agency_review'"
          : "update company_knowledge set review_status = 'approved', risk_flags = '{}', content = '', applied_at = null where org_id = $1 and section = $2 and review_status = 'pending_agency_review'",
        [orgId, section],
      );
      if (!res.rowCount) throw new AppError("conflict", "Already reviewed.");
      await notifyOrgRoles(db, orgId, ["owner", "admin"], {
        kind: "knowledge_update_ready",
        severity: approve ? "success" : "warning",
        title: approve ? "Knowledge update approved and applied" : "A knowledge update wasn't applied",
        body: approve ? "Your AI employees use it from their next message." : "It conflicted with AI safety rules. Edit the section or contact support.",
        link: "/knowledge",
      });
      await recordAudit({ orgId, actorUserId: user.id, actorKind: "agency", action: approve ? "knowledge.review_approved" : "knowledge.review_rejected", targetType: "knowledge_section", targetId: section, result: "success" }, db);
    });
    revalidatePath(`/admin/clients/${orgId}`);
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function setGhlMappingAction(orgId: string, input: z.input<typeof ghlMappingSchema>) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    const parsed = ghlMappingSchema.safeParse(input);
    if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Check the form.");
    await setGhlMapping(admin, orgId, parsed.data);
    revalidatePath(`/admin/clients/${orgId}`);
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function verifyGhlAction(orgId: string) {
  try {
    const user = await requireAgencyOrgPermissionOrThrow(orgId, "agency.integrations.health");
    const res = await verifyGhlConnection(orgId, user.id);
    revalidatePath(`/admin/clients/${orgId}`);
    return { ok: true as const, data: res };
  } catch (err) {
    return actionError(err);
  }
}

export async function syncGhlAction(orgId: string) {
  try {
    const user = await requireAgencyOrgPermissionOrThrow(orgId, "agency.integrations.health");
    const res = await syncGhl(orgId, user.id);
    revalidatePath(`/admin/clients/${orgId}`);
    return { ok: true as const, data: res };
  } catch (err) {
    return actionError(err);
  }
}

export async function updateUsageLimitsAction(orgId: string, input: z.input<typeof usageLimitsSchema>) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    await updateUsageLimits(admin, orgId, input);
    revalidatePath(`/admin/clients/${orgId}`);
    return { ok: true as const };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false as const, error: err.issues[0]?.message ?? "Check the values.", code: "invalid_input" as const };
    return actionError(err);
  }
}

export async function updateBillingAction(orgId: string, input: z.input<typeof billingSchema>) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    await updateBilling(admin, orgId, input);
    revalidatePath(`/admin/clients/${orgId}`);
    return { ok: true as const };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false as const, error: err.issues[0]?.message ?? "Check the values.", code: "invalid_input" as const };
    return actionError(err);
  }
}

export async function assignStaffAction(orgId: string, staffUserId: string, assign: boolean, expectedRevision?: string) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    await assignStaff(admin, orgId, staffUserId, assign, expectedRevision);
    revalidatePath(`/admin/clients/${orgId}`);
    revalidatePath(`/admin/team/${staffUserId}`);
    revalidatePath("/admin/team");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function agencyReplyAction(ticketId: string, body: string, internal: boolean, status?: string) {
  try {
    const user = await requireAgencyOrThrow();
    const s = status && TICKET_STATUSES.includes(status as TicketStatus) ? (status as TicketStatus) : undefined;
    await agencyReply(user, ticketId, body, { internal, status: s });
    revalidatePath(`/admin/support/${ticketId}`);
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function updateTicketAction(ticketId: string, changes: { status?: string; assignToMe?: boolean; priority?: string }) {
  try {
    const user = await requireAgencyOrThrow();
    await updateTicket(user, ticketId, { ...changes, status: changes.status as TicketStatus | undefined });
    revalidatePath(`/admin/support/${ticketId}`);
    revalidatePath("/admin/support");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function inviteStaffAction(
  email: string,
  platformRole: "agency_staff" | "agency_manager",
  scopeMode: "all_clients" | "assigned_clients",
  initialClientIds: string[],
  permissionOverrides: AgencyPermissionOverrides = {},
) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    if (!z.string().email().safeParse(email).success) throw new AppError("invalid_input", "Enter a valid email.");
    if (scopeMode === "all_clients" && platformRole !== "agency_manager") throw new AppError("invalid_input", "Only an Agency Manager can have all-client scope.");
    if (initialClientIds.length > 100 || initialClientIds.some((id) => !z.string().uuid().safeParse(id).success)) throw new AppError("invalid_input", "The selected client list is invalid.");
    const permissionEntries = Object.entries(permissionOverrides);
    if (permissionEntries.length > AGENCY_TEAM_MANAGED_PERMISSIONS.length || permissionEntries.some(([permission, effect]) => !isAgencyTeamPermission(permission) || !["allow", "deny"].includes(effect))) {
      throw new AppError("invalid_input", "One or more customized permissions are not supported.");
    }
    const res = await createInvitation({ orgId: null, email, platformRole, agencyScopeMode: scopeMode, initialClientIds, agencyPermissionOverrides: permissionOverrides, invitedBy: admin.id });
    await recordAudit({ actorUserId: admin.id, actorKind: "agency", action: "team.invited", targetType: "invitation", targetId: res.id, result: "success", metadata: { platformRole, scopeMode, initialAssignmentCount: initialClientIds.length, emailDelivery: res.delivery?.status ?? "unknown" } });
    revalidatePath("/admin/team");
    return { ok: true as const, data: { link: res.link, delivery: publicDelivery(res.delivery) } };
  } catch (err) {
    return actionError(err);
  }
}

export async function updateAgencyTeamMemberAction(input: {
  userId: string;
  platformRole: "agency_manager" | "agency_staff";
  status: "active" | "disabled";
  scopeMode: "all_clients" | "assigned_clients";
  expectedRevision: string;
  permissionOverrides?: AgencyPermissionOverrides;
}) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    const parsed = z.object({
      userId: z.string().uuid(),
      platformRole: z.enum(["agency_manager", "agency_staff"]),
      status: z.enum(["active", "disabled"]),
      scopeMode: z.enum(["all_clients", "assigned_clients"]),
      expectedRevision: z.string().regex(/^\d{1,20}$/),
      permissionOverrides: z.record(z.string(), z.enum(["allow", "deny"])).optional(),
    }).parse(input);
    if (parsed.permissionOverrides && Object.keys(parsed.permissionOverrides).some((permission) => !isAgencyTeamPermission(permission))) throw new AppError("invalid_input", "One or more permissions are protected or unsupported.");
    await updateAgencyTeamMember(admin, parsed);
    revalidatePath("/admin/team");
    revalidatePath(`/admin/team/${parsed.userId}`);
    revalidatePath("/admin");
    return { ok: true as const };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false as const, error: "Check the role, scope and account status." };
    return actionError(err);
  }
}

export async function setAgencyUserPermissionAction(input: {
  userId: string;
  permission: string;
  effect: "allow" | "deny" | null;
  reason?: string;
  expectedRevision?: string;
}) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    const parsed = z.object({ userId: z.string().uuid(), permission: z.string().refine(isAgencyTeamPermission), effect: z.enum(["allow", "deny"]).nullable(), reason: z.string().trim().max(300).optional(), expectedRevision: z.string().regex(/^\d{1,20}$/).optional() }).parse(input);
    await updateAgencyUserPermission(admin, parsed);
    revalidatePath("/admin/team");
    revalidatePath(`/admin/team/${parsed.userId}`);
    return { ok: true as const };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false as const, error: "This permission is protected or the change is invalid." };
    return actionError(err);
  }
}

export async function updateAgencyUserPermissionsAction(input: {
  userId: string;
  permissions: Partial<Record<AgencyTeamPermission, "allow" | "deny" | null>>;
  expectedRevision: string;
  reason?: string;
}) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    const parsed = z.object({
      userId: z.string().uuid(),
      permissions: z.record(z.string(), z.enum(["allow", "deny"]).nullable()),
      expectedRevision: z.string().regex(/^\d{1,20}$/),
      reason: z.string().trim().max(300).optional(),
    }).parse(input);
    if (Object.keys(parsed.permissions).some((permission) => !isAgencyTeamPermission(permission))) throw new AppError("invalid_input", "One or more permissions are protected or unsupported.");
    await updateAgencyUserPermissions(admin, parsed as typeof input);
    revalidatePath("/admin/team");
    revalidatePath(`/admin/team/${parsed.userId}`);
    return { ok: true as const };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false as const, error: "Check the selected permissions and access states." };
    return actionError(err);
  }
}

export async function copyAgencyUserPermissionsAction(input: {
  sourceUserId: string;
  targetUserId: string;
  permissions: AgencyTeamPermission[];
  expectedRevision: string;
}) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    const parsed = z.object({
      sourceUserId: z.string().uuid(),
      targetUserId: z.string().uuid(),
      permissions: z.array(z.string().refine(isAgencyTeamPermission)).max(AGENCY_TEAM_MANAGED_PERMISSIONS.length),
      expectedRevision: z.string().regex(/^\d{1,20}$/),
    }).parse(input);
    await copyAgencyUserPermissions(admin, { ...parsed, permissions: parsed.permissions as AgencyTeamPermission[] });
    revalidatePath("/admin/team");
    revalidatePath(`/admin/team/${parsed.targetUserId}`);
    return { ok: true as const };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false as const, error: "Choose a teammate and supported permissions to copy." };
    return actionError(err);
  }
}

export async function saveHermesToolPolicyAction(input: {
  scopeKind: "client_default" | "client" | "agent";
  orgId?: string;
  agentId?: string;
  name: string;
  allowedCapabilities: string[];
  blockedToolsets: string[];
  approvalMode: "client_rules" | "approval_required" | "read_only";
}) {
  try {
    const admin = await requireAgencyPermissionOrThrow("agency.tool_policies.manage");
    const parsed = z.object({
      scopeKind: z.enum(["client_default", "client", "agent"]),
      orgId: z.string().uuid().optional(),
      agentId: z.string().uuid().optional(),
      name: z.string().trim().min(1).max(80),
      allowedCapabilities: z.array(z.string()).max(40),
      blockedToolsets: z.array(z.string()).max(24),
      approvalMode: z.enum(["client_rules", "approval_required", "read_only"]),
    }).parse(input);
    await saveHermesToolPolicy(admin, {
      ...parsed,
      allowedCapabilities: parsed.allowedCapabilities as HermesPolicyCapability[],
      blockedToolsets: parsed.blockedToolsets as HermesBlockableToolset[],
    });
    revalidatePath("/admin/workforce/policies");
    revalidatePath("/admin/workforce");
    return { ok: true as const };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false as const, error: "Check the policy scope, capabilities and approval mode." };
    return actionError(err);
  }
}

export async function resetHermesToolPolicyAction(input: { scopeKind: "client" | "agent"; orgId?: string; agentId?: string }) {
  try {
    const admin = await requireAgencyPermissionOrThrow("agency.tool_policies.manage");
    const parsed = z.object({ scopeKind: z.enum(["client", "agent"]), orgId: z.string().uuid().optional(), agentId: z.string().uuid().optional() }).parse(input);
    await resetHermesToolPolicy(admin, parsed);
    revalidatePath("/admin/workforce/policies");
    return { ok: true as const };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false as const, error: "Choose a valid client or employee." };
    return actionError(err);
  }
}

export async function acknowledgeInternalHermesCapabilitiesAction(agentIds: string[]) {
  try {
    const admin = await requireAgencyPermissionOrThrow("agency.workforce.full_capabilities.acknowledge");
    const parsed = z.array(z.string().uuid()).min(1).max(6).parse(agentIds);
    if (new Set(parsed).size !== parsed.length) throw new AppError("invalid_input", "Select each internal employee only once.");
    await acknowledgeInternalFullCapabilities(admin, parsed);
    revalidatePath("/admin/workforce/policies");
    revalidatePath("/admin/workforce");
    return { ok: true as const };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false as const, error: "Select one or more verified internal profiles." };
    return actionError(err);
  }
}

export async function updateAccessRequestAction(id: string, status: "contacted" | "approved" | "declined") {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    await withSystem((db) => db.query("update access_requests set status = $2, reviewed_by = $3 where id = $1", [id, status, admin.id]));
    revalidatePath("/admin/requests");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function revokeInvitationAction(inviteId: string, orgId?: string) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    await withSystem(async (db) => {
      await db.query("update invitations set revoked_at = now() where id = $1 and accepted_at is null", [inviteId]);
      await recordAudit({ orgId: orgId ?? null, actorUserId: admin.id, actorKind: "agency", action: "team.invitation_revoked", targetType: "invitation", targetId: inviteId, result: "success" }, db);
    });
    if (orgId) revalidatePath(`/admin/clients/${orgId}`);
    revalidatePath("/admin/team");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}
