"use server";

import { guard } from "@/server/action-guard";
import { AppError } from "@/server/errors";
import { studioContext } from "@/server/websites/studio-ctx";
import { bookingOptionsFor } from "@/server/websites/booking-setup";

/**
 * The workspace's calendars and appointment types for the Website Studio's booking element: the pickers, and the canvas drawing exactly
 * what visitors will see. The workspace is decided by the server (the user's own, or a client the agency user may edit), never the browser.
 */
export async function listBookingOptionsAction(orgId?: string) {
  return guard(async () => {
    if (orgId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(orgId))) throw new AppError("invalid_input", "That workspace wasn't found.");
    const ctx = await studioContext(orgId, "website.edit");
    return bookingOptionsFor(ctx.org.orgId, { agency: ctx.user.platformRole !== "none" });
  });
}
