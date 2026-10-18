import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer } from "@/server/aqi/access";
import { saveAqiConversation } from "@/server/aqi/lifecycle";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

/** Explicitly save a temporary AQi chat to the signed-in person's history. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    const { id } = await params;
    const saved = await saveAqiConversation(viewer, id);
    return NextResponse.json({ ok: true, ...saved });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
