import { describe, expect, it } from "vitest";
import { NestedTransactionError, withSystem, withUser } from "@/server/db";
import { getAdminOverview } from "@/server/admin/queries";
import { getSystemHealth } from "@/server/admin/health";
import { agencyUser, createUser } from "./support/fixtures";

describe("transaction nesting guard", () => {
  it("rejects a transaction opened inside another instead of deadlocking", async () => {
    const user = await createUser();
    await expect(withUser(user.id, () => withSystem((db) => db.query("select 1")))).rejects.toBeInstanceOf(NestedTransactionError);
    await expect(withSystem(() => withSystem((db) => db.query("select 1")))).rejects.toBeInstanceOf(NestedTransactionError);
  });

  it("allows sequential transactions and work scheduled after one closes", async () => {
    let later: Promise<unknown> | null = null;
    await withSystem(async (db) => {
      await db.query("select 1");
      // Fire-and-forget work only touches the database after this transaction has finished.
      later = new Promise((resolve) => setTimeout(resolve, 20)).then(() => withSystem((d) => d.query("select 1")));
    });
    await expect(later).resolves.toBeTruthy();
    await expect(withSystem((db) => db.query("select 1"))).resolves.toBeTruthy();
  });
});

describe("agency dashboard", () => {
  it("loads the overview for a super admin without nesting transactions", async () => {
    const admin = await createUser({ platformRole: "agency_super_admin" });
    const overview = await getAdminOverview(agencyUser(admin, "agency_super_admin"));
    expect(overview.clients).toBeGreaterThanOrEqual(0);
    expect(overview.newAccessRequests).toBeGreaterThanOrEqual(0);
  });

  it("builds the system health report", async () => {
    const health = await getSystemHealth();
    expect(health).toBeTruthy();
  });

  it("does not count access requests for agency staff", async () => {
    const staff = await createUser({ platformRole: "agency_staff" });
    expect((await getAdminOverview(agencyUser(staff, "agency_staff"))).newAccessRequests).toBe(0);
  });
});
