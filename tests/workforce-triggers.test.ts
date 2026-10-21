import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { deleteTrigger, listTriggers, runDueTriggers, saveTrigger, setTriggerEnabled, triggersOperatorEnabled } from "@/server/workforce/triggers";

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let member: { id: string; email: string };
let appointmentSetterId: string;

async function emit(orgId: string, type: string): Promise<string> {
  const { rows } = await withSystem((db) =>
    db.query<{ id: string }>(
      `insert into crm_events (org_id, type, entity_type, payload, dedupe_key, actor_kind)
       values ($1, $2, 'appointment', '{}'::jsonb, $3, 'system') returning id::text as id`,
      [orgId, type, `trigger-test-${crypto.randomUUID()}`],
    ),
  );
  return rows[0].id;
}

async function waitForJob(jobId: string, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await withSystem((db) => db.query<{ status: string }>("select status from ai_work_jobs where id = $1", [jobId]));
    if (rows[0] && ["completed", "failed", "cancelled", "blocked"].includes(rows[0].status)) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("triggered job did not settle");
}

beforeAll(async () => {
  org = await createOrg({ name: "Trigger Co" });
  owner = await createUser();
  member = await createUser();
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, member.id, "member");
  appointmentSetterId = await agentId(org.id, "appointment_setter");
  for (const role of ["appointment_setter", "sales_assistant"] as const) {
    const id = await agentId(org.id, role);
    await withSystem((db) =>
      createConfigVersion(db, { orgId: org.id, agentId: id, settings: defaultSettings(role), source: "onboarding", userId: owner.id, apply: true }),
    );
  }
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where org_id = $1", [org.id]));
}, 60000);

beforeEach(() => {
  delete process.env.WORKFORCE_TRIGGERS_ENABLED;
});

afterAll(() => {
  delete process.env.WORKFORCE_TRIGGERS_ENABLED;
});

describe("AI workforce event triggers", () => {
  it("saves a trigger paused and does nothing without the operator switch", async () => {
    const saved = await saveTrigger(ctxFor(owner, org, "owner"), { eventType: "appointment.cancelled", enabled: false });
    expect(saved.enabled).toBe(false);
    expect(triggersOperatorEnabled()).toBe(false);
    await emit(org.id, "appointment.cancelled");
    const run = await runDueTriggers();
    expect(run).toMatchObject({ operatorEnabled: false, created: 0 });
    const triggers = await listTriggers(ctxFor(owner, org, "owner"));
    expect(triggers.find((trigger) => trigger.id === saved.id)).toMatchObject({ enabled: false, eventType: "appointment.cancelled" });
  });

  it("creates one durable review job for a new matching event and does not repeat it", async () => {
    process.env.WORKFORCE_TRIGGERS_ENABLED = "true";
    const saved = await saveTrigger(ctxFor(owner, org, "owner"), { eventType: "appointment.cancelled", enabled: true });
    const eventId = await emit(org.id, "appointment.cancelled");
    const run = await runDueTriggers({ limit: 3 });
    expect(run.operatorEnabled).toBe(true);
    expect(run.created).toBe(1);
    const [jobId] = run.jobIds;
    const { rows } = await withSystem((db) =>
      db.query<{ capability: string; title: string; input: Record<string, unknown> }>(
        "select capability, title, input from ai_work_jobs where id = $1",
        [jobId],
      ),
    );
    expect(rows[0].capability).toBe("appointment_review");
    expect(rows[0].title).toContain("appointment.cancelled");
    expect(rows[0].input).toMatchObject({ triggerId: saved.id, eventId });
    await waitForJob(jobId);
    const triggers = await listTriggers(ctxFor(owner, org, "owner"));
    expect(triggers.find((trigger) => trigger.id === saved.id)?.lastEventId).toBe(Number(eventId));
    const again = await runDueTriggers({ limit: 3 });
    expect(again.created).toBe(0);
  }, 30000);

  it("starts from the current event when enabled, so old events are not replayed", async () => {
    process.env.WORKFORCE_TRIGGERS_ENABLED = "true";
    const saved = await saveTrigger(ctxFor(owner, org, "owner"), { eventType: "opportunity.lost", enabled: false });
    await emit(org.id, "opportunity.lost");
    await setTriggerEnabled(ctxFor(owner, org, "owner"), saved.id, true);
    const noJob = await runDueTriggers({ limit: 3 });
    expect(noJob.created).toBe(0);
    await emit(org.id, "opportunity.lost");
    const withJob = await runDueTriggers({ limit: 3 });
    expect(withJob.created).toBe(1);
    await waitForJob(withJob.jobIds[0]);
  }, 30000);

  it("refuses a member, an unknown event type and an unavailable employee", async () => {
    await expect(
      saveTrigger(ctxFor(member, org, "member"), { eventType: "appointment.cancelled", enabled: false }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      saveTrigger(ctxFor(owner, org, "owner"), { eventType: "contact.created", enabled: false }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await withSystem((db) => db.query("update agent_instances set status = 'offline' where id = $1", [appointmentSetterId]));
    try {
      await expect(
        saveTrigger(ctxFor(owner, org, "owner"), { eventType: "appointment.no_show", enabled: false }),
      ).rejects.toMatchObject({ code: "agent_unavailable" });
    } finally {
      await withSystem((db) => db.query("update agent_instances set status = 'online' where id = $1", [appointmentSetterId]));
    }
  });

  it("enables, pauses and deletes a trigger with audit evidence", async () => {
    const saved = await saveTrigger(ctxFor(owner, org, "owner"), { eventType: "appointment.no_show", enabled: false });
    await setTriggerEnabled(ctxFor(owner, org, "owner"), saved.id, true);
    let trigger = (await listTriggers(ctxFor(owner, org, "owner"))).find((row) => row.id === saved.id);
    expect(trigger?.enabled).toBe(true);
    await setTriggerEnabled(ctxFor(owner, org, "owner"), saved.id, false);
    trigger = (await listTriggers(ctxFor(owner, org, "owner"))).find((row) => row.id === saved.id);
    expect(trigger?.enabled).toBe(false);
    await deleteTrigger(ctxFor(owner, org, "owner"), saved.id);
    expect((await listTriggers(ctxFor(owner, org, "owner"))).some((row) => row.id === saved.id)).toBe(false);
    const { rows } = await withSystem((db) =>
      db.query<{ action: string }>("select action from audit_logs where org_id = $1 and target_id = $2 order by created_at asc", [org.id, saved.id]),
    );
    expect(rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      "workforce.trigger_saved", "workforce.trigger_enabled", "workforce.trigger_disabled", "workforce.trigger_deleted",
    ]));
  });
});
