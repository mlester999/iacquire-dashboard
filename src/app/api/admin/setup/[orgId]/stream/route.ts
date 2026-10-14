import { NextResponse } from "next/server";
import { requireAgencyOrgAccessOrThrow } from "@/server/tenancy/context";
import { reserveStream, setupEventStream } from "@/server/setup/hub";
import { authorizedSetupRevision } from "@/server/setup/access";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const { orgId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(orgId)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const user = await requireAgencyOrgAccessOrThrow(orgId);
    const release = reserveStream(user.id);
    if (!release) return NextResponse.json({ error: "Too many open connections." }, { status: 429 });
    const stream = setupEventStream({ orgId, getRevision: (id) => authorizedSetupRevision(user.id, id, true), signal: req.signal, release });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
    });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
