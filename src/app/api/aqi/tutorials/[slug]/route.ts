import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer } from "@/server/aqi/access";
import { getAqiTutorialForViewer, updateAqiTutorialProgress } from "@/server/aqi/tutorials";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

const actionSchema = z.object({
  action: z.enum(["next", "previous", "pause", "resume", "exit", "complete", "skip", "target_missing", "route_verified", "restart", "viewed"]),
  step: z.number().int().min(0).max(100).optional(),
  pathname: z.string().max(300).nullable().optional(),
  eventId: z.string().regex(/^[0-9a-f-]{8,64}$/i).nullable().optional(),
  reason: z.string().max(120).nullable().optional(),
});

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const viewer = await resolveAqiViewer();
    const { slug } = await params;
    const tutorial = await getAqiTutorialForViewer(viewer, slug);
    if (!tutorial) return NextResponse.json({ error: "That walkthrough isn't available for your account." }, { status: 404 });
    return NextResponse.json({ tutorial }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    const { slug } = await params;
    const parsed = actionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "That tutorial action is not valid." }, { status: 400 });
    const result = await updateAqiTutorialProgress(viewer, slug, parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
