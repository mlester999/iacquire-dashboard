import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer } from "@/server/aqi/access";
import { purgeStaleAqiTemporaryConversations } from "@/server/aqi/lifecycle";
import { createAqiConversation, listAqiConversations } from "@/server/aqi/service";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const viewer = await resolveAqiViewer();
    // Unsaved chats from an ended browser session stay out of history and are cleaned up lazily.
    await purgeStaleAqiTemporaryConversations(viewer).catch(() => 0);
    return NextResponse.json({ conversations: await listAqiConversations(viewer) });
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
