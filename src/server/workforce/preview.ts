import "server-only";
import crypto from "node:crypto";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { withSystem } from "@/server/db";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { agentSettingsSchema, diffAgentSettings, type AgentSettings } from "@/lib/agent-settings";
import { AGENT_BY_KEY, isAgentRoleKey, type AgentRoleKey } from "@/lib/agents";
import { decisionFromRiskFlags } from "@/lib/config-review";
import type { ConfigPreviewEvent, ConfigPreviewSummary, PreviewMessage } from "@/lib/workforce-types";
import { AgentRunNotReadyError, getCapabilities, getRunStatus, HermesError, startAgentRun, stopRun, streamRunEvents, toolActivityLabel } from "@/server/integrations/hermes/client";
import {
  compileDraftConfig,
  composeRunInstructions,
  currentSettings,
  getAgentByRole,
  loadConnection,
} from "@/server/workforce/service";
import type { OrgContext } from "@/server/tenancy/context";

const PREVIEW_HISTORY = 10;
const PREVIEW_MESSAGE_MAX = 4000;

function friendly(err: unknown) {
  if (err instanceof HermesError) {
    switch (err.kind) {
      case "auth_failed":
        return "The employee's provider rejected its credential. An iAcquire administrator needs to reconnect this profile.";
      case "unreachable":
      case "timeout":
        return "The AI provider couldn't be reached. The draft was not changed and nothing was saved.";
      case "rate_limited":
        return "The AI provider is at its concurrency limit. Try the test again in a moment.";
      case "not_found":
        return "The provider profile route wasn't found. Check the profile mapping with iAcquire.";
      default:
        return "The AI provider couldn't run this test. The draft was not changed.";
    }
  }
  return err instanceof Error ? err.message : "The test couldn't run. The draft was not changed.";
}

function validateMessages(messages: PreviewMessage[]): PreviewMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) throw new AppError("invalid_input", "Type a test message first.");
  if (messages.length > PREVIEW_HISTORY + 1) throw new AppError("invalid_input", "This test conversation is too long. Start a new test.");
  const clean = messages.map((m) => {
    if (!m || (m.role !== "user" && m.role !== "assistant")) throw new AppError("invalid_input", "The test conversation is invalid.");
    const content = typeof m.content === "string" ? m.content.trim() : "";
    if (!content) throw new AppError("invalid_input", "Type a test message first.");
    return { role: m.role, content: content.slice(0, PREVIEW_MESSAGE_MAX) };
  });
  if (clean[clean.length - 1].role !== "user") throw new AppError("invalid_input", "The last test message must be from you.");
  return clean;
}

interface Prepared {
  agentId: string;
  role: AgentRoleKey;
  settings: AgentSettings;
  active: AgentSettings;
  instructions: string;
  summary: ConfigPreviewSummary;
  connection: Awaited<ReturnType<typeof loadConnection>>;
}

async function prepare(ctx: OrgContext, role: string, draft: unknown): Promise<Prepared> {
  if (!isAgentRoleKey(role)) throw new AppError("not_found", "Unknown employee.");
  const parsed = agentSettingsSchema.safeParse(draft);
  if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Check the draft configuration.");
  const agent = await getAgentByRole(ctx.user.id, ctx.org.orgId, role);
  if (!agent) throw new AppError("not_found", "AI employee not found.");
  return withSystem(async (db) => {
    const { settings: active } = await currentSettings(db, agent.id, ctx.org.orgId);
    const { compiled, version } = await compileDraftConfig(db, ctx.org.orgId, agent.id, parsed.data);
    const run = await composeRunInstructions(db, ctx.org.orgId, agent.id, compiled.instructions, null);
    const conn = await loadConnection(db, agent.id);
    const warnings: string[] = [];
    const decision = decisionFromRiskFlags(compiled.riskFlags);
    if (decision === "blocked") {
      warnings.push("Saving this draft would be blocked because it contains content platform security does not allow.");
    } else if (decision === "review_required") {
      warnings.push("Saving this draft would hold it for review before it can be applied.");
    }
    if (!conn) warnings.push("This employee isn't connected to a provider, so a test message can't run yet.");
    if (run.knowledgeTruncated) warnings.push("Some company knowledge was left out by the knowledge size budget.");
    if (parsed.data.disabledTools.length) {
      warnings.push("Switched-off tools are removed from the instructions. The provider profile's tool exposure is enforced separately by the connection health check.");
    }
    return {
      agentId: agent.id,
      role,
      settings: parsed.data,
      active,
      instructions: run.instructions,
      connection: conn,
      summary: {
        role,
        version,
        summary: compiled.summary,
        riskFlags: compiled.riskFlags,
        decision,
        changed: diffAgentSettings(active, parsed.data),
        warnings,
        knowledge: {
          entries: run.knowledgeEntryIds.length,
          documents: run.knowledgeDocumentIds.length,
          truncated: run.knowledgeTruncated,
          characters: run.instructions.length,
        },
        connectionConfigured: Boolean(conn),
        provider: conn ? "hermes" : null,
      },
    };
  });
}

/** Server action helper: validates and compiles a draft without contacting the provider or changing anything. */
export async function prepareConfigPreview(ctx: OrgContext, role: string, draft: unknown): Promise<ConfigPreviewSummary> {
  if (!ctx.can("agents.configure")) throw new AppError("forbidden", "Your role can't test employee configurations.");
  return (await prepare(ctx, role, draft)).summary;
}

/**
 * Runs a real provider test against a draft configuration without writing a chat message, a conversation, an
 * agent_runs row or a configuration version. A unique session and memory scope keep the test out of production
 * history and long-term memory. The provider's own safety gate still applies.
 */
