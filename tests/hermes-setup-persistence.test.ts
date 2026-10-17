import { describe, expect, it, beforeAll } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { listIntegrationManager, saveIntegrationConnection } from "@/server/integrations/manager";
import { listHermesSetupSummaries, saveHermesSetupDraft, saveHermesSetupProgress, hermesSetupDraftConfigSchema } from "@/server/integrations/hermes/setup";
import { createOrg, createUser, agencyUser } from "./support/fixtures";

const safeDraft = {
  label: "Agency Hermes gateway",
  environment: "production" as const,
  baseUrl: "https://hermes-api.iacquire.online",
  gatewayType: "multiplexed_profiles" as const,
  reportedGatewayId: "",
  declaredVersion: "",
};
const accessClientId = "synthetic-cloudflare-id";
const accessClientSecret = "synthetic-cloudflare-secret";

describe("Hermes setup persistence and concurrency", () => {
  let admin: ReturnType<typeof agencyUser>;
  let secondAdmin: ReturnType<typeof agencyUser>;
  let staff: ReturnType<typeof agencyUser>;

  beforeAll(async () => {
    const agency = await createOrg({ kind: "agency", name: "Hermes Setup Test Agency" });
    void agency;
    admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    secondAdmin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    staff = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
  });

  it("persists safe drafts and per-user resume position across manager reloads", async () => {
    const tables = await withSystem((db) => db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema='public' and table_name = any($1)",
      [["hermes_gateway_configuration_history", "hermes_gateway_setup_drafts", "hermes_gateway_setup_draft_history", "hermes_gateway_setup_progress"]],
    ));
    expect(tables.rows).toHaveLength(4);
    const first = await saveHermesSetupDraft(admin, {
      gatewayId: null,
      expectedDraftRevision: 0,
      expectedGatewayRevision: null,
      config: safeDraft,
    });
    expect(first.revision).toBe(1);
    await saveHermesSetupProgress(admin, { gatewayId: null, stepIndex: 2 });

    const manager = await listIntegrationManager(admin, null);
    expect(manager.hermesSetup).toMatchObject({
      gatewayId: null,
      navigationStep: 2,
      resumeIndex: 0,
      draft: { revision: 1, config: safeDraft, stale: false },
    });
    expect(manager.hermesSetup?.steps[0]).toMatchObject({ status: "in_progress", complete: false });
    expect(manager.hermesSetup?.steps[5]).toMatchObject({ status: "not_started", complete: false });
    expect(manager.hermesSetup?.draft?.updatedAt).toBeTruthy();
    expect(JSON.stringify(manager)).not.toContain(accessClientSecret);

    const other = await withSystem((db) => listHermesSetupSummaries(db, secondAdmin.id, []));
    expect(other.new.navigationStep).toBe(0);
    expect(other.new.draft?.config).toEqual(safeDraft);
  });

  it("rejects credentials in draft data and denies non-super-admin writes", async () => {
    expect(hermesSetupDraftConfigSchema.safeParse({ ...safeDraft, accessClientSecret }).success).toBe(false);
    await expect(saveHermesSetupDraft(staff, {
      gatewayId: null,
      expectedDraftRevision: 0,
      expectedGatewayRevision: null,
      config: safeDraft,
    })).rejects.toMatchObject({ code: "forbidden" });
    await expect(saveHermesSetupProgress(staff, { gatewayId: null, stepIndex: 4 })).rejects.toMatchObject({ code: "forbidden" });

    const ordinaryUser = await createUser();
    await expect(withUser(ordinaryUser.id, (db) => db.query("select * from hermes_gateway_setup_drafts"))).rejects.toThrow();
  });

  it("rejects stale draft and gateway revisions, preserves Vault credentials, and records safe history", async () => {
    await expect(saveHermesSetupDraft(admin, {
      gatewayId: null,
      expectedDraftRevision: 0,
      expectedGatewayRevision: null,
      config: { ...safeDraft, label: "Stale draft overwrite" },
    })).rejects.toMatchObject({ code: "conflict" });

    const gatewayId = await saveIntegrationConnection(admin, null, {
      provider: "hermes",
      label: safeDraft.label,
      environment: "production",
      accessClientId,
      accessClientSecret,
      config: { baseUrl: safeDraft.baseUrl, gatewayType: safeDraft.gatewayType },
    });
    expect(typeof gatewayId).toBe("string");
    const before = (await listIntegrationManager(admin, null)).hermesGateways.find((gateway) => gateway.id === gatewayId)!;
    expect(before.hasAccessCredential).toBe(true);
    expect((await listIntegrationManager(admin, null)).hermesSetup?.draft).toBeNull();

    const update = {
      provider: "hermes" as const,
      label: "Updated agency Hermes gateway",
      environment: "production" as const,
      config: { gatewayId: gatewayId as string, baseUrl: safeDraft.baseUrl, gatewayType: safeDraft.gatewayType },
    };
    await saveIntegrationConnection(admin, null, { ...update, gatewayRevision: before.revision });
    await expect(saveIntegrationConnection(admin, null, { ...update, gatewayRevision: before.revision })).rejects.toMatchObject({ code: "conflict" });

    const after = (await listIntegrationManager(admin, null)).hermesGateways.find((gateway) => gateway.id === gatewayId)!;
    expect(after.revision).toBe(before.revision + 1);
    expect(after.lastChangedBy).toBe("Test User");
    const history = await withSystem((db) => db.query<{ revision: number; configuration: string }>(
      "select revision,configuration::text as configuration from hermes_gateway_configuration_history where gateway_id=$1 order by revision",
      [gatewayId],
    ));
    expect(history.rows.map((row) => Number(row.revision))).toEqual([1, 2]);
    expect(JSON.stringify(history.rows)).not.toContain(accessClientId);
    expect(JSON.stringify(history.rows)).not.toContain(accessClientSecret);
    expect(JSON.stringify(history.rows)).not.toContain("accessClientSecret");
  });
});
