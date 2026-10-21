import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveCrmActor } from "@/server/crm/request";
import { runBuilderTurn } from "@/server/automation-studio/builder/service";
import { AppError, toPublicError } from "@/server/errors";
import type { BuilderEvent } from "@/lib/automation-studio/types";

// One turn with the AI Automation Builder, streamed as server-sent events (BuilderEvent, one JSON object per event). The route only carries the
// request: the plan, the permission, the workspace, the limits and every validation are enforced in src/server/automation-studio/builder/service.ts.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const bodySchema = z.object({
  message: z.string().max(4000).optional(),
  selectedKey: z.string().max(60).nullish(),
  resume: z.boolean().optional(),
});

const headers = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};
const frame = (event: BuilderEvent) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await assertSameOrigin();
    const { id } = await ctx.params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_input", "Write what you'd like to change, in under 4,000 characters.");
    const actor = await resolveCrmActor(null, "workflows.manage");
    const controller = new AbortController();
    request.signal.addEventListener("abort", () => controller.abort(), { once: true });
    const turn = runBuilderTurn(actor, id, parsed.data, undefined, controller.signal);
    // Everything that can be refused before the first event (the plan, the permission, the workspace, the limits, no model connected) is
    // refused with a plain error response, so the person sees why instead of an empty stream.
    const first = await turn.next();
    const stream = new ReadableStream<Uint8Array>({
      async start(out) {
        try {
          if (!first.done) out.enqueue(frame(first.value));
          for await (const event of turn) out.enqueue(frame(event));
        } catch (err) {
          if (!controller.signal.aborted) {
            const e = toPublicError(err);
            out.enqueue(frame({ type: "error", code: e.code, message: e.message }));
          }
        } finally {
          out.close();
        }
      },
      cancel() {
        controller.abort();
      },
    });
    return new Response(stream, { headers });
  } catch (err) {
    const e = toPublicError(err);
    return Response.json({ error: e.message, code: e.code }, { status: e.status, headers: e.retryAfterSeconds ? { "Retry-After": String(e.retryAfterSeconds) } : undefined });
  }
}
