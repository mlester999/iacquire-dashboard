import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { getConversation, sendChatMessage, stopChatRun } from "@/server/chat/service";
import { decideApproval } from "@/server/approvals/service";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { startMockHermes, type MockHermes, type MockScript } from "./support/mock-hermes";

const KEY = "k".repeat(40);
let mock: MockHermes;
let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let admin: { id: string };
let sales: string;
let script: ((input: string) => MockScript) | null = null;

async function waitForMessage(id: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await withSystem((db) =>
      db.query<{ status: string; content: string; error_code: string | null }>("select status, content, error_code from chat_messages where id = $1", [id]),
    );
    if (rows[0] && rows[0].status !== "streaming") return rows[0];
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("message did not settle");
}

async function waitForWorkJob(id: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await withSystem((db) =>
      db.query<{ status: string; stage: string; result_summary: string | null }>(
        "select status, stage, result_summary from ai_work_jobs where id = $1",
        [id],
      ),
    );
    const job = rows[0];
    if (job && ["completed", "blocked", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("work job did not settle");
}

async function waitForMockRequest(startIndex: number, method: string, path: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (mock.requests.slice(startIndex).some((request) => request.method === method && request.path === path)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("mock Hermes did not receive " + method + " " + path);
}

beforeAll(async () => {
  mock = await startMockHermes({
    "c-chat-sales-assistant": { key: KEY, respond: (input) => (script ? script(input) : { steps: [{ tool: "crm_lookup" }, { delta: "Hello " }, { delta: "from Hermes." }], output: "Hello from Hermes." }) },
    "c-chat-lead-hunter": { key: KEY, tools: ["web_search", "terminal", "read_file"] },
  });
  org = await createOrg({ name: "Chat Co" });
  owner = await createUser();
  admin = await createUser({ platformRole: "agency_super_admin" });
  await addMember(org.id, owner.id, "owner");
  sales = await agentId(org.id, "sales_assistant");
  await withSystem((db) =>
    createConfigVersion(db, { orgId: org.id, agentId: sales, settings: defaultSettings("sales_assistant"), source: "onboarding", userId: owner.id, apply: true }),
  );
});

afterAll(async () => {
  await mock.close();
});

describe("agent readiness", () => {
  it("refuses to chat before a dedicated profile is connected", async () => {
    await expect(
      sendChatMessage(ctxFor(owner, org, "owner"), { agentRole: "sales_assistant", content: "hi", clientMessageId: crypto.randomUUID() }),
    ).rejects.toThrow(/being set up|still being set up/);
  });

  it("goes online only after a real authenticated health check", async () => {
    await connectHermesProfile({ agentId: sales, baseUrl: mock.url, profile: "c-chat-sales-assistant", apiKey: KEY, agencyUserId: admin.id });
    const { rows } = await withSystem((db) => db.query<{ status: string }>("select status from agent_instances where id = $1", [sales]));
    expect(rows[0].status).toBe("provisioning");
    const health = await runHealthCheck(sales, { userId: admin.id, kind: "agency" });
    expect(health).toMatchObject({ ok: true, status: "online" });
  });

  it("blocks an employee when the complete tool inventory is unavailable",async()=>{
    mock.setInventory("c-chat-sales-assistant", { advertised: false });
    try {
      const result=await runHealthCheck(sales,{userId:admin.id,kind:"agency"});
      expect(result).toMatchObject({ok:false,status:"setup_required"});
      expect(result.detail).toMatch(/GET \/v1\/tools/);
      await expect(sendChatMessage(ctxFor(owner,org,"owner"),{agentRole:"sales_assistant",content:"blocked",clientMessageId:crypto.randomUUID()})).rejects.toMatchObject({code:"agent_unavailable"});
    }finally{mock.setInventory("c-chat-sales-assistant", null);await runHealthCheck(sales,{userId:admin.id,kind:"agency"});}
  });

  it("rejects a wrong key and a profile exposing shell or file tools", async () => {
    const hunter = await agentId(org.id, "lead_hunter");
    await withSystem((db) =>
      createConfigVersion(db, { orgId: org.id, agentId: hunter, settings: defaultSettings("lead_hunter"), source: "onboarding", userId: owner.id, apply: true }),
    );
    await connectHermesProfile({ agentId: hunter, baseUrl: mock.url, profile: "c-chat-lead-hunter", apiKey: "w".repeat(40), agencyUserId: admin.id });
    expect((await runHealthCheck(hunter, { userId: null, kind: "system" })).status).toBe("error");
    await connectHermesProfile({ agentId: hunter, baseUrl: mock.url, profile: "c-chat-lead-hunter", apiKey: KEY, agencyUserId: admin.id });
    const res = await runHealthCheck(hunter, { userId: null, kind: "system" });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/restricted or unreviewed tools/);
  });
});

describe("conversation persistence", () => {
  let conversationId: string;

  it("refreshes an expired inventory before persisting an authorized chat message", async () => {
    const ctx = ctxFor(owner, org, "owner");
    const before = (await withSystem((db) => db.query<{ digest: string; expires_at: Date }>(
      "select tool_inventory_digest as digest,tool_inventory_expires_at as expires_at from agent_instances where id=$1",
      [sales],
    ))).rows[0];
    expect(before.digest).toMatch(/^[0-9a-f]{64}$/);
    await withSystem((db) => db.query("update agent_instances set tool_inventory_expires_at=now()-interval '1 second' where id=$1", [sales]));

    const clientMessageId = crypto.randomUUID();
    const requestStart = mock.requests.length;
    mock.setInventory("c-chat-sales-assistant", { delayMs: 200 });
    try {
      const sending = sendChatMessage(ctx, { agentRole: "sales_assistant", content: "Refresh before saving this chat", clientMessageId });
      await waitForMockRequest(requestStart, "GET", "/v1/tools");
      const duringPreflight = await withSystem(async (db) => {
        const { rows } = await db.query<{ messages: number; runs: number }>(
          "select (select count(*)::int from chat_messages where client_message_id=$2 and role='user') as messages, (select count(*)::int from agent_runs where agent_instance_id=$1) as runs",
          [sales, clientMessageId],
        );
        return rows[0];
      });
      expect(duringPreflight).toEqual({ messages: 0, runs: 0 });

      const sent = await sending;
      expect(await waitForMessage(sent.assistantMessageId)).toMatchObject({ status: "complete" });
      const after = (await withSystem((db) => db.query<{ digest: string; verified_at: Date; expires_at: Date; message_at: Date }>(
        "select a.tool_inventory_digest as digest,a.tool_inventory_verified_at as verified_at,a.tool_inventory_expires_at as expires_at,m.created_at as message_at from agent_instances a join chat_conversations c on c.agent_instance_id=a.id join chat_messages m on m.conversation_id=c.id where a.id=$1 and m.client_message_id=$2 and m.role='user'",
        [sales, clientMessageId],
      ))).rows[0];
      expect(after.digest).toBe(before.digest);
      expect(new Date(after.expires_at).getTime()).toBeGreaterThan(Date.now());
      expect(new Date(after.message_at).getTime()).toBeGreaterThanOrEqual(new Date(after.verified_at).getTime());

      const requests = mock.requests.slice(requestStart);
      const runSubmission = requests.findIndex((request) => request.method === "POST" && request.path === "/v1/runs");
      expect(runSubmission).toBeGreaterThan(-1);
      expect(requests.slice(0, runSubmission).filter((request) => request.method === "GET" && request.path === "/v1/tools")).toHaveLength(4);
      expect(requests.some((request) => request.method === "GET" && request.path === "/v1/models" && request.profile === "c-chat-sales-assistant")).toBe(true);
    } finally {
      mock.setInventory("c-chat-sales-assistant", null);
    }
  });

  it("rejects changed inventory before chat persistence or queueing", async () => {
    const ctx = ctxFor(owner, org, "owner");
    const before = (await withSystem((db) => db.query<{ digest: string }>(
      "select tool_inventory_digest as digest from agent_instances where id=$1",
      [sales],
    ))).rows[0];
    const countsBefore = (await withSystem((db) => db.query<{ messages: number; runs: number }>(
      "select (select count(*)::int from chat_messages m join chat_conversations c on c.id=m.conversation_id where c.agent_instance_id=$1 and m.role='user') as messages, (select count(*)::int from agent_runs where agent_instance_id=$1) as runs",
      [sales],
    ))).rows[0];
    const clientMessageId = crypto.randomUUID();
    const requestStart = mock.requests.length;
    mock.setInventory("c-chat-sales-assistant", { tools: [
      { name: "memory", toolset: "memory" },
      { name: "session_search", toolset: "session_search" },
      { name: "todo_list", toolset: "todo" },
      { name: "web_search", toolset: "web" },
      { name: "web_extract", toolset: "web" },
    ] });
    await withSystem((db) => db.query("update agent_instances set tool_inventory_expires_at=now()-interval '1 second' where id=$1", [sales]));
    try {
      await expect(sendChatMessage(ctx, {
        agentRole: "sales_assistant",
        content: "Do not save this after inventory drift",
        clientMessageId,
      })).rejects.toMatchObject({ code: "agent_unavailable" });

      const requests = mock.requests.slice(requestStart);
      expect(requests.some((request) => request.method === "GET" && request.path === "/v1/tools")).toBe(true);
      expect(requests.some((request) => request.method === "POST" && request.path === "/v1/runs")).toBe(false);
      const countsAfter = (await withSystem((db) => db.query<{ messages: number; runs: number }>(
        "select (select count(*)::int from chat_messages m join chat_conversations c on c.id=m.conversation_id where c.agent_instance_id=$1 and m.role='user') as messages, (select count(*)::int from agent_runs where agent_instance_id=$1) as runs",
        [sales],
      ))).rows[0];
      expect(countsAfter).toEqual(countsBefore);
      const changed = (await withSystem((db) => db.query<{ digest: string; status: string; last_health_ok: boolean }>(
        "select tool_inventory_digest as digest,status,last_health_ok from agent_instances where id=$1",
        [sales],
      ))).rows[0];
      expect(changed.digest).not.toBe(before.digest);
      expect(changed).toMatchObject({ status: "provisioning", last_health_ok: false });
      expect(requests.some((request) => request.profile === "c-chat-sales-assistant" && request.path === "/v1/models")).toBe(true);
    } finally {
      mock.setInventory("c-chat-sales-assistant", null);
      const restoredBaseline = await runHealthCheck(sales, { userId: admin.id, kind: "agency" });
      if (!restoredBaseline.ok) await runHealthCheck(sales, { userId: admin.id, kind: "agency" });
    }
  });

  it("blocks a live inventory change discovered between chat preflight and Hermes submission", async () => {
    await runHealthCheck(sales, { userId: admin.id, kind: "agency" });
    const ctx = ctxFor(owner, org, "owner");
    const clientMessageId = crypto.randomUUID();
    const requestStart = mock.requests.length;
    mock.setInventory("c-chat-sales-assistant", {
      delayMs: 100,
      tools: [
        { name: "memory", toolset: "memory" },
        { name: "session_search", toolset: "session_search" },
        { name: "todo_list", toolset: "todo" },
        { name: "web_search", toolset: "web" },
        { name: "web_extract", toolset: "web" },
      ],
    });
    try {
      const sent = await sendChatMessage(ctx, {
        agentRole: "sales_assistant",
        content: "Block this if the live inventory changed before submission",
        clientMessageId,
      });
      expect(await waitForMessage(sent.assistantMessageId)).toMatchObject({ status: "failed", error_code: "start_failed" });

      const requests = mock.requests.slice(requestStart);
      expect(requests.some((request) => request.method === "GET" && request.path === "/v1/tools")).toBe(true);
      expect(requests.some((request) => request.method === "POST" && request.path === "/v1/runs")).toBe(false);
      const { rows } = await withSystem((db) => db.query<{ config_version_id: string | null }>(
        "select config_version_id from agent_runs where assistant_message_id=$1",
        [sent.assistantMessageId],
      ));
      expect(rows[0]?.config_version_id).toBeTruthy();
    } finally {
      mock.setInventory("c-chat-sales-assistant", null);
      const restoredBaseline = await runHealthCheck(sales, { userId: admin.id, kind: "agency" });
      if (!restoredBaseline.ok) await runHealthCheck(sales, { userId: admin.id, kind: "agency" });
    }
  });

  it("blocks a configuration change made during final live inventory verification", async () => {
    await runHealthCheck(sales, { userId: admin.id, kind: "agency" });
    const ctx = ctxFor(owner, org, "owner");
    const requestStart = mock.requests.length;
    mock.setInventory("c-chat-sales-assistant", { delayMs: 1_000 });
    try {
      const sent = await sendChatMessage(ctx, {
        agentRole: "sales_assistant",
        content: "Use only the configuration that was queued for this chat",
        clientMessageId: crypto.randomUUID(),
      });
      await waitForMockRequest(requestStart, "GET", "/v1/tools");

      const queuedConfig = (await withSystem((db) => db.query<{ config_version_id: string }>(
        "select config_version_id from agent_runs where id=$1",
        [sent.runId],
      ))).rows[0].config_version_id;
      await withSystem((db) => createConfigVersion(db, {
        orgId: org.id,
        agentId: sales,
        settings: { ...defaultSettings("sales_assistant"), displayName: "Updated during run preparation" },
        source: "onboarding",
        userId: owner.id,
        apply: true,
      }));

      expect(await waitForMessage(sent.assistantMessageId)).toMatchObject({ status: "failed", error_code: "start_failed" });
      const activeConfig = (await withSystem((db) => db.query<{ id: string }>(
        "select active_config_version_id as id from agent_instances where id=$1",
        [sales],
      ))).rows[0].id;
      expect(activeConfig).not.toBe(queuedConfig);
      const requests = mock.requests.slice(requestStart);
      expect(requests.some((request) => request.method === "POST" && request.path === "/v1/runs")).toBe(false);
    } finally {
      mock.setInventory("c-chat-sales-assistant", null);
    }
  });

  it("streams, persists the authoritative output, records tools, usage and tokens", async () => {
    const ctx = ctxFor(owner, org, "owner");
    const res = await sendChatMessage(ctx, { agentRole: "sales_assistant", content: "Draft a follow-up for Acme", clientMessageId: "m-1" });
    conversationId = res.conversationId;
    const msg = await waitForMessage(res.assistantMessageId);
    expect(msg).toMatchObject({ status: "complete", content: "Hello from Hermes." });
    const { rows: run } = await withSystem((db) =>
      db.query<{ status: string; total_tokens: number; hermes_run_id: string }>("select status, total_tokens, hermes_run_id from agent_runs where id = $1", [res.runId]),
    );
    expect(run[0]).toMatchObject({ status: "completed", total_tokens: 59 });
    const { rows: tools } = await withSystem((db) =>
      db.query<{ label: string; status: string }>("select label, status from tool_executions where run_id = $1", [res.runId]),
    );
    expect(tools).toEqual([{ label: "Looking up CRM information…", status: "completed" }]);
    const sent = mock.runs.get(run[0].hermes_run_id)!;
    expect(String(sent.body.instructions)).toContain("## Agency policy");
    expect(sent.headers["idempotency-key"]).toBe(`chat:${res.assistantMessageId}`);
    expect(sent.headers["x-hermes-session-key"]).toBe(`iaq:${org.id}:sales_assistant`);
    const convo = await getConversation(ctx, conversationId);
    expect(convo?.conversation.title).toBe("Draft a follow-up for Acme");
    expect(convo?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("sends prior turns as conversation history and blocks duplicate sends", async () => {
    const ctx = ctxFor(owner, org, "owner");
    const res = await sendChatMessage(ctx, { agentRole: "sales_assistant", conversationId, content: "Make it shorter", clientMessageId: "m-2" });
    await waitForMessage(res.assistantMessageId);
    const { rows } = await withSystem((db) => db.query<{ hermes_run_id: string }>("select hermes_run_id from agent_runs where id = $1", [res.runId]));
    const history = mock.runs.get(rows[0].hermes_run_id)!.body.conversation_history as Array<{ role: string; content: string }>;
    expect(history).toEqual([
      { role: "user", content: "Draft a follow-up for Acme" },
      { role: "assistant", content: "Hello from Hermes." },
    ]);
    await expect(sendChatMessage(ctx, { agentRole: "sales_assistant", conversationId, content: "Make it shorter", clientMessageId: "m-2" })).rejects.toThrow(/already sent/);
  });

  it("starts one exact persisted native review from employee chat without submitting a Hermes model run", async () => {
    const ctx = ctxFor(owner, org, "owner");
    const requestStart = mock.requests.length;
    const sent = await sendChatMessage(ctx, {
      agentRole: "sales_assistant",
      conversationId,
      content: "Review our sales pipeline and prepare follow-ups for opportunities that need attention.",
      clientMessageId: "sales-pipeline-chat-job",
    });

    expect(sent).toMatchObject({ runId: null, jobId: expect.any(String) });
    const assistant = (await withSystem((db) => db.query<{ content: string; work_job_id: string | null }>(
      "select content, work_job_id from chat_messages where id = $1 and org_id = $2",
      [sent.assistantMessageId, org.id],
    ))).rows[0];
    expect(assistant.work_job_id).toBe(sent.jobId);
    expect(assistant.content).toContain("does not prepare personalized message drafts");

    const job = await waitForWorkJob(sent.jobId!);
    expect(job).toMatchObject({ status: "completed", stage: "completed" });
    expect(job.result_summary).toContain("Pipeline review");
    const events = (await withSystem((db) => db.query<{ stage: string; kind: string }>(
      "select stage, kind from ai_work_events where job_id = $1 order by created_at, id",
      [sent.jobId],
    ))).rows;
    expect(events.map((event) => event.stage)).toEqual(expect.arrayContaining(["preparing", "scanning", "analyzing", "preparing_results", "completed"]));
    expect(mock.requests.slice(requestStart).some((request) => request.method === "POST" && request.path === "/v1/runs")).toBe(false);
  });

  it("refuses outbound chat requests in application code and records the refusal without a Hermes run", async () => {
    const requestStart = mock.requests.length;
    const sent = await sendChatMessage(ctxFor(owner, org, "owner"), {
      agentRole: "sales_assistant",
      conversationId,
      content: "Send an email to these prospects about our offer",
      clientMessageId: "sales-outreach-chat-refusal",
    });
    expect(sent).toMatchObject({ runId: null, jobId: null });

    const assistant = (await withSystem((db) => db.query<{ content: string; work_job_id: string | null; run_id: string | null }>(
      "select content, work_job_id, run_id from chat_messages where id = $1 and org_id = $2",
      [sent.assistantMessageId, org.id],
    ))).rows[0];
    expect(assistant).toMatchObject({ work_job_id: null, run_id: null });
    expect(assistant.content).toContain("No message or campaign was sent or scheduled");

    const audit = (await withSystem((db) => db.query<{ result: string; reason: string }>(
      `select result, metadata->>'reason' as reason from audit_logs
        where org_id = $1 and action = 'workforce.chat_request_refused' and target_id = $2
        order by created_at desc limit 1`,
      [org.id, sales],
    ))).rows[0];
    expect(audit).toEqual({ result: "denied", reason: "external_outreach" });
    expect(mock.requests.slice(requestStart).some((request) => request.method === "POST" && request.path === "/v1/runs")).toBe(false);
  });

  it("other tenants cannot read the conversation", async () => {
    const other = await createOrg();
    const intruder = await createUser();
    await addMember(other.id, intruder.id, "owner");
    expect(await getConversation(ctxFor(intruder, other, "owner"), conversationId)).toBeNull();
  });

  it("stops a running response", async () => {
    script = () => ({ steps: [{ delta: "Partial…" }, { cancelOnly: true }] });
    const ctx = ctxFor(owner, org, "owner");
    const res = await sendChatMessage(ctx, { agentRole: "sales_assistant", conversationId, content: "Write a long proposal", clientMessageId: "m-3" });
    await new Promise((r) => setTimeout(r, 150));
    await stopChatRun(ctx, res.runId!);
    // Under the full parallel suite this can take longer than the default 6s while another worker
    // holds the shared test database; the cancellation itself is immediate.
    const msg = await waitForMessage(res.assistantMessageId, 15_000);
    expect(msg.status).toBe("cancelled");
    script = null;
  });

  it("reports failures with a retryable error instead of fake content", async () => {
    script = () => ({ steps: [{ fail: "provider error" }] });
    const res = await sendChatMessage(ctxFor(owner, org, "owner"), { agentRole: "sales_assistant", conversationId, content: "Try this", clientMessageId: "m-4" });
    const msg = await waitForMessage(res.assistantMessageId);
    expect(msg).toMatchObject({ status: "failed", error_code: "run_failed", content: "" });
    script = null;
  });

  it("turns Hermes approval requests into Approval Center items and resumes on approval", async () => {
    script = () => ({ steps: [{ approval: "crm_update_contact" }, { delta: "Updated." }], output: "Updated." });
    const ctx = ctxFor(owner, org, "owner");
    const res = await sendChatMessage(ctx, { agentRole: "sales_assistant", conversationId, content: "Update the contact", clientMessageId: "m-5" });
    let approvalId: string | undefined;
    for (let i = 0; i < 100 && !approvalId; i++) {
      const { rows } = await withSystem((db) => db.query<{ id: string }>("select id from approval_requests where org_id = $1 and kind = 'tool_action' and status = 'pending'", [org.id]));
      approvalId = rows[0]?.id;
      if (!approvalId) await new Promise((r) => setTimeout(r, 20));
    }
    expect(approvalId).toBeTruthy();
    await decideApproval(ctx, approvalId!, "approve");
    const msg = await waitForMessage(res.assistantMessageId);
    expect(msg).toMatchObject({ status: "complete", content: "Updated." });
    const { rows: hr } = await withSystem((db) => db.query<{ hermes_run_id: string }>("select hermes_run_id from agent_runs where id = $1", [res.runId]));
    expect(mock.runs.get(hr[0].hermes_run_id)!.approvalResolved).toBe("once");
    script = null;
  });

  it("marks the employee offline when Hermes becomes unreachable", async () => {
    await mock.close();
    const res = await sendChatMessage(ctxFor(owner, org, "owner"), { agentRole: "sales_assistant", conversationId, content: "Are you there?", clientMessageId: "m-6" });
    const msg = await waitForMessage(res.assistantMessageId);
    expect(msg).toMatchObject({ status: "failed", error_code: "start_failed" });
    const { rows } = await withSystem((db) => db.query<{ status: string }>("select status from agent_instances where id = $1", [sales]));
    expect(rows[0].status).toBe("offline");
    await expect(
      sendChatMessage(ctxFor(owner, org, "owner"), { agentRole: "sales_assistant", conversationId, content: "Hello?", clientMessageId: "m-7" }),
    ).rejects.toThrow(/offline/);
  });
});
