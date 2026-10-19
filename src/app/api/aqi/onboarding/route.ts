import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer } from "@/server/aqi/access";
import { getAqiOnboarding, setAqiOnboardingAction } from "@/server/aqi/onboarding";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const viewer = await resolveAqiViewer();
    const path = new URL(request.url).searchParams.get("path");
    return NextResponse.json(await getAqiOnboarding(viewer, path), { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}

export async function POST(request: Request) {
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    const parsed = z.object({ action: z.enum(["start", "defer", "dismiss", "complete", "reset"]) }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "That onboarding action is not valid." }, { status: 400 });
    const result = await setAqiOnboardingAction(viewer, parsed.data.action);
    return NextResponse.json(result);
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
