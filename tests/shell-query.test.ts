import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { getShellData } from "@/server/queries/shell";
import { listNotifications, markNotificationsRead } from "@/server/notifications";
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

  describe("Automation Studio plan in the menu", () => {
    const plan = (orgId: string, userId: string, status: string, extra = "") =>
      withSystem((db) =>
        db.query(
          `insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on${extra ? ", past_due_since, grace_ends_at" : ""})
           values ($1, $3, 29900, 4, 't', $2, now() - interval '10 days', current_date - 10${extra ? `, ${extra}` : ""})`,
          [orgId, userId, status],
        ),
      );
    const studio = async (name: string, role: "owner" | "viewer" = "owner") => {
      const user = await createUser();
      const org = await createOrg({ name });
      await addMember(org.id, user.id, role);
      return { user, org, shell: () => getShellData(ctxFor(user, org, role)) };
    };

    it("reads the plan as the signed-in person (the lifecycle columns are not table-granted to them) and says it is not entitled without one", async () => {
      const w = await studio("Studio menu: no plan");
      expect((await w.shell()).automationStudio).toEqual({ entitled: false });
    });

    it.each([
      ["an active plan", "active", "", true],
      ["a past-due plan still inside its grace period", "past_due", "now() - interval '1 day', now() + interval '3 days'", true],
      ["a past-due plan whose grace period has ended", "past_due", "now() - interval '9 days', now() - interval '1 day'", false],
      ["an expired plan", "expired", "", false],
      ["a plan that is only requested", "requested", "", false],
    ])("%s", async (_name, status, extra, entitled) => {
      const w = await studio(`Studio menu: ${status}`);
      await plan(w.org.id, w.user.id, status, extra);
      expect((await w.shell()).automationStudio).toEqual({ entitled });
    });

    it("never shows another workspace's plan, and says nothing to people who can't see automations", async () => {
      const mine = await studio("Studio menu: mine");
      const other = await studio("Studio menu: theirs");
      await plan(other.org.id, other.user.id, "active");
      expect((await mine.shell()).automationStudio).toEqual({ entitled: false });
      const viewer = await studio("Studio menu: viewer", "viewer");
      await plan(viewer.org.id, viewer.user.id, "active");
      expect((await viewer.shell()).automationStudio).toBeUndefined();
    });
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

  it("keeps a client's notification feed inside the active workspace", async () => {
    const user = await createUser();
    const primary = await createOrg({ name: "Primary workspace" });
    const other = await createOrg({ name: "Other workspace" });
    await addMember(primary.id, user.id, "owner");
    await addMember(other.id, user.id, "owner");
    await withSystem((db) =>
      db.query(
        `insert into notifications (org_id,user_id,kind,severity,title) values
         ($1,$3,'system','info','Primary workspace alert'),
         ($2,$3,'system','info','Other workspace alert'),
         (null,$3,'system','info','Account-level notice')`,
        [primary.id, other.id, user.id],
      ),
    );

    const shell = await getShellData(ctxFor(user, primary, "owner"));
    expect(shell.unreadNotifications).toBe(2);

    const scoped = await listNotifications(user.id, { limit: 20, orgId: primary.id });
    expect(scoped.items.map((item) => item.title)).toEqual(expect.arrayContaining(["Primary workspace alert", "Account-level notice"]));
    expect(scoped.items.map((item) => item.title)).not.toContain("Other workspace alert");
    expect(scoped.unread).toBe(2);

    // The same signed-in person is a member of both workspaces, so an unscoped agency-style feed may
    // include both; the workspace filter above is what keeps the client shell in one tenant.
    const unscoped = await listNotifications(user.id, { limit: 20 });
    expect(unscoped.items.map((item) => item.title)).toEqual(expect.arrayContaining(["Primary workspace alert", "Other workspace alert", "Account-level notice"]));

    await markNotificationsRead(user.id, "all", { orgId: primary.id });
    const rows = await withSystem((db) =>
      db.query<{ title: string; read_at: Date | null; org_id: string | null }>(
        "select title, read_at, org_id from notifications where user_id = $1 order by title",
        [user.id],
      ),
    );
    expect(rows.rows.find((row) => row.title === "Primary workspace alert")?.read_at).not.toBeNull();
    expect(rows.rows.find((row) => row.title === "Account-level notice")?.read_at).not.toBeNull();
    expect(rows.rows.find((row) => row.title === "Other workspace alert")?.read_at).toBeNull();
  });
});
