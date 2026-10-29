import { NextResponse } from "next/server";
import { z } from "zod";
import { AGENT_ROLE_KEYS, AGENCY_HERMES_PROFILE_IDS } from "@/lib/agents";
import { HERMES_INFERENCE_ONLY_PROVIDER_CANARY } from "@/lib/hermes-inference-only";
import { assertSameOrigin } from "@/server/auth/session";
import { recordAudit } from "@/server/audit";
import { buildRunInstructions, getAgentByRole, loadConnection } from "@/server/workforce/service";
import { withSystem } from "@/server/db";
import { AppError, toPublicError } from "@/server/errors";
import { requireWorkforceContextOrThrow } from "@/server/workforce/workspace-access";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { readBoundedJson } from "@/server/security/bounded-body";
import { requestInferenceOnly } from "@/server/integrations/hermes/inference-only";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 45;

const bodySchema = z.object({ role: z.enum(AGENT_ROLE_KEYS) }).strict();
const REQUEST_BODY_LIMIT_BYTES = 128;

export async function POST(req: Request) {
  try {
    await assertSameOrigin();
    const ctx = await requireWorkforceContextOrThrow("agents.use");
    if (ctx.org.kind !== "agency" || ctx.user.platformRole !== "agency_super_admin") {
      throw new AppError("forbidden", "Restricted employee inference checks are available to internal Super Admins only.");
    }
    const body = await readBoundedJson(req, REQUEST_BODY_LIMIT_BYTES);
    if (!body.ok && body.reason === "too_large") {
      return NextResponse.json({ error: "Request body too large.", code: "invalid_input" }, { status: 413 });
    }
    const parsed = bodySchema.safeParse(body.ok ? body.value : null);
    if (!parsed.success) throw new AppError("invalid_input", "Choose one existing internal employee.");
    const limit = await consumeRateLimit(RATE_LIMITS.agentInferenceOnlyByUser, ctx.user.id);
    if (!limit.allowed) throw new AppError("rate_limited", "The restricted inference check has reached its short test limit. Wait one minute and try again.", { retryAfterSeconds: limit.retryAfterSeconds });

    const agent = await getAgentByRole(ctx.user.id, ctx.org.orgId, parsed.data.role);
    if (
      !agent
      || !agent.enabled
      || !agent.active_config_version_id
      || agent.hermes_profile !== AGENCY_HERMES_PROFILE_IDS[parsed.data.role]
    ) {
      throw new AppError("agent_unavailable", "The selected internal employee profile or active configuration could not be verified.");
    }
    const prepared = await withSystem(async (db) => {
      const instructions = await buildRunInstructions(db, ctx.org.orgId, agent.id);
      const conn = await loadConnection(db, agent.id);
      if (!conn || conn.orgKind !== "agency" || conn.roleKey !== parsed.data.role || conn.profile !== AGENCY_HERMES_PROFILE_IDS[parsed.data.role]) {
        throw new AppError("agent_unavailable", "The selected internal employee connection could not be verified.");
      }
      return { instructions, conn };
    });
    const result = await requestInferenceOnly(prepared.conn, {
      actorId: ctx.user.id,
      role: parsed.data.role,
      instructions: prepared.instructions.instructions,
      input: HERMES_INFERENCE_ONLY_PROVIDER_CANARY,
      history: [],
    });
    await recordAudit({
      orgId: ctx.org.orgId,
      actorUserId: ctx.user.id,
      actorKind: "user",
      agentInstanceId: agent.id,
      action: "hermes.inference_only_canary",
      targetType: "agent_instance",
      targetId: agent.id,
      result: "success",
      metadata: {
        role: parsed.data.role,
        profile: AGENCY_HERMES_PROFILE_IDS[parsed.data.role],
        provider: result.provider,
        model: result.model,
        usageUnit: "tokens",
        actualUsage: {
          input: result.usage.inputTokens,
          output: result.usage.outputTokens,
          total: result.usage.totalTokens,
        },
        toolSchemas: 0,
        toolCalls: 0,
      },
    });
    return NextResponse.json({
      role: parsed.data.role,
      provider: result.provider,
      model: result.model,
      response: result.content,
      usage: result.usage,
      toolSchemas: 0,
      toolCalls: 0,
      persistedChat: false,
    });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message, code: e.code, retryAfterSeconds: e.retryAfterSeconds }, { status: e.status });
  }
}
