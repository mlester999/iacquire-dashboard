import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/server/auth/session";
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
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX + 64 * 1024) return NextResponse.json({ error: "Images can be up to 10 MB." }, { status: 413 });
    const form = await req.formData();
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
