import "server-only";
import crypto from "node:crypto";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { env } from "@/server/env";
import { recordAudit } from "@/server/audit";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { assertWithinLimits, recordUsage } from "@/server/usage";
import { notifyOrgRoles } from "@/server/notifications";
import { canChat, AGENT_BY_KEY, type AgentRoleKey, type AgentStatus } from "@/lib/agents";
import {
  getCapabilities,
  getRunStatus,
  HermesError,
  startRun,
  startAgentRun,
  stopRun,
  streamRunEvents,
  toolActivityLabel,
  type HermesConnection,
} from "@/server/integrations/hermes/client";
import { buildRunInstructions, loadConnection, markAgentDegraded, runHealthCheck } from "@/server/workforce/service";
import { markEmployeeKnowledgeUsed } from "@/server/workforce/knowledge";
import { abortChannel, openChannel, publish } from "@/server/chat/hub";
import type { OrgContext } from "@/server/tenancy/context";

const MAX_MESSAGE = 8000;
const HISTORY_TURNS = 20;
const HEALTH_MAX_AGE_MS = 10 * 60 * 1000;

export interface ConversationSummary {
  id: string;
  title: string;
  last_message_at: Date | null;
  created_at: Date;
}

export interface ChatMessageRow {
  id: string;
  role: "user" | "assistant" | "notice";
  content: string;
  status: "streaming" | "complete" | "failed" | "cancelled" | "superseded";
  run_id: string | null;
  error_code: string | null;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Reads (row-level security restricts these to the signed-in user's own conversations)
// ---------------------------------------------------------------------------

export async function listConversations(ctx: OrgContext, agentId: string, search?: string): Promise<ConversationSummary[]> {
  await applyRetention(ctx.org.orgId);
  return withUser(ctx.user.id, async (db) => {
    const q = search?.trim().slice(0, 100);
    const { rows } = await db.query<ConversationSummary>(
      `select c.id, c.title, c.last_message_at, c.created_at from chat_conversations c
       where c.org_id = $1 and c.agent_instance_id = $2 and c.deleted_at is null
         and ($3::text is null or c.title ilike '%' || $3 || '%'
              or exists (select 1 from chat_messages m where m.conversation_id = c.id and m.content ilike '%' || $3 || '%'))
       order by coalesce(c.last_message_at, c.created_at) desc limit 100`,
      [ctx.org.orgId, agentId, q || null],
    );
    return rows;
  });
}

export async function getConversation(ctx: OrgContext, conversationId: string, before?: string) {
  return withUser(ctx.user.id, async (db) => {
    const { rows: conv } = await db.query<{ id: string; title: string; agent_instance_id: string }>(
      "select id, title, agent_instance_id from chat_conversations where id = $1 and org_id = $2 and deleted_at is null",
      [conversationId, ctx.org.orgId],
    );
    if (!conv[0]) return null;
    const { rows } = await db.query<ChatMessageRow>(
      `select * from (
         select id, role, content, status, run_id, error_code, created_at from chat_messages
         where conversation_id = $1 and status <> 'superseded' and ($2::timestamptz is null or created_at < $2::timestamptz)
         order by created_at desc limit 60
       ) t order by created_at asc`,
      [conversationId, before ?? null],
    );
    return { conversation: conv[0], messages: rows, hasMore: rows.length === 60 };
  });
}

export async function renameConversation(ctx: OrgContext, conversationId: string, title: string) {
  const clean = title.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!clean) throw new AppError("invalid_input", "Give the conversation a name.");
  const res = await withUser(ctx.user.id, (db) =>
    db.query("update chat_conversations set title = $2 where id = $1 and deleted_at is null", [conversationId, clean]),
  );
  if (!res.rowCount) throw new AppError("not_found", "Conversation not found.");
}

export async function deleteConversation(ctx: OrgContext, conversationId: string) {
  const res = await withUser(ctx.user.id, (db) =>
    db.query("update chat_conversations set deleted_at = now() where id = $1 and deleted_at is null", [conversationId]),
  );
  if (!res.rowCount) throw new AppError("not_found", "Conversation not found.");
  // Message bodies are removed now; the conversation shell is kept only for referential integrity.
  await withSystem(async (db) => {
    await db.query("update chat_messages set content = '' where conversation_id = $1", [conversationId]);
    await recordAudit(
      { orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "chat.conversation_deleted", targetType: "chat_conversation", targetId: conversationId, result: "success" },
      db,
    );
  });
}

/** Applies the workspace's conversation retention setting. */
export async function applyRetention(orgId: string) {
  await withSystem(async (db) => {
    const { rows } = await db.query<{ days: string | null }>(
      "select ai_preferences->>'chatRetentionDays' as days from company_profiles where org_id = $1",
      [orgId],
    );
    const days = Number(rows[0]?.days);
    if (!Number.isFinite(days) || days <= 0) return;
    await db.query(
      `update chat_messages set content = '' where org_id = $1 and content <> '' and conversation_id in (
         select id from chat_conversations where org_id = $1 and coalesce(last_message_at, created_at) < now() - make_interval(days => $2))`,
      [orgId, days],
    );
    await db.query(
      `update chat_conversations set deleted_at = now() where org_id = $1 and deleted_at is null
         and coalesce(last_message_at, created_at) < now() - make_interval(days => $2)`,
      [orgId, days],
    );
  });
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendInput {
  agentRole: AgentRoleKey;
  conversationId?: string | null;
  content?: string;
  clientMessageId?: string;
  regenerateMessageId?: string;
}

export interface SendResult {
  conversationId: string;
  userMessageId: string | null;
  assistantMessageId: string;
  runId: string;
}

async function ensureAgentReady(ctx: OrgContext, role: AgentRoleKey) {
  const agent = await withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ id: string; org_id: string; status: AgentStatus; enabled: boolean; last_health_check_at: Date | null }>(
      "select id, org_id, status, enabled, last_health_check_at from agent_instances where org_id = $1 and role_key = $2",
      [ctx.org.orgId, role],
    );
    return rows[0];
  });
  if (!agent || agent.org_id !== ctx.org.orgId) throw new AppError("not_found", "AI employee not found.");
  if (!agent.enabled) throw new AppError("agent_unavailable", `${AGENT_BY_KEY[role].shortName} isn't enabled for your workspace.`);
  let status = agent.status;
  const stale = !agent.last_health_check_at || Date.now() - new Date(agent.last_health_check_at).getTime() > HEALTH_MAX_AGE_MS;
  if (canChat(status) && stale) status = (await runHealthCheck(agent.id, { userId: ctx.user.id, kind: "system" })).status;
  if (!canChat(status)) {
    const msg =
      status === "setup_required" || status === "provisioning"
        ? `${AGENT_BY_KEY[role].shortName} is still being set up by the iAcquire team. You'll be notified when it's ready.`
        : `${AGENT_BY_KEY[role].shortName} is offline right now. Please try again shortly.`;
    throw new AppError("agent_unavailable", msg);
  }
  return agent;
}

