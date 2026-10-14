import { NextResponse } from "next/server";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { reserveStream, setupEventStream } from "@/server/setup/hub";
import { authorizedSetupRevision } from "@/server/setup/access";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Tells the signed-in client's browser when its own setup changed. Carries only a revision number. */
export async function GET(req: Request) {
  try {
    const ctx = await requireOrgContextOrThrow("setup.view");
    const release = reserveStream(ctx.user.id);
    if (!release) return NextResponse.json({ error: "Too many open connections." }, { status: 429 });
    const stream = setupEventStream({ orgId: ctx.org.orgId, getRevision: (orgId) => authorizedSetupRevision(ctx.user.id, orgId, false), signal: req.signal, release });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
    });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
