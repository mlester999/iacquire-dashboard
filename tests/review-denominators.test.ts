// A read-only review says what it looked at, so an empty workspace reads as "nothing to review yet" instead of "all clear"; the Performance Snapshot hides AI run figures from a person
// who may not view activity; and a review says where its records came from. Embedded test database only; nothing is sent anywhere.
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { examinedPhrase, reviewSummary } from "@/server/workforce/read-only-review";
import { requesterMayReadRuns } from "@/server/workforce/performance-snapshot";
import { agencyPeople } from "./support/crm";
import { sweepLaunchVerification } from "@/server/setup/launch-sweep";
import { getLaunchReadiness } from "@/server/setup/launch-readiness";
import { itemOf, readyClient, settled } from "./support/launch";
import type { OrgRole } from "@/lib/permissions";
import type { AgentRoleKey } from "@/lib/agents";

type Org = Awaited<ReturnType<typeof createOrg>>;
type User = { id: string; email: string };
type Examined = Array<{ label: string; count: number }>;
type Source = { crmMode: string | null; provider: string | null };
interface JobRow {
  status: string;
  result: { examined?: Examined; source?: Source; limitations: string; metrics: Array<{ key: string }>; findings: Array<{ key: string }>; availability?: { reason?: string } };
  result_count: number;
  result_summary: string | null;
}

async function waitForJob(jobId: string, timeoutMs = 15000): Promise<JobRow> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await withSystem((db) => db.query<JobRow>("select status, result, result_count, result_summary from ai_work_jobs where id = $1", [jobId]));
    if (rows[0] && ["completed", "failed", "cancelled", "blocked"].includes(rows[0].status)) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("review job did not settle");
}

/** The four employees that run reviews, each configured and online. */
async function configure(org: Org, owner: User) {
  for (const role of ["crm_manager", "sales_assistant", "appointment_setter", "performance_analyst"] as const) {
    const id = await agentId(org.id, role);
    await withSystem((db) => createConfigVersion(db, { orgId: org.id, agentId: id, settings: defaultSettings(role), source: "onboarding", userId: owner.id, apply: true }));
  }
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where org_id = $1", [org.id]));
}

