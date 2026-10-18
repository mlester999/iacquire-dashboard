import { withSystem } from "@/server/db";
import { assertCan } from "@/server/crm/actor";
import { ApiError, apiHandler, dateParam, decodeCursor, pageLimit } from "../_lib/http";
import { listAppointmentsPage } from "../_lib/resources";
import { APPOINTMENT_STATUSES } from "../_lib/schemas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/v1/crm/appointments: appointments booked in iAcquire calendars that end after ?from= (default now), soonest first.
 * ?to= ?status=new|confirmed|showed|no_show|cancelled ?contact_id= ?calendar_id= ?limit= ?cursor=
 */
export async function GET(req: Request) {
  return apiHandler(req, ["appointments.read"], async ({ actor }) => {
    assertCan(actor, "appointments.view");
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    if (status && !(APPOINTMENT_STATUSES as readonly string[]).includes(status)) throw new ApiError(400, "invalid_request", `status must be one of ${APPOINTMENT_STATUSES.join(", ")}.`);
    const ids: Record<string, string | null> = {};
    for (const name of ["contact_id", "calendar_id"]) {
      const v = url.searchParams.get(name);
      if (v && !UUID.test(v)) throw new ApiError(400, "invalid_request", `${name} must be an id the API returned.`);
      ids[name] = v || null;
    }
    const from = dateParam(url, "from") ?? new Date();
    const to = dateParam(url, "to");
    if (to && to <= from) throw new ApiError(400, "invalid_request", "to must be after from.");
    const page = await withSystem((db) => listAppointmentsPage(db, actor.orgId, { limit: pageLimit(url), cursor: decodeCursor(url), from, to, status, contactId: ids.contact_id, calendarId: ids.calendar_id }));
    return { body: page };
  });
}
