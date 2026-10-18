import { CalendarX } from "lucide-react";
import { BookingShell } from "./_components/shell";

/**
 * Every miss under /book looks the same: an unknown business, a private, archived or paused calendar, a hidden type, or a link that
 * isn't valid any more. Nothing here says which, so the page can't be used to discover what exists.
 */
export default function BookingNotFound() {
  return (
    <BookingShell business={null}>
      <div className="mx-auto mt-10 max-w-md text-center sm:mt-16">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-line bg-surface text-primary shadow-card">
          <CalendarX className="size-5" aria-hidden />
        </div>
        <h1 className="mt-5 text-[22px] font-semibold tracking-[-0.03em] text-ink">This page isn&apos;t available</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-muted">
          The link may be mistyped or out of date, or the business may not be taking bookings here right now. Check the link with the business that shared it.
        </p>
      </div>
    </BookingShell>
  );
}
