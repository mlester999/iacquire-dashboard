import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/server/auth/session";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { deleteKnowledgeDocument, readKnowledgeDocument } from "@/server/knowledge/service";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireOrgContextOrThrow("knowledge.view");
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const doc = await readKnowledgeDocument(ctx, id);
    return new NextResponse(new Uint8Array(doc.bytes), {
      headers: {
        "Content-Type": doc.mime_type,
        // Always download; never render user-supplied files inline on the portal origin.
        "Content-Disposition": `attachment; filename="${doc.filename.replace(/["\\\r\n]/g, "_")}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertSameOrigin();
    const ctx = await requireOrgContextOrThrow("knowledge.edit");
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    await deleteKnowledgeDocument(ctx, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
