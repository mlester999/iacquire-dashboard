import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer } from "@/server/aqi/access";
import { getAqiOnboarding } from "@/server/aqi/onboarding";
import { getAqiTutorialState, listAqiTutorialsForViewer, startAqiTutorial } from "@/server/aqi/tutorials";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

/**
 * Everything the tutorial stage needs before it can offer or resume a walkthrough. The list is
 * already filtered by the server-resolved role, permissions, route access and CRM capability.
 */
export async function GET(request: Request) {
  try {
    const viewer = await resolveAqiViewer();
    const path = new URL(request.url).searchParams.get("path");
    // One eligibility pass feeds the list, the progress state and the welcome decision.
    const tutorials = await listAqiTutorialsForViewer(viewer);
    const [state, onboarding] = await Promise.all([
      getAqiTutorialState(viewer, tutorials),
      getAqiOnboarding(viewer, path, tutorials),
    ]);
    return NextResponse.json({ tutorials, state, onboarding, page: path }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}

const startSchema = z.object({
  slug: z.string().min(3).max(80),
  source: z.enum(["chat", "library", "onboarding", "tip"]).default("library"),
});

export async function POST(request: Request) {
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    const parsed = startSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Choose a walkthrough to start." }, { status: 400 });
    const result = await startAqiTutorial(viewer, parsed.data.slug, parsed.data.source);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
