import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { OrgContext } from "@/server/tenancy/context";
import { INTERNAL_POLICY_VERSION } from "@/server/workforce/policy";
import { INTERNAL_BUSINESS } from "@/lib/internal-business-profile";
import { withSystem } from "@/server/db";
import { createConfigVersion, decideHeldVersion } from "@/server/workforce/service";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { recommendedSettings } from "@/lib/role-playbooks";
import { agentId, addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

const roles = ["appointment_setter", "sales_assistant", "crm_manager", "performance_analyst"] as const;
type InternalRole = (typeof roles)[number];

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: Awaited<ReturnType<typeof createUser>>;
let internalCtx: OrgContext;
const agents = new Map<InternalRole, string>();
const configOutcomes: Partial<Record<InternalRole, string>> = {};

async function waitForJob(jobId: string, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { rows } = await withSystem((db) => db.query<{
      id: string;
      org_id: string;
      agent_instance_id: string;
      status: string;
      result: Record<string, unknown>;
      result_summary: string | null;
      failure_message: string | null;
    }>(
      `select j.id,j.org_id,j.agent_instance_id,j.status,j.result,j.result_summary,j.failure_message
         from ai_work_jobs j where j.id = $1`,
      [jobId],
    ));
    if (rows[0] && ["completed", "failed", "blocked"].includes(rows[0].status)) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Internal capability job ${jobId} did not settle.`);
}

function findingKeys(result: Record<string, unknown>) {
  return ((result.findings as Array<{ key: string }>) ?? []).map((item) => item.key);
}

beforeAll(async () => {
  org = await createOrg({ name: "iAcquire Internal Capability Test", kind: "agency" });
  owner = await createUser({ platformRole: "agency_super_admin" });
  await addMember(org.id, owner.id, "owner");
  const baseContext = ctxFor(owner, org, "owner");
  internalCtx = {
    ...baseContext,
    user: { ...baseContext.user, platformRole: "agency_super_admin" },
    org: { ...baseContext.org, kind: "agency" },
  };

  await withSystem(async (db) => {
    await db.query(
      `update company_profiles set description=$2, services=$3, ideal_customers=$4, operating_area=$5
       where org_id=$1`,
      [org.id, INTERNAL_BUSINESS.description, INTERNAL_BUSINESS.services, INTERNAL_BUSINESS.idealCustomers, INTERNAL_BUSINESS.operatingArea],
    );
    await db.query("update organizations set industry=$2 where id=$1", [org.id, INTERNAL_BUSINESS.industry]);
  });

  for (const role of roles) {
    const id = await agentId(org.id, role);
    agents.set(role, id);
    const config = await withSystem((db) => createConfigVersion(db, {
      orgId: org.id,
      agentId: id,
      settings: recommendedSettings(role),
      source: "agency",
      actorKind: "agency",
      userId: owner.id,
      apply: true,
    }));
    if (config.status === "pending_agency_review") {
      await withSystem((db) => decideHeldVersion(db, {
        orgId: org.id,
        versionId: config.versionId,
        approve: true,
        agencyUserId: owner.id,
        decisionNote: "Synthetic Super Admin review in isolated capability acceptance.",
      }));
      configOutcomes[role] = `reviewed/${config.decision}:${config.riskFlags.join(",")}`;
    } else {
      configOutcomes[role] = `${config.status}/${config.decision}:${config.riskFlags.join(",")}`;
    }
  }

  await withSystem(async (db) => {
    // This isolated suite supplies only the local online status needed to exercise native job
    // handlers. It creates no Hermes inventory, acknowledgement, or production readiness evidence.
    await db.query("update agent_instances set status='online' where org_id=$1 and role_key=any($2::text[])", [org.id, [...roles]]);

    await db.query("insert into contacts (org_id, display_name) values ($1, 'Incomplete Internal Contact')", [org.id]);
    await db.query("insert into crm_companies (org_id, name) values ($1, 'Internal Company Missing Website')", [org.id]);
    await db.query(
      `insert into crm_opportunities (org_id, ghl_opportunity_id, name, status, provider, stage_entered_at, updated_at, created_at)
       values ($1, $2, 'Internal Stale Opportunity', 'open', 'ghl', now()-interval '40 days', now()-interval '40 days', now()-interval '45 days')`,
      [org.id, `internal-stale-${crypto.randomUUID().slice(0, 8)}`],
    );

    const calendar = await db.query<{ id: string }>(
      `insert into crm_calendars (org_id, name, slug, is_default, public, created_by)
       values ($1, 'Internal Test Calendar', 'internal-test-calendar', true, true, $2) returning id`,
      [org.id, owner.id],
    );
    await db.query(
      `insert into crm_appointment_types (org_id, calendar_id, name, slug, duration_minutes, slot_interval_minutes,
         min_notice_minutes, max_days_ahead, location_kind, public)
       values ($1, $2, 'Internal Consultation', 'internal-consultation', 30, 30, 0, 60, 'none', true)`,
      [org.id, calendar.rows[0].id],
    );
    await db.query("insert into crm_calendar_members (org_id, calendar_id, user_id, priority) values ($1, $2, $3, 50)", [org.id, calendar.rows[0].id, owner.id]);
    await db.query("insert into crm_host_settings (org_id, user_id, timezone, accepting) values ($1, $2, 'UTC', true)", [org.id, owner.id]);
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      await db.query(
        "insert into crm_availability_rules (org_id, user_id, weekday, start_minute, end_minute) values ($1, $2, $3, 540, 1020)",
        [org.id, owner.id, weekday],
      );
    }
    await db.query("insert into leads (org_id, business_name, review_status) values ($1, 'Internal KPI Lead', 'pending')", [org.id]);
  });

  // A separate client record acts as a tripwire for accidental cross-tenant reads.
  const otherOrg = await createOrg({ name: "Separate Client Isolation Fixture", kind: "client" });
  await withSystem(async (db) => {
    await db.query("insert into crm_companies (org_id, name) values ($1, 'Foreign Tenant Secret Company')", [otherOrg.id]);
    await db.query("insert into leads (org_id, business_name, review_status) values ($1, 'Foreign Tenant Secret Lead', 'pending')", [otherOrg.id]);
  });
}, 60000);

describe("internal agency employee native work", () => {
  it("executes each priority role's supported read-only work on the agency workspace", async () => {
    const compiled = await withSystem((db) => db.query<{ role_key: string; policy_version: string; compiled_instructions: string }>(
      `select a.role_key,v.policy_version,v.compiled_instructions from agent_instances a
       join agent_config_versions v on v.id=a.active_config_version_id where a.org_id=$1 and a.role_key=any($2::text[])`,
      [org.id, [...roles]],
    ));
    expect(compiled.rows.map((row) => row.role_key).sort(), JSON.stringify(configOutcomes)).toEqual([...roles].sort());
    for (const row of compiled.rows) {
      expect(row.policy_version).toBe(INTERNAL_POLICY_VERSION);
      expect(row.compiled_instructions).toContain("You work only inside iAcquire's internal agency organization");
      expect(row.compiled_instructions).not.toContain("Never discuss iAcquire's internal systems");
    }

    const beforeAppointments = await withSystem((db) => db.query<{ count: number }>(
      "select count(*)::int as count from appointment_bookings where org_id=$1",
      [org.id],
    ));
    const assignments = [
      { role: "appointment_setter", capability: "appointment_availability", title: "Check internal calendar availability" },
      { role: "sales_assistant", capability: "pipeline_review", title: "Review internal opportunities" },
      { role: "crm_manager", capability: "crm_quality_review", title: "Review internal CRM quality" },
      { role: "performance_analyst", capability: "performance_snapshot", title: "Measure internal performance" },
    ] as const;

    const completed: Array<{ role: InternalRole; result: Record<string, unknown> }> = [];
    for (const assignment of assignments) {
      const dispatch = await dispatchCapabilityJob(internalCtx, {
        agentRole: assignment.role,
        capability: assignment.capability,
        title: assignment.title,
        idempotencyKey: `internal-capability-${assignment.role}`,
      });
      expect(dispatch.agentId).toBe(agents.get(assignment.role));
      const job = await waitForJob(dispatch.jobId);
      expect(job).toMatchObject({ org_id: org.id, agent_instance_id: agents.get(assignment.role), status: "completed" });
      expect(job.result_summary?.trim().length).toBeGreaterThan(0);
      completed.push({ role: assignment.role, result: job.result });
    }

    const byRole = new Map(completed.map((item) => [item.role, item.result]));
    const availability = byRole.get("appointment_setter")?.availability as { slots: Array<{ start: string }>; timeZone: string };
    expect(availability.slots.length).toBeGreaterThan(0);
    expect(availability.timeZone).toBe("UTC");
    expect(findingKeys(byRole.get("sales_assistant") ?? {})).toContain("stale_open_deals");
    expect(findingKeys(byRole.get("crm_manager") ?? {})).toContain("companies_missing_web");
    const metrics = byRole.get("performance_analyst")?.metrics as Array<{ key: string; value: number; period?: string }>;
    expect(metrics.find((metric) => metric.key === "leads_created")).toMatchObject({ value: 1, period: "Last 30 days" });

    const afterAppointments = await withSystem((db) => db.query<{ count: number }>(
      "select count(*)::int as count from appointment_bookings where org_id=$1",
      [org.id],
    ));
    expect(afterAppointments.rows[0].count).toBe(beforeAppointments.rows[0].count);
    expect(JSON.stringify(completed)).not.toContain("Foreign Tenant Secret");
  }, 60000);
});
