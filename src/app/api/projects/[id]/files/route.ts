import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/server/auth/session";
import { readBoundedFormData } from "@/server/security/bounded-body";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { attachClientFile } from "@/server/projects/client";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";
const MAX = 10 * 1024 * 1024;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertSameOrigin();
    const ctx = await requireOrgContextOrThrow("projects.request");
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    const form = await readBoundedFormData(req, MAX + 65536);
    if (!form) return NextResponse.json({ error: "Files can be up to 10 MB." }, { status: 413 });
    const file = form.get("file");
    if (!(file instanceof File) || file.size > MAX) return NextResponse.json({ error: "Choose a supported file up to 10 MB." }, { status: 400 });
    const description = typeof form.get("description") === "string" ? String(form.get("description")).slice(0, 300) : null;
    const saved = await attachClientFile(ctx, id, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }, description);
    return NextResponse.json(saved, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const e = toPublicError(error);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
