// The eight readiness states, the role prerequisites and the degraded / unavailable split, on the pure model every screen shares. A saved configuration, a passing health check
// and a verified tool inventory are NOT "ready for authorized work" on their own: the role's blocking prerequisites must be in place too.
import { describe, expect, it } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import {
  HEALTH_FAILURE_THRESHOLD, READINESS_STATE_LABEL, deriveEmployeeReadiness, readinessStateOf, type EmployeeReadinessInput, type HealthSummary, type ReadinessStage, type ReadinessState,
} from "@/lib/workforce-readiness";
import { EMPTY_WORKSPACE_FACTS, ROLE_REQUIREMENTS, blockingUnmet, evaluateRequirements, type WorkspaceFacts } from "@/lib/employee-requirements";

const NOW = "2026-10-26T00:00:00.000Z";
const verified: EmployeeReadinessInput = {
  displayName: "Employee", enabled: true, status: "online", configVersion: 2, lastHealthCheckAt: NOW, lastHealthOk: true,
  inventoryContract: "hermes.api_server.tool_catalog.v1", inventoryDigest: "a".repeat(64), inventoryVerifiedAt: NOW, inventoryExpiresAt: "2026-10-26T00:02:00.000Z", inventoryToolCount: 6,
  credentialCurrent: true, evaluatedAt: NOW,
};
const ALL_FACTS: WorkspaceFacts = { knowledgeApproved: true, calendarReady: true, crmReady: true, pipelineReady: true, leadTargetingSet: true, customerChannelReady: true };
const health = (over: Partial<HealthSummary> = {}): HealthSummary => ({ consecutiveFailures: 0, lastHealthyAt: NOW, lastFailureAt: null, lastProbeAt: NOW, lastProbeSource: "scheduled", ...over });

describe("every stage maps to exactly one of the eight states", () => {
  const STAGES: ReadinessStage[] = ["disabled", "suspended", "review", "setup", "connection", "inventory", "identity", "attention", "approval", "incomplete", "degraded", "ready", "working"];
  it("covers every stage and names every state", () => {
    const seen = new Set<ReadinessState>(STAGES.map(readinessStateOf));
    // "provisioning" is a state of the connection stages while the provisioner is creating the profile (below), so it is not the image of any stage alone.
    expect([...seen].sort()).toEqual(["configuration_incomplete", "connection_required", "degraded", "pending_setup", "ready", "suspended", "unavailable"]);
    expect(Object.keys(READINESS_STATE_LABEL).sort()).toEqual(["configuration_incomplete", "connection_required", "degraded", "pending_setup", "provisioning", "ready", "suspended", "unavailable"]);
    expect(READINESS_STATE_LABEL.ready).toBe("Ready for authorized work");
  });
});

describe("a verified connection is not enough: the role's blocking prerequisites decide 'ready'", () => {
  it("reads Ready exactly as before when the loader supplies no prerequisites", () => {
    const r = deriveEmployeeReadiness(verified);
    expect(r.stage).toBe("ready");
    expect(r.state).toBe("ready");
    expect(r.workReady).toBe(true);
    expect(r.requirements).toEqual([]);
  });

  it("reads Configuration incomplete, still able to chat, when a blocking prerequisite is missing", () => {
    const requirements = evaluateRequirements("appointment_setter", { ...ALL_FACTS, calendarReady: false });
    const r = deriveEmployeeReadiness({ ...verified, extras: { requirements } });
    expect(r.stage).toBe("incomplete");
    expect(r.state).toBe("configuration_incomplete");
    expect(r.label).toBe("Configuration incomplete");
    expect(r.chatAvailable).toBe(true); // the connection is verified: it can chat and explain what is missing
    expect(r.workReady).toBe(false);
    expect(r.blocking.map((b) => b.key)).toEqual(["calendar"]);
    expect(r.description).toMatch(/no appointment can be offered or booked/);
    const step = r.steps.find((s) => s.key === "requirements");
    expect(step?.state).toBe("current");
    expect(r.steps.find((s) => s.key === "ready")?.state).toBe("upcoming");
    expect(r.completed).toBe(r.total - 2);
  });

  it("reads Ready once the prerequisites are in place, and an advisory gap does not stop it", () => {
    const withoutChannel = evaluateRequirements("appointment_setter", { ...ALL_FACTS, customerChannelReady: false });
    expect(blockingUnmet(withoutChannel)).toEqual([]);
    const r = deriveEmployeeReadiness({ ...verified, extras: { requirements: withoutChannel } });
    expect(r.stage).toBe("ready");
    expect(r.workReady).toBe(true);
    expect(r.steps.find((s) => s.key === "requirements")?.description).toMatch(/Still helpful: a customer channel/);
  });

  it("never lets a prerequisite make an unverified connection look better", () => {
    const requirements = evaluateRequirements("crm_manager", ALL_FACTS);
    const r = deriveEmployeeReadiness({ ...verified, status: "offline", lastHealthOk: false, extras: { requirements } });
    expect(r.state).not.toBe("ready");
    expect(r.chatAvailable).toBe(false);
    expect(r.workReady).toBe(false);
  });

  it("gives each of the six roles its own blocking prerequisites, and every role's list is non-empty and uses real facts", () => {
    const blockingByRole = Object.fromEntries(AGENT_ROLE_KEYS.map((role) => [role, evaluateRequirements(role, EMPTY_WORKSPACE_FACTS).filter((x) => x.blocking).map((x) => x.key)]));
    expect(blockingByRole).toEqual({
      operations_manager: [],
      lead_hunter: ["knowledge", "lead_targeting"],
      appointment_setter: ["knowledge", "calendar"],
      sales_assistant: ["knowledge", "pipeline"],
      crm_manager: ["crm"],
      performance_analyst: ["crm"],
    });
    for (const role of AGENT_ROLE_KEYS) {
      expect(ROLE_REQUIREMENTS[role].length, role).toBeGreaterThan(0);
      expect(blockingUnmet(evaluateRequirements(role, ALL_FACTS)), role).toEqual([]);
      for (const x of evaluateRequirements(role, EMPTY_WORKSPACE_FACTS)) expect(x.fixHref === null || x.fixHref.startsWith("/"), `${role}/${x.key}`).toBe(true);
    }
  });

  it("does not let the Appointment Setter read Ready on another role's facts", () => {
    const sales = evaluateRequirements("sales_assistant", { ...ALL_FACTS, calendarReady: false });
    expect(blockingUnmet(sales)).toEqual([]);
    const setter = evaluateRequirements("appointment_setter", { ...ALL_FACTS, pipelineReady: false });
    expect(blockingUnmet(setter)).toEqual([]);
  });
});

