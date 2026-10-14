import { NextResponse } from "next/server";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { sseStream } from "@/server/chat/hub";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Re-attaches to a response that is still streaming (e.g. after navigating away and back). */
export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const ctx = await requireOrgContextOrThrow("agents.use");
    const { runId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(runId)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    // The hub only lets the run's owner subscribe.
    const stream = sseStream(runId, ctx.user.id);
    if (!stream) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
    });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
