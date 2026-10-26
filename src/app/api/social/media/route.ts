import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/server/auth/session";
import { readBoundedFormData } from "@/server/security/bounded-body";
import { toPublicError } from "@/server/errors";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { uploadMedia } from "@/server/social/media";
import { MEDIA_MAX_BYTES } from "@/lib/social/rules";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
export const runtime = "nodejs";

/** Adds a picture or video to the signed-in workspace's library. A route rather than a server action because files exceed an action's body limit. */
export async function POST(request: Request) {
  try {
    await assertSameOrigin();
    // uploadMedia checks the workspace kind and the person's permission itself, in that order, each with its own plain message.
    const ctx = await requireOrgContextOrThrow();
    // Read with a ceiling as it arrives; the declared length is a fast path, not the limit.
    const form = await readBoundedFormData(request, MEDIA_MAX_BYTES + 1_000_000);
    if (!form) return NextResponse.json({ error: "Choose a file up to 50 MB." }, { status: 413 });
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Choose a file to add." }, { status: 400 });
    if (file.size > MEDIA_MAX_BYTES) return NextResponse.json({ error: "Choose a file up to 50 MB." }, { status: 413 });
    const alt = String(form.get("altText") ?? "").trim() || null;
    const media = await uploadMedia(ctx, { filename: file.name, contentType: file.type, bytes: Buffer.from(await file.arrayBuffer()), altText: alt });
    return NextResponse.json({ media }, { status: 201 });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.code === "unauthenticated" ? 401 : e.code === "forbidden" ? 403 : 400 });
  }
}