export async function* runConfigPreview(
  ctx: OrgContext,
  input: { role: string; settings: unknown; messages: PreviewMessage[] },
  signal: AbortSignal,
): AsyncGenerator<ConfigPreviewEvent> {
  if (!ctx.can("agents.configure")) throw new AppError("forbidden", "Your role can't test employee configurations.");
  const limit = await consumeRateLimit(RATE_LIMITS.agentPreviewByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "You're running tests quickly. Please wait a moment.", { retryAfterSeconds: limit.retryAfterSeconds });
  const messages = validateMessages(input.messages);
  const prepared = await prepare(ctx, input.role, input.settings);
  yield { type: "prepared", data: prepared.summary };
  if (!prepared.connection) {
    yield { type: "unavailable", message: "This employee isn't connected to an AI provider yet, so a live test can't run. The draft itself is valid and nothing was changed." };
    return;
  }

  const last = messages[messages.length - 1];
  const history = messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  const testId = crypto.randomUUID();
  let runId: string | null = null;
  let content = "";
  try {
    const started = await startAgentRun(prepared.agentId, ctx.org.orgId, prepared.connection, {
      input: last.content,
      instructions: prepared.instructions,
      sessionId: `preview-${testId}`,
      conversationHistory: history,
      idempotencyKey: `preview:${testId}`,
      memoryScope: `iaq:preview:${ctx.org.orgId}:${prepared.role}:${testId}`,
    });
    runId = started.runId;
    yield { type: "started", runId };
    const wait = () =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, 1000);
        signal.addEventListener("abort", done, { once: true });
      });
    let supportsEvents = true;
    try {
      supportsEvents = (await getCapabilities(prepared.connection)).supportsEvents;
    } catch {
      // Try the event stream; it has its own honest error handling.
    }
    if (!supportsEvents) {
      yield { type: "activity", label: "Waiting for the complete response…" };
      for (;;) {
        if (signal.aborted) {
          await stopRun(prepared.connection, runId).catch(() => undefined);
          yield { type: "cancelled" };
          return;
        }
        const status = await getRunStatus(prepared.connection, runId);
        if (status.status === "completed") {
          await withSystem((db) =>
            recordAudit(
              {
                orgId: ctx.org.orgId,
                actorUserId: ctx.user.id,
                actorKind: "user",
                agentInstanceId: prepared.agentId,
                action: "agent.config_test_run",
                targetType: "agent_config_version",
                result: "success",
                metadata: { version: prepared.summary.version, riskFlags: prepared.summary.riskFlags, messages: messages.length, streaming: false },
              },
              db,
            ),
          );
          yield { type: "done", content: status.output ?? "", usage: status.usage };
          return;
        }
        if (status.status === "failed") {
          yield { type: "error", message: "The AI provider reported that this test failed. The draft was not changed.", retryable: true };
          return;
        }
        if (status.status === "cancelled") {
          yield { type: "cancelled" };
          return;
        }
        if (status.status === "interrupted") {
          yield { type: "error", message: "The AI service restarted while answering the test. Try again.", retryable: true };
          return;
        }
        await wait();
      }
    }
    for await (const event of streamRunEvents(prepared.connection, runId, signal)) {
      if (signal.aborted) break;
      switch (event.type) {
        case "delta":
          content += event.text;
          yield { type: "delta", text: event.text };
          break;
        case "tool_started":
          yield { type: "activity", label: toolActivityLabel(event.tool) };
          break;
        case "completed": {
          const output = event.output ?? content;
          await withSystem((db) =>
            recordAudit(
              {
                orgId: ctx.org.orgId,
                actorUserId: ctx.user.id,
                actorKind: "user",
                agentInstanceId: prepared.agentId,
                action: "agent.config_test_run",
                targetType: "agent_config_version",
                result: "success",
                metadata: { version: prepared.summary.version, riskFlags: prepared.summary.riskFlags, messages: messages.length },
              },
              db,
            ),
          );
          yield { type: "done", content: output, usage: event.usage };
          return;
        }
        case "failed":
          yield { type: "error", message: "The AI provider reported that this test failed. The draft was not changed.", retryable: true };
          return;
        case "cancelled":
          yield { type: "cancelled" };
          return;
        case "interrupted":
          yield { type: "error", message: "The AI service restarted while answering the test. Try again.", retryable: true };
          return;
        default:
          break;
      }
    }
    if (!signal.aborted) yield { type: "error", message: "The test response ended unexpectedly. Nothing was saved.", retryable: true };
  } catch (err) {
    if (signal.aborted) {
      if (runId) await stopRun(prepared.connection, runId).catch(() => undefined);
      yield { type: "cancelled" };
      return;
    }
    await withSystem((db) =>
      recordAudit(
        {
          orgId: ctx.org.orgId,
          actorUserId: ctx.user.id,
          actorKind: "user",
          agentInstanceId: prepared.agentId,
          action: "agent.config_test_run",
          targetType: "agent_config_version",
          result: "failure",
          metadata: { version: prepared.summary.version, code: err instanceof AgentRunNotReadyError ? err.reason : err instanceof HermesError ? err.kind : "unknown" },
        },
        db,
      ),
    ).catch(() => undefined);
    if (err instanceof AgentRunNotReadyError) {
      // Not a transient failure: the employee must pass its health check before it can run anything, even a test.
      yield { type: "unavailable", message: `${err.message} The draft itself is valid and nothing was changed.` };
      return;
    }
    yield { type: "error", message: friendly(err), retryable: true };
  }
}

/** Plain-language name for the preview UI; never claims a mocked provider is a live one. */
export function previewRoleName(role: AgentRoleKey) {
  return AGENT_BY_KEY[role].shortName;
}
