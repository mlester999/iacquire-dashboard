import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { createWorkJob, getWorkJob } from "@/server/workforce/jobs";
import {
  acknowledgeProactiveReport,
  getProactiveMonitoringStatus,
  listProactiveReports,
  publishReviewReport,
  releaseHeldProactiveReports,
  runProactiveBriefings,
  type ProactiveFinding,
} from "@/server/workforce/reports";
import { saveSchedule } from "@/server/workforce/schedules";

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let admin: { id: string; email: string };
let member: { id: string; email: string };
let operationsManagerId: string;

function finding(overrides: Partial<ProactiveFinding> = {}): ProactiveFinding {
  return {
    key: "integration_attention",
    severity: "warning",
    title: "An integration needs attention",
    detail: "A persisted connection is degraded.",
    count: 1,
    samples: ["ghl · error"],
    evidenceHref: "/settings/integrations",
    recommendedAction: "Open the connection status and recheck it before customer work.",
    requiresApproval: false,
    ...overrides,
  };
}

async function reviewJob() {
  const created = await withSystem((db) =>
    createWorkJob(db, {
      orgId: org.id,
      agentId: operationsManagerId,
      requestedBy: owner.id,
      capability: "proactive_review",
      title: "Proactive delivery test",
      idempotencyKey: `proactive-delivery-${crypto.randomUUID()}`,
      input: {},
    }),
  );
  await withSystem((db) =>
    db.query("update ai_work_jobs set status = 'completed', stage = 'completed', started_at = now(), finished_at = now() where id = $1", [created.id]),
  );
  return (await withSystem((db) => getWorkJob(db, org.id, created.id)))!;
}

async function publish(
  findings: ProactiveFinding[],
  options: { now?: Date; job?: Awaited<ReturnType<typeof reviewJob>> } = {},
) {
  const job = options.job ?? await reviewJob();
  return withSystem((db) =>
    publishReviewReport(db, {
      job,
      agent: { display_name: "Operations Manager", role_key: "operations_manager" },
      subject: "Operations",
      findings,
      metrics: [],
      limitations: "Only persisted workspace records were read.",
      checksRun: 8,
      now: options.now,
    }),
  );
}

async function notificationCount(userId: string) {
  const { rows } = await withSystem((db) =>
    db.query<{ n: number }>("select count(*)::int as n from notifications where org_id = $1 and user_id = $2", [org.id, userId]),
  );
  return Number(rows[0]?.n ?? 0);
}

async function setProactivePrefs(userId: string, proactive: Record<string, unknown>) {
  await withSystem((db) =>
    db.query(
      `insert into notification_preferences (user_id, org_id, prefs) values ($1, $2, $3)
       on conflict (user_id, org_id) do update set prefs = excluded.prefs, updated_at = now()`,
      [userId, org.id, JSON.stringify({ proactive })],
    ),
  );
}

beforeAll(async () => {
  org = await createOrg({ name: "Proactive Delivery Co" });
  owner = await createUser();
  admin = await createUser();
  member = await createUser();
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, admin.id, "admin");
  await addMember(org.id, member.id, "member");
  operationsManagerId = await agentId(org.id, "operations_manager");
  await withSystem((db) =>
    createConfigVersion(db, {
      orgId: org.id,
      agentId: operationsManagerId,
      settings: defaultSettings("operations_manager"),
      source: "onboarding",
      userId: owner.id,
      apply: true,
    }),
  );
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where org_id = $1", [org.id]));
}, 60000);

beforeEach(async () => {
  delete process.env.WORKFORCE_SCHEDULES_ENABLED;
  delete process.env.WORKFORCE_TRIGGERS_ENABLED;
  delete process.env.WORKFORCE_BRIEFINGS_ENABLED;
  await withSystem(async (db) => {
    await db.query("delete from notifications where org_id = $1", [org.id]);
    await db.query("delete from tasks where org_id = $1", [org.id]);
    await db.query("delete from ai_work_reports where org_id = $1", [org.id]);
    await db.query("delete from notification_preferences where org_id = $1", [org.id]);
  });
});

afterAll(() => {
  delete process.env.WORKFORCE_SCHEDULES_ENABLED;
  delete process.env.WORKFORCE_TRIGGERS_ENABLED;
  delete process.env.WORKFORCE_BRIEFINGS_ENABLED;
});

