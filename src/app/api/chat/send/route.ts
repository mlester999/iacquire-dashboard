import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { sendChatMessage } from "@/server/chat/service";
import { sseStream } from "@/server/chat/hub";
import { toPublicError } from "@/server/errors";
import { AGENT_ROLE_KEYS } from "@/lib/agents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const uuid = z.string().regex(/^[0-9a-f-]{36}$/i);
const bodySchema = z.object({
  role: z.enum(AGENT_ROLE_KEYS),
  conversationId: uuid.nullish(),
  content: z.string().max(8000).optional(),
  clientMessageId: z.string().max(64).optional(),
  regenerateMessageId: uuid.optional(),
});

export async function POST(req: Request) {
  try {
    await assertSameOrigin();
    const ctx = await requireOrgContextOrThrow("agents.use");
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request.", code: "invalid_input" }, { status: 400 });
    const result = await sendChatMessage(ctx, {
      agentRole: parsed.data.role,
      conversationId: parsed.data.conversationId ?? null,
      content: parsed.data.content,
      clientMessageId: parsed.data.clientMessageId,
      regenerateMessageId: parsed.data.regenerateMessageId,
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
