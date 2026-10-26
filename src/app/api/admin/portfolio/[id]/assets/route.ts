import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/server/auth/session";
import { readBoundedFormData } from "@/server/security/bounded-body";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { uploadPortfolioAsset } from "@/server/portfolio/service";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";
const MAX = 10 * 1024 * 1024;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertSameOrigin();
    const user = await requireAgencyOrThrow("super_admin");
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    const form = await readBoundedFormData(req, MAX + 65536);
    if (!form) return NextResponse.json({ error: "Images can be up to 10 MB." }, { status: 413 });
    const file = form.get("file");
    if (!(file instanceof File) || file.size > MAX) return NextResponse.json({ error: "Choose a PNG, JPEG or WebP image up to 10 MB." }, { status: 400 });
    const alt = String(form.get("alt") ?? "").trim();
    if (alt.length < 3) return NextResponse.json({ error: "Describe the image for accessibility (alt text)." }, { status: 400 });
    const saved = await uploadPortfolioAsset(user, id, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }, {
      alt,
      caption: typeof form.get("caption") === "string" && String(form.get("caption")).trim() ? String(form.get("caption")).trim() : null,
      kind: form.get("kind") === "cover" ? "cover" : "screenshot",
    });
    return NextResponse.json(saved, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const e = toPublicError(error);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