export async function sendChatMessage(ctx: OrgContext, input: SendInput): Promise<SendResult> {
  if (!ctx.can("agents.use")) throw new AppError("forbidden", "Your role can't chat with AI employees.");
  const limit = await consumeRateLimit(RATE_LIMITS.agentMessageByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "You're sending messages quickly. Please wait a moment.", { retryAfterSeconds: limit.retryAfterSeconds });
  await assertWithinLimits(ctx.org.orgId, "agent_message");
  const agent = await ensureAgentReady(ctx, input.agentRole);

  // 1. Persist the user's turn under row-level security.
  const prepared = await withUser(ctx.user.id, async (db) => {
    let conversationId = input.conversationId ?? null;
    let userContent: string;
    let userMessageId: string | null = null;
    let anchorTime: Date | null = null;

    if (input.regenerateMessageId) {
      const { rows } = await db.query<{ conversation_id: string; created_at: Date }>(
        `select m.conversation_id, m.created_at from chat_messages m
         join chat_conversations c on c.id = m.conversation_id
         where m.id = $1 and m.role = 'assistant' and c.agent_instance_id = $2 and c.deleted_at is null`,
        [input.regenerateMessageId, agent.id],
      );
      if (!rows[0]) throw new AppError("not_found", "That response can't be regenerated.");
      conversationId = rows[0].conversation_id;
      const { rows: prev } = await db.query<{ id: string; content: string; created_at: Date }>(
        `select id, content, created_at from chat_messages where conversation_id = $1 and role = 'user' and created_at <= $2
         order by created_at desc limit 1`,
        [conversationId, rows[0].created_at],
      );
      if (!prev[0]) throw new AppError("not_found", "There's no question to answer again.");
      userContent = prev[0].content;
      anchorTime = new Date(prev[0].created_at);
    } else {
      const content = (input.content ?? "").trim();
      if (!content) throw new AppError("invalid_input", "Type a message first.");
      if (content.length > MAX_MESSAGE) throw new AppError("invalid_input", `Messages can be up to ${MAX_MESSAGE.toLocaleString()} characters.`);
      userContent = content;
      if (conversationId) {
        const { rows } = await db.query<{ id: string }>(
          "select id from chat_conversations where id = $1 and agent_instance_id = $2 and org_id = $3 and deleted_at is null",
          [conversationId, agent.id, ctx.org.orgId],
        );
        if (!rows[0]) throw new AppError("not_found", "Conversation not found.");
      } else {
        const title = content.replace(/\s+/g, " ").slice(0, 60) + (content.length > 60 ? "…" : "");
        const { rows } = await db.query<{ id: string }>(
          `insert into chat_conversations (org_id, agent_instance_id, user_id, title, hermes_session_id)
           values ($1, $2, $3, $4, $5) returning id`,
          [ctx.org.orgId, agent.id, ctx.user.id, title, `iaq-${crypto.randomUUID()}`],
        );
        conversationId = rows[0].id;
      }
      const clientMessageId = input.clientMessageId?.slice(0, 64) || crypto.randomUUID();
      const { rows: existing } = await db.query<{ id: string }>(
        "select id from chat_messages where conversation_id = $1 and client_message_id = $2",
        [conversationId, clientMessageId],
      );
      if (existing[0]) throw new AppError("conflict", "This message was already sent.");
      const { rows } = await db.query<{ id: string; created_at: Date }>(
        `insert into chat_messages (conversation_id, org_id, role, content, client_message_id)
         values ($1, $2, 'user', $3, $4) returning id, created_at`,
        [conversationId, ctx.org.orgId, content, clientMessageId],
      );
      userMessageId = rows[0].id;
      anchorTime = new Date(rows[0].created_at);
    }

    const { rows: hist } = await db.query<{ role: "user" | "assistant"; content: string }>(
      `select role, content from (
         select role, content, created_at from chat_messages
         where conversation_id = $1 and status = 'complete' and role in ('user', 'assistant') and created_at < $2
         order by created_at desc limit $3
       ) t order by created_at asc`,
      [conversationId, anchorTime, HISTORY_TURNS],
    );
    const { rows: conv } = await db.query<{ hermes_session_id: string }>("select hermes_session_id from chat_conversations where id = $1", [conversationId]);
    return {
      conversationId: conversationId as string,
      userMessageId,
      userContent,
      history: hist.map((h) => ({ role: h.role, content: h.content.slice(0, 4000) })),
      sessionId: conv[0].hermes_session_id,
    };
  });

  // 2. Create the assistant placeholder and run record (trusted server writes).
  const setup = await withSystem(async (db) => {
    if (input.regenerateMessageId) {
      await db.query("update chat_messages set status = 'superseded' where id = $1 and conversation_id = $2", [
        input.regenerateMessageId,
        prepared.conversationId,
      ]);
    }
    const { instructions, versionId, knowledgeEntryIds, knowledgeDocumentIds } = await buildRunInstructions(db, ctx.org.orgId, agent.id);
    const conn = await loadConnection(db, agent.id);
    if (!conn) throw new AppError("agent_unavailable", "This employee isn't connected yet.");
    const { rows: msg } = await db.query<{ id: string }>(
      "insert into chat_messages (conversation_id, org_id, role, content, status) values ($1, $2, 'assistant', '', 'streaming') returning id",
      [prepared.conversationId, ctx.org.orgId],
    );
    const idempotencyKey = `chat:${msg[0].id}`;
    const { rows: run } = await db.query<{ id: string }>(
      `insert into agent_runs (org_id, agent_instance_id, conversation_id, assistant_message_id, user_id, purpose,
         idempotency_key, status, config_version_id)
       values ($1, $2, $3, $4, $5, 'chat', $6, 'queued', $7) returning id`,
      [ctx.org.orgId, agent.id, prepared.conversationId, msg[0].id, ctx.user.id, idempotencyKey, versionId],
    );
    await db.query("update chat_messages set run_id = $2 where id = $1", [msg[0].id, run[0].id]);
    await db.query("update chat_conversations set last_message_at = now() where id = $1", [prepared.conversationId]);
    await recordUsage(db, { orgId: ctx.org.orgId, userId: ctx.user.id, agentId: agent.id, kind: "agent_message" });
    return { assistantMessageId: msg[0].id, runId: run[0].id, instructions, conn, idempotencyKey, knowledgeEntryIds, knowledgeDocumentIds };
  });

  const abort = new AbortController();
  openChannel(setup.runId, ctx.user.id, abort);
  publish(setup.runId, {
    type: "ready",
    conversationId: prepared.conversationId,
    userMessageId: prepared.userMessageId,
    assistantMessageId: setup.assistantMessageId,
    runId: setup.runId,
  });

  // 3. Start the Hermes run and consume it in the background.
  void executeRun({
    runId: setup.runId,
    orgId: ctx.org.orgId,
    agentId: agent.id,
    agentRole: input.agentRole,
    userId: ctx.user.id,
    assistantMessageId: setup.assistantMessageId,
    conversationId: prepared.conversationId,
    conn: setup.conn,
    abort,
    knowledgeEntryIds: setup.knowledgeEntryIds,
    knowledgeDocumentIds: setup.knowledgeDocumentIds,
    request: {
      input: prepared.userContent,
      instructions: setup.instructions,
      sessionId: prepared.sessionId,
      conversationHistory: prepared.history,
      idempotencyKey: setup.idempotencyKey,
      memoryScope: `iaq:${ctx.org.orgId}:${input.agentRole}`,
    },
  });

  return {
    conversationId: prepared.conversationId,
    userMessageId: prepared.userMessageId,
    assistantMessageId: setup.assistantMessageId,
    runId: setup.runId,
  };
}

