import { describe, expect, it } from "vitest";
import { fleetHealth, type FleetHealthFacts } from "@/lib/setup/health";

function facts(patch: Partial<FleetHealthFacts> = {}): FleetHealthFacts {
  return {
    agentsOnline: 6,
    agentsEnabled: 6,
    failedChecks: 0,
    failingAgents: 0,
    ghl: null,
    calendar: null,
    n8n: null,
    crmMode: "native",
    setupState: "activated",
    nativeRecords: 0,
    ...patch,
  };
}

describe("agency fleet health", () => {
  it("treats an activated native workspace with its agents online as healthy without GoHighLevel", () => {
    expect(fleetHealth(facts())).toBe("healthy");
    expect(fleetHealth(facts({ crmMode: null, setupState: null, nativeRecords: 3 }))).toBe("healthy");
  });

  it("treats a native workspace with real CRM records as configured", () => {
    expect(fleetHealth(facts({ setupState: "in_setup", nativeRecords: 12 }))).toBe("healthy");
  });

  it("does not call an empty native workspace connected or healthy", () => {
    expect(fleetHealth(facts({ agentsOnline: 0, setupState: null, nativeRecords: 0 }))).toBe("not_connected");
    expect(fleetHealth(facts({ agentsOnline: 0, setupState: "in_setup", nativeRecords: 0 }))).toBe("not_connected");
  });

  it("keeps healthy native clients in partial while their agents are offline", () => {
    expect(fleetHealth(facts({ agentsOnline: 0 }))).toBe("partial");
  });

  it("keeps the GoHighLevel rule for GoHighLevel workspaces", () => {
    expect(fleetHealth(facts({ crmMode: "ghl", setupState: null, ghl: "connected", calendar: "connected", n8n: "connected" }))).toBe("healthy");
    expect(fleetHealth(facts({ crmMode: "ghl", setupState: null, ghl: null, calendar: null, n8n: null }))).toBe("partial");
  });

  it("accepts either side of a controlled hybrid", () => {
    expect(fleetHealth(facts({ crmMode: "hybrid", setupState: null, nativeRecords: 2 }))).toBe("healthy");
    expect(fleetHealth(facts({ crmMode: "hybrid", setupState: null, ghl: "connected", calendar: "connected", n8n: "connected" }))).toBe("healthy");
  });

  it("reports failures before configuration state", () => {
    expect(fleetHealth(facts({ failedChecks: 1 }))).toBe("issue");
    expect(fleetHealth(facts({ failingAgents: 1 }))).toBe("issue");
    expect(fleetHealth(facts({ n8n: "error" }))).toBe("issue");
  });
});
