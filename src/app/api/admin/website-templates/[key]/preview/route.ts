import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/server/auth/session";
import { readBoundedFormData } from "@/server/security/bounded-body";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { toPublicError } from "@/server/errors";
import { setTemplatePreviewImage } from "@/server/websites/templates";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX = 6 * 1024 * 1024;
const KEY = /^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;

/** The agency uploads a card picture for a template. It is re-encoded on the server, so only a real image is ever stored. */
export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    await assertSameOrigin();
    const user = await requireAgencyOrThrow();
    const { key } = await params;
    if (!KEY.test(key)) return NextResponse.json({ error: "Template not found." }, { status: 404 });
    const form = await readBoundedFormData(req, MAX + 64 * 1024);
    if (!form) return NextResponse.json({ error: "Images can be up to 6 MB." }, { status: 413 });
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Choose an image to upload." }, { status: 400 });
    if (file.size > MAX) return NextResponse.json({ error: "Images can be up to 6 MB." }, { status: 413 });
    await setTemplatePreviewImage(user, key, Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ ok: true });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
