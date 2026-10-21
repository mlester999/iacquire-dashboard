import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer } from "@/server/aqi/access";
import { runAqiTurn } from "@/server/aqi/service";
import { runOpsTurn } from "@/server/aqi/ops/turn";
import { opsScopeRequestSchema } from "@/server/aqi/ops/scope";
import { classifyAqiError, logAqiError } from "@/server/aqi/errors";
import { AppError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const bodySchema = z.object({
  conversationId: z.string().uuid().nullish(),
  message: z.string().max(2000).default(""),
  path: z.string().max(300).nullish(),
  attachmentIds: z.array(z.string().uuid()).max(20).optional(),
  /** Only read for a Super Admin, whose turns run on the operations runtime. Ignored for everyone else. */
  scope: opsScopeRequestSchema.nullish(),
});

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  let superAdmin = false;
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    superAdmin = viewer.user.platformRole === "agency_super_admin";
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      const error = classifyAqiError(new AppError("invalid_input", "Type a question under 2,000 characters."), { requestId, superAdmin, reason: "request_validation" });
      return Response.json({ error: error.message, code: error.code, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) }, { status: 400 });
    }
    const controller = new AbortController();
    request.signal.addEventListener("abort", () => controller.abort(), { once: true });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(streamController) {
        try {
          // The runtime is chosen by the server-resolved role. A Super Admin is never served by the Client
          // assistant's prompt, and nothing the browser sends can select the other runtime.
          const turn = superAdmin
            ? runOpsTurn(viewer, {
                conversationId: parsed.data.conversationId ?? null,
                message: parsed.data.message,
                pathname: parsed.data.path ?? null,
                scope: parsed.data.scope ?? null,
              }, controller.signal)
            : runAqiTurn(viewer, {
                conversationId: parsed.data.conversationId ?? null,
                message: parsed.data.message,
                pathname: parsed.data.path ?? null,
                attachmentIds: parsed.data.attachmentIds,
              }, controller.signal);
          for await (const event of turn) {
            streamController.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
        } catch (err) {
          const error = classifyAqiError(err, { requestId, superAdmin, reason: "chat_route" });
          logAqiError(err, { requestId, superAdmin, reason: "chat_route" });
          streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", code: error.code, message: error.message, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) })}\n\n`));
        } finally {
          streamController.close();
        }
      },
      cancel() {
        controller.abort();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    const error = classifyAqiError(err, { requestId, superAdmin, reason: "chat_route" });
    logAqiError(err, { requestId, superAdmin, reason: "chat_route" });
    return Response.json({ error: error.message, code: error.code, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) }, { status: err instanceof AppError ? err.status : 500 });
  }
}
