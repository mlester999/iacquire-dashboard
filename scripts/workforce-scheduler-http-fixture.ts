/** Local seed and read-back worker for workforce-scheduler-http-qa.mjs. */
import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeDb, withSystem, withUser } from "../src/server/db/index";
import { defaultSettings } from "../src/server/workforce/compiler";
import { saveSchedule } from "../src/server/workforce/schedules";
import { createConfigVersion, ensureGrowthPartnerRuntime } from "../src/server/workforce/service";
import { listWorkBoardJobs } from "../src/server/workforce/work-board";
import { addMember, createOrg, createUser, ctxFor } from "../tests/support/fixtures";

const capability = "proactive_review";
const role = "growth_partner";

async function tenant(name: string, enabled: boolean, scheduledAt: string) {
  const org = await createOrg({ name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const runtimeId = await withSystem(async (db) => {
    const id = await ensureGrowthPartnerRuntime(org.id, db);
    const version = await createConfigVersion(db, {
      orgId: org.id, agentId: id, settings: defaultSettings(role), source: "onboarding", userId: owner.id, apply: true,
    });
    assert.equal(version.status, "applied");
    await db.query(
      "update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where org_id = $1 and id = $2",
      [org.id, id],
    );
    return id;
  });
  const schedule = await saveSchedule(ctxFor(owner, org, "owner"), {
    agentRole: role,
    capability,
    cadence: "daily",
    recurrenceRule: { kind: "daily", localTime: scheduledAt.slice(11, 16) },
    enabled,
  });
  // Place both rows at the same past wall-clock slot so a paused row would also qualify if the pause were ignored.
  await withSystem((db) => db.query(
    "update ai_work_schedules set next_run_at = $3::timestamptz where org_id = $1 and id = $2",
    [org.id, schedule.id, scheduledAt],
  ));
  return { org, owner, runtimeId, scheduleId: schedule.id };
}

async function seed() {
  const reference = new Date(Date.now() - 60_000);
  reference.setUTCSeconds(0, 0);
  const scheduledAt = reference.toISOString();
  const due = await tenant("Fictional Scheduler QA Enabled", true, scheduledAt);
  const paused = await tenant("Fictional Scheduler QA Paused", false, scheduledAt);
  return { scheduledAt, due, paused };
}

async function verify(fixture: Awaited<ReturnType<typeof seed>>, expected: "empty" | "completed") {
  const { due, paused, scheduledAt } = fixture;
  const snapshot = await withSystem(async (db) => {
    const { rows: jobs } = await db.query<{
      id: string; org_id: string; agent_instance_id: string; requested_by: string; capability: string;
      status: string; idempotency_key: string; input: unknown; result: { checksRun?: number };
    }>(`select id, org_id, agent_instance_id, requested_by, capability, status, idempotency_key, input, result
          from ai_work_jobs order by created_at`);
    const { rows: schedules } = await db.query<{
      id: string; enabled: boolean; next_run_at: Date; last_job_id: string | null;
    }>(`select id, enabled, next_run_at, last_job_id from ai_work_schedules order by enabled desc`);
    const { rows: events } = await db.query<{
      org_id: string; job_id: string; schedule_id: string; scheduled_at: string;
    }>(`select org_id, job_id, data->>'scheduleId' as schedule_id, data->>'scheduledAt' as scheduled_at
          from ai_work_events where kind = 'notice' and data ? 'scheduleId' and data ? 'scheduledAt'`);
    const { rows: audit } = await db.query<{ org_id: string; target_id: string; actor_user_id: string; enabled: boolean }>(
      `select org_id, target_id, actor_user_id, (metadata->>'enabled')::boolean as enabled
         from audit_logs where action = 'workforce.schedule_saved' and result = 'success' order by enabled desc`,
    );
    const { rows: external } = await db.query<{ outbound: number; delivery: number; hermes: number }>(
      `select (select count(*)::int from conversation_messages) as outbound,
              (select count(*)::int from message_delivery_events) as delivery,
              (select count(*)::int from agent_runs) as hermes`,
    );
    assert.deepEqual(external, [{ outbound: 0, delivery: 0, hermes: 0 }]);
    assert.deepEqual(audit, [
      { org_id: due.org.id, target_id: due.scheduleId, actor_user_id: due.owner.id, enabled: true },
      { org_id: paused.org.id, target_id: paused.scheduleId, actor_user_id: paused.owner.id, enabled: false },
    ]);
    assert.equal(schedules.length, 2);
    const [runningSchedule, pausedSchedule] = schedules;
    assert.equal(runningSchedule.id, due.scheduleId);
    assert.equal(runningSchedule.enabled, true);
    assert.deepEqual(pausedSchedule, { id: paused.scheduleId, enabled: false, next_run_at: new Date(scheduledAt), last_job_id: null });
    if (expected === "empty") {
      assert.deepEqual(jobs, []);
      assert.deepEqual(events, []);
      assert.equal(runningSchedule.last_job_id, null);
      assert.equal(runningSchedule.next_run_at.toISOString(), scheduledAt);
      return { jobs: 0 };
    }

    assert.equal(jobs.length, 1);
    const [job] = jobs;
    assert.deepEqual({
      orgId: job.org_id, runtimeId: job.agent_instance_id, requestedBy: job.requested_by,
      capability: job.capability, status: job.status, occurrence: job.idempotency_key, input: job.input,
    }, {
      orgId: due.org.id, runtimeId: due.runtimeId, requestedBy: due.owner.id,
      capability, status: "completed", occurrence: `schedule:${due.scheduleId}:${scheduledAt.slice(0, 16)}`,
      input: { scheduleId: due.scheduleId, scheduled: true, scheduledAt },
    });
    assert.equal(job.result.checksRun, 9);
    assert.deepEqual(events, [{
      org_id: due.org.id, job_id: job.id, schedule_id: due.scheduleId, scheduled_at: scheduledAt,
    }]);
    assert.equal(runningSchedule.last_job_id, job.id);
    assert.equal(runningSchedule.next_run_at.getTime(), new Date(scheduledAt).getTime() + 86_400_000);
    return { jobs: 1, jobId: job.id, occurrence: job.idempotency_key, nextRunAt: runningSchedule.next_run_at.toISOString(), pausedJobs: 0, scheduleAudits: 2, scheduledEvents: 1, providerRows: 0 };
  });
  if ("jobId" in snapshot) {
    const visible = await listWorkBoardJobs(ctxFor(due.owner, due.org, "owner"));
    assert.deepEqual(visible.map(({ id, employeeRole, status }) => ({ id, employeeRole, status })), [
      { id: snapshot.jobId, employeeRole: role, status: "completed" },
    ]);
    const otherTenant = await listWorkBoardJobs(ctxFor(paused.owner, paused.org, "owner"));
    assert.deepEqual(otherTenant, []);
    await withUser(paused.owner.id, async (db) => {
      assert.deepEqual((await db.query("select id from ai_work_jobs where id = $1", [snapshot.jobId])).rows, []);
      assert.deepEqual((await db.query("select id from ai_work_events where job_id = $1", [snapshot.jobId])).rows, []);
    });
  }
  return snapshot;
}

async function main() {
  const [phase, statePath] = process.argv.slice(2);
  assert.ok(statePath && (phase === "seed" || phase === "empty" || phase === "completed"));
  const directory = await realpath(path.dirname(statePath));
  const qaRoot = await realpath(".data/crm-qa");
  assert.equal(path.dirname(directory), qaRoot);
  assert.match(path.basename(directory), /^scheduler-http-[A-Za-z0-9]+$/);
  assert.equal(path.basename(statePath), "fixture.json");
  assert.equal(path.resolve(process.env.PGLITE_DATA_DIR ?? ""), path.join(directory, "database"));
  assert.equal(process.env.DATABASE_DRIVER, "pglite");
  assert.equal(process.env.DATABASE_URL, "");
  assert.equal(process.env.AUTH_PROVIDER, "local");
  assert.equal(process.env.OUTBOUND_MESSAGING_ENABLED, "false");
  assert.equal(process.env.HELP_LLM_PROVIDER, "none");
  try {
    if (phase === "seed") {
      await writeFile(statePath, JSON.stringify(await seed()), { flag: "wx" });
    } else {
      const fixture = JSON.parse(await readFile(statePath, "utf8")) as Awaited<ReturnType<typeof seed>>;
      console.log(JSON.stringify(await verify(fixture, phase)));
    }
  } finally {
    await closeDb();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
