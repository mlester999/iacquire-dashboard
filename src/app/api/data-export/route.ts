import { NextResponse } from "next/server";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { toPublicError } from "@/server/errors";
import { consumeRateLimit } from "@/server/security/rate-limit";
import { buildExport } from "@/server/offboarding/export";
import { recordExport } from "@/server/offboarding/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Downloads everything the signed-in workspace owner owns, as a ZIP. The workspace comes from the verified session (never from the request),
 * only the owner can ask, and each download is recorded in the audit trail and against any closing request. The archive is built on demand and
 * never stored, and the response is not cacheable.
 */
export async function GET() {
  try {
    const ctx = await requireOrgContextOrThrow("data.export");
    const limit = await consumeRateLimit({ name: "data-export", limit: 3, windowSeconds: 600 }, ctx.user.id);
    if (!limit.allowed) return NextResponse.json({ error: "You've just downloaded your data. Please wait a few minutes before asking again." }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds ?? 600) } });
    const out = await buildExport(ctx.org.orgId);
    await recordExport(ctx.org.orgId, ctx.user.id);
    return new Response(new Uint8Array(out.bytes), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${out.filename}"`,
        "Content-Length": String(out.bytes.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status, headers: { "Cache-Control": "no-store" } });
  }
}