/** A client workspace with an owner and nothing else in it. */
async function freshWorkspace(name: string) {
  const org = await createOrg({ name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  await configure(org, owner);
  return { org, owner };
}

async function run(org: Org, user: User, role: OrgRole, agentRole: AgentRoleKey, capability: string, title: string): Promise<JobRow & { id: string }> {
  const dispatched = await dispatchCapabilityJob(ctxFor(user, org, role), { agentRole, capability: capability as never, title, input: {} });
  return { ...(await waitForJob(dispatched.jobId)), id: dispatched.jobId };
}

async function noticeData(jobId: string): Promise<{ examined?: Examined; source?: Source }> {
  const { rows } = await withSystem((db) =>
    db.query<{ data: { examined?: Examined; source?: Source } }>("select data from ai_work_events where job_id = $1 and kind = 'notice' and stage = 'completed' order by created_at desc limit 1", [jobId]),
  );
  return rows[0]?.data ?? {};
}

const NATIVE_NOTE = "Read from the records iAcquire holds (native mode)";

describe("review summaries and the examined phrase (pure)", () => {
  it("reads a count of one in the singular and joins several counts in plain words", () => {
    expect(examinedPhrase([{ label: "deals", count: 120 }])).toBe("120 deals");
    expect(examinedPhrase([{ label: "deals", count: 1 }])).toBe("1 deal");
    expect(examinedPhrase([{ label: "companies", count: 1 }])).toBe("1 company");
    expect(examinedPhrase([{ label: "bookings", count: 0 }])).toBe("0 bookings");
    expect(examinedPhrase([{ label: "contacts", count: 3 }, { label: "companies", count: 2 }])).toBe("3 contacts and 2 companies");
    expect(examinedPhrase([{ label: "leads", count: 1 }, { label: "contacts", count: 4 }, { label: "deals", count: 2 }])).toBe("1 lead, 4 contacts and 2 deals");
  });

  it("says nothing to review for all zeros, no signals for a seeded workspace, and keeps the older wording without a reader", () => {
    const base = { subject: "Pipeline", findings: 0, affected: 0, critical: 0, warning: 0, metricNote: "" };
    expect(reviewSummary({ ...base, examined: [{ label: "deals", count: 0 }] })).toBe("Pipeline review. Checked 0 deals. Nothing to review yet.");
    expect(reviewSummary({ ...base, examined: [{ label: "deals", count: 120 }] })).toBe("Pipeline review. Checked 120 deals: no signals.");
    expect(reviewSummary(base)).toBe("Pipeline review found no actionable signals in the persisted records checked.");
    // With findings the count of signals leads and the denominator follows; a finding is never hidden behind "nothing to review".
    expect(reviewSummary({ ...base, findings: 2, affected: 5, critical: 0, warning: 2, examined: [{ label: "deals", count: 0 }] })).toBe(
      "Pipeline review found 2 signals across 5 affected items (0 critical, 2 warning). Checked 0 deals.",
    );
  });
});

describe("an empty workspace is not described as clean", () => {
  it("reports every review's denominator as zero, says there is nothing to review yet, and still completes", async () => {
    const { org, owner } = await freshWorkspace("Denominators Empty Co");
    const cases: Array<{ role: AgentRoleKey; capability: string; examined: Examined; summary: string }> = [
      { role: "sales_assistant", capability: "pipeline_review", examined: [{ label: "deals", count: 0 }], summary: "Pipeline review. Checked 0 deals. Nothing to review yet." },
      { role: "crm_manager", capability: "crm_quality_review", examined: [{ label: "contacts", count: 0 }, { label: "companies", count: 0 }], summary: "CRM quality review. Checked 0 contacts and 0 companies. Nothing to review yet." },
      { role: "sales_assistant", capability: "lead_priority_review", examined: [{ label: "assessed leads", count: 0 }], summary: "Lead priority review. Checked 0 assessed leads. Nothing to review yet." },
      { role: "appointment_setter", capability: "appointment_review", examined: [{ label: "bookings", count: 0 }], summary: "Appointment review. Checked 0 bookings. Nothing to review yet." },
    ];
    for (const c of cases) {
      const job = await run(org, owner, "owner", c.role, c.capability, c.capability);
      // A pass stays a pass: a brand-new client is legitimately empty.
      expect(job.status, c.capability).toBe("completed");
      expect(job.result_count, c.capability).toBe(0);
      expect(job.result.examined, c.capability).toEqual(c.examined);
      expect(job.result_summary, c.capability).toBe(c.summary);
      expect(job.result_summary, c.capability).not.toMatch(/no actionable signals/);
      expect((await noticeData(job.id)).examined, c.capability).toEqual(c.examined);
    }
  }, 120_000);

  it("reports the snapshot's denominators (people with activity access also get AI runs) and the calendar check's", async () => {
    const { org, owner } = await freshWorkspace("Denominators Snapshot Empty Co");
    const snapshot = await run(org, owner, "owner", "performance_analyst", "performance_snapshot", "Performance snapshot");
    expect(snapshot.status).toBe("completed");
    const zeros: Examined = [
      { label: "leads", count: 0 }, { label: "contacts", count: 0 }, { label: "appointments", count: 0 }, { label: "deals", count: 0 }, { label: "AI runs", count: 0 },
    ];
    expect(snapshot.result.examined).toEqual(zeros);
    // A workspace with no leads in the period still carries its own stated finding; the denominator is added to it, not swapped for it.
    expect(snapshot.result.findings.map((f) => f.key)).toEqual(["no_lead_flow"]);
    expect(snapshot.result_summary).toContain("Checked 0 leads, 0 contacts, 0 appointments, 0 deals and 0 AI runs.");
    expect((await noticeData(snapshot.id)).examined).toEqual(zeros);

    const availability = await run(org, owner, "owner", "appointment_setter", "appointment_availability", "Calendar availability check");
    expect(availability.status).toBe("completed");
    expect(availability.result.examined).toEqual([{ label: "active calendars", count: 0 }, { label: "appointment types", count: 0 }]);
    expect(availability.result.availability?.reason).toBeTruthy();
    expect((await noticeData(availability.id)).examined).toEqual(availability.result.examined);
  }, 120_000);

  it("gives the counts for a seeded workspace and says no signals only when there were records to check", async () => {
    const { org, owner } = await freshWorkspace("Denominators Seeded Co");
    await withSystem(async (db) => {
      const deal = (name: string, status: string, extra = "") => db.query(
        `insert into crm_opportunities (org_id, ghl_opportunity_id, name, status, provider, monetary_value, assigned_to, contact_label, expected_close_date, stage_entered_at, updated_at, created_at${extra ? ", closed_at" : ""})
         values ($1, $2, $3, $4, 'ghl', 900, 'Owner', 'Acme', current_date + 30, now(), now(), now()${extra ? ", now()" : ""})`,
        [org.id, `den-${crypto.randomUUID().slice(0, 8)}`, name, status],
      );
      await deal("Clean Deal One", "open");
      await deal("Clean Deal Two", "open");
      await deal("Won Deal Is Not Open", "won", "closed");
      for (const [name, email] of [["Ada", "ada@example.test"], ["Ben", "ben@example.test"], ["Cy", "cy@example.test"]]) {
        await db.query("insert into contacts (org_id, display_name, email) values ($1, $2, $3)", [org.id, name, email]);
      }
      await db.query("insert into contacts (org_id, display_name, email, deleted_at) values ($1, 'Removed Person', 'removed@example.test', now())", [org.id]);
      await db.query("insert into crm_companies (org_id, name, domain) values ($1, 'Alpha Co', 'alpha.example'), ($1, 'Beta Co', 'beta.example')", [org.id]);
    });

    const pipeline = await run(org, owner, "owner", "sales_assistant", "pipeline_review", "Pipeline review");
    expect(pipeline.result.examined).toEqual([{ label: "deals", count: 2 }]);
    expect(pipeline.result_summary).toBe("Pipeline review. Checked 2 deals: no signals.");
    const quality = await run(org, owner, "owner", "crm_manager", "crm_quality_review", "CRM quality review");
    expect(quality.result.examined).toEqual([{ label: "contacts", count: 3 }, { label: "companies", count: 2 }]);
    expect(quality.result_summary).toBe("CRM quality review. Checked 3 contacts and 2 companies: no signals.");
    expect((await noticeData(quality.id)).examined).toEqual(quality.result.examined);

    // A finding is never hidden: the count of signals leads and the denominator follows it.
    await withSystem((db) => db.query("insert into crm_opportunities (org_id, ghl_opportunity_id, name, status, provider, created_at) values ($1, $2, 'Bare Deal', 'open', 'ghl', now())", [org.id, `den-${crypto.randomUUID().slice(0, 8)}`]));
    const withFinding = await run(org, owner, "owner", "sales_assistant", "pipeline_review", "Pipeline review again");
    expect(withFinding.result.examined).toEqual([{ label: "deals", count: 3 }]);
    expect(withFinding.result_summary).toMatch(/^Pipeline review found \d+ signals? across \d+ affected items?/);
    expect(withFinding.result_summary).toContain("Checked 3 deals.");
    expect(withFinding.result_count).toBeGreaterThan(0);
  }, 120_000);

  it("counts only the bookings and priorities the checks read", async () => {
    const { org, owner } = await freshWorkspace("Denominators Bookings Co");
    await withSystem(async (db) => {
      const contact = (await db.query<{ id: string }>("insert into contacts (org_id, display_name, email) values ($1, 'Booker', 'booker@example.test') returning id", [org.id])).rows[0].id;
      const booking = (status: string, title: string, assigned: string | null) => db.query(
        `insert into appointment_bookings (org_id, contact_id, calendar_id, start_at, end_at, timezone, title, requested_by_kind, status, ghl_appointment_id, booked_at, assigned_user_id, idempotency_key)
         values ($1, $2, 'cal-den', now() + interval '4 days', now() + interval '4 days' + interval '30 minutes', 'UTC', $3, 'ai', $4, $5, $6, $7, $8)`,
        [org.id, contact, title, status, status === "booked" ? `ghl-${crypto.randomUUID().slice(0, 8)}` : null, status === "booked" ? new Date() : null, assigned, `den-booking-${crypto.randomUUID()}`],
      );
      await booking("booked", "Assigned booking", owner.id);
      await booking("cancelled", "Cancelled booking", null);
      // Two contacts the scoring engine has assessed and one it has not.
      await db.query("insert into contacts (org_id, display_name, priority_label, priority_evaluated_at) values ($1, 'Assessed One', 'cold', now()), ($1, 'Assessed Two', 'cold', now()), ($1, 'Never Scored', null, null)", [org.id]);
    });
    const appointments = await run(org, owner, "owner", "appointment_setter", "appointment_review", "Appointment review");
    expect(appointments.result.examined).toEqual([{ label: "bookings", count: 1 }]);
    expect(appointments.result_summary).toBe("Appointment review. Checked 1 booking: no signals.");
    const priority = await run(org, owner, "owner", "sales_assistant", "lead_priority_review", "Lead priority review");
    expect(priority.result.examined).toEqual([{ label: "assessed leads", count: 2 }]);
    expect(priority.result_summary).toBe("Lead priority review. Checked 2 assessed leads: no signals.");
  }, 120_000);
});

describe("a final launch check on an empty workspace still passes, and says so truthfully", () => {
  it("reaches 100% Ready to Launch and words the check as what it examined", async () => {
    const c = await readyClient({ name: "Denominators Launch Roofing", timezone: "America/Chicago" });
    await sweepLaunchVerification(c.org.id);
    await settled(c.org.id, 6);
    const r = (await getLaunchReadiness(c.ctx))!;
    expect(r).toMatchObject({ state: "ready_to_launch", percent: 100 });
    for (const role of ["crm_manager", "sales_assistant"] as const) {
      const check = itemOf(r, `verification.${role}`);
      expect(check.state, role).toBe("done");
      expect(check.detail, role).toMatch(/Checked \d+ /);
      expect(check.detail, role).not.toMatch(/no actionable signals/);
    }
    const jobs = await withSystem((db) => db.query<{ result: { examined?: Examined } }>("select result from ai_work_jobs where org_id = $1 and input ->> 'launchVerification' = 'true' and capability <> 'appointment_availability'", [c.org.id]));
    expect(jobs.rows.every((row) => Array.isArray(row.result.examined) || row.result.examined === undefined)).toBe(true);
  }, 180_000);
});

describe("the snapshot withholds AI run figures from a person who may not view activity", () => {
  it("gives a Team member no ai_runs metric, no failure-rate finding and no AI run count, and gives an owner and a Manager all of them", async () => {
    const { org, owner } = await freshWorkspace("Denominators Runs Co");
    const member = await createUser();
    await addMember(org.id, member.id, "member");
    const manager = await createUser();
    await addMember(org.id, manager.id, "admin");
    const analyst = await agentId(org.id, "performance_analyst");
    await withSystem(async (db) => {
      // Five runs, two failed: over the 20% review threshold, so the failure-rate finding exists for anyone who may see it.
      for (let i = 0; i < 5; i += 1) {
        await db.query(
          `insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, started_at)
           values ($1, $2, $3, 'chat', $4, $5, now() - interval '1 day')`,
          [org.id, analyst, owner.id, `den-run-${crypto.randomUUID()}`, i < 2 ? "failed" : "completed"],
        );
      }
      await db.query("insert into leads (org_id, business_name, review_status, created_at) values ($1, 'Snapshot Lead', 'pending', now())", [org.id]);
    });

    const asMember = await run(org, member, "member", "performance_analyst", "performance_snapshot", "Snapshot for a member");
    expect(asMember.status).toBe("completed");
    const memberKeys = asMember.result.metrics.map((m) => m.key);
    expect(memberKeys).toHaveLength(10);
    expect(memberKeys.some((key) => key.startsWith("ai_runs_"))).toBe(false);
    expect(memberKeys).toContain("leads_created");
    expect(asMember.result.findings.map((f) => f.key)).not.toContain("ai_run_failure_rate");
    expect(asMember.result.examined?.map((e) => e.label)).toEqual(["leads", "contacts", "appointments", "deals"]);
    expect(JSON.stringify(asMember.result)).not.toMatch(/AI runs? (completed|failed)|ai_runs_|did not complete/i);
    expect(asMember.result_summary).not.toMatch(/AI run/);
    expect(JSON.stringify(await noticeData(asMember.id))).not.toMatch(/AI runs/);

    for (const [user, role] of [[owner, "owner"], [manager, "admin"]] as const) {
      const full = await run(org, user, role, "performance_analyst", "performance_snapshot", `Snapshot for ${role}`);
      expect(full.status, role).toBe("completed");
      const keys = full.result.metrics.map((m) => m.key);
      expect(keys, role).toHaveLength(12);
      expect(keys, role).toEqual(expect.arrayContaining(["ai_runs_completed", "ai_runs_failed"]));
      expect(full.result.findings.map((f) => f.key), role).toContain("ai_run_failure_rate");
      expect(full.result.examined?.find((e) => e.label === "AI runs")?.count, role).toBe(5);
    }
  }, 120_000);
});

describe("the snapshot says no to AI run figures whenever it cannot tell who is asking", () => {
  it("shows them only to a requester who may view this workspace's activity: no requester, a removed member, a stranger, another workspace's owner, an agency person without scope and an unreadable id all get none", async () => {
    const { org, owner } = await freshWorkspace("Denominators Requester Co");
    const removed = await createUser();
    await addMember(org.id, removed.id, "owner");
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [org.id, removed.id]));
    const stranger = await createUser();
    const elsewhere = await freshWorkspace("Denominators Other Requester Co");
    const { staff } = await agencyPeople();
    const may = (requestedBy: string | null) => requesterMayReadRuns({ org_id: org.id, requested_by: requestedBy });

    // The control: the owner may, so every "no" below is about the requester and not about the workspace.
    expect(await may(owner.id)).toBe(true);
    expect(await may(null)).toBe(false);
    expect(await may(removed.id)).toBe(false);
    expect(await may(stranger.id)).toBe(false);
    expect(await may(elsewhere.owner.id)).toBe(false);
    // An id the database cannot read (the read throws) is a no as well, never a yes.
    expect(await may("not-a-user-id")).toBe(false);
    expect(await may(crypto.randomUUID())).toBe(false);
    // An agency person with no scope over this workspace is not its member either: the permission read says no, and nothing is assumed for them.
    expect(await may(staff.id)).toBe(false);
  }, 120_000);
});

