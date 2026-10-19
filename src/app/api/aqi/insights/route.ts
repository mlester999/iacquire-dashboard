import { NextResponse } from "next/server";
import { resolveAqiViewer } from "@/server/aqi/access";
import { getAqiInsights } from "@/server/aqi/insights";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

/** Super Admin only. Organization and role filters are resolved server-side; unknown filters are rejected. */
export async function GET(request: Request) {
  try {
    const viewer = await resolveAqiViewer();
    const params = new URL(request.url).searchParams;
    const days = params.get("days");
    const insights = await getAqiInsights(viewer.user, {
      from: params.get("from"),
      to: params.get("to"),
      days: days ? Number(days) : null,
      orgId: params.get("orgId"),
      role: params.get("role"),
    });
    return NextResponse.json(insights, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
