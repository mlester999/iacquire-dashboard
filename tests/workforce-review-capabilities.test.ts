import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { createFindingTask } from "@/server/workforce/finding-actions";
import { capabilitiesForRole, roleMayUseCapability, WORKFORCE_CAPABILITIES } from "@/lib/workforce-capabilities";

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let contactId: string;
let performanceAnalystId: string;

async function waitForJob(jobId: string, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await withSystem((db) =>
      db.query<{ status: string; result: Record<string, unknown>; result_count: number; failure_message: string | null }>(
        "select status, result, result_count, failure_message from ai_work_jobs where id = $1",
        [jobId],
      ),
    );
    if (rows[0] && ["completed", "failed", "cancelled", "blocked"].includes(rows[0].status)) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("review job did not settle");
}

function keysOf(result: Record<string, unknown>) {
  return ((result.findings as Array<{ key: string; count: number }>) ?? []).map((item) => item.key).sort();
}

beforeAll(async () => {
  org = await createOrg({ name: "Review Capabilities Co" });
  owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  for (const role of ["crm_manager", "sales_assistant", "appointment_setter", "performance_analyst"] as const) {
    const id = await agentId(org.id, role);
    await withSystem((db) =>
      createConfigVersion(db, {
        orgId: org.id,
        agentId: id,
        settings: defaultSettings(role),
        source: "onboarding",
        userId: owner.id,
        apply: true,
      }),
    );
  }
  performanceAnalystId = await agentId(org.id, "performance_analyst");
  await withSystem(async (db) => {
    await db.query("update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where org_id = $1", [org.id]);
    const contact = await db.query<{ id: string }>(
      "insert into contacts (org_id, display_name, email) values ($1, 'Booking Contact', 'booking@example.test') returning id",
      [org.id],
    );
    contactId = contact.rows[0].id;

    // CRM quality fixtures.
    await db.query("insert into contacts (org_id, display_name, created_at) values ($1, 'Incomplete Contact', now())", [org.id]);
    await db.query("insert into contacts (org_id, display_name, email) values ($1, 'Duplicate Name', 'dup-one@example.test')", [org.id]);
    await db.query("insert into contacts (org_id, display_name, email) values ($1, 'Duplicate Name', 'dup-two@example.test')", [org.id]);
    const identityContact = await db.query<{ id: string }>(
      "insert into contacts (org_id, display_name, email) values ($1, 'Unverified Person', 'unverified-person@example.test') returning id",
      [org.id],
    );
    await db.query(
      "insert into contact_identities (org_id, contact_id, kind, value, verified) values ($1, $2, 'email', 'unverified@example.test', false)",
      [org.id, identityContact.rows[0].id],
    );
    await db.query("insert into crm_companies (org_id, name) values ($1, 'No Web Co')", [org.id]);
    await db.query("insert into crm_companies (org_id, name, domain) values ($1, 'Twin Co', 'twin-one.example')", [org.id]);
    await db.query("insert into crm_companies (org_id, name, domain) values ($1, 'Twin Co', 'twin-two.example')", [org.id]);

    // Pipeline fixtures.
    await db.query(
      `insert into crm_opportunities (org_id, ghl_opportunity_id, name, status, provider, stage_entered_at, updated_at, created_at)
       values ($1, $2, 'Stale Deal', 'open', 'ghl', now() - interval '30 days', now() - interval '30 days', now() - interval '40 days')`,
      [org.id, `ghl-stale-${crypto.randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `insert into crm_opportunities (org_id, ghl_opportunity_id, name, status, provider, monetary_value, assigned_to, contact_label,
         expected_close_date, stage_entered_at, updated_at, created_at)
       values ($1, $2, 'Past Close Deal', 'open', 'ghl', 1000, 'Owner', 'Acme', current_date - 5, now(), now(), now() - interval '10 days')`,
      [org.id, `ghl-close-${crypto.randomUUID().slice(0, 8)}`],
    );

    // Appointment fixtures.
    const booking = (status: string, title: string, startOffset: string, createdOffset: string, extra: { ghl?: string; booked?: boolean; assigned?: string | null } = {}) =>
      db.query(
        `insert into appointment_bookings (org_id, contact_id, calendar_id, start_at, end_at, timezone, title, requested_by_kind,
           status, ghl_appointment_id, booked_at, assigned_user_id, idempotency_key, created_at)
         values ($1, $2, 'cal-review', now() + $3::interval, now() + $3::interval + interval '30 minutes', 'UTC', $4, 'ai', $5, $6, $7, $8, $9, now() - $10::interval)`,
        [org.id, contactId, startOffset, title, status, extra.ghl ?? null, extra.booked ? new Date() : null, extra.assigned ?? null, `booking-${crypto.randomUUID()}`, createdOffset],
      );
    await booking("awaiting_approval", "Awaiting approval booking", "1 day", "2 days");
    await booking("needs_manual", "Manual booking", "2 days", "3 hours");
    await booking("requested", "Stuck request", "3 days", "3 hours");
    await booking("booked", "Unassigned confirmed booking", "4 days", "1 day", { ghl: "ghl-booking-1", booked: true });

    // Real native calendar availability fixtures.
    const calendar = await db.query<{ id: string }>(
      "insert into crm_calendars (org_id, name, slug, is_default, public, created_by) values ($1, 'Review Calendar', 'review-calendar', true, true, $2) returning id",
      [org.id, owner.id],
    );
    await db.query(
      `insert into crm_appointment_types (org_id, calendar_id, name, slug, duration_minutes, slot_interval_minutes, min_notice_minutes, max_days_ahead, location_kind, public)
       values ($1, $2, 'Discovery Call', 'discovery-call', 30, 30, 0, 60, 'none', true)`,
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

    // Performance fixtures: measured leads, runs and a won deal.
    await db.query("insert into leads (org_id, business_name, review_status, created_at) values ($1, 'Perf Lead A', 'pending', now())", [org.id]);
    await db.query("insert into leads (org_id, business_name, review_status, created_at) values ($1, 'Perf Lead B', 'pending', now())", [org.id]);
    await db.query(
      "insert into leads (org_id, business_name, review_status, reviewed_at, created_at) values ($1, 'Perf Lead C', 'approved', now(), now())",
      [org.id],
    );
    await db.query(
      "insert into leads (org_id, business_name, review_status, created_at) values ($1, 'Previous Month Lead', 'pending', now() - interval '25 days')",
      [org.id],
    );
    for (let i = 0; i < 5; i += 1) {
      await db.query(
        `insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, started_at)
         values ($1, $2, $3, 'chat', $4, $5, now() - interval '1 day')`,
        [org.id, performanceAnalystId, owner.id, `perf-run-${crypto.randomUUID()}`, i < 2 ? "failed" : "completed"],
      );
    }
    await db.query(
      `insert into crm_opportunities (org_id, ghl_opportunity_id, name, status, provider, monetary_value, closed_at, updated_at, created_at)
       values ($1, $2, 'Won Deal', 'won', 'ghl', 500, now(), now(), now() - interval '5 days')`,
      [org.id, `ghl-won-${crypto.randomUUID().slice(0, 8)}`],
    );

    // Previous 30-day period, used only for measured trend comparisons.
    await db.query(
      "insert into leads (org_id, business_name, review_status, reviewed_at, created_at) values ($1, 'Previous Lead', 'approved', now() - interval '45 days', now() - interval '45 days')",
      [org.id],
    );
    await db.query("insert into contacts (org_id, display_name, email, created_at) values ($1, 'Previous Contact', 'previous@example.test', now() - interval '45 days')", [org.id]);
    await db.query(
      `insert into appointment_bookings (org_id, contact_id, calendar_id, start_at, end_at, timezone, title, requested_by_kind, status,
         ghl_appointment_id, booked_at, idempotency_key, created_at)
       values ($1, $2, 'cal-review', now() - interval '45 days', now() - interval '45 days' + interval '30 minutes', 'UTC',
               'Previous booked appointment', 'ai', 'booked', 'ghl-booking-previous', now() - interval '45 days', $3, now() - interval '45 days')`,
      [org.id, contactId, `booking-${crypto.randomUUID()}`],
    );
    await db.query(
      `insert into crm_opportunities (org_id, ghl_opportunity_id, name, status, provider, monetary_value, closed_at, updated_at, created_at)
       values ($1, $2, 'Previous Won Deal', 'won', 'ghl', 300, now() - interval '45 days', now() - interval '45 days', now() - interval '50 days')`,
      [org.id, `ghl-won-prev-${crypto.randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, started_at)
       values ($1, $2, $3, 'chat', $4, 'completed', now() - interval '45 days')`,
      [org.id, performanceAnalystId, owner.id, `perf-prev-${crypto.randomUUID()}`],
    );
    await db.query(
      `insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, started_at)
       values ($1, $2, $3, 'chat', $4, 'failed', now() - interval '45 days')`,
      [org.id, performanceAnalystId, owner.id, `perf-prev-f-${crypto.randomUUID()}`],
    );
  });
}, 60000);

describe("reviewed workforce capabilities", () => {
  it("allows the intended role and permission for each reviewed capability", () => {
    expect(capabilitiesForRole("crm_manager").map((definition) => definition.key)).toEqual(["crm_quality_review"]);
    expect(capabilitiesForRole("sales_assistant").map((definition) => definition.key)).toEqual(["pipeline_review", "pipeline_followup_drafts", "lead_priority_review"]);
    expect(capabilitiesForRole("appointment_setter").map((definition) => definition.key)).toEqual(["appointment_review", "appointment_availability", "missed_call_review"]);
    expect(capabilitiesForRole("performance_analyst").map((definition) => definition.key)).toEqual(["social_performance_review", "receivables_review", "reputation_review", "performance_snapshot"]);
    expect(WORKFORCE_CAPABILITIES.pipeline_followup_drafts).toMatchObject({
      requiredPermission: "sales.view",
      additionalPermissions: ["inbox.reply"],
      risk: "approval_required",
      workBoardAction: false,
    });
    expect(roleMayUseCapability("crm_manager", "pipeline_review")).toBe(false);
    expect(roleMayUseCapability("sales_assistant", "crm_quality_review")).toBe(false);
    expect(roleMayUseCapability("appointment_setter", "appointment_review")).toBe(true);
    expect(roleMayUseCapability("performance_analyst", "performance_snapshot")).toBe(true);
  });

  it("runs a real CRM quality review and reports only data-quality findings", async () => {
    const dispatched = await dispatchCapabilityJob(ctxFor(owner, org, "owner"), {
      agentRole: "crm_manager",
      capability: "crm_quality_review",
      title: "CRM quality review",
      input: {},
    });
    const job = await waitForJob(dispatched.jobId);
    expect(job.status).toBe("completed");
    expect(keysOf(job.result)).toEqual(expect.arrayContaining([
      "contacts_missing_details", "companies_missing_web", "duplicate_companies", "duplicate_contact_names", "unverified_identities",
    ]));
    const { rows } = await withSystem((db) =>
      db.query<{ count: number }>("select count(*)::int as count from crm_companies where org_id = $1 and deleted_at is null", [org.id]),
    );
    expect(rows[0].count).toBe(3);
  });

  it("turns a completed finding into one idempotent, assigned follow-up task", async () => {
    const dispatched = await dispatchCapabilityJob(ctxFor(owner, org, "owner"), {
      agentRole: "crm_manager",
      capability: "crm_quality_review",
      title: "CRM quality review",
      input: {},
    });
    const job = await waitForJob(dispatched.jobId);
    expect(job.status).toBe("completed");
    const findings = job.result.findings as Array<{ key: string; title: string }>;
    expect(findings.length).toBeGreaterThan(0);
    const first = await createFindingTask(ctxFor(owner, org, "owner"), { jobId: dispatched.jobId, findingKey: findings[0].key });
    expect(first.created).toBe(true);
    const again = await createFindingTask(ctxFor(owner, org, "owner"), { jobId: dispatched.jobId, findingKey: findings[0].key });
    expect(again).toMatchObject({ taskId: first.taskId, created: false });
    const { rows } = await withSystem((db) =>
      db.query<{ title: string; assigned_user_id: string; source: string; related_type: string; related_id: string }>(
        "select title, assigned_user_id, source, related_type, related_id from tasks where id = $1 and org_id = $2",
        [first.taskId, org.id],
      ),
    );
    expect(rows[0]).toMatchObject({
      title: `Follow up: ${findings[0].title}`.slice(0, 200),
      assigned_user_id: owner.id,
      source: "agent",
      related_type: "ai_work_finding",
      related_id: `${dispatched.jobId}:${findings[0].key}`,
    });
    const audit = await withSystem((db) =>
      db.query<{ action: string }>("select action from audit_logs where org_id = $1 and target_id = $2", [org.id, first.taskId]),
    );
    expect(audit.rows.map((row) => row.action)).toContain("workforce.finding_task_created");
  });

  it("runs a real pipeline review without changing any opportunity", async () => {
    const before = await withSystem((db) =>
      db.query<{ count: number; open: number }>(
        "select count(*)::int as count, count(*) filter (where status = 'open')::int as open from crm_opportunities where org_id = $1",
        [org.id],
      ),
    );
    const dispatched = await dispatchCapabilityJob(ctxFor(owner, org, "owner"), {
      agentRole: "sales_assistant",
      capability: "pipeline_review",
      title: "Pipeline review",
      input: {},
    });
    const job = await waitForJob(dispatched.jobId);
    expect(job.status).toBe("completed");
    expect(keysOf(job.result)).toEqual(expect.arrayContaining([
      "stale_open_deals", "open_deals_without_value", "open_deals_without_owner", "open_deals_past_close_date", "open_deals_without_contact",
    ]));
    const after = await withSystem((db) =>
      db.query<{ count: number; open: number }>(
        "select count(*)::int as count, count(*) filter (where status = 'open')::int as open from crm_opportunities where org_id = $1",
        [org.id],
      ),
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("runs a real appointment review and never confirms or moves a booking", async () => {
    const before = await withSystem((db) =>
      db.query<{ status: string; count: number }>("select status, count(*)::int as count from appointment_bookings where org_id = $1 group by status order by status", [org.id]),
    );
    const dispatched = await dispatchCapabilityJob(ctxFor(owner, org, "owner"), {
      agentRole: "appointment_setter",
      capability: "appointment_review",
      title: "Appointment review",
      input: {},
    });
    const job = await waitForJob(dispatched.jobId);
    expect(job.status).toBe("completed");
    expect(keysOf(job.result)).toEqual(expect.arrayContaining([
      "bookings_awaiting_approval", "manual_bookings_upcoming", "stuck_booking_requests", "upcoming_unassigned",
    ]));
    const after = await withSystem((db) =>
      db.query<{ status: string; count: number }>("select status, count(*)::int as count from appointment_bookings where org_id = $1 group by status order by status", [org.id]),
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("reads real calendar availability without holding or booking a slot", async () => {
    const before = await withSystem((db) =>
      db.query<{ count: number }>("select count(*)::int as count from appointment_bookings where org_id = $1", [org.id]),
    );
    const dispatched = await dispatchCapabilityJob(ctxFor(owner, org, "owner"), {
      agentRole: "appointment_setter",
      capability: "appointment_availability",
      title: "Calendar availability check",
      input: {},
    });
    const job = await waitForJob(dispatched.jobId);
    expect(job.status).toBe("completed");
    const availability = job.result.availability as { slots: Array<{ start: string; end: string }>; timeZone: string } | null;
    expect(availability?.slots.length).toBeGreaterThan(0);
    expect(availability?.timeZone).toBe("UTC");
    const metrics = (job.result.metrics as Array<{ key: string; value: number }>) ?? [];
    expect(metrics.find((metric) => metric.key === "available_slots")?.value).toBeGreaterThan(0);
    const after = await withSystem((db) =>
      db.query<{ count: number }>("select count(*)::int as count from appointment_bookings where org_id = $1", [org.id]),
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it("produces measured performance KPIs and only stated anomaly findings", async () => {
    const dispatched = await dispatchCapabilityJob(ctxFor(owner, org, "owner"), {
      agentRole: "performance_analyst",
      capability: "performance_snapshot",
      title: "Performance snapshot",
      input: {},
    });
    const job = await waitForJob(dispatched.jobId);
    expect(job.status).toBe("completed");
    const metrics = (job.result.metrics as Array<{ key: string; value: number; previous?: number | null; trend?: string; higherIsBetter?: boolean; period?: string }>) ?? [];
    const metric = (key: string) => metrics.find((item) => item.key === key);
    expect(metrics).toHaveLength(12);
    expect(metric("leads_created")?.value).toBe(4);
    expect(metric("leads_created")?.previous).toBe(1);
    expect(metric("leads_created")?.period).toBe("Last 30 days");
    expect(metric("leads_created")?.trend).toBe("up");
    expect(metric("leads_pending")?.value).toBe(3);
    expect(metric("leads_approved")?.value).toBe(1);
    expect(metric("appointments_booked")?.value).toBe(1);
    expect(metric("appointments_booked")?.previous).toBe(1);
    expect(metric("appointments_booked")?.trend).toBe("flat");
    expect(metric("deals_won")?.value).toBe(1);
    expect(metric("ai_runs_completed")?.value).toBe(3);
    expect(metric("ai_runs_completed")?.previous).toBe(1);
    expect(metric("ai_runs_failed")?.value).toBe(2);
    expect(metric("ai_runs_failed")?.previous).toBe(1);
    expect(metric("ai_runs_failed")?.higherIsBetter).toBe(false);
    expect(keysOf(job.result)).toEqual(expect.arrayContaining(["ai_run_failure_rate", "unvalued_open_pipeline"]));
    expect(keysOf(job.result)).not.toContain("no_lead_flow");
    const failure = (job.result.findings as Array<{ key: string; detail: string }>).find((item) => item.key === "ai_run_failure_rate");
    expect(failure?.detail).toMatch(/20% review threshold/i);
  });

  it("compares calendar months in the workspace time zone when the assignment asks for this month", async () => {
    const monthStart = (await withSystem((db) => db.query<{ month_start: Date }>(
      "select timezone('America/Los_Angeles', date_trunc('month', timezone('America/Los_Angeles', now()))) as month_start",
    ))).rows[0].month_start;
    await withSystem(async (db) => {
      await db.query("update organizations set timezone = 'America/Los_Angeles' where id = $1", [org.id]);
      await db.query(
        `insert into leads (org_id, business_name, review_status, created_at)
         values ($1, 'Before Local Month Boundary', 'pending', $2::timestamptz - interval '30 minutes'),
                ($1, 'After Local Month Boundary', 'pending', $2::timestamptz + interval '30 minutes')`,
        [org.id, monthStart],
      );
    });
    try {
      const dispatched = await dispatchCapabilityJob(ctxFor(owner, org, "owner"), {
        agentRole: "performance_analyst",
        capability: "performance_snapshot",
        title: "Current month performance snapshot",
        input: { period: "current_month" },
      });
      const job = await waitForJob(dispatched.jobId);
      expect(job.status).toBe("completed");
      const metrics = (job.result.metrics as Array<{ key: string; value: number; previous?: number | null; period?: string; comparisonPeriod?: string }>) ?? [];
      const leads = metrics.find((item) => item.key === "leads_created");
      expect(leads).toMatchObject({ value: 4, previous: 3, period: "Current calendar month", comparisonPeriod: "Previous calendar month" });
    } finally {
      await withSystem((db) => db.query("update organizations set timezone = 'UTC' where id = $1", [org.id]));
    }
  });

  it("refuses a review when the caller cannot use the AI workforce", async () => {
    const viewer = await createUser();
    await addMember(org.id, viewer.id, "member");
    const base = ctxFor(viewer, org, "member");
    const restricted = { ...base, can: (permission: Parameters<typeof base.can>[0]) => permission !== "agents.use" && base.can(permission) };
    await expect(
      dispatchCapabilityJob(restricted, {
        agentRole: "crm_manager",
        capability: "crm_quality_review",
        title: "Restricted CRM review",
        input: {},
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("requires Inbox reply permission before dispatching a customer-message draft capability", async () => {
    const base = ctxFor(owner, org, "owner");
    const withoutReply = { ...base, can: (permission: Parameters<typeof base.can>[0]) => permission !== "inbox.reply" && base.can(permission) };
    await expect(
      dispatchCapabilityJob(withoutReply, {
        agentRole: "sales_assistant",
        capability: "pipeline_followup_drafts",
        title: "Prepare safe sales follow-up drafts",
        input: { limit: 5 },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