describe("degraded and unavailable are told apart by the probe's record", () => {
  const failing: EmployeeReadinessInput = { ...verified, status: "offline", lastHealthOk: false, lastHealthDetail: "Hermes did not answer." };

  it("is Degraded while fewer than the threshold of probes have failed since the employee was last healthy", () => {
    for (let n = 1; n < HEALTH_FAILURE_THRESHOLD; n += 1) {
      const r = deriveEmployeeReadiness({ ...failing, extras: { health: health({ consecutiveFailures: n, lastFailureAt: NOW }) } });
      expect(r.stage, `${n} failures`).toBe("degraded");
      expect(r.state).toBe("degraded");
      expect(r.chatAvailable).toBe(false); // the recorded status is offline, so the run gate still refuses
      expect(r.description).toContain(`${n} of ${HEALTH_FAILURE_THRESHOLD}`);
    }
  });

  it("is Unavailable at the threshold, and when it was never seen healthy", () => {
    const atThreshold = deriveEmployeeReadiness({ ...failing, extras: { health: health({ consecutiveFailures: HEALTH_FAILURE_THRESHOLD, lastFailureAt: NOW }) } });
    expect(atThreshold.state).toBe("unavailable");
    expect(atThreshold.label).toBe("Unavailable");
    expect(atThreshold.title).toContain(`${HEALTH_FAILURE_THRESHOLD} failed checks`);
    const neverHealthy = deriveEmployeeReadiness({ ...failing, extras: { health: health({ consecutiveFailures: 1, lastHealthyAt: null, lastFailureAt: NOW }) } });
    expect(neverHealthy.state).toBe("unavailable");
  });

  it("returns to Ready the moment a probe passes (the count is of consecutive failures)", () => {
    const r = deriveEmployeeReadiness({ ...verified, extras: { health: health({ consecutiveFailures: 0 }) } });
    expect(r.state).toBe("ready");
    expect(r.health?.consecutiveFailures).toBe(0);
  });
});

describe("suspension, setup, provisioning and connection", () => {
  it("reads Suspended for a suspended workspace and for a paused employee, with the reason", () => {
    const ws = deriveEmployeeReadiness({ ...verified, extras: { suspended: { reason: "This workspace is suspended. Contact iAcquire." } } });
    expect(ws.state).toBe("suspended");
    expect(ws.description).toBe("This workspace is suspended. Contact iAcquire.");
    const paused = deriveEmployeeReadiness({ ...verified, enabled: false });
    expect(paused.state).toBe("suspended");
  });

  it("reads Pending setup before any configuration, Connection required once configured, and Provisioning while the provisioner works", () => {
    const fresh: EmployeeReadinessInput = { displayName: "E", enabled: true, status: "setup_required", configVersion: null, lastHealthCheckAt: null, lastHealthOk: null, inventoryDigest: null, evaluatedAt: NOW };
    expect(deriveEmployeeReadiness(fresh).state).toBe("pending_setup");
    expect(deriveEmployeeReadiness({ ...fresh, configVersion: 1 }).state).toBe("connection_required");
    expect(deriveEmployeeReadiness({ ...fresh, configVersion: 1, status: "provisioning" }).state).toBe("provisioning");
    expect(deriveEmployeeReadiness({ ...fresh, paymentCleared: false }).state).toBe("pending_setup");
  });

  it("never reads Ready from saved configuration alone, for any role", () => {
    for (const role of AGENT_ROLE_KEYS as readonly AgentRoleKey[]) {
      const r = deriveEmployeeReadiness({ displayName: role, enabled: true, status: "setup_required", configVersion: 3, lastHealthCheckAt: null, lastHealthOk: null, inventoryDigest: null, evaluatedAt: NOW, extras: { requirements: evaluateRequirements(role, ALL_FACTS) } });
      expect(r.state, role).not.toBe("ready");
      expect(r.workReady, role).toBe(false);
    }
  });
});
