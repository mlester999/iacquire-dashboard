import { describe,expect,it } from "vitest";
import { withSystem } from "@/server/db";
import { agencyTeamView } from "@/server/admin/team";
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
});