describe("a review says where its records came from", () => {
  it("states native mode for a native workspace, and the same source in the result and in the event", async () => {
    const { org, owner } = await freshWorkspace("Denominators Native Source Co");
    const job = await run(org, owner, "owner", "sales_assistant", "pipeline_review", "Pipeline review");
    expect(job.result.source).toEqual({ crmMode: "native", provider: "native" });
    expect(job.result.limitations).toContain(NATIVE_NOTE);
    expect((await noticeData(job.id)).source).toEqual({ crmMode: "native", provider: "native" });
  }, 60_000);

  it("states a hybrid workspace's mode and the owner of that capability instead of describing it as native", async () => {
    const { org, owner } = await freshWorkspace("Denominators Hybrid Source Co");
    await withSystem(async (db) => {
      await db.query("update crm_workspaces set mode = 'hybrid' where org_id = $1", [org.id]);
      await db.query(
        `insert into crm_capability_providers (org_id, capability, provider) values ($1, 'opportunities', 'ghl'), ($1, 'contacts', 'native'), ($1, 'appointments', 'native')
         on conflict (org_id, capability) do update set provider = excluded.provider`,
        [org.id],
      );
    });
    const pipeline = await run(org, owner, "owner", "sales_assistant", "pipeline_review", "Pipeline review");
    expect(pipeline.status).toBe("completed");
    expect(pipeline.result.source).toEqual({ crmMode: "hybrid", provider: "ghl" });
    expect(pipeline.result.limitations).toContain("Read from the records iAcquire holds (hybrid mode)");
    expect(pipeline.result.limitations).not.toContain(NATIVE_NOTE);
    const quality = await run(org, owner, "owner", "crm_manager", "crm_quality_review", "CRM quality review");
    expect(quality.result.source).toEqual({ crmMode: "hybrid", provider: "native" });
    expect((await noticeData(pipeline.id)).source).toEqual({ crmMode: "hybrid", provider: "ghl" });
    const calendar = await run(org, owner, "owner", "appointment_setter", "appointment_availability", "Calendar availability check");
    expect(calendar.result.source).toMatchObject({ crmMode: "hybrid" });
    expect(calendar.result.limitations).toContain("hybrid mode");
  }, 90_000);

  it("says the records are the copies iAcquire stores for a GoHighLevel workspace, and still reads them", async () => {
    const { org, owner } = await freshWorkspace("Denominators GHL Source Co");
    await withSystem(async (db) => {
      await db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [org.id]);
      await db.query(
        `insert into crm_opportunities (org_id, ghl_opportunity_id, name, status, provider, monetary_value, assigned_to, contact_label, expected_close_date, stage_entered_at, updated_at, created_at)
         values ($1, $2, 'Cached GHL Deal', 'open', 'ghl', 100, 'Owner', 'Acme', current_date + 10, now(), now(), now())`,
        [org.id, `den-ghl-${crypto.randomUUID().slice(0, 8)}`],
      );
    });
    const job = await run(org, owner, "owner", "sales_assistant", "pipeline_review", "Pipeline review");
    expect(job.status).toBe("completed");
    expect(job.result.source).toEqual({ crmMode: "ghl", provider: "ghl" });
    expect(job.result.limitations).toContain("Read from the records iAcquire holds (GoHighLevel mode)");
    expect(job.result.limitations).toContain("copies iAcquire stores");
    expect(job.result.examined).toEqual([{ label: "deals", count: 1 }]);
  }, 60_000);
});
