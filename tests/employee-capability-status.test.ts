import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { loadCapabilityActivity } from "@/server/workforce/capability-status";
import {
  capabilityChecksFor, CAPABILITY_KEYS, deriveCapabilityChecks, provedCapabilityCount, type CapabilityActivity, type CapabilityInput,
} from "@/lib/employee-capability-status";
import { agentId, createOrg, createUser } from "./support/fixtures";

const NOW = new Date("2026-10-28T08:00:00Z");
const base: CapabilityInput = {
  configured: true, configVersion: 3, enabled: true, connected: true, runtimeStatus: "online", inventoryVerified: true, inventoryToolCount: 6,
  prerequisitesMet: true, missingPrerequisites: [], mode: "approval_required", activity: null, now: NOW,
};
const read = (over: Partial<NonNullable<CapabilityActivity["lastEvidenceRead"]>> = {}) => ({ at: "2026-10-28T07:00:00Z", ok: true, unavailableAreas: [], role: "crm_manager", ...over });
const activity = (over: Partial<CapabilityActivity> = {}): CapabilityActivity => ({ lastEvidenceRead: null, completedChatRuns: 0, lastCompletedChatAt: null, scheduledJobsOn: 0, ...over });
const by = (checks: ReturnType<typeof deriveCapabilityChecks>) => Object.fromEntries(checks.map((c) => [c.key, c.state]));

describe("capability checks", () => {
  it("always lists the eight facts in a fixed order", () => {
    expect(deriveCapabilityChecks(base).map((c) => c.key)).toEqual([...CAPABILITY_KEYS]);
  });

  it("a configured, connected employee is not marked able to read records or to have chatted until that is recorded", () => {
    const checks = deriveCapabilityChecks(base);
    expect(by(checks)).toMatchObject({ configuration: "yes", connected: "yes", tools: "yes", business_setup: "yes", read_only: "not_verified", real_chat: "not_verified", automatic_work: "no", approval_for_changes: "yes" });
    expect(provedCapabilityCount(checks)).toEqual({ proved: 4, total: 6 });
  });

  it("a recent complete read and a completed chat make those two facts yes", () => {
    const checks = deriveCapabilityChecks({ ...base, activity: activity({ lastEvidenceRead: read(), completedChatRuns: 2, lastCompletedChatAt: "2026-10-28T07:05:00Z" }) });
    expect(by(checks)).toMatchObject({ read_only: "yes", real_chat: "yes" });
    expect(provedCapabilityCount(checks)).toEqual({ proved: 6, total: 6 });
  });

  it("a read that could not reach an area is no, naming the area only for administrators", () => {
    const checks = deriveCapabilityChecks({ ...base, activity: activity({ lastEvidenceRead: read({ ok: false, unavailableAreas: ["calendar"] }) }) });
    const check = checks.find((c) => c.key === "read_only")!;
    expect(check.state).toBe("no");
    expect(check.admin).toContain("calendar");
    expect(check.customer).not.toContain("calendar");
  });

  it("old evidence does not count", () => {
    const stale = deriveCapabilityChecks({ ...base, activity: activity({ lastEvidenceRead: read({ at: "2026-08-01T00:00:00Z" }), completedChatRuns: 5, lastCompletedChatAt: "2026-08-01T00:00:00Z" }) });
    expect(by(stale)).toMatchObject({ read_only: "not_verified", real_chat: "not_verified" });
  });

  it("missing setup, an unverified tool set and a switched-off employee are each reported on their own", () => {
    const checks = deriveCapabilityChecks({ ...base, configured: false, configVersion: null, enabled: false, inventoryVerified: false, prerequisitesMet: false, missingPrerequisites: ["A booking calendar"] });
    expect(by(checks)).toMatchObject({ configuration: "no", connected: "no", tools: "not_verified", business_setup: "no" });
    expect(checks.find((c) => c.key === "business_setup")!.customer).toContain("A booking calendar");
    expect(by(deriveCapabilityChecks({ ...base, prerequisitesMet: null }))).toMatchObject({ business_setup: "not_verified" });
  });

  it("working on its own is yes only for an autonomous employee or switched-on schedules", () => {
    expect(by(deriveCapabilityChecks({ ...base, mode: "autonomous" })).automatic_work).toBe("yes");
    expect(by(deriveCapabilityChecks({ ...base, activity: activity({ scheduledJobsOn: 2 }) })).automatic_work).toBe("yes");
    expect(by(deriveCapabilityChecks(base)).automatic_work).toBe("no");
  });

  it("customer sentences contain no technical wording", () => {
    const checks = deriveCapabilityChecks({ ...base, activity: activity({ lastEvidenceRead: read({ ok: false, unavailableAreas: ["crm quality"] }), completedChatRuns: 1, lastCompletedChatAt: "2026-10-28T07:05:00Z" }) });
    for (const check of checks) expect(check.customer, check.key).not.toMatch(/\b(?:tool registry|toolset|digest|inventory|api|schema|rls|endpoint|[a-z]+\.[a-z_]+)\b/i);
  });

  it("builds from the readiness result so it cannot disagree with the badge", () => {
    const checks = capabilityChecksFor({
      readiness: { chatAvailable: false, inventoryAttestationCurrent: false, blocking: [{ key: "calendar", label: "A booking calendar", met: false, blocking: true, detail: "", fixHref: null }], requirements: [{ key: "calendar", label: "A booking calendar", met: false, blocking: true, detail: "", fixHref: null }] },
      configVersion: 1, enabled: true, status: "offline", mode: "approval_required", inventoryToolCount: null, activity: null, now: NOW,
    });
    expect(by(checks)).toMatchObject({ configuration: "yes", connected: "no", tools: "not_verified", business_setup: "no" });
  });
});

