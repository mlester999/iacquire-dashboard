import { NextResponse } from "next/server";
import { z } from "zod";
import { AGENT_ROLE_KEYS, AGENCY_HERMES_PROFILE_IDS } from "@/lib/agents";
import { HERMES_INFERENCE_ONLY_CHAT_CANARY, HERMES_INFERENCE_ONLY_PROVIDER_CANARY } from "@/lib/hermes-inference-only";
import { assertSameOrigin } from "@/server/auth/session";
import { env } from "@/server/env";
import { AppError, toPublicError } from "@/server/errors";
import { requestPromptAudit } from "@/server/integrations/hermes/inference-only";
import { withSystem } from "@/server/db";
import { getAgentByRole, buildRunInstructions, loadConnection } from "@/server/workforce/service";
import { requireWorkforceContextOrThrow } from "@/server/workforce/workspace-access";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { readBoundedJson } from "@/server/security/bounded-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 45;

const bodySchema = z.object({ role: z.enum(AGENT_ROLE_KEYS) }).strict();
const REQUEST_BODY_LIMIT_BYTES = 128;

/** Measures the exact messages assembled by pinned Hermes against a synthetic loopback provider. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin();
    const ctx = await requireWorkforceContextOrThrow("agents.use");
    if (ctx.org.kind !== "agency" || ctx.user.platformRole !== "agency_super_admin") {
      throw new AppError("forbidden", "The no-call prompt audit is available to internal Super Admins only.");
    }
    if (!env().HERMES_PROMPT_AUDIT_ENABLED) throw new AppError("integration_unavailable", "The no-call prompt audit is disabled.");
    const body = await readBoundedJson(req, REQUEST_BODY_LIMIT_BYTES);
    if (!body.ok && body.reason === "too_large") {
      return NextResponse.json({ error: "Request body too large.", code: "invalid_input" }, { status: 413 });
    }
    const parsed = bodySchema.safeParse(body.ok ? body.value : null);
    if (!parsed.success) throw new AppError("invalid_input", "Choose one existing internal employee.");
    const limit = await consumeRateLimit(RATE_LIMITS.agentInferenceOnlyByUser, ctx.user.id);
    if (!limit.allowed) throw new AppError("rate_limited", "The no-call prompt audit reached its short test limit. Wait one minute and try again.", { retryAfterSeconds: limit.retryAfterSeconds });

    const agent = await getAgentByRole(ctx.user.id, ctx.org.orgId, parsed.data.role);
    if (
      !agent
      || !agent.enabled
      || !agent.active_config_version_id
      || agent.hermes_profile !== AGENCY_HERMES_PROFILE_IDS[parsed.data.role]
    ) {
      throw new AppError("agent_unavailable", "The existing employee profile or active configuration could not be verified.");
    }
    const prepared = await withSystem(async (db) => {
      const instructions = await buildRunInstructions(db, ctx.org.orgId, agent.id);
      const conn = await loadConnection(db, agent.id);
      if (
        !conn
        || conn.orgKind !== "agency"
        || conn.roleKey !== parsed.data.role
        || conn.profile !== AGENCY_HERMES_PROFILE_IDS[parsed.data.role]
        || instructions.versionId !== agent.active_config_version_id
      ) {
        throw new AppError("agent_unavailable", "The employee's active configuration, instructions, and profile identity did not match.");
      }
      return { instructions: instructions.instructions, conn };
    });
    const result = await requestPromptAudit(prepared.conn, {
      actorId: ctx.user.id,
      role: parsed.data.role,
      instructions: prepared.instructions,
      providerInput: HERMES_INFERENCE_ONLY_PROVIDER_CANARY,
      chatInput: HERMES_INFERENCE_ONLY_CHAT_CANARY,
    });
    return NextResponse.json({
      role: result.role,
      appInstructionBytes: result.appInstructionBytes,
      soulBytes: result.soulBytes,
      providerOnlyMessageBytes: result.providerOnlyMessageBytes,
      chatMessageBytes: result.chatMessageBytes,
      syntheticProviderRequests: result.syntheticProviderRequests,
      promptLimitBytes: result.promptLimitBytes,
      underLimit: result.providerOnlyMessageBytes <= result.promptLimitBytes && result.chatMessageBytes <= result.promptLimitBytes,
      hermesVersion: result.hermesVersion,
      toolSchemas: 0,
      toolCalls: 0,
      deepseekCalls: 0,
    });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message, code: e.code, retryAfterSeconds: e.retryAfterSeconds }, { status: e.status });
  }
}
