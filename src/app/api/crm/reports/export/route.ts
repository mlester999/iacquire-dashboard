import { NextResponse } from "next/server";
import { toPublicError } from "@/server/errors";
import { resolveCrmActor } from "@/server/crm/request";
import { exportCrmReport } from "@/server/crm/reports/export";
import { resolveReportRequest } from "@/server/crm/reports/params";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** A byte order mark, so spreadsheet apps read the file as UTF-8. */
const BOM = String.fromCharCode(0xfeff);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Downloads a CRM report as CSV, with the same filters and sections as the address of the reports screen (or a saved report). The workspace
 * comes from the verified session; an agency support session never has the export permission. Needs "Export reports"; each download is
 * rate limited and recorded in the audit log.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const orgParam = url.searchParams.get("org");
    // The export permission is checked by the service, which says which permission is missing.
    const actor = await resolveCrmActor(orgParam && UUID.test(orgParam) ? orgParam : null, "analytics.view");
    const sp: Record<string, string> = {};
    for (const [k, v] of url.searchParams) if (!(k in sp)) sp[k] = v.slice(0, 200);
    const r = await resolveReportRequest(actor, sp);
    const { filename, csv } = await exportCrmReport(actor, { filters: r.filters, sections: r.sections, savedId: r.active?.id ?? null });
    return new Response(`${BOM}${csv}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename.replace(/[^a-z0-9._-]/gi, "-")}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const e = toPublicError(err);
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    if (e.retryAfterSeconds) headers["Retry-After"] = String(e.retryAfterSeconds);
    return NextResponse.json({ error: e.message }, { status: e.status, headers });
  }
}
