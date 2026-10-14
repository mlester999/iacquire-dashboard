import { NextResponse } from "next/server";
import { requireUserOrThrow } from "@/server/auth/session";
import { projectFileDownload } from "@/server/projects/client";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

/** Project files are re-authorized on every download (tenant, role and visibility), then handed off as a short-lived link. */
export async function GET(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    const user = await requireUserOrThrow();
    const { fileId } = await params;
    const target = await projectFileDownload(user.id, fileId);
    return NextResponse.redirect(new URL(target, req.url), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const e = toPublicError(error);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
