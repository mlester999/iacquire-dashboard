import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer } from "@/server/aqi/access";
import { generateAqiConversationTitle } from "@/server/aqi/titles";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const idSchema = z.string().uuid();

/**
 * Called after a turn has already rendered, so naming never blocks the chat. The database update is
 * conditional on the conversation still being the owner's and still having a default title; a
 * deleted chat is never recreated and a manual rename always wins.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    const { id } = await params;
    if (!idSchema.safeParse(id).success) return NextResponse.json({ title: null, generated: false }, { status: 404 });
    const limit = await consumeRateLimit(RATE_LIMITS.aqiTitleByUser, viewer.user.id);
    if (!limit.allowed) {
      return NextResponse.json(
        { title: null, generated: false, retryAfterSeconds: limit.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }
    const result = await generateAqiConversationTitle(viewer, id);
    return NextResponse.json(result ?? { title: null, generated: false }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