interface ExecuteRunInput {
  runId: string;
  orgId: string;
  agentId: string;
  agentRole: AgentRoleKey;
  userId: string;
  assistantMessageId: string;
  conversationId: string;
  conn: HermesConnection;
  abort: AbortController;
  /** Sources that were actually included in the instructions. Recorded only after the provider accepts the run. */
  knowledgeEntryIds?: string[];
  knowledgeDocumentIds?: string[];
  request: Parameters<typeof startRun>[1];
}

const FRIENDLY_FAILURE: Record<string, string> = {
  start_failed: "The employee couldn't start working on this. Please try again.",
  connection_lost: "The connection to your AI employee dropped before it finished.",
  timeout: "This took longer than expected, so it was stopped.",
  run_failed: "Your AI employee couldn't finish this request.",
  interrupted: "The AI service restarted while answering. Please try again.",
  stream_ended: "The response ended unexpectedly.",
};

async function safeDb(fn: (db: Queryable) => Promise<unknown>) {
  try {
    await withSystem(fn);
  } catch (err) {
    if (process.env.NODE_ENV !== "test") console.error("[iacquire] chat persistence error", err);
  }
}

export async function executeRun(r: ExecuteRunInput): Promise<void> {
  const timeout = setTimeout(() => r.abort.abort(new Error("timeout")), env().HERMES_RUN_TIMEOUT_MS);
  let content = "";
  let lastPersist = Date.now();
  let hermesRunId: string | null = null;
  const openTools: Array<{ id: string; tool: string; callId?: string; started: number }> = [];

  const finish = async (
    status: "completed" | "failed" | "cancelled" | "timeout" | "interrupted",
    opts: { content?: string; errorCode?: string; usage?: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } | null },
  ) => {
    const finalContent = opts.content ?? content;
    const messageStatus = status === "completed" ? "complete" : status === "cancelled" ? "cancelled" : "failed";
    await safeDb(async (db) => {
      await db.query("update chat_messages set content = $2, status = $3, error_code = $4 where id = $1", [
        r.assistantMessageId,
        finalContent.slice(0, 64000),
        messageStatus,
        opts.errorCode ?? null,
      ]);
      await db.query(
        `update agent_runs set status = $2, finished_at = now(), error_code = $3, error_message = $4,
           input_tokens = $5, output_tokens = $6, total_tokens = $7 where id = $1`,
        [
          r.runId,
          status,
          opts.errorCode ?? null,
          opts.errorCode ? FRIENDLY_FAILURE[opts.errorCode] ?? null : null,
          opts.usage?.inputTokens ?? null,
          opts.usage?.outputTokens ?? null,
          opts.usage?.totalTokens ?? null,
        ],
      );
      await db.query("update tool_executions set status = 'failed', finished_at = now() where run_id = $1 and status = 'started'", [r.runId]);
      await db.query("update chat_conversations set last_message_at = now() where id = $1", [r.conversationId]);
      if (opts.usage && (opts.usage.inputTokens || opts.usage.outputTokens)) {
        await db.query(
          `update usage_events set input_tokens = $2, output_tokens = $3 where id = (
             select id from usage_events where org_id = $1 and agent_instance_id = $4 and kind = 'agent_message'
             and input_tokens is null order by created_at desc limit 1)`,
          [r.orgId, opts.usage.inputTokens, opts.usage.outputTokens, r.agentId],
        );
      }
      if (status !== "completed" && status !== "cancelled") {
        await recordUsage(db, { orgId: r.orgId, userId: r.userId, agentId: r.agentId, kind: "agent_run_failed" });
      }
    });
    if (status === "completed") publish(r.runId, { type: "done", content: finalContent });
    else if (status === "cancelled") publish(r.runId, { type: "cancelled", content: finalContent });
    else
      publish(r.runId, {
        type: "error",
        code: opts.errorCode ?? "run_failed",
        message: FRIENDLY_FAILURE[opts.errorCode ?? "run_failed"] ?? FRIENDLY_FAILURE.run_failed,
        retryable: true,
      });
  };

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        r.abort.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      r.abort.signal.addEventListener("abort", done, { once: true });
    });

  // Providers that do not advertise SSE still expose GET /v1/runs/{id}. In that case show an honest processing
  // state and render the completed output once; the browser UI already handles a response with no deltas.
  const pollUntilComplete = async (runId: string) => {
    publish(r.runId, { type: "activity", label: "Waiting for the complete response…" });
    for (;;) {
      if (r.abort.signal.aborted) {
        await stopRun(r.conn, runId).catch(() => undefined);
        const reason = String((r.abort.signal.reason as Error | undefined)?.message ?? "");
        await finish(reason === "timeout" ? "timeout" : "cancelled", reason === "timeout" ? { errorCode: "timeout" } : {});
        return;
      }
      const status = await getRunStatus(r.conn, runId);
      if (status.status === "completed") {
        await finish("completed", { content: status.output ?? "", usage: status.usage });
        return;
      }
      if (status.status === "failed") {
        await finish("failed", { content: status.output ?? "", errorCode: "run_failed", usage: status.usage });
        return;
      }
      if (status.status === "cancelled") {
        await finish("cancelled", {});
        return;
      }
      if (status.status === "interrupted") {
        await finish("interrupted", { errorCode: "interrupted" });
        return;
      }
      await wait(1000);
    }
  };

  try {
    try {
      const started = await startAgentRun(r.agentId, r.orgId, r.conn, r.request);
      hermesRunId = started.runId;
    } catch (err) {
      if (err instanceof HermesError && ["unreachable", "auth_failed", "not_found", "timeout"].includes(err.kind)) {
        await markAgentDegraded(r.agentId, err.message);
      }
      await finish("failed", { errorCode: "start_failed" });
      return;
    }
    await safeDb(async (db) => {
      await db.query("update agent_runs set status = 'running', hermes_run_id = $2 where id = $1", [r.runId, hermesRunId]);
      if (r.knowledgeEntryIds?.length || r.knowledgeDocumentIds?.length) {
        await markEmployeeKnowledgeUsed(db, r.orgId, r.agentId, r.knowledgeEntryIds ?? [], r.knowledgeDocumentIds ?? []);
      }
    });

    let supportsEvents = true;
    try {
      supportsEvents = (await getCapabilities(r.conn)).supportsEvents;
    } catch {
      // If capability discovery fails now, try the event stream; it has its own error handling.
    }
    if (!supportsEvents) {
      await pollUntilComplete(hermesRunId);
      return;
    }

    for await (const ev of streamRunEvents(r.conn, hermesRunId, r.abort.signal)) {
      switch (ev.type) {
        case "delta": {
          content += ev.text;
          publish(r.runId, { type: "delta", text: ev.text });
          if (Date.now() - lastPersist > 1500) {
            lastPersist = Date.now();
            const snapshot = content;
            void safeDb((db) => db.query("update chat_messages set content = $2 where id = $1 and status = 'streaming'", [r.assistantMessageId, snapshot]));
          }
          break;
        }
        case "tool_started": {
          const label = toolActivityLabel(ev.tool);
          publish(r.runId, { type: "activity", label });
          const id = crypto.randomUUID();
          openTools.push({ id, tool: ev.tool, callId: ev.callId, started: Date.now() });
          await safeDb((db) =>
            db.query("insert into tool_executions (id, run_id, org_id, tool_name, label) values ($1, $2, $3, $4, $5)", [
              id,
              r.runId,
              r.orgId,
              ev.tool.slice(0, 120),
              label,
            ]),
          );
          break;
        }
        case "tool_completed": {
          const idx = openTools.findIndex((t) => (ev.callId ? t.callId === ev.callId : t.tool === ev.tool));
          if (idx >= 0) {
            const t = openTools.splice(idx, 1)[0];
            await safeDb((db) =>
              db.query("update tool_executions set status = $2, finished_at = now(), duration_ms = $3 where id = $1", [
                t.id,
                ev.error ? "failed" : "completed",
                ev.durationMs ?? Date.now() - t.started,
              ]),
            );
          }
          break;
        }
        case "approval_request": {
          const title = `${AGENT_BY_KEY[r.agentRole].shortName} wants to use ${ev.tool ?? "a tool"}`;
          let approvalId: string | null = null;
          await safeDb(async (db) => {
            const { rows } = await db.query<{ id: string }>(
              `insert into approval_requests (org_id, agent_instance_id, requested_by, kind, title, action, target_type, target_label,
                 reason, expected_effect, risk, expires_at, idempotency_key)
               values ($1, $2, $3, 'tool_action', $4, $5, 'agent_run', $6, $7, $8, 'high', now() + interval '30 minutes', $9)
               on conflict (idempotency_key) do nothing returning id`,
              [
                r.orgId,
                r.agentId,
                r.userId,
                title.slice(0, 200),
                JSON.stringify({ hermesRunId, hermesApprovalId: ev.approvalId ?? null, tool: ev.tool ?? null, runId: r.runId }),
                ev.tool ?? "Agent tool",
                (ev.summary ?? "The employee paused and needs a human decision before continuing.").slice(0, 2000),
                "If approved, the employee runs this step once. If rejected, the step is blocked.",
                `hermes-approval:${hermesRunId}:${ev.approvalId ?? openTools.length}`,
              ],
            );
            approvalId = rows[0]?.id ?? null;
            if (approvalId) {
              await db.query("insert into approval_events (approval_id, org_id, actor_kind, event) values ($1, $2, 'agent', 'created')", [approvalId, r.orgId]);
              await notifyOrgRoles(db, r.orgId, ["owner", "admin"], {
                kind: "approval_requested",
                severity: "warning",
                title,
                body: "An AI employee is waiting for approval.",
                link: "/approvals",
              });
            }
          });
          if (approvalId) publish(r.runId, { type: "approval", approvalId, title });
          publish(r.runId, { type: "activity", label: "Waiting for your approval…" });
          break;
        }
        case "completed": {
          // The run's final output is authoritative; streamed deltas are only a preview.
          await finish("completed", { content: ev.output ?? content, usage: ev.usage });
          return;
        }
        case "failed": {
          await finish("failed", { content: content || ev.partialOutput || "", errorCode: "run_failed", usage: ev.usage });
          return;
        }
        case "cancelled":
          await finish("cancelled", {});
          return;
        case "interrupted":
          await finish("interrupted", { errorCode: "interrupted" });
          return;
        default:
          break;
      }
    }
    await finish("failed", { errorCode: "stream_ended" });
  } catch (err) {
    const reason = r.abort.signal.aborted ? String((r.abort.signal.reason as Error | undefined)?.message ?? "") : "";
    if (reason === "stopped_by_user" || reason === "timeout") {
      if (hermesRunId) await stopRun(r.conn, hermesRunId).catch(() => undefined);
      await finish(reason === "timeout" ? "timeout" : "cancelled", reason === "timeout" ? { errorCode: "timeout" } : {});
      return;
    }
    if (err instanceof HermesError && (err.kind === "unreachable" || err.kind === "auth_failed")) {
      await markAgentDegraded(r.agentId, err.message);
    }
    await finish("failed", { errorCode: "connection_lost" });
  } finally {
    clearTimeout(timeout);
  }
}

