import { getWorkspace } from "@/server/crm/workspace";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { listHostAvailability, listSchedulingPeople } from "@/server/calendars/setup";
import { isValidTimeZone, zonedDate } from "@/lib/calendars/slots";
import { GhlOwnedNotice } from "@/components/crm/ghl-owned";
import { AvailabilityManager } from "@/components/crm/scheduling/settings/availability-manager";

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** IANA zones this server can compute with, so whatever is chosen is also accepted when saved. */
function timeZoneList(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
  const zones = typeof intl.supportedValuesOf === "function" ? intl.supportedValuesOf("timeZone") : [];
  return [...new Set(["UTC", ...zones])].filter(isValidTimeZone).sort((a, b) => (a === "UTC" ? -1 : b === "UTC" ? 1 : a.localeCompare(b)));
}

/** Today's date where the workspace is, so a past date can't be chosen for an exception. */
const todayIn = (timeZone: string) => zonedDate(Date.now(), timeZone);

/** Availability: weekly hours per person in their own time zone, days off, and workspace holidays. */
export async function AvailabilityView({ actor, scope, searchParams }: { actor: CrmActor; scope: CrmScope; searchParams?: SP; id?: string }) {
  const ws = await getWorkspace(actor);
  if (ws.capabilities.calendars === "ghl") return <GhlOwnedNotice what="Calendars" agency={scope.agency} href="/appointments" />;
  const [avail, people] = await Promise.all([listHostAvailability(actor), actor.can("calendars.manage") ? listSchedulingPeople(actor) : Promise.resolve([])]);
  const person = one(searchParams?.person);
  await auditSupportView(actor, "availability");
  return (
    <AvailabilityManager
      scope={scope}
      hosts={JSON.parse(JSON.stringify(avail.hosts))}
      overrides={JSON.parse(JSON.stringify(avail.overrides))}
      people={people}
      orgTimezone={avail.orgTimezone}
      timeZones={timeZoneList()}
      today={todayIn(avail.orgTimezone)}
      initialPerson={person && /^[0-9a-f-]{36}$/i.test(person) ? person : null}
    />
  );
}
