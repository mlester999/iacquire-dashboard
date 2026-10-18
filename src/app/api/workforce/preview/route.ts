import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/server/auth/session";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { toPublicError } from "@/server/errors";
import { runConfigPreview } from "@/server/workforce/preview";
import type { ConfigPreviewEvent, PreviewMessage } from "@/lib/workforce-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function frame(event: ConfigPreviewEvent) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Streams a real provider run against an unsaved draft configuration. It never creates a conversation, chat message,
 * run record or configuration version. The signed-in user's own provider gate still applies.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin();
    const ctx = await requireOrgContextOrThrow("agents.configure");
    const body = (await req.json().catch(() => null)) as
      | { role?: unknown; settings?: unknown; messages?: unknown }
      | null;
    if (!body || typeof body.role !== "string" || !Array.isArray(body.messages)) {
      return NextResponse.json({ error: "Send a test message first." }, { status: 400 });
    }
    const messages = body.messages as PreviewMessage[];
    const abort = new AbortController();
    req.signal.addEventListener("abort", () => abort.abort(), { once: true });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          for await (const event of runConfigPreview(ctx, { role: body.role as string, settings: body.settings, messages }, abort.signal)) {
            controller.enqueue(encoder.encode(frame(event)));
          }
        } catch (err) {
          const e = toPublicError(err);
          controller.enqueue(encoder.encode(frame({ type: "error", message: e.message, retryable: e.code === "rate_limited" })));
        } finally {
          controller.close();
        }
      },
      cancel() {
        abort.abort();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
