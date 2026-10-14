import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/server/auth/session";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { stopChatRun } from "@/server/chat/service";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    await assertSameOrigin();
    const ctx = await requireOrgContextOrThrow("agents.use");
    const { runId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(runId)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    await stopChatRun(ctx, runId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
