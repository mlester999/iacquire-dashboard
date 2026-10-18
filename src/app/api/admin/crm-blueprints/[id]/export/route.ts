import { NextResponse } from "next/server";
import { toPublicError } from "@/server/errors";
import { consumeRateLimit, type RateLimitRule } from "@/server/security/rate-limit";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { exportPackage } from "@/server/crm/blueprints/library";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Exports per agency person. A package is at most 1 MB, so this is generous for real work and cheap to enforce. */
const EXPORT_LIMIT: RateLimitRule = { name: "crm-blueprint:export", limit: 30, windowSeconds: 600 };

const noStore = { "Cache-Control": "private, no-store" };
const error = (message: string, status: number, headers: Record<string, string> = {}) => NextResponse.json({ error: message }, { status, headers: { ...noStore, ...headers } });

/**
 * Downloads one published version of a Blueprint as an iAcquire package file: the content, its manifest and its sha256 integrity digest.
 * Agency only (the service checks the export permission for the signed-in person); a package never contains contacts, credentials, people
 * or GoHighLevel IDs. `?version=<n>` names the published version (drafts are never exported).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAgencyOrThrow();
    const { id } = await params;
    if (!UUID.test(id)) return error("Blueprint not found.", 404);
    const raw = new URL(req.url).searchParams.get("version") ?? "";
    if (!/^[1-9][0-9]{0,5}$/.test(raw)) return error("Choose a published version to export.", 400);
    const version = Number(raw);
    const limit = await consumeRateLimit(EXPORT_LIMIT, user.id);
    if (!limit.allowed) {
      return error("Too many exports in a short time. Please wait a few minutes.", 429, { "Retry-After": String(limit.retryAfterSeconds || EXPORT_LIMIT.windowSeconds) });
    }
    const pkg = await exportPackage(user, id, version);
    // Only a plain, safe file name ever reaches the header.
    const filename = /^[A-Za-z0-9._-]{1,120}\.json$/.test(pkg.filename) ? pkg.filename : `crm-blueprint-${id.slice(0, 8)}.json`;
    return new Response(pkg.json, {
      headers: {
        ...noStore,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const e = toPublicError(err);
    return error(e.message, e.status);
  }
}