describe("recorded capability activity", () => {
  it("reads the latest usable evidence read, completed chats and schedules, and ignores reads nobody could see", async () => {
    const org = await createOrg({ name: "Capability Activity Co" });
    const crm = await agentId(org.id, "crm_manager");
    const lead = await agentId(org.id, "lead_hunter");
    const analyst = await agentId(org.id, "performance_analyst");
    const person = await createUser({ name: "Capability Person" });
    await withSystem(async (db) => {
      const audit = (agent: string, result: string, sections: Record<string, string>, at: string) => db.query(
        `insert into audit_logs (org_id, actor_kind, agent_instance_id, action, target_type, result, metadata, created_at)
         values ($1, 'agent', $2, 'workforce.employee_evidence_read', 'workspace_evidence', $3, $4, $5)`,
        [org.id, agent, result, JSON.stringify({ role: "x", sections }), at],
      );
      await audit(crm, "success", { crm: "empty", pipeline: "ready" }, "2026-10-27T10:00:00Z");
      await audit(crm, "success", { crm: "no_permission", pipeline: "no_permission" }, "2026-10-28T06:00:00Z"); // newer, but the asker could see nothing
      await audit(lead, "failure", { leads: "unavailable", targeting: "ready" }, "2026-10-28T06:30:00Z");
      const conversation = await db.query<{ id: string }>(
        "insert into chat_conversations (org_id, agent_instance_id, user_id, hermes_session_id) values ($1, $2, $3, $4) returning id",
        [org.id, crm, person.id, `session-${crypto.randomUUID()}`],
      );
      for (const [i, status] of (["completed", "completed", "failed"] as const).entries()) {
        await db.query(
          `insert into agent_runs (org_id, agent_instance_id, purpose, idempotency_key, status, started_at, finished_at, conversation_id)
           values ($1, $2, 'chat', $3, $4, '2026-10-28T05:00:00Z', $5, $6)`,
          [org.id, crm, `capability-${i}-${crypto.randomUUID()}`, status, `2026-10-28T0${5 + i}:30:00Z`, conversation.rows[0].id],
        );
      }
      await db.query("insert into ai_work_schedules (org_id, agent_instance_id, capability, enabled) values ($1, $2, 'performance_snapshot', true)", [org.id, analyst]);
    });
    const result = await loadCapabilityActivity(org.id, [crm, lead, analyst]);
    expect(result.get(crm)).toMatchObject({
      lastEvidenceRead: { at: "2026-10-27T10:00:00.000Z", ok: true, unavailableAreas: [] },
      completedChatRuns: 2,
      scheduledJobsOn: 0,
    });
    expect(result.get(lead)!.lastEvidenceRead).toMatchObject({ ok: false, unavailableAreas: ["leads"] });
    expect(result.get(analyst)).toMatchObject({ lastEvidenceRead: null, completedChatRuns: 0, scheduledJobsOn: 1 });
  });

  it("never counts another workspace's records", async () => {
    const a = await createOrg({ name: "Activity A" });
    const b = await createOrg({ name: "Activity B" });
    const agentA = await agentId(a.id, "crm_manager");
    const agentB = await agentId(b.id, "crm_manager");
    await withSystem((db) => db.query(
      `insert into audit_logs (org_id, actor_kind, agent_instance_id, action, target_type, result, metadata) values ($1, 'agent', $2, 'workforce.employee_evidence_read', 'workspace_evidence', 'success', $3)`,
      [b.id, agentB, JSON.stringify({ role: "crm_manager", sections: { crm: "ready" } })],
    ));
    const fromA = await loadCapabilityActivity(a.id, [agentA, agentB]);
    expect(fromA.get(agentA)!.lastEvidenceRead).toBeNull();
    expect(fromA.get(agentB)!.lastEvidenceRead).toBeNull();
  });
});
