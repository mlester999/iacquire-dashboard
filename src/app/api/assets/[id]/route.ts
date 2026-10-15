import { NextResponse } from "next/server";
import { studioContext } from "@/server/websites/studio-ctx";
import { readAsset } from "@/server/assets/service";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Serves a brand image to signed-in members of the owning workspace, and to agency staff assigned to it. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: "Image not found." }, { status: 404 });
    const url = new URL(req.url);
    // An agency user names the client they were assigned to; anyone else always gets their own workspace.
    const ctx = await studioContext(url.searchParams.get("org"), "workspace.view");
    const variant = url.searchParams.get("variant") === "processed" ? "processed" : "original";
    const { bytes, mimeType } = await readAsset(ctx, id, variant);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=300",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
