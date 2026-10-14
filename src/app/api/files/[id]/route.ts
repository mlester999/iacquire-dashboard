import { NextResponse } from "next/server";
import { requireUserOrThrow } from "@/server/auth/session";
import { withUser } from "@/server/db";
import { readPrivateFile, type PrivateBucket } from "@/server/storage/private";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUserOrThrow();
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "File not found." }, { status: 404 });
    const file = await withUser(user.id, async (db) => (await db.query<{ org_id: string; bucket: PrivateBucket; storage_key: string }>(
      "select org_id,bucket,storage_key from private_files where id=$1", [id],
    )).rows[0]);
    if (!file) return NextResponse.json({ error: "File not found." }, { status: 404 });
    const data = await readPrivateFile({ userId: user.id, orgId: file.org_id, bucket: file.bucket, path: file.storage_key });
    return new NextResponse(new Uint8Array(data.bytes), { headers: {
      "Content-Type": data.mime_type, "Content-Disposition": `attachment; filename="${data.filename.replace(/["\\\r\n]/g, "_")}"`,
      "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'; sandbox",
    } });
  } catch (error) {
    const e = toPublicError(error);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
