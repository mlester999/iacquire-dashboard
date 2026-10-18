"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowLeft, ArrowUp, CalendarPlus, ExternalLink, MoreHorizontal, Pencil, Plus, Star, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Switch } from "@/components/ui/overlays";
import {
  archiveAppointmentTypeAction, archiveCalendarAction, duplicateAppointmentTypeAction, reorderAppointmentTypesAction, setAppointmentTypePublicAction, setCalendarPublicAction,
} from "@/app/actions/crm-calendar-settings";
import { Avatar, ConfirmDialog, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { permissionNeeded } from "@/lib/permissions";
import { CalendarDialog, type SchedulingPerson } from "@/components/crm/scheduling/settings/calendar-dialog";
import { TypeEditor, type MeetingSupport } from "@/components/crm/scheduling/settings/type-editor";
import { ASSIGNMENT_INFO, BlockerList, BookingStatusBadge, ColorDot, CopyButton, DraftBadge, LOCATION_INFO, ROUND_ROBIN_INFO } from "@/components/crm/scheduling/settings/shared";
import { VerifyPanel } from "@/components/crm/scheduling/settings/verify-panel";
import { durationLabel } from "@/components/crm/scheduling/settings/hours";
import { absoluteUrl, bookingUrl } from "@/lib/calendars/urls";
import type { AppointmentTypeView, BookingPageView, CalendarView } from "@/server/calendars/setup";
import type { CalendarVerification } from "@/server/calendars/activation";
import type { CrmScope } from "@/server/crm/page";

/**
 * One calendar: its hosts, its booking page switch and link, and its appointment types in the order customers see them. A draft (from a
 * Blueprint) also shows its activation checks and the Activate button, and has no booking page until it is active.
 */
export function CalendarDetail({ scope, calendar, page, people, orgSlug, appUrl, meeting, verification = null }: {
  scope: CrmScope; calendar: CalendarView; page: BookingPageView | null; people: SchedulingPerson[]; orgSlug: string; appUrl: string | null; meeting: MeetingSupport;
  verification?: CalendarVerification | null;
}) {
  const router = useRouter();
  const { run, busy, pending } = useCrmAction();
  const canManage = !!scope.can["calendars.manage"] && !scope.readOnly;
  const [editOpen, setEditOpen] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [typeOpen, setTypeOpen] = React.useState(false);
  const [typeTarget, setTypeTarget] = React.useState<AppointmentTypeView | null>(null);
  const [archiveType, setArchiveType] = React.useState<AppointmentTypeView | null>(null);
  const [archiveTypeOpen, setArchiveTypeOpen] = React.useState(false);
  const types = calendar.types;
  const active = calendar.members.filter((m) => m.active);
  const url = absoluteUrl(bookingUrl(orgSlug, calendar.slug), appUrl);
  const live = !!page?.live;
  const draft = calendar.status === "draft";

  function openType(t: AppointmentTypeView | null) {
    setTypeTarget(t);
    setTypeOpen(true);
  }

  async function move(index: number, delta: -1 | 1) {
    const ids = types.map((t) => t.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    await run("reorder", () => reorderAppointmentTypesAction(scope.orgId, calendar.id, ids), "Order saved.");
  }

  return (
    <div className="space-y-5">
      <Link href={`${scope.base}/calendars`} className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink sm:min-h-0">
        <ArrowLeft className="size-4" aria-hidden />Calendars &amp; types
      </Link>

      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <ColorDot color={calendar.color} className="size-3" />
              <h2 className="min-w-0 break-words text-[20px] font-semibold tracking-[-0.03em] text-ink">{calendar.name}</h2>
              {calendar.isDefault && <Badge tone="primary"><Star className="size-3" aria-hidden />Default</Badge>}
              {draft && <DraftBadge />}
            </div>
            {calendar.description && <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted">{calendar.description}</p>}
          </div>
          {canManage && (
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)}><Pencil className="size-4" />Edit calendar</Button>
              <Menu>
                <MenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={`More for ${calendar.name}`}><MoreHorizontal className="size-4" /></Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem destructive onSelect={() => setArchiveOpen(true)}>Archive calendar</MenuItem>
                </MenuContent>
              </Menu>
            </div>
          )}
        </div>

        <dl className="mt-5 grid gap-4 text-[13px] sm:grid-cols-2">
          <div>
            <dt className="text-[12px] font-medium uppercase tracking-wider text-faint">Assignment</dt>
            <dd className="mt-1 text-ink-2">
              <span className="font-medium text-ink">{ASSIGNMENT_INFO[calendar.assignment].label}</span>
              {calendar.assignment === "round_robin" && <span className="text-muted"> · {ROUND_ROBIN_INFO[calendar.roundRobinMode].label}</span>}
              <span className="mt-0.5 block text-[12.5px] text-muted">{ASSIGNMENT_INFO[calendar.assignment].explain}</span>
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[12px] font-medium uppercase tracking-wider text-faint">Hosts</dt>
            <dd className="mt-1">
              {active.length ? (
                <ul className="flex flex-wrap gap-1.5">
                  {active.map((m) => (
                    <li key={m.userId} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface py-0.5 pl-0.5 pr-2.5">
                      <Avatar name={m.name} size="sm" />
                      <span className="truncate text-[12.5px] text-ink-2">{m.name}</span>
                      {calendar.assignment === "round_robin" && calendar.roundRobinMode === "priority" && <span className="text-[11.5px] tabular-nums text-faint">· {m.priority}</span>}
                    </li>
                  ))}
                </ul>
              ) : <span className="inline-flex items-center gap-1.5 text-warning-ink"><Users className="size-4" aria-hidden />Nobody active hosts this calendar.</span>}
              <Link href={`${scope.base}/availability`} className="mt-1.5 inline-block text-[12.5px] font-medium text-primary hover:underline">Working hours</Link>
            </dd>
          </div>
        </dl>

        <div className="mt-5 rounded-2xl border border-line bg-surface-2/60 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 id="cal-page-h" className="text-[13px] font-semibold text-ink">Booking page</h3>
                <BookingStatusBadge page={page ?? undefined} />
              </div>
              {calendar.bookingIntro && <p className="mt-1 line-clamp-2 text-[12.5px] text-muted">{calendar.bookingIntro}</p>}
            </div>
            <label className="flex min-h-11 items-center gap-2.5 text-[13px] text-ink-2 sm:min-h-0">
              <Switch checked={calendar.public} disabled={!canManage || busy("public") || draft}
                onCheckedChange={(v) => run("public", () => setCalendarPublicAction(scope.orgId, calendar.id, v), v ? "Booking page turned on." : "Booking page turned off.")} aria-labelledby="cal-page-h" aria-describedby={draft ? "cal-page-draft" : undefined} />
              <span aria-hidden>{calendar.public ? "On" : "Off"}</span>
            </label>
          </div>
          {draft && <p id="cal-page-draft" className="mt-2 text-[12.5px] text-ink-2">No booking page while this calendar is a draft. Activate it below, then turn the page on.</p>}
          {page && !page.live && <div className="mt-3"><BlockerList blockers={page.blockers} base={scope.base} calendarId={calendar.id} skip={["draft", "calendar_private", "no_types", "no_public_types"]} /></div>}
          {page && page.blockers.some((b) => b.code === "no_types" || b.code === "no_public_types") && (
            <p className="mt-2 text-[12.5px] text-ink-2">{page.blockers.some((b) => b.code === "no_types") ? "Add an appointment type below so customers have something to book." : "Show at least one appointment type below."}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="min-w-0 max-w-full flex-1 break-all rounded-lg border border-line bg-surface px-2.5 py-2 font-mono text-[12px] text-ink-2">{url}</code>
            <CopyButton text={url} label={`Copy the link to ${calendar.name}`} />
            {live && <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink shadow-soft hover:bg-surface-2 sm:h-8">Open<ExternalLink className="size-3.5" aria-hidden /><span className="sr-only"> (opens in a new tab)</span></a>}
          </div>
        </div>
      </Card>

      {draft && <VerifyPanel scope={scope} calendar={calendar} verification={verification} onEditHosts={canManage ? () => setEditOpen(true) : undefined} />}

      <section aria-labelledby="types-h">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="types-h" className="text-[15px] font-semibold tracking-tight text-ink">Appointment types</h2>
            <p className="mt-0.5 text-[13px] text-muted">Listed on the booking page in this order.{calendar.isDefault ? " The first one is what your AI Appointment Setter offers when no type is named." : ""}</p>
          </div>
          {canManage && <Button onClick={() => openType(null)}><Plus className="size-4" />New appointment type</Button>}
        </div>
        {!canManage && <div className="mb-3"><ReadOnlyNotice>{scope.readOnly ? undefined : permissionNeeded("Changing appointment types", "calendars.manage")}</ReadOnlyNotice></div>}

        {!types.length ? (
          <Card>
            <EmptyState compact icon={<CalendarPlus className="size-5" />} title="No appointment types yet"
              description="Add what customers can book, such as a 30-minute consultation. Each type sets its own length, notice, location and questions."
              action={canManage ? <Button onClick={() => openType(null)}><Plus className="size-4" />New appointment type</Button> : undefined} />
          </Card>
        ) : (
          <ol className="space-y-2">
            {types.map((t, i) => (
              <li key={t.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <ColorDot color={t.color ?? calendar.color} />
                        <h3 className="min-w-0 break-words text-[14px] font-semibold text-ink">{t.name}</h3>
                        {!t.public && <Badge tone="neutral">Hidden from page</Badge>}
                        {t.requiresConfirmation && <Badge tone="violet">You confirm</Badge>}
                      </div>
                      <p className="mt-1 text-[12.5px] text-muted">
                        {[durationLabel(t.durationMinutes), LOCATION_INFO[t.locationKind].label, t.capacity > 1 ? `Group of up to ${t.capacity}` : null, t.questions.length ? `${t.questions.length} ${t.questions.length === 1 ? "question" : "questions"}` : null,
                          t.meetingProvider === "google_meet" ? "Google Meet" : t.meetingProvider === "microsoft_teams" ? "Microsoft Teams" : t.meetingProvider === "custom_link" ? "Fixed link" : null].filter(Boolean).join(" · ")}
                      </p>
                      {t.description && <p className="mt-1.5 line-clamp-2 text-[13px] text-ink-2">{t.description}</p>}
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <label className="mr-1 flex min-h-11 items-center gap-2 text-[12.5px] text-ink-2 sm:min-h-0">
                        <Switch checked={t.public} disabled={!canManage || pending === `pub-${t.id}`} onCheckedChange={(v) => run(`pub-${t.id}`, () => setAppointmentTypePublicAction(scope.orgId, t.id, v), v ? `${t.name} is shown on the booking page.` : `${t.name} is hidden from the booking page.`)} aria-labelledby={`pub-${t.id}-l`} />
                        <span id={`pub-${t.id}-l`}><span className="sr-only sm:not-sr-only">On page</span><span className="sr-only">: {t.name}</span></span>
                      </label>
                      {canManage && (
                        <>
                          <Button variant="ghost" size="icon-sm" aria-label={`Move ${t.name} up`} disabled={i === 0 || busy("reorder")} onClick={() => move(i, -1)}><ArrowUp className="size-4" /></Button>
                          <Button variant="ghost" size="icon-sm" aria-label={`Move ${t.name} down`} disabled={i === types.length - 1 || busy("reorder")} onClick={() => move(i, 1)}><ArrowDown className="size-4" /></Button>
                          <Button variant="secondary" size="sm" onClick={() => openType(t)}>Edit</Button>
                          <Menu>
                            <MenuTrigger asChild>
                              <Button variant="ghost" size="icon-sm" aria-label={`More for ${t.name}`}><MoreHorizontal className="size-4" /></Button>
                            </MenuTrigger>
                            <MenuContent>
                              <MenuItem onSelect={() => run(`dup-${t.id}`, () => duplicateAppointmentTypeAction(scope.orgId, t.id), "Copy added at the end, hidden from the booking page until you show it.")}>Duplicate</MenuItem>
                              <MenuSeparator />
                              <MenuItem destructive onSelect={() => { setArchiveType(t); setArchiveTypeOpen(true); }}>Archive</MenuItem>
                            </MenuContent>
                          </Menu>
                        </>
                      )}
                      {live && t.public && (
                        <a href={absoluteUrl(bookingUrl(orgSlug, calendar.slug, t.slug), appUrl)} target="_blank" rel="noopener noreferrer" aria-label={`Open the booking page for ${t.name} (opens in a new tab)`}
                          className="inline-flex size-11 items-center justify-center rounded-xl text-ink-2 hover:bg-surface-2 sm:size-8"><ExternalLink className="size-4" aria-hidden /></a>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ol>
        )}
      </section>

      {canManage && <CalendarDialog open={editOpen} onOpenChange={setEditOpen} scope={scope} calendar={calendar} people={people} />}
      {canManage && <TypeEditor open={typeOpen} onOpenChange={setTypeOpen} scope={scope} calendar={calendar} type={typeTarget} meeting={meeting} />}
      <ConfirmDialog open={archiveTypeOpen} onOpenChange={setArchiveTypeOpen} title={`Archive ${archiveType?.name ?? "this type"}?`} confirmLabel="Archive type" danger loading={busy("archive-type")}
        description="It's removed from the booking page and can't be booked again. Appointments already booked stay on the calendar with their reminders and can still be cancelled, but they can no longer be moved to a new time."
        onConfirm={async () => { if (archiveType && (await run("archive-type", () => archiveAppointmentTypeAction(scope.orgId, archiveType.id), "Appointment type archived."))) setArchiveTypeOpen(false); }} />
      <ConfirmDialog open={archiveOpen} onOpenChange={setArchiveOpen} title={`Archive ${calendar.name}?`} confirmLabel="Archive calendar" danger loading={busy("archive")}
        description="Its booking page goes offline and nothing new can be booked on it. Appointments already booked stay on the calendar, and so do their reminders."
        onConfirm={async () => { if (await run("archive", () => archiveCalendarAction(scope.orgId, calendar.id), "Calendar archived.")) { setArchiveOpen(false); router.push(`${scope.base}/calendars`); } }} />
    </div>
  );
}
