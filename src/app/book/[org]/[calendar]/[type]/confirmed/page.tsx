import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarClock, CalendarPlus, CircleCheck, Hourglass, Info } from "lucide-react";
import { env } from "@/server/env";
import { allowPageView, loadManagePage } from "@/server/calendars/public-booking";
import { absoluteUrl, manageUrl } from "@/lib/calendars/urls";
import { Card } from "@/components/ui/primitives";
import { BookingShell, BusyNotice } from "../../../../_components/shell";
import { AppointmentDetails, secondaryLinkClass, StatusBadge } from "../../../../_components/details";
import { CopyLink } from "../../../../_components/copy-link";
import { visitorIp } from "../../../../_components/visitor";

export const dynamic = "force-dynamic";

// The URL carries the customer's manage secret: the proxy marks it no-store, noindex and no-referrer as well.
export const metadata: Metadata = { title: "Booking confirmed", robots: { index: false, follow: false }, referrer: "no-referrer" };

type Params = Promise<{ org: string; calendar: string; type: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

/** What the customer sees right after booking: the time in their zone, where, what happens next, and their own link to change it. */
export default async function BookingConfirmedPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  if (!(await allowPageView(await visitorIp()))) return <BusyNotice />;
  const { org, calendar, type } = await params;
  const sp = await searchParams;
  const token = typeof sp.booking === "string" ? sp.booking : null;
  if (!token) notFound();
  const view = await loadManagePage(token);
  // The link must belong to this very page, so a valid secret can't be dressed up under another business's address.
  if (!view || view.slugs.org !== org.toLowerCase() || view.slugs.calendar !== calendar.toLowerCase() || view.slugs.type !== type.toLowerCase()) notFound();
  const a = view.appointment;
  const pending = a.status === "new";
  const cancelled = a.status === "cancelled";
  const link = absoluteUrl(manageUrl(token), env().APP_URL);

  return (
    <BookingShell business={view.business}>
      <div className="mx-auto max-w-2xl space-y-5">
        <div className="text-center">
          <div className={`mx-auto flex size-14 items-center justify-center rounded-full ${cancelled ? "bg-surface-2 text-muted" : pending ? "bg-warning-soft text-warning-ink" : "bg-success-soft text-success-ink"}`}>
            {pending ? <Hourglass className="size-6" aria-hidden /> : <CircleCheck className="size-7" aria-hidden />}
          </div>
          <h1 className="mt-4 text-[26px] font-semibold tracking-[-0.035em] text-ink">
            {cancelled ? "This booking is cancelled" : pending ? "Booking requested" : "You're booked"}
          </h1>
          <p className="mx-auto mt-2 max-w-md text-[14.5px] leading-relaxed text-muted">
            {cancelled
              ? "It no longer holds a time."
              : pending
                ? `${view.business.name} confirms each booking. Your time is held while they review it.`
                : `Your appointment with ${view.business.name} is confirmed.`}
          </p>
        </div>

        <Card className="p-5 sm:p-6">
          <div className="mb-1 flex justify-end"><StatusBadge status={a.status} /></div>
          <AppointmentDetails view={view} />
          {view.confirmationMessage && !cancelled && (
            <figure className="mt-5 rounded-xl border border-line bg-surface-2 px-4 py-3">
              <figcaption className="text-[12px] font-medium text-muted">A note from {view.business.name}</figcaption>
              <blockquote className="mt-1 whitespace-pre-line text-[14px] leading-relaxed text-ink">{view.confirmationMessage}</blockquote>
            </figure>
          )}
          {!cancelled && (
            <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-5">
              <a href={view.icsUrl} download="appointment.ics" className={secondaryLinkClass}><CalendarPlus className="size-4" aria-hidden />Add to calendar</a>
              {view.allowCustomerChanges && (
                <Link href={manageUrl(token)} prefetch={false} className={secondaryLinkClass}><CalendarClock className="size-4" aria-hidden />Reschedule or cancel</Link>
              )}
            </div>
          )}
        </Card>

        <Card className="p-5 sm:p-6">
          <CopyLink id="manage-link" value={link} label="Your booking link" />
          <p className="mt-3 flex items-start gap-2 text-[12.5px] leading-relaxed text-muted">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              Save this link: it&apos;s how you see this booking{view.allowCustomerChanges ? " and reschedule or cancel it" : ""} later. Anyone with the link can do the same, so keep it to yourself.
              {!view.allowCustomerChanges && ` To change this booking, contact ${view.business.name} directly.`}
            </span>
          </p>
        </Card>
      </div>
    </BookingShell>
  );
}
