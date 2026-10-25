"use client";

import * as React from "react";
import Link from "next/link";
import { CalendarDays, MoreHorizontal, Plus, Star } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { archiveCalendarAction, updateCalendarAction } from "@/app/actions/crm-calendar-settings";
import { Avatar, ConfirmDialog, PageTitle, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { permissionNeeded } from "@/lib/permissions";
import { CalendarDialog, type SchedulingPerson } from "@/components/crm/scheduling/settings/calendar-dialog";
import { ASSIGNMENT_INFO, BookingStatusBadge, ColorDot, DraftBadge, ROUND_ROBIN_INFO, blockerText } from "@/components/crm/scheduling/settings/shared";
import type { BookingPageView, CalendarView } from "@/server/calendars/setup";
import type { CrmScope } from "@/server/crm/page";

/** Every calendar as a card: its hosts, how bookings are shared, how many types, and whether its booking page is live. */
export function CalendarsManager({ scope, calendars, pages, people }: { scope: CrmScope; calendars: CalendarView[]; pages: BookingPageView[]; people: SchedulingPerson[] }) {
  const { run, busy } = useCrmAction();
  const canManage = !!scope.can["calendars.manage"] && !scope.readOnly;
  // The target stays set while a dialog closes, so its title doesn't change mid-animation.
  const [editing, setEditing] = React.useState<CalendarView | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [archiving, setArchiving] = React.useState<CalendarView | null>(null);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const edit = (c: CalendarView) => {
    setEditing(c);
    setEditOpen(true);
  };
  const pageFor = (id: string) => pages.find((p) => p.calendarId === id);

  return (
    <div>
      <PageTitle
        title="Calendars & types"
        description="Each calendar has its hosts and the appointment types customers can book with them. People's working hours are set in Availability."
        actions={canManage ? <Button onClick={() => setCreating(true)}><Plus className="size-4" />New calendar</Button> : undefined}
      />
      {!canManage && <div className="mb-4"><ReadOnlyNotice>{scope.readOnly ? undefined : permissionNeeded("Changing calendars and appointment types", "calendars.manage")}</ReadOnlyNotice></div>}

      {!calendars.length ? (
        <Card>
          <EmptyState
            icon={<CalendarDays className="size-5" />}
            title="No calendars yet"
            description="Create a calendar for each kind of work you book, such as consultations or site visits, then add the appointment types customers can choose."
            action={canManage ? <Button onClick={() => setCreating(true)}><Plus className="size-4" />New calendar</Button> : undefined}
          />
        </Card>
      ) : (
        <ul className="grid w-full min-w-0 gap-4 md:grid-cols-2 2xl:grid-cols-3" aria-label="Calendars">
          {calendars.map((c) => {
            const page = pageFor(c.id);
            const active = c.members.filter((m) => m.active);
            const firstProblem = page && !page.live && page.public ? page.blockers.find((b) => b.code !== "calendar_private") : undefined;
            return (
              <li key={c.id} className="min-w-0">
                <Card className="flex h-full min-w-0 w-full flex-col p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <ColorDot color={c.color} />
                        <h3 className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-ink">
                          <Link href={`${scope.base}/calendars/${c.id}`} className="hover:underline">{c.name}</Link>
                        </h3>
                        {c.isDefault && <Badge tone="primary"><Star className="size-3" aria-hidden />Default</Badge>}
                        {c.status === "draft" && <DraftBadge />}
                      </div>
                      <p className="mt-1 text-[13px] text-muted">
                        {ASSIGNMENT_INFO[c.assignment].short}
                        {c.assignment === "round_robin" ? ` · ${ROUND_ROBIN_INFO[c.roundRobinMode].label.toLowerCase()}` : ""}
                      </p>
                    </div>
                    {canManage && (
                      <Menu>
                        <MenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`More for ${c.name}`}><MoreHorizontal className="size-4" /></Button>
                        </MenuTrigger>
                        <MenuContent>
                          <MenuItem onSelect={() => edit(c)}>Edit calendar</MenuItem>
                          {!c.isDefault && c.status !== "draft" && <MenuItem onSelect={() => run("default", () => updateCalendarAction(scope.orgId, c.id, { isDefault: true }), `${c.name} is now the default calendar.`)}>Make default</MenuItem>}
                          <MenuSeparator />
                          <MenuItem destructive onSelect={() => { setArchiving(c); setArchiveOpen(true); }}>Archive</MenuItem>
                        </MenuContent>
                      </Menu>
                    )}
                  </div>

                  {c.description && <p className="mt-3 line-clamp-2 text-[14px] leading-relaxed text-ink-2">{c.description}</p>}

                  <dl className="mt-4 grid grid-cols-2 gap-3 text-[13px]">
                    <div className="min-w-0">
                      <dt className="text-muted">Hosts</dt>
                      <dd className="mt-1 flex min-w-0 items-center gap-1.5">
                        {active.length ? (
                          <>
                            <span className="flex -space-x-1.5" aria-hidden>{active.slice(0, 3).map((m) => <Avatar key={m.userId} name={m.name} size="sm" className="ring-2 ring-surface" />)}</span>
                            <span className="min-w-0 truncate text-ink-2">{active.length === 1 ? active[0].name : `${active[0].name} +${active.length - 1}`}</span>
                          </>
                        ) : <span className="text-warning-ink">No active hosts</span>}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted">Appointment types</dt>
                      <dd className="mt-1 tabular-nums text-ink-2">{c.types.length}{c.types.length ? ` (${c.types.filter((t) => t.public).length} shown)` : ""}</dd>
                    </div>
                  </dl>

                  <div className="mt-4 space-y-1.5">
                    <BookingStatusBadge page={page} />
                    {firstProblem && <p className="text-[13px] text-muted">{blockerText(firstProblem, scope.base, c.id).text}</p>}
                    {c.status === "draft" && (
                      <p className="text-[13px] text-muted">
                        Takes no bookings until it is verified and activated.{" "}
                        <Link href={`${scope.base}/calendars/${c.id}#verify`} className="font-medium text-primary hover:underline">Verify and activate</Link>
                      </p>
                    )}
                  </div>

                  <div className="mt-auto pt-4">
                    <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
                      <ButtonLink href={`${scope.base}/calendars/${c.id}`} variant="secondary" size="sm">{canManage ? "Manage types" : "View types"}</ButtonLink>
                      {canManage && <Button variant="ghost" size="sm" onClick={() => edit(c)}>Edit</Button>}
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <CalendarDialog open={creating} onOpenChange={setCreating} scope={scope} calendar={null} people={people} />
      {editing && <CalendarDialog open={editOpen} onOpenChange={setEditOpen} scope={scope} calendar={editing} people={people} />}
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={`Archive ${archiving?.name ?? "calendar"}?`}
        description="Its booking page goes offline and nothing new can be booked on it. Appointments already booked stay on the calendar, and so do their reminders."
        confirmLabel="Archive calendar"
        danger
        loading={busy("archive")}
        onConfirm={async () => {
          if (!archiving) return;
          if (await run("archive", () => archiveCalendarAction(scope.orgId, archiving.id), "Calendar archived.")) setArchiveOpen(false);
        }}
      />
    </div>
  );
}
