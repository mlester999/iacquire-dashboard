import { describe, expect, it } from "vitest";
import { deriveEmployeeReadiness } from "@/lib/workforce-readiness";

const base = {
  displayName: "Operations Manager",
  enabled: true,
  status: "provisioning" as const,
  configVersion: null,
  lastHealthCheckAt: null,
  lastHealthOk: null,
  inventoryDigest: null,
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
    const readiness = deriveEmployeeReadiness({ ...base, configVersion: 1 });
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
      configVersion: 1,
      lastHealthCheckAt: "2026-10-20T00:00:00.000Z",
      lastHealthOk: false,
      lastHealthDetail: "The gateway rejected the profile credential.",
      status: "error",
    });
    expect(readiness.stage).toBe("attention");
    expect(readiness.stage).not.toBe("ready");
    expect(readiness.steps.find((step) => step.key === "connection")?.state).toBe("blocked");
  });

  it("shows ready only when configuration, health, inventory and lifecycle all agree", () => {
    const readiness = deriveEmployeeReadiness({
      ...base,
      configVersion: 1,
      status: "online",
      lastHealthCheckAt: "2026-10-20T00:00:00.000Z",
      lastHealthOk: true,
      inventoryDigest: "a".repeat(64),
    });
    expect(readiness.stage).toBe("ready");
    expect(readiness.label).toBe("Online and ready");
    expect(readiness.cta).toBe("chat");
    expect(readiness.completed).toBe(readiness.total);
  });

  it("adds the agency-only acknowledgement and blocks a stale approval", () => {
    const readiness = deriveEmployeeReadiness({
      ...base,
      configVersion: 1,
      status: "online",
      lastHealthCheckAt: "2026-10-20T00:00:00.000Z",
      lastHealthOk: true,
      inventoryDigest: "b".repeat(64),
      acknowledgementCurrent: false,
      isAgencyEmployee: true,
    });
    expect(readiness.stage).toBe("approval");
    expect(readiness.label).toBe("Approval required");
    expect(readiness.steps.some((step) => step.key === "acknowledgement")).toBe(true);
    expect(readiness.steps.find((step) => step.key === "ready")?.state).toBe("upcoming");
  });

  it("does not expose an acknowledgement requirement to client employees", () => {
    const readiness = deriveEmployeeReadiness({
      ...base,
      configVersion: 1,
      status: "online",
      lastHealthCheckAt: "2026-10-20T00:00:00.000Z",
      lastHealthOk: true,
      inventoryDigest: "c".repeat(64),
      acknowledgementCurrent: false,
      isAgencyEmployee: false,
    });
    expect(readiness.stage).toBe("ready");
    expect(readiness.steps.some((step) => step.key === "acknowledgement")).toBe(false);
  });

  it("keeps disabled employees unavailable regardless of prior checks", () => {
    const readiness = deriveEmployeeReadiness({ ...base, enabled: false, configVersion: 1, lastHealthOk: true, status: "online", inventoryDigest: "d".repeat(64) });
    expect(readiness.stage).toBe("disabled");
    expect(readiness.cta).toBe("none");
    // Earlier checks remain recorded facts; pausing does not erase them.
    expect(readiness.completed).toBe(3);
    expect(readiness.steps.find((step) => step.key === "ready")?.state).toBe("upcoming");
  });

  it("supports list views that know only whether an active configuration exists", () => {
    const readiness = deriveEmployeeReadiness({ ...base, configured: true });
    expect(readiness.stage).toBe("connection");
    expect(readiness.completed).toBe(1);
  });
});
