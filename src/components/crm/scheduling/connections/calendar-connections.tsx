"use client";

import * as React from "react";
import { CalendarClock, CheckCircle2, Info, Link2Off, PauseCircle, Plus, ShieldCheck, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { ConfirmDialog, PageTitle, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";
import { disconnectCalendarAction } from "@/app/actions/crm-calendar-connections";
import { ConnectionCard } from "@/components/crm/scheduling/connections/connection-card";
import { CalDavDialog, IcsDialog } from "@/components/crm/scheduling/connections/connect-forms";
import { ProviderMark } from "@/components/crm/scheduling/connections/provider-mark";
import { connectionStatus, providerName, RUN_LABEL, RUN_TONE, runKindLabel, runSummary } from "@/components/crm/scheduling/connections/status";
import type { CalendarConnectionSettings, CalendarNotice, ConnectionView, ProviderOption, SyncRunView } from "@/server/calendars/connections";
import type { CrmScope } from "@/server/crm/page";

const OAUTH_RETURN = encodeURIComponent("/crm/calendar-connections");

const DESCRIPTIONS: Record<ProviderOption["key"], string> = {
  google: "Busy times from the calendars you choose. Bookings can be added, with Google Meet links for Meet appointment types.",
  microsoft: "Outlook.com and Microsoft 365. Busy times, and bookings added with Teams links where your account allows them.",
  icloud: "Uses an app-specific password. Busy times, and bookings added to the calendar you choose (no meeting links).",
  caldav: "Fastmail, Nextcloud and other CalDAV servers over HTTPS. Busy times, and bookings if you choose.",
  ics: "Any calendar's subscription link. Busy times only, read-only, and refreshed on a schedule rather than instantly.",
};

const anchorButton = "inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-ink px-4 text-[13px] font-medium text-surface shadow-soft transition hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-9";

/** The Calendar connections screen. Data comes from the server view; every change goes through a server action. */
export function CalendarConnectionsWorkspace({ scope, settings, mine, team, runs, canConnect, notice, renderedAt }: {
  scope: CrmScope;
  settings: CalendarConnectionSettings;
  mine: ConnectionView[];
  team: ConnectionView[];
  runs: SyncRunView[];
  canConnect: boolean;
  notice: CalendarNotice | null;
  renderedAt: string;
}) {
  const now = new Date(renderedAt).getTime();
  const [dialog, setDialog] = React.useState<{ kind: "icloud" | "caldav" | "ics"; label?: string | null } | null>(null);
  const [showNotice, setShowNotice] = React.useState(true);
  const manager = !!scope.can["calendars.manage"];
  const labels = new Map([...mine, ...team].map((c) => [c.id, c.accountLabel]));

  const reconnect = (c: ConnectionView) => {
    if (c.provider === "ics") setDialog({ kind: "ics", label: c.accountLabel });
    else if (c.provider === "caldav") setDialog({ kind: providerName(c) === "Apple iCloud" ? "icloud" : "caldav", label: c.accountLabel });
  };

  return (
    <div className="space-y-8">
      <PageTitle
        title="Calendar connections"
        description="Connect the calendars you already use. Times you're busy there are kept off your booking pages, and appointments you host can be added to them. Each person connects their own."
      />

      {notice && showNotice && (
        <div role="status" className={cn("flex items-start gap-3 rounded-2xl border px-4 py-3 text-[13px]", notice.kind === "error" ? "border-danger/30 bg-danger-soft text-danger-ink" : notice.kind === "success" ? "border-success/30 bg-success-soft text-success-ink" : "border-line bg-surface-2 text-ink-2")}>
          {notice.kind === "error" ? <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> : notice.kind === "success" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <Info className="mt-0.5 size-4 shrink-0" aria-hidden />}
          <p className="flex-1 leading-relaxed">{notice.message}</p>
          <button type="button" onClick={() => setShowNotice(false)} className="-m-1.5 inline-flex size-11 items-center justify-center rounded-lg hover:bg-black/5 sm:size-8" aria-label="Dismiss message">
            <X className="size-4" aria-hidden />
          </button>
        </div>
      )}

      {settings.syncPaused && (
        <div role="status" className="flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning-ink">
          <PauseCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p className="leading-relaxed">Calendar sync is paused by iAcquire right now. Connections are kept, but busy times aren&apos;t refreshed and nothing is added to calendars until it resumes.</p>
        </div>
      )}

      {scope.agency ? (
        <Card className="flex items-start gap-3 p-4 text-[13px] leading-relaxed text-ink-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <p>Support view. You can see which calendars this team has connected{scope.readOnly ? "" : " and disconnect one that's misbehaving"}, but you can&apos;t connect a calendar for anyone: each person connects their own from their account.</p>
        </Card>
      ) : (
        <>
          <section aria-labelledby="my-calendars" className="space-y-3">
            <div>
              <h3 id="my-calendars" className="text-[15px] font-semibold tracking-tight text-ink">Your calendars</h3>
              <p className="mt-0.5 text-[12.5px] text-muted">Only you can connect or change these. Workspace managers can see that they exist and their status, never their events.</p>
            </div>
            {mine.length ? (
              <div className="grid gap-4 xl:grid-cols-2">
                {mine.map((c) => <ConnectionCard key={c.id} scope={scope} connection={c} settings={settings} renderedAt={now} onReconnect={reconnect} />)}
              </div>
            ) : (
              <Card className="border-dashed">
                <EmptyState compact icon={<CalendarClock className="size-5" />} title="No calendars connected yet" description="Without one, people can book you at times you're busy elsewhere. Connect the calendar you use every day below." />
              </Card>
            )}
          </section>

          <section aria-labelledby="connect-calendar" className="space-y-3">
            <div>
              <h3 id="connect-calendar" className="text-[15px] font-semibold tracking-tight text-ink">Connect a calendar</h3>
              <p className="mt-0.5 text-[12.5px] text-muted">A calendar shows as connected only after iAcquire has signed in and read it successfully.</p>
            </div>
            {!canConnect && <ReadOnlyNotice>Your role doesn&apos;t include connecting a calendar. Ask a workspace owner if you need it.</ReadOnlyNotice>}
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {settings.providers.map((p) => {
                const oauth = p.key === "google" || p.key === "microsoft";
                const usable = canConnect && p.configured && !scope.readOnly;
                return (
                  <li key={p.key}>
                    <Card className="flex h-full flex-col p-4">
                      <div className="flex items-start gap-3">
                        <ProviderMark provider={p.key === "icloud" ? "caldav" : p.key} icloud={p.key === "icloud"} />
                        <div className="min-w-0">
                          <h4 className="text-[14px] font-semibold text-ink">{p.label}</h4>
                          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{DESCRIPTIONS[p.key]}</p>
                        </div>
                      </div>
                      <div className="mt-auto pt-4">
                        {!p.configured ? (
                          <div className="space-y-1.5">
                            <Badge tone="neutral">Not set up by iAcquire yet</Badge>
                            <p className="text-[12px] leading-relaxed text-muted">{p.unavailableReason}</p>
                          </div>
                        ) : oauth ? (
                          usable ? (
                            <a href={`/api/crm/calendar-oauth/${p.key}/start?return=${OAUTH_RETURN}`} className={anchorButton}>
                              <Plus className="size-4" aria-hidden />Connect {p.key === "google" ? "Google" : "Microsoft"}
                            </a>
                          ) : (
                            <Button size="sm" disabled>Connect {p.key === "google" ? "Google" : "Microsoft"}</Button>
                          )
                        ) : (
                          <Button size="sm" disabled={!usable} onClick={() => setDialog({ kind: p.key as "icloud" | "caldav" | "ics" })}>
                            <Plus className="size-4" aria-hidden />{p.key === "ics" ? "Add a feed" : "Connect"}
                          </Button>
                        )}
                      </div>
                    </Card>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}

      {(manager || scope.agency) && <TeamConnections scope={scope} team={team} now={now} />}

      {!scope.agency && runs.length > 0 && <SyncHistory runs={runs} labels={labels} now={now} timezone={scope.timezone} />}

      <Card className="p-4 text-[12.5px] leading-relaxed text-muted sm:p-5">
        <h3 className="text-[13.5px] font-semibold text-ink">What iAcquire keeps</h3>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li>From your calendars: only the start and end of busy times, for the period people can book. No titles, guests or descriptions.</li>
          <li>Your sign-in tokens, app-specific passwords and feed addresses, encrypted. They&apos;re never shown again, and disconnecting deletes them.</li>
          <li>Busy times are refreshed about every {settings.syncMinutes} minutes ({settings.icsMinutes} for ICS feeds). A change made in the last few minutes may not be reflected yet; iAcquire&apos;s own bookings are always checked instantly.</li>
        </ul>
      </Card>

      {dialog && (dialog.kind === "ics" ? (
        <IcsDialog scope={scope} open onOpenChange={(o) => !o && setDialog(null)} minutes={settings.icsMinutes} initialLabel={dialog.label} />
      ) : (
        <CalDavDialog scope={scope} preset={dialog.kind} open onOpenChange={(o) => !o && setDialog(null)} initialLabel={dialog.label} />
      ))}
    </div>
  );
}

/** Other people's connections, for managers (and agency support): status only, with a way to disconnect one that's misbehaving. */
function TeamConnections({ scope, team, now }: { scope: CrmScope; team: ConnectionView[]; now: number }) {
  const { run, busy } = useCrmAction();
  const [target, setTarget] = React.useState<ConnectionView | null>(null);
  const canDisconnect = !scope.readOnly && !!scope.can["calendars.manage"];
  return (
    <section aria-labelledby="team-calendars" className="space-y-3">
      <div>
        <h3 id="team-calendars" className="text-[15px] font-semibold tracking-tight text-ink">Your team&apos;s connections</h3>
        <p className="mt-0.5 text-[12.5px] text-muted">Who has connected a calendar, and whether it&apos;s working. You can disconnect one, but only its owner can connect or change it.</p>
      </div>
      {!team.length ? (
        <Card className="border-dashed"><EmptyState compact title="No one else has connected a calendar" description="When teammates connect theirs, you'll see them here." /></Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <ul className="divide-y divide-line">
            {team.map((c) => {
              const s = connectionStatus(c, now);
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap">
                  <ProviderMark provider={c.provider} icloud={providerName(c) === "Apple iCloud"} className="size-9" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-medium text-ink">{c.userName ?? "Teammate"}</p>
                    <p className="truncate text-[12.5px] text-muted">{providerName(c)} · {c.accountLabel} · {c.lastSuccessAt ? `synced ${relativeTime(c.lastSuccessAt, now)}` : "not synced yet"}</p>
                  </div>
                  <Badge tone={s.tone}>{s.label}</Badge>
                  {canDisconnect && (
                    <Button variant="ghost" size="sm" className="text-danger-ink hover:bg-danger-soft" onClick={() => setTarget(c)} aria-label={`Disconnect ${c.userName ?? "teammate"}'s ${providerName(c)}`}>
                      <Link2Off className="size-3.5" aria-hidden /><span className="sm:sr-only lg:not-sr-only">Disconnect</span>
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      <ConfirmDialog
        open={!!target}
        onOpenChange={(o) => !o && setTarget(null)}
        danger
        title={target ? `Disconnect ${target.userName ?? "this person"}'s calendar?` : "Disconnect?"}
        confirmLabel="Disconnect"
        loading={!!target && busy(`disconnect-${target.id}`)}
        description="Their busy times stop counting for bookings straight away. They're told it was disconnected, and only they can connect it again."
        onConfirm={async () => {
          if (!target) return;
          const r = await run(`disconnect-${target.id}`, () => disconnectCalendarAction(scope.orgId, target.id), "Calendar disconnected.");
          if (r) setTarget(null);
        }}
      />
    </section>
  );
}

function SyncHistory({ runs, labels, now, timezone }: { runs: SyncRunView[]; labels: Map<string, string>; now: number; timezone: string }) {
  return (
    <section aria-labelledby="sync-history" className="space-y-3">
      <div>
        <h3 id="sync-history" className="text-[15px] font-semibold tracking-tight text-ink">Recent sync activity</h3>
        <p className="mt-0.5 text-[12.5px] text-muted">The last {runs.length} runs for your calendars. Only counts are recorded, never what your events say.</p>
      </div>
      <Card className="overflow-hidden p-0">
        <ul className="divide-y divide-line">
          {runs.map((r) => (
            <li key={r.id} className="grid gap-1 px-4 py-2.5 text-[13px] sm:grid-cols-[10rem_minmax(0,12rem)_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
              <time dateTime={r.startedAt} title={formatDateTime(r.startedAt, timezone)} className="text-[12.5px] tabular-nums text-muted">{relativeTime(r.startedAt, now)}</time>
              <span className="truncate text-ink">{labels.get(r.connectionId) ?? "Disconnected calendar"}</span>
              <span className="min-w-0 text-ink-2"><span className="font-medium text-ink">{runKindLabel(r.kind)}</span> · <span className="break-words">{runSummary(r)}</span></span>
              <Badge tone={RUN_TONE[r.status]} className="justify-self-start sm:justify-self-end">{RUN_LABEL[r.status]}</Badge>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
