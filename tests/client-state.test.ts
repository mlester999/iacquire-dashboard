import { describe, expect, it } from "vitest";
import { countStates, plural, STATE, STATE_ORDER, stateOf } from "@/components/admin/client-state";
import type { ClientSetupRow } from "@/server/setup/snapshots";

function row(over: { orgStatus?: string; started?: boolean; state?: "in_setup" | "ready_for_review" | "activated" | null; onboarded?: boolean } = {}): ClientSetupRow {
  return {
    id: crypto.randomUUID(),
    name: "Client",
    slug: "client",
    orgStatus: over.orgStatus ?? "active",
    isDemo: false,
    createdAt: new Date().toISOString(),
    onboardingCompletedAt: over.onboarded === false ? null : new Date().toISOString(),
    contact: null,
    services: [],
    setup: { started: over.started ?? true, state: over.state === undefined ? "in_setup" : over.state, percent: 0, completed: 0, total: 18, clientActions: 0, blocked: 0, outstanding: 18, blockers: [] },
    responsible: null,
    health: { level: "not_connected", agentsOnline: 0, agentsEnabled: 6, ghl: null, calendar: null, n8n: null, failedChecks: 0, failingAgents: 0 },
    openTickets: 0,
    lastActivityAt: null,
  };
}

describe("client directory state", () => {
  it("derives each client's state, with suspension taking priority over setup progress", () => {
    expect(stateOf(row({ orgStatus: "suspended", state: "activated" }))).toBe("suspended");
    expect(stateOf(row({ started: false, state: null }))).toBe("not_started");
    expect(stateOf(row({ state: "activated" }))).toBe("activated");
    expect(stateOf(row({ state: "ready_for_review" }))).toBe("ready_for_review");
    expect(stateOf(row({ onboarded: false }))).toBe("awaiting_onboarding");
    expect(stateOf(row())).toBe("in_setup");
  });

  it("counts every client exactly once and labels every state", () => {
    const rows = [row(), row(), row({ onboarded: false }), row({ state: "activated" }), row({ orgStatus: "suspended" })];
    const counts = countStates(rows);
    expect(counts).toMatchObject({ in_setup: 2, awaiting_onboarding: 1, activated: 1, suspended: 1, ready_for_review: 0, not_started: 0 });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(rows.length);
    expect([...STATE_ORDER].sort()).toEqual(Object.keys(STATE).sort());
  });

  it("pluralizes counts", () => {
    expect(plural(1, "step")).toBe("1 step");
    expect(plural(0, "step")).toBe("0 steps");
    expect(plural(2, "support issue")).toBe("2 support issues");
    expect(plural(3, "employee")).toBe("3 employees");
  });
});
