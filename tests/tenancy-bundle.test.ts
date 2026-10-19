import { describe, expect, it } from "vitest";
import { NestedTransactionError, readSystem, withSystem } from "@/server/db";
import { loadTenancy } from "@/server/tenancy/context";
import { addMember, createOrg, createUser } from "./support/fixtures";

describe("readSystem", () => {
  it("runs a scoped read without opening a transaction", async () => {
    const { rows } = await readSystem((db) => db.query<{ n: number }>("select count(*)::int as n from users"));
    expect(rows[0].n).toBeGreaterThanOrEqual(0);
  });

  it("refuses statements that are not reads", async () => {
    await expect(readSystem((db) => db.query("update users set full_name = full_name"))).rejects.toThrow(/select statements/);
    await expect(readSystem((db) => db.query("delete from users"))).rejects.toThrow(/select statements/);
  });

  it("rejects running inside an open transaction instead of silently joining it", async () => {
    await expect(withSystem(() => readSystem((db) => db.query("select 1")))).rejects.toBeInstanceOf(NestedTransactionError);
  });
});

describe("loadTenancy", () => {
  it("returns memberships and every per-workspace override in one read", async () => {
    const user = await createUser();
    const orgA = await createOrg();
    const orgB = await createOrg();
    await addMember(orgA.id, user.id, "admin");
    await addMember(orgB.id, user.id, "member");
    await withSystem((db) =>
      db.query(
        `insert into member_permission_overrides (org_id, user_id, permission, effect)
         values ($1, $2, 'contacts.view', 'revoke'), ($3, $2, 'sales.view', 'grant')`,
        [orgA.id, user.id, orgB.id],
      ),
    );

    const { memberships, overridesByOrg } = await loadTenancy(user.id);

    expect(memberships.map((m) => m.orgId).sort()).toEqual([orgA.id, orgB.id].sort());
    expect(memberships.find((m) => m.orgId === orgA.id)?.role).toBe("admin");
    expect(overridesByOrg[orgA.id]).toEqual({ "contacts.view": "revoke" });
    expect(overridesByOrg[orgB.id]).toEqual({ "sales.view": "grant" });
  });

  it("never returns another person's memberships or overrides", async () => {
    const user = await createUser();
    const other = await createUser();
    const org = await createOrg();
    await addMember(org.id, user.id, "member");
    await addMember(org.id, other.id, "member");
    await withSystem((db) =>
      db.query("insert into member_permission_overrides (org_id, user_id, permission, effect) values ($1, $2, 'contacts.view', 'grant')", [org.id, other.id]),
    );

    const { memberships, overridesByOrg } = await loadTenancy(user.id);

    expect(memberships.map((m) => m.orgId)).toEqual([org.id]);
    expect(overridesByOrg).toEqual({});
  });

  it("omits archived workspaces", async () => {
    const user = await createUser();
    const archived = await createOrg({ name: "Archived Co", status: "archived" });
    const active = await createOrg({ name: "Active Co" });
    await addMember(archived.id, user.id, "member");
    await addMember(active.id, user.id, "member");

    const { memberships } = await loadTenancy(user.id);

    expect(memberships.map((m) => m.orgId)).toEqual([active.id]);
  });
});
