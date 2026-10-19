import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer } from "@/server/aqi/access";
import { getAqiTutorialForViewer, recordAqiGuideSignal } from "@/server/aqi/tutorials";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  kind: z.enum(["guidance_accept", "guidance_decline", "guidance_offer"]),
  slug: z.string().min(3).max(80),
  page: z.string().max(300).nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
});

/** Privacy-conscious guide signals. The server re-verifies that the tutorial is eligible. */
export async function POST(request: Request) {
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "That guidance action is not valid." }, { status: 400 });
    const tutorial = await getAqiTutorialForViewer(viewer, parsed.data.slug);
    if (!tutorial) return NextResponse.json({ error: "That walkthrough isn't available for your account." }, { status: 404 });
    await recordAqiGuideSignal(viewer, parsed.data.kind, {
      slug: tutorial.slug,
      page: parsed.data.page ?? null,
      conversationId: parsed.data.conversationId ?? null,
      source: "chat",
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
