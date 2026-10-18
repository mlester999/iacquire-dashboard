import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { allowPageView, bookingFormToken, resolvePublicBookingPage } from "@/server/calendars/public-booking";
import { BookingShell, BusyNotice } from "../../../_components/shell";
import { BookingFlow } from "../../../_components/booking-flow";
import { requestTime, visitorIp } from "../../../_components/visitor";

export const dynamic = "force-dynamic";

type Params = Promise<{ org: string; calendar: string; type: string }>;

const load = cache((org: string, calendar: string, type: string) => resolvePublicBookingPage(org, calendar, type));

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { org, calendar, type } = await params;
  const page = await load(org, calendar, type);
  return { title: page?.type ? `${page.type.name} · ${page.business.name}` : "Page not available" };
}

/** One appointment type's booking page: pick a time in your own time zone, add your details, confirm. */
export default async function TypeBookingPage({ params }: { params: Params }) {
  if (!(await allowPageView(await visitorIp()))) return <BusyNotice />;
  const { org, calendar, type } = await params;
  const page = await load(org, calendar, type);
  if (!page?.type) notFound();
  const slugs = { org: page.business.slug, calendar: page.calendar.slug, type: page.type.slug };
  return (
    <BookingShell business={page.business} subtitle={page.calendar.name}>
      {page.calendar.intro && <p className="mb-5 max-w-3xl whitespace-pre-line text-[14px] leading-relaxed text-muted">{page.calendar.intro}</p>}
      <BookingFlow
        business={page.business}
        calendar={{ name: page.calendar.name }}
        type={page.type}
        slugs={slugs}
        formToken={bookingFormToken(slugs.org, slugs.calendar, slugs.type)}
        typeCount={page.types.length}
        renderedAt={requestTime()}
      />
    </BookingShell>
  );
}
