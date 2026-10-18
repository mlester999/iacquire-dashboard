import { NextResponse } from "next/server";
import { toPublicError } from "@/server/errors";
import { consumeRateLimit } from "@/server/security/rate-limit";
import { resolveCrmActor } from "@/server/crm/request";
import { downloadSwitchBackup } from "@/server/crm/provider-switch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Downloads the backup a CRM provider switch took before it changed anything (the offboarding export archive). The workspace comes from the
 * verified session; only the workspace owner may download it (an agency support session never includes export rights). Each download is
 * audited, and the response is not cacheable.
 */
export async function GET(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get("switch") ?? "";
    if (!UUID.test(id)) return NextResponse.json({ error: "That provider switch isn't valid." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    const actor = await resolveCrmActor(null, "crm.provider.manage");
    const limit = await consumeRateLimit({ name: "crm-switch-backup", limit: 3, windowSeconds: 600 }, actor.userId ?? actor.orgId);
    if (!limit.allowed) return NextResponse.json({ error: "You've just downloaded this backup. Please wait a few minutes before asking again." }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds ?? 600) } });
    const out = await downloadSwitchBackup(actor, id);
    return new Response(new Uint8Array(out.bytes), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${out.filename.replace(/[^A-Za-z0-9._-]+/g, "_")}"`,
        "Content-Length": String(out.bytes.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Content-SHA256": out.sha256,
      },
    });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status, headers: { "Cache-Control": "no-store" } });
  }
}
