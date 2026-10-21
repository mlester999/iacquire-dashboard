import { describe, expect, it } from "vitest";
import { internalAcknowledgementIsCurrent, internalIdentityIsCurrent, deriveEmployeeReadiness } from "@/lib/workforce-readiness";
import { toolInventoryReady } from "@/lib/hermes-tool-inventory";

const NOW = "2026-10-20T00:00:00.000Z";
const base = {
  displayName: "Operations Manager",
  enabled: true,
  status: "provisioning" as const,
  configVersion: null,
  lastHealthCheckAt: null,
  lastHealthOk: null,
  inventoryDigest: null,
  evaluatedAt: NOW,
};
const currentInventory = {
  configVersion: 2,
  status: "online" as const,
  lastHealthCheckAt: NOW,
  lastHealthOk: true,
  inventoryContract: "hermes.api_server.tool_catalog.v1",
  inventoryDigest: "a".repeat(64),
  inventoryVerifiedAt: NOW,
  inventoryExpiresAt: "2026-10-20T00:02:00.000Z",
  inventoryToolCount: 6,
};
const currentIdentity = {
  expectedProfile: "iacquire-operations-manager",
  savedProfile: "iacquire-operations-manager",
  savedGatewayId: "gateway-1",
  checkedProfile: "iacquire-operations-manager",
  checkedGatewayId: "gateway-1",
  checkStatus: "verified",
  identityVerified: true,
  apiContractVerified: true,
  toolPermissionsStatus: "verified",
  checkedAt: NOW,
  configAppliedAt: "2026-10-19T23:00:00.000Z",
};
const currentAcknowledgement = {
  ...currentIdentity,
  acknowledgedAt: NOW,
  acknowledgedProfile: "iacquire-operations-manager",
  acknowledgedPolicyId: "policy-1",
  expectedPolicyId: "policy-1",
  activeConfigVersionId: "config-2",
  acknowledgedConfigVersionId: "config-2",
  inventoryDigest: "a".repeat(64),
  acknowledgedInventoryDigest: "a".repeat(64),
  credentialReady: true,
  hasAgentPolicyOverride: false,
};

describe("employee readiness hierarchy", () => {
  it("starts at configuration and never invents a completed state", () => {
    const readiness = deriveEmployeeReadiness(base);
    expect(readiness.stage).toBe("setup");
    expect(readiness.label).toBe("Setup required");
    expect(readiness.cta).toBe("configure");
    expect(readiness.completed).toBe(0);
    expect(readiness.steps.find((step) => step.key === "configuration")?.state).toBe("current");
    expect(readiness.steps.find((step) => step.key === "ready")?.state).toBe("upcoming");
  });

  it("moves to a connection requirement once a configuration is applied", () => {
    const readiness = deriveEmployeeReadiness({ ...base, configVersion: 2 });
    expect(readiness.stage).toBe("connection");
    expect(readiness.cta).toBe("connection");
    expect(readiness.completed).toBe(1);
    expect(readiness.steps.find((step) => step.key === "connection")?.state).toBe("current");
  });

  it("keeps a held configuration in review instead of calling it applied", () => {
    const readiness = deriveEmployeeReadiness({ ...base, hasPendingReview: true });
    expect(readiness.stage).toBe("review");
    expect(readiness.cta).toBe("history");
    expect(readiness.steps.find((step) => step.key === "configuration")?.state).toBe("blocked");
  });

  it("surfaces a failed health check without claiming the employee is online", () => {
    const readiness = deriveEmployeeReadiness({
      ...base,
      configVersion: 2,
      lastHealthCheckAt: NOW,
      lastHealthOk: false,
      lastHealthDetail: "The gateway rejected the profile credential.",
      status: "error",
    });
    expect(readiness.stage).toBe("attention");
    expect(readiness.steps.find((step) => step.key === "connection")?.state).toBe("blocked");
  });

  it("keeps expired inventory available for server preflight while blocking incomplete evidence", () => {
    const expired = deriveEmployeeReadiness({ ...base, ...currentInventory, inventoryExpiresAt: "2026-10-19T23:59:59.000Z" });
    expect(expired.stage).toBe("ready");
    expect(expired.label).toBe("Ready for authorized work");
    expect(expired.chatAvailable).toBe(true);
    expect(expired.inventoryAttestationCurrent).toBe(false);
    expect(expired.completed).toBe(expired.total);
    expect(expired.steps.find((step) => step.key === "inventory")?.state).toBe("done");
    expect(expired.steps.find((step) => step.key === "inventory")?.description).toMatch(/refreshed server-side before a new chat is saved/);

    const incomplete = deriveEmployeeReadiness({ ...base, ...currentInventory, inventoryDigest: null });
    expect(incomplete.stage).toBe("inventory");
    expect(incomplete.chatAvailable).toBe(false);
  });

  it("blocks a revoked or missing saved credential even when the last health check passed", () => {
    const readiness = deriveEmployeeReadiness({ ...base, ...currentInventory, credentialCurrent: false });
    expect(readiness.stage).toBe("attention");
    expect(readiness.label).toBe("Connection needs attention");
    expect(readiness.chatAvailable).toBe(false);
  });

  it("shows ready only when configuration, health, inventory and lifecycle all agree", () => {
    const readiness = deriveEmployeeReadiness({ ...base, ...currentInventory });
    expect(readiness.stage).toBe("ready");
    expect(readiness.label).toBe("Ready for authorized work");
    expect(readiness.cta).toBe("chat");
    expect(readiness.chatAvailable).toBe(true);
    expect(readiness.completed).toBe(readiness.total);
    expect(readiness.total).toBe(4);
  });

  it("adds separate identity and acknowledgement gates to internal employees", () => {
    const identityBlocked = deriveEmployeeReadiness({
      ...base, ...currentInventory, isAgencyEmployee: true, identityCurrent: false, acknowledgementCurrent: false,
    });
    expect(identityBlocked.stage).toBe("identity");
    expect(identityBlocked.steps.find((step) => step.key === "identity")?.state).toBe("current");

    const acknowledgementBlocked = deriveEmployeeReadiness({
      ...base, ...currentInventory, isAgencyEmployee: true, identityCurrent: true, acknowledgementCurrent: false,
    });
    expect(acknowledgementBlocked.stage).toBe("approval");
    expect(acknowledgementBlocked.label).toBe("Awaiting Super Admin acknowledgement");
    expect(acknowledgementBlocked.steps.some((step) => step.key === "acknowledgement")).toBe(true);
    expect(acknowledgementBlocked.total).toBe(6);
    expect(acknowledgementBlocked.chatAvailable).toBe(false);
  });

  it("does not call an idle busy employee executing", () => {
    const idle = deriveEmployeeReadiness({ ...base, ...currentInventory, status: "busy" });
    expect(idle.label).toBe("Ready for authorized work");
    expect(idle.executing).toBe(false);

    const running = deriveEmployeeReadiness({ ...base, ...currentInventory, status: "busy", taskExecuting: true });
    expect(running.stage).toBe("working");
    expect(running.label).toBe("Working / executing");
  });

  it("does not expose an acknowledgement requirement to client employees", () => {
    const readiness = deriveEmployeeReadiness({
      ...base, ...currentInventory, acknowledgementCurrent: false, isAgencyEmployee: false,
    });
    expect(readiness.stage).toBe("ready");
    expect(readiness.steps.some((step) => step.key === "acknowledgement")).toBe(false);
    expect(readiness.total).toBe(4);
  });

  it("keeps disabled employees unavailable regardless of prior checks", () => {
    const readiness = deriveEmployeeReadiness({ ...base, ...currentInventory, enabled: false });
    expect(readiness.stage).toBe("disabled");
    expect(readiness.cta).toBe("none");
    expect(readiness.steps.find((step) => step.key === "ready")?.state).toBe("upcoming");
  });

  it("supports list views that know only whether an active configuration exists", () => {
    const readiness = deriveEmployeeReadiness({ ...base, configured: true });
    expect(readiness.stage).toBe("connection");
    expect(readiness.completed).toBe(1);
  });
});

