import { env } from "@/server/env";
import { getWorkspace } from "@/server/crm/workspace";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { listBookingPages } from "@/server/calendars/setup";
import { GhlOwnedNotice } from "@/components/crm/ghl-owned";
import { BookingPagesManager } from "@/components/crm/scheduling/settings/booking-pages-manager";

type SP = Record<string, string | string[] | undefined>;

/** Booking pages: each calendar's public link, whether it's live, and why not. */
export async function BookingPagesView({ actor, scope }: { actor: CrmActor; scope: CrmScope; searchParams?: SP; id?: string }) {
  const ws = await getWorkspace(actor);
  // Booking pages book native appointments on native calendars, so either one living in GoHighLevel means there's nothing to show here.
  if (ws.capabilities.calendars === "ghl" || ws.capabilities.appointments === "ghl") return <GhlOwnedNotice what="Booking pages" agency={scope.agency} href="/appointments" />;
  const booking = await listBookingPages(actor);
  await auditSupportView(actor, "booking_pages");
  return <BookingPagesManager scope={scope} pages={JSON.parse(JSON.stringify(booking.pages))} orgSlug={booking.orgSlug} appUrl={env().APP_URL} />;
}
