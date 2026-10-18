import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/server/auth/session";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { uploadKnowledgeDocument } from "@/server/knowledge/service";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX = 10 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    await assertSameOrigin();
    const ctx = await requireOrgContextOrThrow("knowledge.edit");
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX + 64 * 1024) return NextResponse.json({ error: "Files can be up to 10 MB." }, { status: 413 });
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Choose a file to upload." }, { status: 400 });
    if (file.size > MAX) return NextResponse.json({ error: "Files can be up to 10 MB." }, { status: 413 });
    const rawAgentId = form.get("agentId");
    const agentId = typeof rawAgentId === "string" && /^[0-9a-f-]{36}$/i.test(rawAgentId) ? rawAgentId : null;
    const bytes = Buffer.from(await file.arrayBuffer());
    const res = await uploadKnowledgeDocument(ctx, { name: file.name, bytes }, { agentInstanceId: agentId });
    return NextResponse.json(res);
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
