import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer } from "@/server/aqi/access";
import { deleteAqiConversation, getAqiConversation, renameAqiConversation } from "@/server/aqi/service";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const viewer = await resolveAqiViewer();
    const { id } = await params;
    const before = new URL(request.url).searchParams.get("before");
    return NextResponse.json(await getAqiConversation(viewer, id, before));
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    const { id } = await params;
    const parsed = z.object({ title: z.string().trim().min(1).max(120) }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Give the conversation a name." }, { status: 400 });
    await renameAqiConversation(viewer, id, parsed.data.title);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    const { id } = await params;
    await deleteAqiConversation(viewer, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
