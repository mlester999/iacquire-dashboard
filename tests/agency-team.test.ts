import { describe,expect,it } from "vitest";
import { withSystem } from "@/server/db";
import { agencyTeamView } from "@/server/admin/team";
import { applyInvitation, createInvitation } from "@/server/auth/service";
import { recordAudit } from "@/server/audit";
import { ensureInstanceStandalone } from "@/server/setup/core";
import { agencyUser,createOrg,createUser } from "./support/fixtures";

describe("agency team read-only overview",()=>{
  it("reports actual role groups, active assignment coverage and assigned work",async()=>{
    const superUser=await createUser({platformRole:"agency_super_admin",name:"Founder"});
    const staff=await createUser({platformRole:"agency_staff",name:"Coordinator"});
    const covered=await createOrg({name:"Covered client"});const uncovered=await createOrg({name:"Unassigned client"});
    await ensureInstanceStandalone(covered.id);
    await withSystem(async db=>{
      await db.query("insert into staff_assignments(org_id,user_id,assigned_by) values($1,$2,$3)",[covered.id,staff.id,superUser.id]);
      await db.query("update client_setup_tasks set assigned_to=$1 where org_id=$2 and template_key='company_info'",[staff.id,covered.id]);
    });
    const view=await agencyTeamView(agencyUser(superUser,"agency_super_admin"));
    const member=view.members.find(m=>m.id===staff.id)!;
    expect(member.clients).toEqual([{id:covered.id,name:covered.name}]);expect(member.openTasks).toBe(1);
    expect(member.role).toBe("agency_staff");expect(member.lastLoginAt).toBeNull();
    expect(view.clients.find(c=>c.id===covered.id)!.assignedStaff).toBe(1);
    expect(view.clients.find(c=>c.id===uncovered.id)!.assignedStaff).toBe(0);
    await withSystem(db=>db.query("update users set status='disabled' where id=$1",[staff.id]));
    const disabled=await agencyTeamView(agencyUser(superUser,"agency_super_admin"));
    expect(disabled.clients.find(c=>c.id===covered.id)!.assignedStaff).toBe(0);
  });
  it("rejects cached or forged super-admin claims",async()=>{
    const user=await createUser({platformRole:"agency_staff"});
    await expect(agencyTeamView(agencyUser(user,"agency_super_admin"))).rejects.toThrow(/super admins/);
  });

  it("delivers agency invitations through the email outbox and records the actual outcome", async () => {
    const owner = await createUser({ platformRole: "agency_super_admin", name: "Invitation Owner" });
    const email = `agency-invite-${crypto.randomUUID()}@example.test`;
    const invitation = await createInvitation({
      orgId: null,
      email,
      platformRole: "agency_staff",
      agencyScopeMode: "assigned_clients",
      invitedBy: owner.id,
    });

    expect(invitation.delivery).toMatchObject({ status: "captured" });
    const message = await withSystem((db) => db.query<{
      to_email: string;
      template: string;
      status: string;
      body_text: string;
    }>("select to_email::text,template,status,body_text from email_outbox where id=$1", [invitation.delivery!.id]));
    expect(message.rows[0]).toMatchObject({ to_email: email, template: "staff_invitation", status: "captured" });
    expect(message.rows[0].body_text).toContain(invitation.link);
    expect(message.rows[0].body_text).toContain("Agency Staff");

    const stored = await withSystem((db) => db.query<{ email_delivery_status: string }>(
      "select email_delivery_status from invitations where id=$1",
      [invitation.id],
    ));
    expect(stored.rows[0].email_delivery_status).toBe("captured");
  });

  it("includes creation and acceptance events from the teammate's invitation in activity", async () => {
    const owner = await createUser({ platformRole: "agency_super_admin", name: "Agency Owner" });
    const email = `invite-activity-${crypto.randomUUID()}@example.test`;
    const staff = await createUser({ email, platformRole: "agency_staff", name: "Invited Staff" });
    const invitation = await withSystem((db) => createInvitation({
      orgId: null,
      email,
      platformRole: "agency_staff",
      agencyScopeMode: "assigned_clients",
      invitedBy: owner.id,
    }, db));

    await withSystem(async (db) => {
      await recordAudit({
        actorUserId: owner.id,
        actorKind: "agency",
        action: "team.invited",
        targetType: "invitation",
        targetId: invitation.id,
        result: "success",
      }, db);
      await applyInvitation(db, invitation.id, staff.id);
    });

    const view = await agencyTeamView(agencyUser(owner, "agency_super_admin"));
    const member = view.members.find((item) => item.id === staff.id)!;
    expect(member.activity.map((event) => event.action)).toEqual(expect.arrayContaining([
      "team.invited",
      "auth.invitation_accepted",
    ]));
  });

  it("keeps each teammate's latest activity when unrelated agency audit traffic is higher", async () => {
    const owner = await createUser({ platformRole: "agency_super_admin", name: "Audit Owner" });
    const staff = await createUser({ platformRole: "agency_staff", name: "Audit Staff" });
    const unrelated = await createUser({ name: "Unrelated Actor" });
    await withSystem(async (db) => {
      await recordAudit({
        actorUserId: owner.id,
        actorKind: "agency",
        action: "team.permissions_updated",
        targetType: "user",
        targetId: staff.id,
        result: "success",
        metadata: { marker: "member_event_before_global_noise" },
      }, db);
      for (let index = 0; index < 205; index += 1) {
        await recordAudit({
          actorUserId: unrelated.id,
          actorKind: "user",
          action: "unrelated.test_event",
          targetType: "test_event",
          targetId: String(index),
          result: "success",
        }, db);
      }
    });

    const view = await agencyTeamView(agencyUser(owner, "agency_super_admin"));
    const member = view.members.find((item) => item.id === staff.id)!;
    expect(member.activity).toHaveLength(1);
    expect(member.activity[0].metadata).toMatchObject({ marker: "member_event_before_global_noise" });
  });
});
