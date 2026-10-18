import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer } from "@/server/aqi/access";
import { runAqiTurn } from "@/server/aqi/service";
import { classifyAqiError, logAqiError } from "@/server/aqi/errors";
import { AppError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const bodySchema = z.object({
  conversationId: z.string().uuid().nullish(),
  message: z.string().min(1).max(2000),
  path: z.string().max(300).nullish(),
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
          for await (const event of runAqiTurn(viewer, {
            conversationId: parsed.data.conversationId ?? null,
            message: parsed.data.message,
            pathname: parsed.data.path ?? null,
          }, controller.signal)) {
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
