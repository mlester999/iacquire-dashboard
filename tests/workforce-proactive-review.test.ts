import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { createWorkJob } from "@/server/workforce/jobs";
import { runWorkJob } from "@/server/workforce/work-runner";
import { listWorkBoardJobs, workBoardSummary } from "@/server/workforce/work-board";
import { WORKFORCE_CAPABILITIES, capabilitiesForRole, roleMayUseCapability } from "@/lib/workforce-capabilities";

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let member: { id: string; email: string };
let operationsManagerId: string;

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
  throw new Error("job did not settle");
}

beforeAll(async () => {
  org = await createOrg({ name: "Operations Review Co" });
  owner = await createUser();
  member = await createUser();
  await addMember(org.id, owner.id, "owner");
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
  await withSystem(async (db) => {
    await db.query("update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where org_id = $1", [org.id]);
    await db.query("update agent_instances set status = 'offline' where org_id = $1 and role_key = 'sales_assistant'", [org.id]);
  });
}, 60000);

describe("reviewed capability allowlists", () => {
  it("gives Lead Hunter research and Operations Manager an on-demand review only", () => {
    expect(roleMayUseCapability("lead_hunter", "lead_research")).toBe(true);
    expect(roleMayUseCapability("lead_hunter", "proactive_review")).toBe(false);
    expect(roleMayUseCapability("operations_manager", "proactive_review")).toBe(true);
    expect(roleMayUseCapability("operations_manager", "lead_research")).toBe(false);
    expect(roleMayUseCapability("sales_assistant", "proactive_review")).toBe(false);
    expect(capabilitiesForRole("lead_hunter").map((definition) => definition.key)).toEqual(["lead_research", "lead_generation_review"]);
    expect(WORKFORCE_CAPABILITIES.proactive_review.requiredPermission).toBe("activity.view");
  });

  it("refuses a dispatch from the wrong role and from a member without review access", async () => {
    await expect(
      dispatchCapabilityJob(ctxFor(owner, org, "owner"), {
        agentRole: "lead_hunter",
        capability: "proactive_review",
        title: "Wrong role",
        input: {},
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    await expect(
      dispatchCapabilityJob(ctxFor(member, org, "member"), {
        agentRole: "operations_manager",
        capability: "proactive_review",
        title: "Member review",
        input: {},
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses an employee with no applied configuration", async () => {
    const other = await createOrg({ name: "Unconfigured Co" });
    const otherOwner = await createUser();
    await addMember(other.id, otherOwner.id, "owner");
    await withSystem((db) => db.query("update agent_instances set status = 'online' where org_id = $1", [other.id]));
    await expect(
      dispatchCapabilityJob(ctxFor(otherOwner, other, "owner"), {
        agentRole: "operations_manager",
        capability: "proactive_review",
        title: "No configuration",
        input: {},
      }),
    ).rejects.toMatchObject({ code: "agent_unavailable" });
  });
});

describe("on-demand operations review", () => {
  it("reads persisted records, records evidence and recommends actions without changing business records", async () => {
    const seeded = await withSystem(async (db) => {
      const approval = await db.query<{ id: string }>(
        `insert into approval_requests (org_id, requested_by, kind, title, status, created_at)
         values ($1, $2, 'outreach', 'Approve follow-up to a quiet prospect', 'pending', now() - interval '2 days') returning id`,
        [org.id, owner.id],
      );
      const task = await db.query<{ id: string }>(
        `insert into tasks (org_id, title, status, due_at) values ($1, 'Call the Johnson account', 'open', now() - interval '3 hours') returning id`,
        [org.id],
      );
      const run = await db.query<{ id: string }>(
        `insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, started_at)
         values ($1, $2, $3, 'chat', $4, 'failed', now() - interval '1 day') returning id`,
        [org.id, operationsManagerId, owner.id, `review-seed-${crypto.randomUUID()}`],
      );
      const lead = await db.query<{ id: string }>(
        `insert into leads (org_id, business_name, review_status, created_at) values ($1, 'Seed Prospect', 'pending', now() - interval '3 days') returning id`,
        [org.id],
      );
      const contact = await db.query<{ id: string }>(
        `insert into contacts (org_id, display_name, created_at) values ($1, 'Incomplete Contact', now()) returning id`,
        [org.id],
      );
      await db.query("insert into integration_status (org_id, provider, status) values ($1, 'ghl', 'error')", [org.id]);
      const stalled = await createWorkJob(db, {
        orgId: org.id,
        agentId: operationsManagerId,
        requestedBy: owner.id,
        capability: "proactive_review",
        title: "A previously failed review",
        idempotencyKey: `review-stalled-${crypto.randomUUID()}`,
        input: {},
      });
      await db.query("update ai_work_jobs set status = 'failed', stage = 'failed', failure_code = 'worker_lost' where id = $1", [stalled.id]);
      return { approvalId: approval.rows[0].id, taskId: task.rows[0].id, runId: run.rows[0].id, leadId: lead.rows[0].id, contactId: contact.rows[0].id, stalledId: stalled.id };
    });

    const dispatched = await dispatchCapabilityJob(ctxFor(owner, org, "owner"), {
      agentRole: "operations_manager",
      capability: "proactive_review",
      title: "Weekly operations review",
      input: { sinceDays: 7 },
    });
    expect(dispatched.jobId).toBeTruthy();
    const audit = await withSystem((db) =>
      db.query<{ action: string; metadata: Record<string, unknown> }>(
        "select action, metadata from audit_logs where org_id = $1 and target_id = $2 and action = 'workforce.capability_dispatched'",
        [org.id, dispatched.jobId],
      ),
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ capability: "proactive_review", agentRole: "operations_manager" });
    const job = await waitForJob(dispatched.jobId);
    expect(job.status, job.failure_message ?? undefined).toBe("completed");
    const findings = (job.result.findings as Array<{ key: string; count: number; samples: string[]; evidenceHref: string; recommendedAction: string }>) ?? [];
    const keys = findings.map((item) => item.key);
    expect(keys).toEqual(expect.arrayContaining([
      "failed_runs", "pending_approvals", "overdue_tasks", "leads_awaiting_review",
      "workforce_attention", "integration_attention", "stalled_jobs", "contact_data_quality",
    ]));
    expect(findings.find((item) => item.key === "overdue_tasks")?.count).toBe(1);
    expect(findings.find((item) => item.key === "pending_approvals")?.samples[0]).toMatch(/follow-up/i);
    expect(findings.find((item) => item.key === "workforce_attention")?.samples[0]).toMatch(/Sales Assistant/i);
    expect(findings.every((item) => item.evidenceHref.startsWith("/") && item.recommendedAction.length > 0)).toBe(true);

    const { rows: unchanged } = await withSystem(async (db) => {
      const task = await db.query<{ status: string }>("select status from tasks where id = $1", [seeded.taskId]);
      const approval = await db.query<{ status: string }>("select status from approval_requests where id = $1", [seeded.approvalId]);
      const lead = await db.query<{ review_status: string }>("select review_status from leads where id = $1", [seeded.leadId]);
      const contact = await db.query<{ display_name: string }>("select display_name from contacts where id = $1", [seeded.contactId]);
      return { rows: { task: task.rows[0], approval: approval.rows[0], lead: lead.rows[0], contact: contact.rows[0] } };
    });
    expect(unchanged.task.status).toBe("open");
    expect(unchanged.approval.status).toBe("pending");
    expect(unchanged.lead.review_status).toBe("pending");
    expect(unchanged.contact.display_name).toBe("Incomplete Contact");

    const { rows: notifications } = await withSystem((db) =>
      db.query<{ title: string; link: string | null; severity: string }>(
        "select title, link, severity from notifications where org_id = $1 and user_id = $2 order by created_at desc limit 1",
        [org.id, owner.id],
      ),
    );
    expect(notifications[0].title).toMatch(/found 8 (urgent )?signals/i);
    expect(notifications[0].link).toContain("/work?job=");
  }, 30000);

  it("lists the review on the tenant-scoped work board and hides it from a member who did not request it", async () => {
    const dispatched = await dispatchCapabilityJob(ctxFor(owner, org, "owner"), {
      agentRole: "operations_manager",
      capability: "proactive_review",
      title: "Work board visibility check",
      input: { sinceDays: 7 },
    });
    await waitForJob(dispatched.jobId);
    const ownerView = await listWorkBoardJobs(ctxFor(owner, org, "owner"), "all");
    const review = ownerView.find((job) => job.id === dispatched.jobId);
    expect(review).toBeTruthy();
    expect(review!.employeeRole).toBe("operations_manager");
    expect(review!.latestEvent).toBeTruthy();

    const memberView = await listWorkBoardJobs(ctxFor(member, org, "member"), "all");
    expect(memberView.some((job) => job.capability === "proactive_review")).toBe(false);
    // Database-level defence: the member cannot read the proactive row even without the service filter.
    expect((await withUser(member.id, (db) => db.query("select 1 from ai_work_jobs where id = $1", [review!.id]))).rows).toHaveLength(0);
    expect((await withUser(owner.id, (db) => db.query("select 1 from ai_work_jobs where id = $1", [review!.id]))).rows).toHaveLength(1);

    const summary = await workBoardSummary(ctxFor(owner, org, "owner"));
    expect(summary.completedToday).toBeGreaterThanOrEqual(1);

    const other = await createOrg({ name: "Other Work Board Co" });
    const outsider = await createUser();
    await addMember(other.id, outsider.id, "owner");
    const otherView = await listWorkBoardJobs(ctxFor(outsider, other, "owner"), "all");
    expect(otherView.some((job) => job.id === review!.id)).toBe(false);
  });

  it("does not execute a proactive review for a role that is not allowed", async () => {
    const salesAssistantId = await agentId(org.id, "sales_assistant");
    const job = await withSystem((db) =>
      createWorkJob(db, {
        orgId: org.id,
        agentId: salesAssistantId,
        requestedBy: owner.id,
        capability: "proactive_review",
        title: "Role boundary check",
        idempotencyKey: `role-boundary-${crypto.randomUUID()}`,
        input: {},
      }),
    );
    await runWorkJob(job.id);
    const { rows } = await withSystem((db) => db.query<{ status: string; failure_code: string | null }>("select status, failure_code from ai_work_jobs where id = $1", [job.id]));
    expect(rows[0]).toMatchObject({ status: "blocked", failure_code: "capability_not_allowed" });
  });

  it("routes a running job with no active lease to recovery attention, not Running now", async () => {
    const before = await workBoardSummary(ctxFor(owner, org, "owner"));
    const stale = await withSystem(async (db) => {
      const created = await createWorkJob(db, {
        orgId: org.id,
        agentId: operationsManagerId,
        requestedBy: owner.id,
        capability: "proactive_review",
        title: "Expired worker lease",
        idempotencyKey: `expired-board-${crypto.randomUUID()}`,
        input: {},
      });
      await db.query(
        `update ai_work_jobs set status='running', stage='reviewing', lease_owner=null, lease_expires_at=now() - interval '1 minute' where id=$1`,
        [created.id],
      );
      return created;
    });

    const all = await listWorkBoardJobs(ctxFor(owner, org, "owner"), "all");
    const active = await listWorkBoardJobs(ctxFor(owner, org, "owner"), "active");
    const attention = await listWorkBoardJobs(ctxFor(owner, org, "owner"), "attention");
    const staleJob = all.find((job) => job.id === stale.id);
    expect(staleJob).toMatchObject({ status: "running", statusLabel: "Recovery pending", recoveryPending: true });
    expect(active.some((job) => job.id === stale.id)).toBe(false);
    expect(attention.some((job) => job.id === stale.id)).toBe(true);

    const after = await workBoardSummary(ctxFor(owner, org, "owner"));
    expect(after.active).toBe(before.active);
    expect(after.needsAttention).toBe(before.needsAttention + 1);
  });
});
