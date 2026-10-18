import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer } from "@/server/aqi/access";
import { purgeStaleAqiTemporaryConversations } from "@/server/aqi/lifecycle";
import { createAqiConversation, searchAqiConversations } from "@/server/aqi/service";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const viewer = await resolveAqiViewer();
    // Unsaved chats from an ended browser session stay out of history and are cleaned up lazily.
    await purgeStaleAqiTemporaryConversations(viewer).catch(() => 0);
    const params = new URL(request.url).searchParams;
    const query = params.get("q")?.slice(0, 120) ?? "";
    const before = params.get("before");
    const parsedLimit = Number(params.get("limit") ?? 20);
    const limit = Number.isFinite(parsedLimit) ? Math.min(50, Math.max(1, Math.trunc(parsedLimit))) : 20;
    const page = await searchAqiConversations(viewer, {
      query,
      limit,
      before: before && !Number.isNaN(Date.parse(before)) ? before : null,
    });
    return NextResponse.json(page, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}

export async function POST(request: Request) {
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    const parsed = z.object({ path: z.string().max(300).optional() }).safeParse(await request.json().catch(() => ({})));
    const conversation = await createAqiConversation(viewer, parsed.success ? parsed.data.path ?? null : null);
    return NextResponse.json({ conversation }, { status: 201 });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
