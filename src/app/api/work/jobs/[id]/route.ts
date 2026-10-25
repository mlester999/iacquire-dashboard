import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { requireWorkforceContextOrThrow } from "@/server/workforce/workspace-access";
import { cancelWorkJob, getWorkJobView, retryWorkJobForUser } from "@/server/workforce/jobs";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const uuid = /^[0-9a-f-]{36}$/i;
const actionSchema = z.object({ action: z.enum(["cancel", "retry"]) });

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireWorkforceContextOrThrow();
    const { id } = await params;
    if (!uuid.test(id)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const after = new URL(req.url).searchParams.get("after");
    const job = await getWorkJobView(ctx, id, { afterId: after });
    if (!job) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ job }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertSameOrigin();
    const ctx = await requireWorkforceContextOrThrow();
    const { id } = await params;
    if (!uuid.test(id)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const parsed = actionSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Choose cancel or retry." }, { status: 400 });
    if (parsed.data.action === "cancel") {
      const result = await cancelWorkJob(ctx, id);
      return NextResponse.json({ ok: true, result });
    }
    await retryWorkJobForUser(ctx, id);
    return NextResponse.json({ ok: true, result: "queued" });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  }
}
