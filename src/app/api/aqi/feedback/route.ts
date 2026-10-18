import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer } from "@/server/aqi/access";
import { rateAqiMessage } from "@/server/aqi/service";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    const parsed = z.object({ messageId: z.string().uuid(), rating: z.union([z.literal(1), z.literal(-1)]), comment: z.string().max(1000).optional() }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid feedback." }, { status: 400 });
    await rateAqiMessage(viewer, parsed.data.messageId, parsed.data.rating, parsed.data.comment);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
