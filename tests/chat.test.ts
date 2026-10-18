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
    await stopChatRun(ctx, res.runId);
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
