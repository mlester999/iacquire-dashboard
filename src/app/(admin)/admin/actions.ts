"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withSystem } from "@/server/db";
import { actionError, AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { requireAgencyOrThrow, requireAgencyOrgAccessOrThrow } from "@/server/tenancy/context";
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
import { getProvisioningBundle, updateProvisioningJob } from "@/server/workforce/provisioning";
import { syncGhl, verifyGhlConnection } from "@/server/integrations/ghl";
import { agencyReply, updateTicket, TICKET_STATUSES, type TicketStatus } from "@/server/support/service";
import { createInvitation } from "@/server/auth/service";
import { notifyOrgRoles } from "@/server/notifications";

async function agentOrg(agentId: string) {
  const { rows } = await withSystem((db) => db.query<{ org_id: string }>("select org_id from agent_instances where id = $1", [agentId]));
  if (!rows[0]) throw new AppError("not_found", "AI employee not found.");
  return rows[0].org_id;
}

export async function createClientAction(input: z.input<typeof createTenantSchema>) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
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
    const admin = await requireAgencyOrThrow("super_admin");
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

export async function connectHermesAction(agentId: string, input: { baseUrl: string; profile: string; apiKey: string }) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    const orgId = await agentOrg(agentId);
    await connectHermesProfile({ agentId, ...input, agencyUserId: admin.id });
    const health = await runHealthCheck(agentId, { userId: admin.id, kind: "agency" });
    revalidatePath(`/admin/clients/${orgId}`);
    return { ok: true as const, data: health };
  } catch (err) {
    return actionError(err);
  }
}

export async function healthCheckAction(agentId: string) {
  try {
    const orgId = await agentOrg(agentId);
    const user = await requireAgencyOrgAccessOrThrow(orgId);
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
    await requireAgencyOrgAccessOrThrow(orgId);
    return { ok: true as const, data: await getProvisioningBundle(agentId) };
  } catch (err) {
    return actionError(err);
  }
}

export async function updateProvisioningJobAction(orgId: string, jobId: string, status: "in_progress" | "failed" | "cancelled", detail?: string) {
  try {
    const user = await requireAgencyOrgAccessOrThrow(orgId);
    await updateProvisioningJob(user.id, jobId, status, detail);
    revalidatePath(`/admin/clients/${orgId}`);
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function decideHeldVersionAction(orgId: string, versionId: string, approve: boolean) {
  try {
    const user = await requireAgencyOrgAccessOrThrow(orgId);
    await withSystem((db) => decideHeldVersion(db, { versionId, approve, agencyUserId: user.id }));
    revalidatePath(`/admin/clients/${orgId}`);
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function decideHeldKnowledgeAction(orgId: string, section: string, approve: boolean) {
  try {
    const user = await requireAgencyOrgAccessOrThrow(orgId);
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
    const user = await requireAgencyOrgAccessOrThrow(orgId);
    const res = await verifyGhlConnection(orgId, user.id);
    revalidatePath(`/admin/clients/${orgId}`);
    return { ok: true as const, data: res };
  } catch (err) {
    return actionError(err);
  }
}

export async function syncGhlAction(orgId: string) {
  try {
    const user = await requireAgencyOrgAccessOrThrow(orgId);
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

export async function assignStaffAction(orgId: string, staffUserId: string, assign: boolean) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    await assignStaff(admin, orgId, staffUserId, assign);
    revalidatePath(`/admin/clients/${orgId}`);
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

export async function inviteStaffAction(email: string, platformRole: "agency_staff" | "agency_super_admin") {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    if (!z.string().email().safeParse(email).success) throw new AppError("invalid_input", "Enter a valid email.");
    const res = await createInvitation({ orgId: null, email, platformRole, invitedBy: admin.id });
    await recordAudit({ actorUserId: admin.id, actorKind: "agency", action: "team.invited", targetType: "invitation", targetId: res.id, result: "success", metadata: { platformRole } });
    revalidatePath("/admin/team");
    return { ok: true as const, data: { link: res.link } };
  } catch (err) {
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
