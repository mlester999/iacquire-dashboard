import { NextResponse } from "next/server";
import { resolveAqiViewer } from "@/server/aqi/access";
import { getAqiHealth } from "@/server/aqi/service";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

/** Provider availability, resolved independently from the welcome screen. */
export async function GET() {
  try {
    const viewer = await resolveAqiViewer();
    return NextResponse.json(await getAqiHealth(viewer), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
