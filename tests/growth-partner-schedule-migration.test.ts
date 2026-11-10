import { describe, expect, it } from "vitest";
import { previewGrowthPartnerScheduleMigration } from "@/server/admin/growth-partner-migration";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { ensureGrowthPartnerRuntime } from "@/server/workforce/service";
import { agentId, createOrg } from "./support/fixtures";

describe("Growth Partner schedule migration preview", () => {
  it("previews eligible mappings, duplicate schedules and open work without changing tenant data", async () => {
    const org = await createOrg({ name: "Schedule preview source" });
    const otherOrg = await createOrg({ name: "Other schedule preview tenant" });
    const leadHunter = await agentId(org.id, "lead_hunter");
    const appointmentSetter = await agentId(org.id, "appointment_setter");
    const otherLeadHunter = await agentId(otherOrg.id, "lead_hunter");
    const partnerRuntime = await withSystem((db) => ensureGrowthPartnerRuntime(org.id, db));

    const source = await withSystem(async (db) => {
      const first = (await db.query<{ id: string }>(
        `insert into ai_work_schedules (org_id, agent_instance_id, capability, cadence, interval_minutes, timezone, enabled, next_run_at, payload)
         values ($1, $2, 'lead_generation_review', 'daily', 1440, 'America/New_York', true, now() - interval '1 hour', '{"prompt":"PRIVATE old assignment text"}') returning id`,
        [org.id, leadHunter],
      )).rows[0].id;
      const second = (await db.query<{ id: string }>(
        `insert into ai_work_schedules (org_id, agent_instance_id, capability, cadence, interval_minutes, timezone, enabled, next_run_at)
         values ($1, $2, 'appointment_review', 'weekly', 10080, 'America/Los_Angeles', true, now() + interval '3 days') returning id`,
        [org.id, appointmentSetter],
      )).rows[0].id;
      await db.query(
        `insert into ai_work_schedules (org_id, agent_instance_id, capability, cadence, interval_minutes, timezone, enabled)
         values ($1, $2, 'appointment_review', 'weekly', 10080, 'UTC', false)`,
        [org.id, partnerRuntime],
      );
      const idempotencyKey = `schedule-preview-${crypto.randomUUID()}`;
      const openWorkItem = await db.query<{ id: string }>(
        `insert into ai_work_jobs (org_id, agent_instance_id, capability, title, idempotency_key, status)
         values ($1, $2, 'lead_generation_review', 'Synthetic open legacy work', $3, 'running') returning id`,
        [org.id, leadHunter, idempotencyKey],
      );
      await db.query(
        `insert into ai_work_schedules (org_id, agent_instance_id, capability, cadence, interval_minutes, timezone, enabled)
         values ($1, $2, 'lead_generation_review', 'daily', 1440, 'UTC', true)`,
        [otherOrg.id, otherLeadHunter],
      );
      await db.query(
        `insert into ai_work_jobs (org_id, agent_instance_id, capability, title, idempotency_key, status)
         values ($1, $2, 'lead_generation_review', 'Other tenant open work', $3, 'running')`,
        [otherOrg.id, otherLeadHunter, `schedule-preview-${crypto.randomUUID()}`],
      );
      return { scheduleIds: [first, second], openWorkItemId: openWorkItem.rows[0].id, idempotencyKey };
    });

    const before = await withSystem(async (db) => ({
      schedules: (await db.query(
        `select org_id, agent_instance_id, capability, cadence, interval_minutes, timezone, enabled, next_run_at, payload
           from ai_work_schedules where org_id = any($1::uuid[]) order by org_id, capability, agent_instance_id`,
        [[org.id, otherOrg.id]],
      )).rows,
      jobs: (await db.query(
        `select org_id, agent_instance_id, capability, idempotency_key, status
           from ai_work_jobs where org_id = any($1::uuid[]) order by org_id, idempotency_key`,
        [[org.id, otherOrg.id]],
      )).rows,
    }));

    const preview = await previewGrowthPartnerScheduleMigration(org.id);

    expect(preview.summary).toEqual({
      total: 2,
      enabled: 2,
      potentiallySupported: 2,
      openWorkItems: 1,
      partnerScheduleMatches: 1,
      dueSchedules: 1,
    });
    expect(preview.schedules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: source.scheduleIds[0],
        legacyRole: "lead_hunter",
        capability: "lead_generation_review",
        potentiallySupportedByGrowthPartner: true,
        matchingGrowthPartnerSchedule: false,
        due: true,
        openWorkItemsForCapability: 1,
      }),
      expect.objectContaining({
        id: source.scheduleIds[1],
        legacyRole: "appointment_setter",
        capability: "appointment_review",
        potentiallySupportedByGrowthPartner: true,
        matchingGrowthPartnerSchedule: true,
        due: false,
        openWorkItemsForCapability: 0,
      }),
    ]));
    expect(preview.openWorkItems).toEqual([{
      id: source.openWorkItemId,
      legacyRole: "lead_hunter",
      capability: "lead_generation_review",
      status: "running",
      idempotencyKey: source.idempotencyKey,
      scheduleId: null,
    }]);
    expect(JSON.stringify(preview)).not.toContain("PRIVATE old assignment text");

    const after = await withSystem(async (db) => ({
      schedules: (await db.query(
        `select org_id, agent_instance_id, capability, cadence, interval_minutes, timezone, enabled, next_run_at, payload
           from ai_work_schedules where org_id = any($1::uuid[]) order by org_id, capability, agent_instance_id`,
        [[org.id, otherOrg.id]],
      )).rows,
      jobs: (await db.query(
        `select org_id, agent_instance_id, capability, idempotency_key, status
           from ai_work_jobs where org_id = any($1::uuid[]) order by org_id, idempotency_key`,
        [[org.id, otherOrg.id]],
      )).rows,
    }));
    expect(after).toEqual(before);
  });

  it("refuses unknown, non-client and inactive workspaces", async () => {
    const agency = await createOrg({ name: "Schedule preview agency", kind: "agency" });
    const inactive = await createOrg({ name: "Schedule preview inactive", status: "suspended" });
    await expect(previewGrowthPartnerScheduleMigration(crypto.randomUUID())).rejects.toMatchObject({ code: "not_found" });
    await expect(previewGrowthPartnerScheduleMigration(agency.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(previewGrowthPartnerScheduleMigration(inactive.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(previewGrowthPartnerScheduleMigration(agency.id)).rejects.toBeInstanceOf(AppError);
  });
});
