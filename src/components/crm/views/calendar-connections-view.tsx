import { cookies } from "next/headers";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { getWorkspace } from "@/server/crm/workspace";
import {
  CALENDAR_NOTICE_COOKIE, calendarConnectionSettings, decodeCalendarNotice, listMyConnections, listSyncRuns, listTeamConnections,
} from "@/server/calendars/connections";
import { GhlOwnedNotice } from "@/components/crm/ghl-owned";
import { CalendarConnectionsWorkspace } from "@/components/crm/scheduling/connections/calendar-connections";

type SP = Record<string, string | string[] | undefined>;

/**
 * Calendar connections: the person's own connected calendars (and what they count for), ways to connect more, sync history, and for
 * managers a read-only view of who on the team has connected what. In an agency support session there is no "own" calendar: only the
 * team list, with no way to connect anyone's.
 */
export async function CalendarConnectionsView({ actor, scope }: { actor: CrmActor; scope: CrmScope; searchParams?: SP; id?: string }) {
  const ws = await getWorkspace(actor);
  if (ws.capabilities.calendars === "ghl") return <GhlOwnedNotice what="Calendars" agency={scope.agency} href="/appointments" />;
  const manager = actor.can("calendars.manage");
  const [mine, team, runs] = await Promise.all([
    listMyConnections(actor),
    manager ? listTeamConnections(actor) : Promise.resolve([]),
    listSyncRuns(actor, { limit: 20 }),
  ]);
  // A one-time message from the sign-in round trip (set by the OAuth routes; client workspace only).
  const notice = scope.agency ? null : decodeCalendarNotice((await cookies()).get(CALENDAR_NOTICE_COOKIE)?.value);
  await auditSupportView(actor, "calendar-connections");
  return (
    <CalendarConnectionsWorkspace
      scope={scope}
      settings={calendarConnectionSettings()}
      mine={JSON.parse(JSON.stringify(mine))}
      team={JSON.parse(JSON.stringify(team.filter((c) => c.userId !== actor.userId)))}
      runs={JSON.parse(JSON.stringify(runs))}
      canConnect={actor.kind === "member" && actor.can("calendars.connect")}
      notice={notice}
      renderedAt={new Date().toISOString()}
    />
  );
}
