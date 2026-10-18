import { NextResponse } from "next/server";
import { resolveAqiViewer } from "@/server/aqi/access";
import { getAqiBootstrap } from "@/server/aqi/service";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const viewer = await resolveAqiViewer();
    const page = new URL(request.url).searchParams.get("path");
    return NextResponse.json(await getAqiBootstrap(viewer, page));
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
