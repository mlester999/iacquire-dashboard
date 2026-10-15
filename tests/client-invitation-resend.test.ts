import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { createClientTenant, resendOrgInvitation } from "@/server/admin/tenants";
import { getTenantDetail } from "@/server/admin/queries";
import { acceptInvitationAsNewUser, getInvitation } from "@/server/auth/service";
import { agencyUser, createUser, uid } from "./support/fixtures";

async function superAdmin() {
  const user = await createUser({ platformRole: "agency_super_admin" });
  return agencyUser(user, "agency_super_admin");
}

async function newClient(admin: Awaited<ReturnType<typeof superAdmin>>) {
  const ownerEmail = `owner-${uid()}@example.test`;
  const res = await createClientTenant(admin, { name: `Resend Co ${uid()}`, ownerEmail, enabledRoles: ["lead_hunter"] });
  const { rows } = await withSystem((db) => db.query<{ id: string }>("select id from invitations where org_id = $1 and revoked_at is null", [res.orgId]));
  return { ...res, ownerEmail, inviteId: rows[0].id };
}

function useResend(respond: (to: string) => Response) {
  const sent: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const to = (JSON.parse(init.body) as { to: string[] }).to[0];
    sent.push(to);
    return respond(to);
  });
  process.env.EMAIL_PROVIDER = "resend";
  process.env.RESEND_API_KEY = "re_test_key";
  resetEnvCache();
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EMAIL_PROVIDER;
  delete process.env.RESEND_API_KEY;
  resetEnvCache();
});

