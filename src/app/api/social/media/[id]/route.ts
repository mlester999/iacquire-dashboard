import { toPublicError } from "@/server/errors";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { readMediaForPreview } from "@/server/social/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** A library picture or video for the signed-in person's own preview. Only a file of their workspace, and only if they may see social media. Never cached by a shared cache. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "Not found." }, { status: 404 });
  try {
    const ctx = await requireOrgContextOrThrow(); // readMediaForPreview checks the workspace kind and the permission itself
    const f = await readMediaForPreview(ctx, id);
    return new Response(new Uint8Array(f.bytes), {
      headers: {
        "Content-Type": f.mimeType,
        "Content-Length": String(f.bytes.length),
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
        "Content-Disposition": "inline",
      },
    });
  } catch (err) {
    const e = toPublicError(err);
    return Response.json({ error: e.message }, { status: e.code === "unauthenticated" ? 401 : e.code === "forbidden" ? 403 : e.code === "not_found" ? 404 : 500 });
  }
}
