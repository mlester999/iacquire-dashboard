import { notFound } from "next/navigation";
import { env } from "@/server/env";
import { getWorkspace } from "@/server/crm/workspace";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { hostMeetingSupport, listBookingPages, listCalendars, listSchedulingPeople } from "@/server/calendars/setup";
import { verifyCalendar } from "@/server/calendars/activation";
import { GhlOwnedNotice } from "@/components/crm/ghl-owned";
import { CalendarsManager } from "@/components/crm/scheduling/settings/calendars-manager";
import { CalendarDetail } from "@/components/crm/scheduling/settings/calendar-detail";

type SP = Record<string, string | string[] | undefined>;

/** Calendars & types: every calendar with its hosts, assignment, types and booking page status. */
export async function CalendarsSettingsView({ actor, scope }: { actor: CrmActor; scope: CrmScope; searchParams?: SP; id?: string }) {
  const ws = await getWorkspace(actor);
  if (ws.capabilities.calendars === "ghl") return <GhlOwnedNotice what="Calendars" agency={scope.agency} href="/appointments" />;
  const [calendars, booking, people] = await Promise.all([listCalendars(actor), listBookingPages(actor), listSchedulingPeople(actor)]);
  await auditSupportView(actor, "calendars");
  return <CalendarsManager scope={scope} calendars={JSON.parse(JSON.stringify(calendars))} pages={JSON.parse(JSON.stringify(booking.pages))} people={people} />;
}

/** One calendar and its appointment types editor. */
export async function CalendarDetailView({ actor, scope, id }: { actor: CrmActor; scope: CrmScope; searchParams?: SP; id?: string }) {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ws = await getWorkspace(actor);
  if (ws.capabilities.calendars === "ghl") return <GhlOwnedNotice what="Calendars" agency={scope.agency} href="/appointments" />;
  const [calendars, booking, people, meeting] = await Promise.all([
    listCalendars(actor),
    listBookingPages(actor),
    listSchedulingPeople(actor),
    // Other people's calendar connections are only visible to calendar managers, who are also the only ones editing types.
    actor.can("calendars.manage") ? hostMeetingSupport(actor) : Promise.resolve(null),
  ]);
  const calendar = calendars.find((c) => c.id === id);
  if (!calendar) notFound();
  // A draft shows its activation checks straight away, for the people who can act on them.
  const verification = calendar.status === "draft" && actor.can("calendars.manage") ? await verifyCalendar(actor, id) : null;
  await auditSupportView(actor, "calendar", id);
  return (
    <CalendarDetail
      scope={scope}
      calendar={JSON.parse(JSON.stringify(calendar))}
      page={booking.pages.find((p) => p.calendarId === id) ?? null}
      people={people}
      orgSlug={booking.orgSlug}
      appUrl={env().APP_URL}
      meeting={meeting}
      verification={verification ? JSON.parse(JSON.stringify(verification)) : null}
    />
  );
}
