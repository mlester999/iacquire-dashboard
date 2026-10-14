import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUserOrThrow } from "@/server/auth/session";
import { setupDocumentLink } from "@/server/setup/documents";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Document not found." }, { status: 404 });
    const user = await requireUserOrThrow();
    const url = await setupDocumentLink(user.id, id);
    const res = NextResponse.redirect(new URL(url, req.url));
    res.headers.set("Cache-Control", "no-store, private");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  } catch (error) {
    const e = toPublicError(error);
    return NextResponse.json({ error: e.message }, { status: e.status, headers: { "Cache-Control": "no-store" } });
  }
}
