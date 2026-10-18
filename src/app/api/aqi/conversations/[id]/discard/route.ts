import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer } from "@/server/aqi/access";
import { discardAqiTemporaryConversation } from "@/server/aqi/lifecycle";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

/**
 * Explicitly discard a temporary AQi chat. This endpoint cannot delete a saved conversation; saved
 * chats are deleted through DELETE /api/aqi/conversations/[id] after the person confirms.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    const { id } = await params;
    await discardAqiTemporaryConversation(viewer, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
