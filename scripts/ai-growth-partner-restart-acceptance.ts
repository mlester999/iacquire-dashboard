/**
 * Restart acceptance for app-owned Growth Partner memory/goals, a paused cron schedule,
 * reviewed legacy knowledge, the permanent conversation and Work Board ledger.
 * Uses one disposable, file-backed PGlite database, closes it, then opens it in a fresh Node
 * process. This verifies application database recovery only; it does not exercise Hermes or its
 * separate long-term profile memory.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DB_PREFIX = "iacquire-growth-partner-restart-";
const dataDirEnvKey = "PGLITE_DATA_DIR";
const phaseKey = "IACQUIRE_GROWTH_PARTNER_RESTART_PHASE";
const worker = process.env[phaseKey] === "verify";

function setIsolatedEnvironment(dataDir: string) {
  Reflect.set(process.env, "NODE_ENV", "test");
  process.env.AUTH_PROVIDER = "local";
  process.env.SECRET_STORE = "test-memory";
  process.env.APP_ENCRYPTION_KEY = "restart-acceptance-only-key-0123456789abcdef";
  process.env.DATABASE_DRIVER = "pglite";
  process.env.DATABASE_URL = "";
  process.env[dataDirEnvKey] = dataDir;
  process.env.ALLOW_REMOTE_DB_IN_DEV = "false";
  process.env.UPLOAD_DIR = path.join(dataDir, "uploads");
}

async function runWorker() {
  const orgId = process.env.IACCEPTANCE_ORG_ID ?? "";
  const userId = process.env.IACCEPTANCE_USER_ID ?? "";
  const jobId = process.env.IACCEPTANCE_JOB_ID ?? "";
  const scheduleId = process.env.IACCEPTANCE_SCHEDULE_ID ?? "";
  const expectedConversationId = process.env.IACCEPTANCE_CONVERSATION_ID ?? "";
  if (![orgId, userId, jobId, scheduleId, expectedConversationId].every(Boolean)) throw new Error("Restart verification identifiers are missing.");

  const [{ withSystem, closeDb }, fixtures] = await Promise.all([
    import("../src/server/db/index"),
    import("../tests/support/fixtures"),
  ]);
  const [{ getGrowthPartnerConversationPage, searchGrowthPartnerConversation }, { getWorkJobView }, { listGrowthPartnerMemories, growthPartnerMemoryPromptContext }, { growthPartnerGoalPromptContext, listGrowthPartnerGoalProgress }, { employeeKnowledgeContext }] = await Promise.all([
    import("../src/server/ai-growth-partner/service"),
    import("../src/server/workforce/jobs"),
    import("../src/server/ai-growth-partner/memory"),
    import("../src/server/ai-growth-partner/goals"),
    import("../src/server/workforce/knowledge"),
  ]);

  try {
    const { rows } = await withSystem((db) => db.query<{
      email: string; org_name: string; org_slug: string;
    }>(
      `select u.email::text as email, o.name as org_name, o.slug as org_slug
         from users u cross join organizations o
        where u.id = $1 and o.id = $2`,
      [userId, orgId],
    ));
    const identity = rows[0];
    if (!identity) throw new Error("The persisted test user or tenant could not be read after restart.");
    const ctx = fixtures.ctxFor(
      { id: userId, email: identity.email },
      { id: orgId, name: identity.org_name, slug: identity.org_slug },
      "owner",
    );
    const page = await getGrowthPartnerConversationPage(ctx);
    if (!page || page.conversation.id !== expectedConversationId) throw new Error("The canonical Growth Partner conversation did not recover after process restart.");
    if (!page.messages.some((message) => message.content.includes("persistent conversation restart marker"))) {
      throw new Error("The persisted conversation marker was missing after restart.");
    }
    const matches = await searchGrowthPartnerConversation(ctx, "persistent conversation restart marker");
    if (!matches.length) throw new Error("Conversation search did not recover the persisted marker.");
    const memories = await listGrowthPartnerMemories(ctx);
    if (!memories.some((memory) => memory.content === "The business prefers concise progress updates.")) {
      throw new Error("App-owned Growth Partner memory did not recover after process restart.");
    }
    const runtimeId = (await withSystem((db) => db.query<{ runtime_agent_instance_id: string }>(
      "select runtime_agent_instance_id from ai_growth_partners where org_id = $1",
      [orgId],
    ))).rows[0]?.runtime_agent_instance_id;
    if (!runtimeId) throw new Error("The persisted Growth Partner runtime link could not be read after restart.");
    const promptMemory = await withSystem((db) => growthPartnerMemoryPromptContext(db, orgId, runtimeId, "concise progress updates"));
    if (!promptMemory.includes(JSON.stringify("The business prefers concise progress updates."))) {
      throw new Error("The persisted memory did not return as prompt context after process restart.");
    }
    const goals = await listGrowthPartnerGoalProgress(ctx);
    if (!goals.some((goal) => goal.metric === "leads_approved" && goal.cadence === "monthly" && goal.targetValue === 9 && goal.enabled)) {
      throw new Error("The saved Growth Partner goal did not recover after process restart.");
    }
    const promptGoals = await withSystem((db) => growthPartnerGoalPromptContext(db, orgId, runtimeId));
    if (!promptGoals.includes("Leads approved: 9 per month.")) {
      throw new Error("The persisted Growth Partner goal did not return as prompt context after process restart.");
    }
    const partnerKnowledge = await withSystem((db) => employeeKnowledgeContext(db, orgId, runtimeId, {
      includeCompanyKnowledge: false,
      includeGrowthPartnerLegacyKnowledge: true,
    }));
    if (!partnerKnowledge.block.includes("Persistent approved legacy knowledge after restart.")) {
      throw new Error("The approved retained-profile knowledge did not recover as Partner context after process restart.");
    }
    const schedule = (await withSystem((db) => db.query<{
      role_key: string;
      capability: string;
      cadence: string;
      timezone: string;
      enabled: boolean;
      recurrence_rule: { kind?: string; localTime?: string } | null;
      business_hours: { mon?: string[][] };
    }>(
      `select a.role_key, s.capability, s.cadence, s.timezone, s.enabled, s.recurrence_rule, s.business_hours
         from ai_work_schedules s
         join agent_instances a on a.id = s.agent_instance_id and a.org_id = s.org_id
        where s.id = $1 and s.org_id = $2`,
      [scheduleId, orgId],
    ))).rows[0];
    if (!schedule || schedule.role_key !== "growth_partner" || schedule.capability !== "proactive_review"
      || schedule.enabled || schedule.cadence !== "daily" || schedule.timezone !== "UTC"
      || schedule.recurrence_rule?.kind !== "daily" || schedule.recurrence_rule.localTime !== "09:00"
      || schedule.business_hours.mon?.[0]?.[0] !== "09:00" || schedule.business_hours.mon?.[0]?.[1] !== "17:00") {
      throw new Error("The saved paused Growth Partner cron schedule did not recover with its approved settings after process restart.");
    }
    const job = await getWorkJobView(ctx, jobId);
    if (!job || job.status !== "completed" || job.resultSummary !== "Persistent restart acceptance task state.") {
      throw new Error("The completed Work Board task did not recover after restart.");
    }
    console.log(JSON.stringify({
      phase: "restart-verified",
      database: "disposable file-backed PGlite",
      conversationRecovered: true,
      conversationSearchRecovered: true,
      applicationMemoryRecovered: true,
      applicationMemoryPromptContextRecovered: true,
      goalConfigurationRecovered: true,
      goalPromptContextRecovered: true,
      approvedLegacyKnowledgePromptContextRecovered: true,
      pausedCronScheduleRecovered: true,
      pausedCronScheduleExecuted: false,
      workBoardTaskRecovered: true,
      hermesMemoryVerified: false,
    }));
  } finally {
    await closeDb();
  }
}

async function seedAndRestart() {
  const tempRoot = os.tmpdir();
  const dataDir = await mkdtemp(path.join(tempRoot, DB_PREFIX));
  const resolvedTempRoot = path.resolve(tempRoot);
  const resolvedDataDir = path.resolve(dataDir);
  if (path.dirname(resolvedDataDir) !== resolvedTempRoot || !path.basename(resolvedDataDir).startsWith(DB_PREFIX)) {
    throw new Error("Refusing to use a restart-test database outside its unique temporary directory.");
  }
  setIsolatedEnvironment(resolvedDataDir);

  try {
    const [{ withSystem, closeDb }, fixtures, { createConfigVersion, ensureGrowthPartnerRuntime }, { defaultSettings }, { createWorkJob, appendWorkEvent }] = await Promise.all([
      import("../src/server/db/index"),
      import("../tests/support/fixtures"),
      import("../src/server/workforce/service"),
      import("../src/server/workforce/compiler"),
      import("../src/server/workforce/jobs"),
    ]);
    const org = await fixtures.createOrg({ name: `Restart Acceptance ${randomUUID().slice(0, 8)}` });
    const owner = await fixtures.createUser({ name: "Restart Acceptance Owner" });
    await fixtures.addMember(org.id, owner.id, "owner");
    const { runtimeId, conversationId } = await withSystem(async (db) => {
      const runtimeId = await ensureGrowthPartnerRuntime(org.id, db);
      const partnerId = (await db.query<{ id: string }>(
        "select id from ai_growth_partners where org_id = $1 and runtime_agent_instance_id = $2",
        [org.id, runtimeId],
      )).rows[0]?.id;
      if (!partnerId) throw new Error("The Growth Partner identity was not created in the restart database.");
      const conversationId = (await db.query<{ id: string }>(
        `insert into chat_conversations (org_id, agent_instance_id, user_id, growth_partner_id, title, hermes_session_id)
         values ($1, $2, null, $3, 'AI Growth Partner', $4) returning id`,
        [org.id, runtimeId, partnerId, `iaq:${org.id}:growth_partner`],
      )).rows[0]?.id;
      if (!conversationId) throw new Error("The canonical conversation was not created.");
      await db.query(
        `insert into chat_messages (conversation_id, org_id, role, content, status, client_message_id, author_user_id)
         values ($1, $2, 'user', 'Remember this persistent conversation restart marker.', 'complete', $3, $4),
                ($1, $2, 'assistant', 'I will keep this verified note in the shared conversation history.', 'complete', null, null)`,
        [conversationId, org.id, `restart-${randomUUID()}`, owner.id],
      );
      await db.query(
        "insert into ai_growth_partner_memories (partner_id, org_id, kind, content, content_fingerprint, created_by, updated_by) " +
        "values ($1, $2, 'preference', $3, $4, $5, $5)",
        [
          partnerId,
          org.id,
          "The business prefers concise progress updates.",
          createHash("sha256").update("the business prefers concise progress updates").digest("hex"),
          owner.id,
        ],
      );
      await db.query(
        "insert into ai_growth_partner_goals (partner_id, org_id, metric_key, cadence, target_value, created_by, updated_by) values ($1, $2, 'leads_approved', 'monthly', 9, $3, $3)",
        [partnerId, org.id, owner.id],
      );
      await db.query(
        `insert into ai_growth_partner_legacy_knowledge
           (partner_id, org_id, source_type, source_record_id, source_version, source_role_key, title, content, status, created_by, reviewed_by, reviewed_at)
         values ($1, $2, 'employee_note', $3, '1', 'lead_hunter', 'Restart context',
           'Persistent approved legacy knowledge after restart.', 'approved', $4, $4, now())`,
        [partnerId, org.id, randomUUID(), owner.id],
      );
      return { runtimeId, conversationId };
    });
    await withSystem((db) => createConfigVersion(db, {
      orgId: org.id,
      agentId: runtimeId,
      settings: defaultSettings("growth_partner"),
      source: "onboarding",
      userId: owner.id,
      apply: true,
    }));
    await withSystem((db) => db.query(
      "update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where id = $1 and org_id = $2",
      [runtimeId, org.id],
    ));
    const scheduleId = await withSystem(async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into ai_work_schedules
           (org_id, agent_instance_id, created_by, capability, cadence, interval_minutes, timezone, business_hours, payload, recurrence_rule, enabled, next_run_at)
         values ($1, $2, $3, 'proactive_review', 'daily', 1440, 'UTC', $4::jsonb, '{}'::jsonb, $5::jsonb, false, now() + interval '1 day')
         returning id`,
        [org.id, runtimeId, owner.id, JSON.stringify({ mon: [["09:00", "17:00"]] }), JSON.stringify({ kind: "daily", localTime: "09:00" })],
      );
      if (!rows[0]) throw new Error("The paused Growth Partner schedule could not be persisted.");
      return rows[0].id;
    });
    const job = await withSystem(async (db) => {
      const created = await createWorkJob(db, {
        orgId: org.id,
        agentId: runtimeId,
        requestedBy: owner.id,
        capability: "lead_research",
        title: "Persistent restart acceptance",
        idempotencyKey: `restart-acceptance:${randomUUID()}`,
        conversationId,
        input: { fixtureOnly: true },
        maxAttempts: 1,
      });
      await db.query(
        `update ai_work_jobs set status = 'completed', stage = 'completed', result = '{"persisted":true}'::jsonb,
                result_summary = 'Persistent restart acceptance task state.', result_count = 1, started_at = now(), finished_at = now()
          where id = $1 and org_id = $2`,
        [created.id, org.id],
      );
      await appendWorkEvent(db, { jobId: created.id, orgId: org.id, kind: "evidence", stage: "completed", message: "Persistent restart acceptance task state." });
      return created;
    });

    await closeDb();
    const scriptPath = fileURLToPath(import.meta.url);
    const childEnv = {
      ...process.env,
      [dataDirEnvKey]: resolvedDataDir,
      [phaseKey]: "verify",
      IACCEPTANCE_ORG_ID: org.id,
      IACCEPTANCE_USER_ID: owner.id,
      IACCEPTANCE_JOB_ID: job.id,
      IACCEPTANCE_SCHEDULE_ID: scheduleId,
      IACCEPTANCE_CONVERSATION_ID: conversationId,
    };
    const child = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", scriptPath], {
      cwd: process.cwd(),
      env: childEnv,
      encoding: "utf8",
      timeout: 180_000,
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.status !== 0) throw new Error(`The fresh-process restart check failed: ${child.stderr || child.error?.message || `exit ${child.status}`}`);
    console.log(JSON.stringify({
      phase: "restart-seeded",
      database: "disposable file-backed PGlite",
      tenantIsolated: true,
      runtime: "logical Growth Partner row only; Hermes not started",
    }));
  } finally {
    const target = path.resolve(resolvedDataDir);
    if (path.dirname(target) !== resolvedTempRoot || !path.basename(target).startsWith(DB_PREFIX)) {
      throw new Error("Refusing to remove a restart-test directory outside the verified temporary target.");
    }
    await rm(target, { recursive: true, force: true });
  }
}

async function main() {
  if (worker) {
    const dataDir = process.env[dataDirEnvKey];
    if (!dataDir) throw new Error("The disposable database path is missing.");
    setIsolatedEnvironment(dataDir);
    await runWorker();
  } else {
    await seedAndRestart();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
