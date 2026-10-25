"use client";

import * as React from "react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Select } from "@/components/ui/primitives";
import { PageTitle, ReadOnlyNotice } from "@/components/crm/ui";
import { permissionNeeded } from "@/lib/permissions";
import { HoursEditor } from "@/components/crm/scheduling/settings/hours-editor";
import { ExceptionsPanel } from "@/components/crm/scheduling/settings/exceptions-panel";
import type { SchedulingPerson } from "@/components/crm/scheduling/settings/calendar-dialog";
import type { AvailabilityOverrideView, HostAvailability } from "@/server/calendars/setup";
import type { CrmScope } from "@/server/crm/page";

/**
 * Working hours and exceptions. Everyone can set their own; people with calendar management can set anyone's and add workspace
 * holidays. Others' hours are shown read-only to everyone else, so a team can see when colleagues can be booked.
 */
export function AvailabilityManager({ scope, hosts, people, overrides, orgTimezone, timeZones, today, initialPerson }: {
  scope: CrmScope; hosts: HostAvailability[]; people: SchedulingPerson[]; overrides: AvailabilityOverrideView[]; orgTimezone: string; timeZones: string[]; today: string; initialPerson: string | null;
}) {
  const canManageOthers = !!scope.can["calendars.manage"] && !scope.readOnly;
  // Managers can set hours for anyone in the workspace, including people with none yet.
  const all = React.useMemo(() => {
    const list = [...hosts];
    if (canManageOthers) {
      for (const p of people) if (!list.some((h) => h.userId === p.id)) list.push({ userId: p.id, name: p.name, timezone: orgTimezone, accepting: true, rules: [], configured: false });
    }
    const me = list.filter((h) => h.userId === scope.userId);
    return [...me, ...list.filter((h) => h.userId !== scope.userId).sort((a, b) => a.name.localeCompare(b.name))];
  }, [hosts, people, canManageOthers, orgTimezone, scope.userId]);
  const [person, setPerson] = React.useState<string | null>(() => (initialPerson && all.some((h) => h.userId === initialPerson) ? initialPerson : all[0]?.userId ?? null));
  const host = all.find((h) => h.userId === person) ?? all[0];
  const isMe = !!host && host.userId === scope.userId;
  const editable = !!host && !scope.readOnly && (isMe || canManageOthers);
  const label = (h: HostAvailability) => `${h.name}${h.userId === scope.userId ? " (you)" : ""}${!h.rules.length ? " · no hours yet" : !h.accepting ? " · paused" : ""}`;

  return (
    <div className="space-y-5">
      <PageTitle title="Availability" description="Working hours decide which times booking pages, your team and your AI Appointment Setter can offer. Each person's hours are in their own time zone." />
      {scope.readOnly && <ReadOnlyNotice />}

      <Card>
        <CardHeader className="flex-wrap">
          <div className="min-w-0">
            <CardTitle>Weekly hours</CardTitle>
            <CardDescription>{canManageOthers ? "Set anyone's regular hours." : `Set your own regular hours. ${permissionNeeded("Changing anyone else's", "calendars.manage")}`}</CardDescription>
          </div>
          {all.length > 1 && (
            <div className="w-full sm:w-72">
              <label htmlFor="avail-person" className="sr-only">Whose hours</label>
              <Select id="avail-person" value={host?.userId ?? ""} onChange={(e) => setPerson(e.target.value)}>
                {all.map((h) => <option key={h.userId} value={h.userId}>{label(h)}</option>)}
              </Select>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {host ? (
            <>
              {all.length === 1 && <p className="mb-3 flex items-center gap-2 text-[14px] font-medium text-ink">{host.name}{isMe && <Badge tone="neutral">You</Badge>}</p>}
              {!editable && !scope.readOnly && <p className="mb-3 text-[13px] text-muted">{permissionNeeded(`Changing ${host.name}'s hours`, "calendars.manage")}</p>}
              {/* Keyed by what was saved, so a save or a switch to another person starts from the stored hours. */}
              <HoursEditor key={`${host.userId}:${host.timezone}:${host.accepting}:${host.rules.map((r) => `${r.weekday}.${r.startMinute}.${r.endMinute}`).join(",")}`}
                scope={scope} host={host} editable={editable} timeZones={timeZones} isMe={isMe} />
            </>
          ) : (
            <p className="text-[14px] text-muted">Nobody hosts appointments yet. Add hosts to a calendar first.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Days off and exceptions</CardTitle>
            <CardDescription>A day that differs from the weekly hours. Dates follow each person&apos;s own time zone.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <ExceptionsPanel scope={scope} hosts={all} overrides={overrides} today={today} canManageOthers={canManageOthers} />
        </CardContent>
      </Card>
    </div>
  );
}
