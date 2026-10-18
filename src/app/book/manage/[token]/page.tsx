import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { allowPageView, loadManagePage, manageFormToken } from "@/server/calendars/public-booking";
import { BookingShell, BusyNotice } from "../../_components/shell";
import { ManagePanel } from "../../_components/manage-panel";
import { requestTime, visitorIp } from "../../_components/visitor";

export const dynamic = "force-dynamic";

// The URL is the customer's secret: the proxy also marks it no-store, noindex and no-referrer.
export const metadata: Metadata = { title: "Your booking", robots: { index: false, follow: false }, referrer: "no-referrer" };

/** The customer's own page for one booking: see it, add it to a calendar, and reschedule or cancel it when the business allows. */
export default async function ManageBookingPage({ params }: { params: Promise<{ token: string }> }) {
  if (!(await allowPageView(await visitorIp()))) return <BusyNotice />;
  const { token } = await params;
  const view = await loadManagePage(token);
  if (!view) notFound();
  return (
    <BookingShell business={view.business}>
      <ManagePanel view={JSON.parse(JSON.stringify(view))} token={token} formToken={manageFormToken(token)} renderedAt={requestTime()} />
    </BookingShell>
  );
}
