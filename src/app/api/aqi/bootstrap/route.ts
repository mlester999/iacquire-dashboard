import { NextResponse } from "next/server";
import { resolveAqiViewer } from "@/server/aqi/access";
import { getAqiWelcome } from "@/server/aqi/service";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

/**
 * Fast welcome payload: approved suggestions, the verified page label and identity. Provider health
 * is resolved by `/api/aqi/health` so a slow credential lookup cannot delay the suggestions.
 */
export async function GET(request: Request) {
  try {
    const viewer = await resolveAqiViewer();
    const page = new URL(request.url).searchParams.get("path");
    return NextResponse.json(await getAqiWelcome(viewer, page), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