/** Stops a run the signed-in user started. */
export async function stopChatRun(ctx: OrgContext, runId: string): Promise<void> {
  const run = await withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ id: string; user_id: string; status: string; hermes_run_id: string | null; agent_instance_id: string }>(
      "select id, user_id, status, hermes_run_id, agent_instance_id from agent_runs where id = $1 and org_id = $2",
      [runId, ctx.org.orgId],
    );
    return rows[0];
  });
  if (!run || run.user_id !== ctx.user.id) throw new AppError("not_found", "Run not found.");
  if (!["queued", "running"].includes(run.status)) return;
  if (abortChannel(runId)) return;
  // The run is not attached to this server process (e.g. after a restart): ask Hermes directly.
  const conn = await withSystem((db) => loadConnection(db, run.agent_instance_id));
  if (conn && run.hermes_run_id) await stopRun(conn, run.hermes_run_id).catch(() => undefined);
  await withSystem(async (db) => {
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where id = $1 and status in ('queued', 'running')", [runId]);
    await db.query("update chat_messages set status = 'cancelled' where run_id = $1 and status = 'streaming'", [runId]);
  });
}

/** Marks runs that were in flight when the server stopped, so nothing is shown as still running. */
export async function reconcileOrphanedRuns() {
  await withSystem(async (db) => {
    await db.query(
      `update agent_runs set status = 'interrupted', finished_at = now(), error_code = 'interrupted'
       where status in ('queued', 'running') and started_at < now() - make_interval(secs => $1)`,
      [Math.ceil(env().HERMES_RUN_TIMEOUT_MS / 1000) + 60],
    );
    await db.query(
      `update chat_messages m set status = 'failed', error_code = 'interrupted'
       from agent_runs r where r.id = m.run_id and m.status = 'streaming' and r.status = 'interrupted'`,
    );
  });
}
