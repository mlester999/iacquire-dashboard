import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { defaultSettings } from "@/server/workforce/compiler";
import { createConfigVersion, decideHeldVersion, listConfigVersions } from "@/server/workforce/service";
import { addMember, agentId, createOrg, createUser } from "./support/fixtures";

async function notificationsFor(userId: string) {
  const { rows } = await withSystem((db) =>
    db.query<{ kind: string; title: string; body: string | null; link: string | null }>(
      "select kind, title, body, link from notifications where user_id = $1 order by created_at",
      [userId],
    ),
  );
  return rows;
}

// A review-level instruction: it may let external work proceed without approval, but it is not a
// blocked instruction-override attempt.
const risky = () => ({ ...defaultSettings("sales_assistant"), customInstruction: "Send quotes automatically without approval." });

describe("configuration review notifications", () => {
  it("notifies the client with a confirmation and the scoped agency reviewer with the actionable review", async () => {
    const clientOrg = await createOrg({ name: "Review Client" });
    const owner = await createUser();
    const reviewer = await createUser({ platformRole: "agency_staff" });
    const otherReviewer = await createUser({ platformRole: "agency_staff" });
    const agent = await agentId(clientOrg.id, "sales_assistant");
    await addMember(clientOrg.id, owner.id, "owner");
    await withSystem(async (db) => {
      await db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [clientOrg.id, reviewer.id]);
    });

    const held = await withSystem((db) =>
      createConfigVersion(db, {
        orgId: clientOrg.id,
        agentId: agent,
        settings: risky(),
        source: "change_request",
        changeRequest: "Make the sales assistant more direct",
        userId: owner.id,
        apply: true,
      }),
    );
    expect(held.status).toBe("pending_agency_review");

    const ownerFeed = await notificationsFor(owner.id);
    expect(ownerFeed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "agent_status",
          title: expect.stringContaining("waiting for iAcquire review"),
          link: expect.stringContaining("/workforce/sales-assistant"),
        }),
      ]),
    );

    const reviewerFeed = await notificationsFor(reviewer.id);
    expect(reviewerFeed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "approval_requested",
          title: expect.stringContaining("Review Client"),
          link: `/admin/clients/${clientOrg.id}?tab=reviews`,
        }),
      ]),
    );
    // A reviewer outside the client's scope must not receive the tenant-specific review notice.
    expect(await notificationsFor(otherReviewer.id)).toEqual([]);

    await withSystem((db) => decideHeldVersion(db, { orgId: clientOrg.id, versionId: held.versionId, approve: false, agencyUserId: reviewer.id }));
    const decided = await notificationsFor(owner.id);
    expect(decided).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "approval_decided",
          title: expect.stringContaining("was not approved"),
          link: "/workforce/sales-assistant?tab=history",
        }),
      ]),
    );
    const versions = await listConfigVersions(owner.id, agent);
    expect(versions.find((version) => version.id === held.versionId)).toMatchObject({
      status: "rejected",
      decided_by: reviewer.id,
      // The reviewer is not in the client workspace, so the name is correctly not visible to the
      // client. The UI labels that absence instead of inventing a reviewer name.
      decided_by_name: null,
    });
  });

  it("does not send the client-facing waiting message to an internal agency workspace", async () => {
    const agencyOrg = await createOrg({ name: "Agency Internal", kind: "agency" });
    const superAdmin = await createUser({ platformRole: "agency_super_admin" });
    const agent = await agentId(agencyOrg.id, "operations_manager");
    await addMember(agencyOrg.id, superAdmin.id, "owner");

    const held = await withSystem((db) =>
      createConfigVersion(db, {
        orgId: agencyOrg.id,
        agentId: agent,
        settings: { ...defaultSettings("operations_manager"), customInstruction: "Send customer updates without approval." },
        source: "agency",
        userId: superAdmin.id,
        apply: true,
      }),
    );
    expect(held.status).toBe("pending_agency_review");
    expect(await notificationsFor(superAdmin.id)).toEqual([]);
  });

  it("stores and exposes the settings snapshot and decision metadata used by the version UI", async () => {
    const clientOrg = await createOrg({ name: "Version Metadata Client" });
    const owner = await createUser();
    const agent = await agentId(clientOrg.id, "sales_assistant");
    await addMember(clientOrg.id, owner.id, "owner");
    const version = await withSystem((db) =>
      createConfigVersion(db, {
        orgId: clientOrg.id,
        agentId: agent,
        settings: { ...defaultSettings("sales_assistant"), tone: "professional" },
        source: "client_edit",
        userId: owner.id,
        apply: true,
      }),
    );
    const [row] = await listConfigVersions(owner.id, agent);
    expect(row.id).toBe(version.versionId);
    expect(row.settings).toMatchObject({ tone: "professional" });
    expect(row).toMatchObject({ policy_version: expect.any(String), decided_at: expect.any(Date), source: "client_edit" });
    expect(row.created_by_name).toBe("Test User");
  });
});