describe("internal identity and acknowledgement evidence", () => {
  it("requires exact profile, gateway, permission and current-config identity evidence", () => {
    expect(internalIdentityIsCurrent(currentIdentity)).toBe(true);
    expect(internalIdentityIsCurrent({ ...currentIdentity, checkedProfile: "another-profile" })).toBe(false);
    expect(internalIdentityIsCurrent({ ...currentIdentity, toolPermissionsStatus: "incomplete" })).toBe(false);
    expect(internalIdentityIsCurrent({ ...currentIdentity, checkedAt: "2026-10-19T22:00:00.000Z" })).toBe(false);
  });

  it("binds acknowledgement to the same config, digest, policy and identity", () => {
    expect(internalAcknowledgementIsCurrent(currentAcknowledgement)).toBe(true);
    expect(internalAcknowledgementIsCurrent({ ...currentAcknowledgement, acknowledgedInventoryDigest: "b".repeat(64) })).toBe(false);
    expect(internalAcknowledgementIsCurrent({ ...currentAcknowledgement, acknowledgedConfigVersionId: "config-1" })).toBe(false);
    expect(internalAcknowledgementIsCurrent({ ...currentAcknowledgement, acknowledgedPolicyId: "other-policy" })).toBe(false);
    expect(internalAcknowledgementIsCurrent({ ...currentAcknowledgement, credentialReady: false })).toBe(false);
    expect(internalAcknowledgementIsCurrent({ ...currentAcknowledgement, hasAgentPolicyOverride: true })).toBe(false);
  });

  it("keeps internal Super Admin acknowledgement valid after the short-lived inventory attestation expires", () => {
    const expiredAt = "2026-10-19T23:59:59.000Z";
    const stillApproved = internalAcknowledgementIsCurrent(currentAcknowledgement);
    expect(toolInventoryReady({
      last_health_ok: true,
      tool_inventory_contract: currentInventory.inventoryContract,
      tool_inventory_digest: currentInventory.inventoryDigest,
      tool_inventory_verified_at: currentInventory.inventoryVerifiedAt,
      tool_inventory_expires_at: expiredAt,
      tool_inventory_tool_count: currentInventory.inventoryToolCount,
    }, new Date(NOW))).toBe(false);
    expect(stillApproved).toBe(true);

    const readiness = deriveEmployeeReadiness({
      ...base,
      ...currentInventory,
      inventoryExpiresAt: expiredAt,
      isAgencyEmployee: true,
      identityCurrent: true,
      acknowledgementCurrent: stillApproved,
    });
    expect(readiness.stage).toBe("ready");
    expect(readiness.chatAvailable).toBe(true);
    expect(readiness.completed).toBe(6);
  });
});
