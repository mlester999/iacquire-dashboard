import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer, requireAqiAdmin } from "@/server/aqi/access";
import { archiveAqiKnowledgeDocument, readAqiKnowledgeDocument } from "@/server/aqi/knowledge-documents";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const idSchema = z.string().uuid();

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const viewer = await resolveAqiViewer();
    requireAqiAdmin(viewer);
    const { id } = await params;
    if (!idSchema.safeParse(id).success) return NextResponse.json({ error: "Document not found." }, { status: 404 });
    const file = await readAqiKnowledgeDocument(viewer.user, id);
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Disposition": `attachment; filename="${file.filename.replace(/["\\]/g, "")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    requireAqiAdmin(viewer);
    const { id } = await params;
    if (!idSchema.safeParse(id).success) return NextResponse.json({ error: "Document not found." }, { status: 404 });
    await archiveAqiKnowledgeDocument(viewer.user, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
