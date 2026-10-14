import { NextResponse } from "next/server";
import { requireUserOrThrow } from "@/server/auth/session";
import { getPortfolioImage } from "@/server/portfolio/service";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

/** Portfolio images are private: only signed-in users, only published images (agency staff may preview drafts). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUserOrThrow();
    const { id } = await params;
    const variant = new URL(req.url).searchParams.get("v") === "thumb" ? "thumb" : "full";
    const image = await getPortfolioImage(user.id, id, variant);
    return new NextResponse(new Uint8Array(image.bytes), {
      headers: { "Content-Type": image.mime, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" },
    });
  } catch (error) {
    const e = toPublicError(error);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