describe("proactive report delivery policy", () => {
  it("records one report and notifies the workspace's supervisors with a real job deep link", async () => {
    const published = await publish([finding()]);
    expect(published.created).toBe(true);
    const reports = await listProactiveReports(ctxFor(owner, org, "owner"));
    expect(reports[0]).toMatchObject({ id: published.reportId, kind: "alert", severity: "warning", employeeName: "Operations Manager" });
    expect(reports[0].findings[0]?.key).toBe("integration_attention");
    expect(reports[0].deliveryStatus).toBe("delivered");
    expect(await notificationCount(owner.id)).toBe(1);
    expect(await notificationCount(admin.id)).toBe(1);
    const { rows } = await withSystem((db) =>
      db.query<{ title: string; link: string; severity: string }>(
        "select title, link, severity from notifications where org_id = $1 and user_id = $2 order by created_at desc limit 1",
        [org.id, owner.id],
      ),
    );
    expect(rows[0].title).toMatch(/found 1 signal/i);
    expect(rows[0].link).toContain(`/work?job=`);
    expect(rows[0].link).toContain(`report=${published.reportId}`);
    expect(rows[0].severity).toBe("warning");
  }, 30000);

  it("is idempotent for the same job and does not duplicate the notification", async () => {
    const job = await reviewJob();
    const first = await publish([finding()], { job });
    const second = await publish([finding()], { job });
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ reportId: first.reportId, created: false });
    expect(await notificationCount(owner.id)).toBe(1);
  }, 30000);

  it("suppresses routine reports below the recipient's severity threshold", async () => {
    await setProactivePrefs(owner.id, { minimumSeverity: "critical" });
    await publish([finding()]);
    expect(await notificationCount(owner.id)).toBe(0);
    const { rows } = await withSystem((db) =>
      db.query<{ status: string; reason: string }>(
        "select status, reason from ai_work_report_deliveries where org_id = $1 and user_id = $2 order by created_at desc limit 1",
        [org.id, owner.id],
      ),
    );
    expect(rows[0]).toMatchObject({ status: "suppressed", reason: "below_severity_threshold" });
  }, 30000);

  it("lets a critical alert bypass quiet hours and the threshold for supervisors only", async () => {
    await setProactivePrefs(owner.id, { minimumSeverity: "critical", quietStart: "21:00", quietEnd: "07:00" });
    const now = new Date("2026-10-21T22:30:00.000Z");
    await publish([finding({ severity: "critical", key: "critical_connection", title: "A critical connection is down" })], { now });
    expect(await notificationCount(owner.id)).toBe(1);
    expect(await notificationCount(admin.id)).toBe(1);
    expect(await notificationCount(member.id)).toBe(0);
    const { rows } = await withSystem((db) =>
      db.query<{ severity: string; audience: string; link: string }>(
        "select severity, audience, link from notifications where org_id = $1 and user_id = $2 order by created_at desc limit 1",
        [org.id, owner.id],
      ),
    );
    expect(rows[0]).toMatchObject({ severity: "critical", audience: "client" });
    expect(rows[0].link).toContain("/work?");
  }, 30000);

  it("holds a routine report during quiet hours and releases it when they end", async () => {
    await setProactivePrefs(owner.id, { quietStart: "21:00", quietEnd: "07:00" });
    const job = await reviewJob();
    const held = await publish([finding()], { job, now: new Date("2026-10-21T22:30:00.000Z") });
    expect(await notificationCount(owner.id)).toBe(0);
    const before = await withSystem((db) =>
      db.query<{ status: string; reason: string }>("select status, reason from ai_work_report_deliveries where report_id = $1 and user_id = $2", [held.reportId, owner.id]),
    );
    expect(before.rows[0]).toMatchObject({ status: "held", reason: "quiet_hours" });
    const release = await releaseHeldProactiveReports(new Date("2026-10-22T08:00:00.000Z"));
    expect(release.delivered).toBeGreaterThanOrEqual(1);
    expect(await notificationCount(owner.id)).toBe(1);
    const after = await withSystem((db) =>
      db.query<{ status: string }>("select status from ai_work_report_deliveries where report_id = $1 and user_id = $2", [held.reportId, owner.id]),
    );
    expect(after.rows[0].status).toBe("delivered");
  }, 30000);

  it("keeps reports and acknowledgements tenant-scoped and permission-checked", async () => {
    const published = await publish([finding()]);
    expect(await listProactiveReports(ctxFor(member, org, "member"))).toHaveLength(0);
    await expect(acknowledgeProactiveReport(ctxFor(member, org, "member"), published.reportId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(acknowledgeProactiveReport(ctxFor(owner, org, "owner"), published.reportId)).resolves.toEqual({ acknowledged: true });

    const other = await createOrg({ name: "Other Proactive Co" });
    const otherOwner = await createUser();
    await addMember(other.id, otherOwner.id, "owner");
    const outsider = await listProactiveReports(ctxFor(otherOwner, other, "owner"));
    expect(outsider.some((report) => report.id === published.reportId)).toBe(false);
    const raw = await withUser(otherOwner.id, (db) => db.query("select 1 from ai_work_reports where id = $1", [published.reportId]));
    expect(raw.rows).toHaveLength(0);
  }, 30000);

  it("honours an owner's explicit opt-in to create one internal follow-up task for a critical report", async () => {
    await setProactivePrefs(owner.id, { autoCreateTasks: true });
    const job = await reviewJob();
    const first = await publish([finding({ severity: "critical", key: "critical_followup", title: "Critical records need a person" })], { job });
    const second = await publish([finding({ severity: "critical", key: "critical_followup", title: "Critical records need a person" })], { job });
    expect(second.created).toBe(false);
    const { rows } = await withSystem((db) =>
      db.query<{ id: string; assigned_user_id: string; source: string; related_type: string; related_id: string }>(
        "select id, assigned_user_id, source, related_type, related_id from tasks where org_id = $1 and related_type = 'ai_work_report'",
        [org.id],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ assigned_user_id: owner.id, source: "agent", related_type: "ai_work_report", related_id: first.reportId });
    const audit = await withSystem((db) =>
      db.query<{ action: string }>("select action from audit_logs where org_id = $1 and target_id = $2", [org.id, rows[0].id]),
    );
    expect(audit.rows.map((row) => row.action)).toContain("workforce.proactive_task_created");
  }, 30000);

  it("keeps automatic task creation off by default", async () => {
    const job = await reviewJob();
    await publish([finding({ severity: "critical", key: "critical_default_off", title: "Critical but not preauthorized" })], { job });
    const { rows } = await withSystem((db) =>
      db.query<{ n: number }>("select count(*)::int as n from tasks where org_id = $1 and related_type = 'ai_work_report'", [org.id]),
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  }, 30000);
});

describe("monitoring state and briefing slots", () => {
  it("reports no monitoring until a row is enabled and the operator switch is on", async () => {
    const ctx = ctxFor(owner, org, "owner");
    expect((await getProactiveMonitoringStatus(ctx)).state).toBe("not_configured");
    process.env.WORKFORCE_SCHEDULES_ENABLED = "true";
    await saveSchedule(ctx, { capability: "proactive_review", cadence: "daily", enabled: true });
    const active = await getProactiveMonitoringStatus(ctx);
    expect(active.state).toBe("active");
    expect(active.schedulesEnabled).toBeGreaterThanOrEqual(1);
    process.env.WORKFORCE_SCHEDULES_ENABLED = "false";
    expect((await getProactiveMonitoringStatus(ctx)).state).toBe("paused");
  }, 30000);

  it("creates one opt-in daily briefing per local day and does not duplicate it on the next tick", async () => {
    process.env.WORKFORCE_BRIEFINGS_ENABLED = "true";
    await setProactivePrefs(owner.id, { dailyBriefing: true, briefingHour: 0, minimumSeverity: "info", delivery: "immediate", quietStart: null, quietEnd: null });
    await publish([finding()]);
    const first = await runProactiveBriefings(new Date("2026-10-21T09:00:00.000Z"));
    expect(first.operatorEnabled).toBe(true);
    expect(first.generated).toBeGreaterThanOrEqual(1);
    const second = await runProactiveBriefings(new Date("2026-10-21T10:00:00.000Z"));
    expect(second.generated).toBe(0);
    const { rows } = await withSystem((db) =>
      db.query<{ n: number; title: string; kind: string }>(
        "select count(*)::int as n, min(title) as title, min(kind) as kind from ai_work_reports where org_id = $1 and kind = 'daily_briefing'",
        [org.id],
      ),
    );
    expect(Number(rows[0].n)).toBe(1);
    expect(rows[0].title).toMatch(/daily AI workforce briefing/i);
  }, 30000);

  it("does not create a briefing when the operator switch is off", async () => {
    await setProactivePrefs(owner.id, { dailyBriefing: true, briefingHour: 0 });
    await publish([finding()]);
    const result = await runProactiveBriefings(new Date("2026-10-21T09:00:00.000Z"));
    expect(result).toMatchObject({ operatorEnabled: false, generated: 0 });
  }, 30000);
});
