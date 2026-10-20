import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer } from "@/server/aqi/access";
import { prepareAqiSupportDraft } from "@/server/aqi/support";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

/**
 * Prepares (and only prepares) a support request from the person's own AQi conversation: a proposed subject, description and topic, and
 * the exact excerpt that would be shared if they agree. Nothing is created or sent, and no ticket reference exists until the person
 * presses Send in the dialog.
 */
export async function POST(request: Request) {
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    const parsed = z.object({ conversationId: z.string().uuid() }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "A valid conversation is required." }, { status: 400 });
    const draft = await prepareAqiSupportDraft(viewer, parsed.data.conversationId);
    return NextResponse.json(draft, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
