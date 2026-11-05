/**
 * Restart acceptance for app-owned Growth Partner memory, the permanent conversation and Work Board ledger.
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
  const expectedConversationId = process.env.IACCEPTANCE_CONVERSATION_ID ?? "";
  if (![orgId, userId, jobId, expectedConversationId].every(Boolean)) throw new Error("Restart verification identifiers are missing.");

  const [{ withSystem, closeDb }, fixtures] = await Promise.all([
    import("../src/server/db/index"),
    import("../tests/support/fixtures"),
  ]);
  const [{ getGrowthPartnerConversationPage, searchGrowthPartnerConversation }, { getWorkJobView }, { listGrowthPartnerMemories, growthPartnerMemoryPromptContext }] = await Promise.all([
    import("../src/server/ai-growth-partner/service"),
    import("../src/server/workforce/jobs"),
    import("../src/server/ai-growth-partner/memory"),
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
    const [{ withSystem, closeDb }, fixtures, { ensureGrowthPartnerRuntime }, { createWorkJob, appendWorkEvent }] = await Promise.all([
      import("../src/server/db/index"),
      import("../tests/support/fixtures"),
      import("../src/server/workforce/service"),
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
      return { runtimeId, conversationId };
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
