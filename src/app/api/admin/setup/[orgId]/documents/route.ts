import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { requireAgencyOrgAccessOrThrow } from "@/server/tenancy/context";
import { attachSetupDocument } from "@/server/setup/documents";
import { toPublicError } from "@/server/errors";
import { AppError } from "@/server/errors";

export const runtime = "nodejs";

async function limitedForm(req: Request) {
  if (!req.body) throw new AppError("invalid_input", "Choose a document.");
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 11 * 1024 * 1024) { await reader.cancel(); throw new AppError("invalid_input", "Choose a document up to 10 MB."); }
    parts.push(chunk.value);
  }
  return new Response(Buffer.concat(parts), { headers: { "Content-Type": req.headers.get("content-type") ?? "" } }).formData();
}

export async function POST(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    await assertSameOrigin();
    const { orgId } = await params;
    if (!z.string().uuid().safeParse(orgId).success) return NextResponse.json({ ok: false, error: "Client not found." }, { status: 404 });
    const admin = await requireAgencyOrgAccessOrThrow(orgId);
    if (Number(req.headers.get("content-length")) > 11 * 1024 * 1024) return NextResponse.json({ ok: false, error: "Choose a document up to 10 MB." }, { status: 413 });
    const form = await limitedForm(req);
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "Choose a document." }, { status: 400 });
    const result = await attachSetupDocument(admin, orgId, String(form.get("taskId") ?? ""), { file, label: form.get("label"), visibility: form.get("visibility") });
    return NextResponse.json({ ok: true, data: { revision: result.revision, attachmentId: result.result.attachmentId } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ ok: false, error: error.issues[0]?.message ?? "Check the document details." }, { status: 400 });
    const e = toPublicError(error);
    return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
  }
}
