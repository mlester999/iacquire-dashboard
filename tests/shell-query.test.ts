import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { getShellData } from "@/server/queries/shell";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

describe("portal shell query", () => {
  it("loads the tenant-aware shell summary with the expected defaults", async () => {
    const user = await createUser();
    const org = await createOrg({ name: "Shell query workspace" });
    await addMember(org.id, user.id, "owner");

    const shell = await getShellData(ctxFor(user, org, "owner"));

    expect(shell.agents).toHaveLength(6);
    expect(shell.agents.every((agent) => agent.enabled && agent.status === "setup_required")).toBe(true);
    expect(shell.unreadNotifications).toBe(0);
    expect(shell.pendingApprovals).toBe(0);
    expect(shell.setup).toEqual({ visible: false, percent: null, needsAttention: 0 });
    expect(shell.projectsAttention).toBe(0);
    expect(shell.inboxAttention).toBe(0);
    expect(shell.crmMode).toBe("native");
  });

  it("keeps notification preferences and critical alerts in the unread count", async () => {
    const user = await createUser();
    const org = await createOrg({ name: "Shell notifications workspace" });
    await addMember(org.id, user.id, "owner");
    await withSystem(async (db) => {
      await db.query("insert into notification_preferences (user_id,org_id,prefs) values ($1,$2,$3::jsonb)", [
        user.id,
        org.id,
        JSON.stringify({ approvals: false, workforce: false, calendar: false }),
      ]);
      await db.query(
        `insert into notifications (org_id,user_id,kind,severity,title) values
         ($1,$2,'approval_requested','info','Hidden approval'),
         ($1,$2,'agent_status','info','Hidden workforce alert'),
         ($1,$2,'booking_confirmed','info','Hidden calendar notice'),
         ($1,$2,'approval_decided','critical','Critical approval alert'),
         ($1,$2,'system','info','Visible system alert')`,
        [org.id, user.id],
      );
    });

    const shell = await getShellData(ctxFor(user, org, "owner"));

    expect(shell.unreadNotifications).toBe(2);
  });
});
