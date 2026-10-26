"use client";

import * as React from "react";
import Link from "next/link";
import { ExternalLink, Globe } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";
import { setAppointmentTypePublicAction, setCalendarPublicAction } from "@/app/actions/crm-calendar-settings";
import { PageTitle, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { permissionNeeded } from "@/lib/permissions";
import { BlockerList, BookingStatusBadge, ColorDot, CopyButton, DraftBadge } from "@/components/crm/scheduling/settings/shared";
import { durationLabel } from "@/components/crm/scheduling/settings/hours";
import { absoluteUrl, bookingUrl } from "@/lib/calendars/urls";
import type { BookingPageView } from "@/server/calendars/setup";
import type { CrmScope } from "@/server/crm/page";

function OpenLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[14px] font-medium text-ink shadow-soft hover:bg-surface-2 sm:h-8">
      Open<ExternalLink className="size-3.5" aria-hidden /><span className="sr-only"> {label} (opens in a new tab)</span>
    </a>
  );
}

/** Every calendar's public booking page: its link, whether it's live and, when it isn't, what to fix. People who set up calendars switch pages and types on or off here. */
export function BookingPagesManager({ scope, pages, orgSlug, appUrl }: { scope: CrmScope; pages: BookingPageView[]; orgSlug: string; appUrl: string | null }) {
  const { run, pending } = useCrmAction();
  const canManage = !!scope.can["calendars.manage"] && !scope.readOnly;
  const liveCount = pages.filter((p) => p.live).length;

  return (
    <div>
      <PageTitle
        title="Booking pages"
        description="Public pages where customers choose a time. A page is live when it's turned on, someone with working hours hosts it, and at least one appointment type is shown."
        actions={<ButtonLink href={`${scope.base}/calendars`} variant="secondary">Calendars &amp; types</ButtonLink>}
      />
      {!canManage && <div className="mb-4"><ReadOnlyNotice>{scope.readOnly ? undefined : permissionNeeded("Turning booking pages on or off", "calendars.manage")}</ReadOnlyNotice></div>}
      {pages.length > 0 && <p className="mb-3 text-[13px] text-muted" role="status">{liveCount} of {pages.length} {pages.length === 1 ? "page is" : "pages are"} live.</p>}

      {!pages.length ? (
        <Card>
          <EmptyState icon={<Globe className="size-5" />} title="No booking pages yet" description="Each calendar gets a booking page. Create a calendar and add an appointment type, then turn its page on."
            action={<Link href={`${scope.base}/calendars`} className="text-[14px] font-medium text-primary hover:underline">Set up a calendar</Link>} />
        </Card>
      ) : (
        <ul className="space-y-4" aria-label="Booking pages">
          {pages.map((p) => {
            const url = absoluteUrl(bookingUrl(orgSlug, p.slug), appUrl);
            const notOffered = p.assignment === "round_robin" ? p.hosts.filter((h) => h.accepting && !h.hasHours) : [];
            return (
              <li key={p.calendarId}>
                <Card className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <ColorDot color={p.color} />
                        <h3 className="min-w-0 break-words text-[15px] font-semibold tracking-tight text-ink">
                          <Link href={`${scope.base}/calendars/${p.calendarId}`} className="hover:underline">{p.name}</Link>
                        </h3>
                        {p.status === "draft" && <DraftBadge />}
                        <BookingStatusBadge page={p} />
                      </div>
                    </div>
                    <label className="flex min-h-11 items-center gap-2.5 text-[14px] text-ink-2 sm:min-h-0">
                      <Switch checked={p.public} disabled={!canManage || pending === `cal-${p.calendarId}` || p.status === "draft"} aria-label={`Booking page for ${p.name}`}
                        onCheckedChange={(v) => run(`cal-${p.calendarId}`, () => setCalendarPublicAction(scope.orgId, p.calendarId, v), v ? `${p.name}'s booking page is on.` : `${p.name}'s booking page is off.`)} />
                      <span aria-hidden>{p.public ? "On" : "Off"}</span>
                    </label>
                  </div>

                  {!p.live && (
                    <div className="mt-3">
                      <BlockerList blockers={p.blockers} base={scope.base} calendarId={p.calendarId} />
                    </div>
                  )}
                  {notOffered.length > 0 && p.live && (
                    <p className="mt-3 text-[13px] text-muted">Not offered until they set working hours: {notOffered.map((h) => h.name).join(", ")}.</p>
                  )}

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <code className="min-w-0 max-w-full flex-1 break-all rounded-lg border border-line bg-surface-2 px-2.5 py-2 font-mono text-[12px] text-ink-2">{url}</code>
                    <CopyButton text={url} label={`Copy the link to ${p.name}`} />
                    {p.live && <OpenLink href={url} label={p.name} />}
                  </div>

                  {p.types.length > 0 && (
                    <div className="mt-4">
                      <h4 className="text-[12px] font-medium uppercase tracking-wider text-faint">Appointment types</h4>
                      <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
                        {p.types.map((t) => {
                          const typeUrl = absoluteUrl(bookingUrl(orgSlug, p.slug, t.slug), appUrl);
                          return (
                            <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                              <div className="min-w-0 flex-1">
                                <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-ink">
                                  <span className="min-w-0 break-words">{t.name}</span>
                                  {!t.public && <Badge tone="neutral">Hidden</Badge>}
                                </p>
                                <p className="text-[12px] text-muted">{durationLabel(t.durationMinutes)}{t.capacity > 1 ? ` · group of up to ${t.capacity}` : ""}</p>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <label className="flex min-h-11 items-center gap-2 text-[13px] text-ink-2 sm:min-h-0">
                                  <Switch checked={t.public} disabled={!canManage || pending === `type-${t.id}`} aria-labelledby={`bp-${t.id}-l`}
                                    onCheckedChange={(v) => run(`type-${t.id}`, () => setAppointmentTypePublicAction(scope.orgId, t.id, v), v ? `${t.name} is shown.` : `${t.name} is hidden.`)} />
                                  <span id={`bp-${t.id}-l`}><span className="sr-only sm:not-sr-only">On page</span><span className="sr-only">: {t.name}</span></span>
                                </label>
                                {t.public && <CopyButton text={typeUrl} label={`Copy the link to ${t.name}`} size="icon-sm" />}
                                {t.live && (
                                  <a href={typeUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open the booking page for ${t.name} (opens in a new tab)`}
                                    className="inline-flex size-11 items-center justify-center rounded-xl text-ink-2 hover:bg-surface-2 sm:size-8"><ExternalLink className="size-4" aria-hidden /></a>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
