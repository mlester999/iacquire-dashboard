import { NextResponse } from "next/server";
import { z } from "zod";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { HERMES_INFERENCE_ONLY_CHAT_CANARY } from "@/lib/hermes-inference-only";
import { assertSameOrigin } from "@/server/auth/session";
import { sendChatMessage } from "@/server/chat/service";
import { sseStream } from "@/server/chat/hub";
import { toPublicError } from "@/server/errors";
import { requireWorkforceContextOrThrow } from "@/server/workforce/workspace-access";
import { readBoundedJson } from "@/server/security/bounded-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 45;

const bodySchema = z.object({
  role: z.enum(AGENT_ROLE_KEYS),
  clientMessageId: z.string().max(64).optional(),
}).strict();
const REQUEST_BODY_LIMIT_BYTES = 512;

/** Starts the fixed no-tool canary from the normal employee Chat view, through its isolated worker. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin();
    const ctx = await requireWorkforceContextOrThrow("agents.use");
    if (ctx.org.kind !== "agency" || ctx.user.platformRole !== "agency_super_admin") {
      return NextResponse.json({ error: "Restricted Chat checks are available to internal Super Admins only.", code: "forbidden" }, { status: 403 });
    }
    const body = await readBoundedJson(req, REQUEST_BODY_LIMIT_BYTES);
    if (!body.ok && body.reason === "too_large") {
      return NextResponse.json({ error: "Request body too large.", code: "invalid_input" }, { status: 413 });
    }
    const parsed = bodySchema.safeParse(body.ok ? body.value : null);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request.", code: "invalid_input" }, { status: 400 });
    const result = await sendChatMessage(ctx, {
      agentRole: parsed.data.role,
      content: HERMES_INFERENCE_ONLY_CHAT_CANARY,
      clientMessageId: parsed.data.clientMessageId,
      inferenceOnly: true,
    });
    if (!result.runId) return NextResponse.json(result);
    const stream = sseStream(result.runId, ctx.user.id);
    if (!stream) return NextResponse.json(result);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message, code: e.code, retryAfterSeconds: e.retryAfterSeconds }, { status: e.status });
  }
}