describe("client owner invitation email", () => {
  it("reports that nothing was delivered while only the capture provider is configured", async () => {
    const admin = await superAdmin();
    const client = await newClient(admin);
    expect(client.emailDelivery.status).toBe("captured");
    const detail = await getTenantDetail(admin, client.orgId);
    expect(detail.invitations).toHaveLength(1);
    expect(detail.invitations[0]).toMatchObject({ email: client.ownerEmail, role: "owner", expired: false, email_status: "captured" });
  });

  it("returns the real provider outcome when the owner invitation is created", async () => {
    const sent = useResend(() => new Response("{}", { status: 200 }));
    const admin = await superAdmin();
    const client = await newClient(admin);
    expect(sent).toEqual([client.ownerEmail]);
    expect(client.emailDelivery).toMatchObject({ status: "sent" });
    const detail = await getTenantDetail(admin, client.orgId);
    expect(detail.invitations[0].email_status).toBe("sent");
  });

  it("surfaces the provider's reason when the email is rejected, instead of claiming it was sent", async () => {
    useResend(() => new Response(JSON.stringify({ statusCode: 403, name: "validation_error", message: "The iacquire.local domain is not verified." }), { status: 403 }));
    const admin = await superAdmin();
    const client = await newClient(admin);
    expect(client.emailDelivery.status).toBe("failed");
    expect(client.emailDelivery.error).toBe("Provider responded 403: The iacquire.local domain is not verified.");
    const detail = await getTenantDetail(admin, client.orgId);
    expect(detail.invitations[0]).toMatchObject({ email_status: "failed", email_error: "Provider responded 403: The iacquire.local domain is not verified." });
    // The workspace and invitation survive a failed email; the admin can still share the link or resend.
    expect(client.inviteLink).toMatch(/\/invite\//);
  });

  it("reports a missing API key as a failed delivery", async () => {
    process.env.EMAIL_PROVIDER = "resend";
    resetEnvCache();
    const admin = await superAdmin();
    const client = await newClient(admin);
    expect(client.emailDelivery).toMatchObject({ status: "failed", error: "RESEND_API_KEY is not configured" });
  });
});

describe("resending a client invitation", () => {
  it("issues a fresh working link, revokes the old one and emails the owner again", async () => {
    const admin = await superAdmin();
    const client = await newClient(admin);
    const oldToken = client.inviteLink.split("/invite/")[1];
    const sent = useResend(() => new Response("{}", { status: 200 }));

    const res = await resendOrgInvitation(admin, client.orgId, client.inviteId);

    expect(sent).toEqual([client.ownerEmail]);
    expect(res.delivery).toMatchObject({ status: "sent" });
    expect(res.email).toBe(client.ownerEmail.toLowerCase());
    expect((await getInvitation(oldToken))?.status).toBe("revoked");
    const fresh = await getInvitation(res.link.split("/invite/")[1]);
    expect(fresh).toMatchObject({ status: "valid", role: "owner", orgId: client.orgId });

    // The new link really onboards the owner.
    const accepted = await acceptInvitationAsNewUser({ token: res.link.split("/invite/")[1], fullName: "Marko Bar", password: "Correct-Horse-42", ip: "10.9.9.9" });
    expect(accepted.ok).toBe(true);

    const { rows } = await withSystem((db) => db.query<{ action: string; result: string }>("select action, result from audit_logs where org_id = $1 and action = 'team.invitation_resent'", [client.orgId]));
    expect(rows).toEqual([{ action: "team.invitation_resent", result: "success" }]);
  });

  it("can resend an expired invitation and lists it as expired", async () => {
    const admin = await superAdmin();
    const client = await newClient(admin);
    await withSystem((db) => db.query("update invitations set expires_at = now() - interval '1 day' where id = $1", [client.inviteId]));

    const before = await getTenantDetail(admin, client.orgId);
    expect(before.invitations).toHaveLength(1);
    expect(before.invitations[0]).toMatchObject({ id: client.inviteId, expired: true });

    const res = await resendOrgInvitation(admin, client.orgId, client.inviteId);
    expect((await getInvitation(res.link.split("/invite/")[1]))?.status).toBe("valid");
    const after = await getTenantDetail(admin, client.orgId);
    expect(after.invitations).toHaveLength(1);
    expect(after.invitations[0]).toMatchObject({ id: res.id, expired: false });
  });

  it("returns the failure so the admin can share the link instead", async () => {
    const admin = await superAdmin();
    const client = await newClient(admin);
    useResend(() => new Response(JSON.stringify({ message: "Too many requests" }), { status: 429 }));
    const res = await resendOrgInvitation(admin, client.orgId, client.inviteId);
    expect(res.delivery).toMatchObject({ status: "failed", error: "Provider responded 429: Too many requests" });
    expect((await getInvitation(res.link.split("/invite/")[1]))?.status).toBe("valid");
  });

  it("refuses accepted, revoked and foreign invitations and non-super-admins", async () => {
    const admin = await superAdmin();
    const client = await newClient(admin);
    const other = await newClient(admin);

    await expect(resendOrgInvitation(admin, other.orgId, client.inviteId)).rejects.toThrow(/not found/i);

    const staff = await createUser({ platformRole: "agency_staff" });
    await expect(resendOrgInvitation(agencyUser(staff, "agency_staff"), client.orgId, client.inviteId)).rejects.toThrow(/super admins/);

    await withSystem((db) => db.query("update invitations set revoked_at = now() where id = $1", [client.inviteId]));
    await expect(resendOrgInvitation(admin, client.orgId, client.inviteId)).rejects.toThrow(/revoked/);

    await withSystem((db) => db.query("update invitations set revoked_at = null, accepted_at = now() where id = $1", [client.inviteId]));
    await expect(resendOrgInvitation(admin, client.orgId, client.inviteId)).rejects.toThrow(/already accepted/);
  });

  it("limits how often the same invitation can be resent", async () => {
    const admin = await superAdmin();
    const client = await newClient(admin);
    let inviteId = client.inviteId;
    for (let i = 0; i < 6; i++) inviteId = (await resendOrgInvitation(admin, client.orgId, inviteId)).id;
    await expect(resendOrgInvitation(admin, client.orgId, inviteId)).rejects.toThrow(/resent several times/);
  });
});
