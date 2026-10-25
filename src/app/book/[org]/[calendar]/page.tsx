import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronRight, Clock, Hourglass, Users } from "lucide-react";
import { allowPageView, resolvePublicBookingPage } from "@/server/calendars/public-booking";
import { bookingUrl } from "@/lib/calendars/urls";
import { BookingShell, BusyNotice } from "../../_components/shell";
import { LocationIcon } from "../../_components/details";
import { durationLabel } from "../../_components/time";
import { visitorIp } from "../../_components/visitor";

export const dynamic = "force-dynamic";

type Params = Promise<{ org: string; calendar: string }>;

const load = cache((org: string, calendar: string) => resolvePublicBookingPage(org, calendar));

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { org, calendar } = await params;
  const page = await load(org, calendar);
  return { title: page ? `Book with ${page.business.name}` : "Page not available" };
}

/** A calendar's booking page: the business, the calendar's intro, and each public appointment type to choose from. */
export default async function CalendarBookingPage({ params }: { params: Params }) {
  if (!(await allowPageView(await visitorIp()))) return <BusyNotice />;
  const { org, calendar } = await params;
  const page = await load(org, calendar);
  if (!page) notFound();
  // With only one thing to book there is nothing to choose.
  if (page.types.length === 1) redirect(bookingUrl(page.business.slug, page.calendar.slug, page.types[0].slug));

  return (
    <BookingShell business={page.business} subtitle={page.calendar.name}>
      <div className="mx-auto max-w-3xl">
        <h1 className="text-[26px] font-semibold tracking-[-0.035em] text-ink sm:text-[30px]">Book with {page.business.name}</h1>
        {(page.calendar.intro || page.calendar.description) && (
          <p className="mt-2 max-w-2xl whitespace-pre-line text-[14.5px] leading-relaxed text-muted">{page.calendar.intro ?? page.calendar.description}</p>
        )}
        <h2 className="mt-8 text-[14px] font-semibold uppercase tracking-wide text-muted">Choose an appointment</h2>
        <ul className="mt-3 grid gap-3">
          {page.types.map((t) => (
            <li key={t.slug}>
              <Link
                href={bookingUrl(page.business.slug, page.calendar.slug, t.slug)}
                className="card-surface group flex items-center gap-4 rounded-2xl p-5 outline-none transition-[box-shadow,transform] hover:-translate-y-px hover:shadow-card focus-visible:ring-2 focus-visible:ring-primary"
              >
                <span aria-hidden className="h-12 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: t.color && /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : page.calendar.color ?? "var(--primary)" }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[16px] font-semibold tracking-[-0.02em] text-ink">{t.name}</span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[14px] text-muted">
                    <span className="inline-flex items-center gap-1.5"><Clock className="size-3.5" aria-hidden />{durationLabel(t.durationMinutes)}</span>
                    {t.locationLabel && <span className="inline-flex items-center gap-1.5"><LocationIcon kind={t.locationKind} className="size-3.5" />{t.locationLabel}</span>}
                    {t.capacity > 1 && <span className="inline-flex items-center gap-1.5"><Users className="size-3.5" aria-hidden />Group, up to {t.capacity}</span>}
                    {t.requiresConfirmation && <span className="inline-flex items-center gap-1.5"><Hourglass className="size-3.5" aria-hidden />Confirmed by {page.business.name}</span>}
                  </span>
                  {t.description && <span className="mt-2 line-clamp-2 block text-[14px] leading-relaxed text-ink-2">{t.description}</span>}
                </span>
                <ChevronRight className="size-5 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </BookingShell>
  );
}
