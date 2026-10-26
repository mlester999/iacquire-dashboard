import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/server/auth/session";
import { readBoundedFormData } from "@/server/security/bounded-body";
import { resolveAqiViewer } from "@/server/aqi/access";
import { requireAqiAdmin } from "@/server/aqi/access";
import { listAqiKnowledgeDocuments, uploadAqiKnowledgeDocument } from "@/server/aqi/knowledge-documents";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  try {
    const viewer = await resolveAqiViewer();
    requireAqiAdmin(viewer);
    return NextResponse.json({ documents: await listAqiKnowledgeDocuments() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}

export async function POST(request: Request) {
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    requireAqiAdmin(viewer);
    // Read with a ceiling as it arrives, so a chunked request cannot make the server hold an unbounded body before the 10 MB rule below sees it.
    const form = await readBoundedFormData(request, 10 * 1024 * 1024 + 1_000_000);
    if (!form) return NextResponse.json({ error: "Platform knowledge documents can be up to 10 MB." }, { status: 413 });
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Choose a document to upload." }, { status: 400 });
    if (file.size > 10 * 1024 * 1024) return NextResponse.json({ error: "Platform knowledge documents can be up to 10 MB." }, { status: 413 });
    const result = await uploadAqiKnowledgeDocument(viewer.user, {
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
