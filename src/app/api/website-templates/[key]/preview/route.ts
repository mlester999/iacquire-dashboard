import { NextResponse } from "next/server";
import { requireUserOrThrow } from "@/server/auth/session";
import { toPublicError } from "@/server/errors";
import { readTemplatePreviewImage } from "@/server/websites/templates";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const KEY = /^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;

/** A published template's card picture, for signed-in users. */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    await requireUserOrThrow();
    const { key } = await params;
    if (!KEY.test(key)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const img = await readTemplatePreviewImage(key);
    if (!img) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return new NextResponse(new Uint8Array(img.bytes), { headers: { "Content-Type": img.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=300", "Content-Security-Policy": "default-src 'none'; sandbox" } });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
