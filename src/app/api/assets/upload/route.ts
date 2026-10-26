import { NextResponse } from "next/server";
import { assertSameOrigin, requireUserOrThrow } from "@/server/auth/session";
import { readBoundedFormData } from "@/server/security/bounded-body";
import { studioContext } from "@/server/websites/studio-ctx";
import { createAsset, type AssetKind } from "@/server/assets/service";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX = 10 * 1024 * 1024;
const KINDS: AssetKind[] = ["logo", "image", "reference"];

export async function POST(req: Request) {
  try {
    await assertSameOrigin();
    // Who is asking, before any of the body is read: the workspace is still resolved from the form below (a person may work in more than one), but an anonymous
    // request must not be able to make the server hold a body at all. The body is then read with a ceiling, because a Content-Length header can be left out.
    await requireUserOrThrow();
    const form = await readBoundedFormData(req, MAX + 64 * 1024);
    if (!form) return NextResponse.json({ error: "Images can be up to 10 MB." }, { status: 413 });
    const ctx = await studioContext(String(form.get("org") ?? "") || null, "workspace.manage_profile");
    const file = form.get("file");
    const kind = String(form.get("kind") ?? "");
    if (!(file instanceof File)) return NextResponse.json({ error: "Choose an image to upload." }, { status: 400 });
    if (!KINDS.includes(kind as AssetKind)) return NextResponse.json({ error: "Unknown image type." }, { status: 400 });
    if (file.size > MAX) return NextResponse.json({ error: "Images can be up to 10 MB." }, { status: 413 });
    const asset = await createAsset(ctx, { kind: kind as AssetKind, bytes: Buffer.from(await file.arrayBuffer()), filename: file.name, altText: String(form.get("alt") ?? "") });
    return NextResponse.json({ asset });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
