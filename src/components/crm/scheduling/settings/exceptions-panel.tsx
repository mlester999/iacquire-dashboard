"use client";

import * as React from "react";
import { CalendarOff, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, Field, Input, Select } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/overlays";
import { clearDayExceptionAction, setDayExceptionAction } from "@/app/actions/crm-calendar-settings";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { RangeSelects } from "@/components/crm/scheduling/settings/hours-editor";
import { dateLabel, dayProblem, hoursAroundAbsence, rangeLabel, WEEKDAY_NAMES, weekdayOfDate, type Range } from "@/components/crm/scheduling/settings/hours";
import type { AvailabilityOverrideView, HostAvailability } from "@/server/calendars/setup";
import type { CrmScope } from "@/server/crm/page";

type Kind = "closed" | "away" | "custom";
const EVERYONE = "everyone";

interface DayGroup {
  key: string;
  userId: string | null;
  date: string;
  closed: boolean;
  windows: Range[];
  reason: string | null;
}

/** Exceptions are stored one row per window; people think of them per day, so they are shown and removed per person and day. */
function groupOverrides(overrides: AvailabilityOverrideView[], today: string): DayGroup[] {
  const map = new Map<string, DayGroup>();
  for (const o of overrides) {
    if (o.date < today) continue;
    const key = `${o.userId ?? EVERYONE}|${o.date}`;
    const g = map.get(key) ?? { key, userId: o.userId, date: o.date, closed: false, windows: [], reason: null };
    if (o.startMinute === null || o.endMinute === null) g.closed = true;
    else g.windows.push({ startMinute: o.startMinute, endMinute: o.endMinute });
    g.reason ??= o.reason;
    map.set(key, g);
  }
  return [...map.values()].map((g) => ({ ...g, windows: g.windows.sort((a, b) => a.startMinute - b.startMinute) })).sort((a, b) => a.date.localeCompare(b.date) || (a.userId === null ? 0 : 1) - (b.userId === null ? 0 : 1));
}

/**
 * Days that differ from the weekly hours: a day off, time away for part of a day, or different hours, for one person or (with calendar
 * management) for everyone as a workspace holiday. Each saved day replaces what was set for that person and date before.
 */
export function ExceptionsPanel({ scope, hosts, overrides, today, canManageOthers }: { scope: CrmScope; hosts: HostAvailability[]; overrides: AvailabilityOverrideView[]; today: string; canManageOthers: boolean }) {
  const { run, busy } = useCrmAction();
  const me = scope.userId && hosts.some((h) => h.userId === scope.userId) ? scope.userId : null;
  const canOwn = !!me && !scope.readOnly;
  const choices = [...(canOwn ? hosts.filter((h) => h.userId === me) : []), ...(canManageOthers ? hosts.filter((h) => h.userId !== me) : [])];
  const [who, setWho] = React.useState<string>(canOwn && me ? me : canManageOthers ? EVERYONE : "");
  const [date, setDate] = React.useState("");
  const [kind, setKind] = React.useState<Kind>("closed");
  const [away, setAway] = React.useState<Range>({ startMinute: 720, endMinute: 840 });
  const [windows, setWindows] = React.useState<Range[]>([{ startMinute: 540, endMinute: 720 }]);
  const [reason, setReason] = React.useState("");
  const [tried, setTried] = React.useState(false);
  const [removing, setRemoving] = React.useState<DayGroup | null>(null);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const groups = groupOverrides(overrides, today);
  const names = new Map(hosts.map((h) => [h.userId, h.userId === scope.userId ? `${h.name} (you)` : h.name]));
  const nameOf = (userId: string | null, fallback?: string | null) => (userId === null ? "Everyone" : names.get(userId) ?? fallback ?? "A former member");
  const canAdd = canOwn || canManageOthers;
  const pickWho = choices.length + (canManageOthers ? 1 : 0) > 1;
  const userId = who === EVERYONE ? null : who || null;
  const effectiveKind: Kind = userId === null && kind === "away" ? "closed" : kind;

  const host = userId ? hosts.find((h) => h.userId === userId) : undefined;
  const usual = host && date ? host.rules.filter((r) => r.weekday === weekdayOfDate(date)).map((r) => ({ startMinute: r.startMinute, endMinute: r.endMinute })) : [];
  const awayProblem = effectiveKind === "away" ? (away.endMinute <= away.startMinute ? "The time away has to end after it starts." : date && !usual.length ? `${userId === me ? "You don't" : `${host?.name ?? "They"} doesn't`} usually work on ${WEEKDAY_NAMES[weekdayOfDate(date)]}s, so there's nothing to block.` : null) : null;
  const remaining = effectiveKind === "away" && !awayProblem ? hoursAroundAbsence(usual, away) : [];
  const customProblem = effectiveKind === "custom" ? (windows.length ? dayProblem(windows) : "Add the hours that day, or choose closed all day.") : null;
  const dateProblem = !date ? "Choose a date." : date < today ? "Choose today or a later date." : null;
  const existing = groups.find((g) => g.userId === userId && g.date === date);
  const problem = dateProblem ?? awayProblem ?? customProblem ?? (reason.trim().length > 120 ? "Keep the reason to 120 characters." : null);
  const mayRemove = (g: DayGroup) => !scope.readOnly && ((g.userId !== null && g.userId === scope.userId) || canManageOthers);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (problem || !who) return;
    const payload = effectiveKind === "closed" ? null : effectiveKind === "custom" ? windows : remaining.length ? remaining : null;
    const label = userId === null ? "Workspace holiday saved." : userId === me ? "Your exception is saved." : `Exception saved for ${host?.name ?? "them"}.`;
    if (await run("add", () => setDayExceptionAction(scope.orgId, { userId, date, windows: payload, reason: reason.trim() || null }), label)) {
      setDate("");
      setReason("");
      setTried(false);
    }
  }

  return (
    <div className="space-y-5">
      {canAdd ? (
        <form className="space-y-4 rounded-2xl border border-line p-4" onSubmit={add} noValidate>
          <h3 className="text-[14px] font-semibold text-ink">Add a day off or different hours</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="For" htmlFor={pickWho ? "exc-who" : undefined} hint={userId === null ? "Applies to every host. Someone with their own exception that day keeps theirs." : undefined}>
              {pickWho ? (
                <Select id="exc-who" value={who} onChange={(e) => setWho(e.target.value)}>
                  {canManageOthers && <option value={EVERYONE}>Everyone (workspace holiday)</option>}
                  {choices.map((h) => <option key={h.userId} value={h.userId}>{names.get(h.userId)}</option>)}
                </Select>
              ) : (
                <p className="flex min-h-11 items-center text-[14px] text-ink sm:min-h-10">{who === EVERYONE ? "Everyone (workspace holiday)" : names.get(who) ?? "You"}</p>
              )}
            </Field>
            <Field label="Date" htmlFor="exc-date" error={tried ? dateProblem : null}>
              <Input id="exc-date" type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={(tried && !!dateProblem) || undefined} />
            </Field>
          </div>
          <div className="space-y-2">
            <p className="text-[14px] font-medium text-ink-2">What changes</p>
            <Segmented<Kind> id="exc-kind" ariaLabel="What changes" size="sm" value={effectiveKind} onChange={setKind}
              options={[{ value: "closed", label: "Closed all day" }, ...(userId !== null ? [{ value: "away" as Kind, label: "Away part of the day" }] : []), { value: "custom", label: "Different hours" }]} />
          </div>
          {effectiveKind === "away" && (
            <div className="space-y-2">
              <p className="text-[13px] text-muted">Away from</p>
              <RangeSelects id="exc-away" range={away} onChange={setAway} label="Away" />
              {awayProblem ? (
                <p role={tried ? "alert" : undefined} className="text-[13px] text-muted">{awayProblem}</p>
              ) : date ? (
                <p className="text-[13px] text-ink-2" aria-live="polite">
                  {remaining.length
                    ? <>Bookable that day: {remaining.map(rangeLabel).join(", ")} (from the usual {WEEKDAY_NAMES[weekdayOfDate(date)]} hours, {usual.map(rangeLabel).join(", ")}).</>
                    : "That covers the whole working day, so the day will be closed."}
                </p>
              ) : <p className="text-[13px] text-muted">Choose a date to see the hours left that day.</p>}
            </div>
          )}
          {effectiveKind === "custom" && (
            <div className="space-y-2">
              <p className="text-[13px] text-muted">Only these hours can be booked that day. They replace the usual weekly hours.</p>
              {windows.map((w, i) => (
                <div key={i} className="flex items-center gap-1">
                  <RangeSelects id={`exc-w${i}`} range={w} onChange={(r) => setWindows(windows.map((x, j) => (j === i ? r : x)))} label={`Range ${i + 1}`} />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${rangeLabel(w)}`} onClick={() => setWindows(windows.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
                </div>
              ))}
              {tried && customProblem && <p role="alert" className="text-[13px] text-danger-ink">{customProblem}</p>}
              <Button type="button" variant="ghost" size="sm" disabled={windows.length >= 6} onClick={() => {
                const last = windows.length ? Math.max(...windows.map((w) => w.endMinute)) : 480;
                const start = Math.min(last + 60, 1380);
                setWindows([...windows, { startMinute: start, endMinute: Math.min(start + 120, 1440) }]);
              }}><Plus className="size-4" />Add range</Button>
            </div>
          )}
          <Field label="Reason" htmlFor="exc-reason" optional hint="A note for your team.">
            <Input id="exc-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={120} placeholder="Public holiday, training, dentist" />
          </Field>
          {existing && <p className="text-[13px] text-warning-ink">This replaces what&apos;s already set for {nameOf(existing.userId).replace(" (you)", "")} on {dateLabel(existing.date)}.</p>}
          <div className="flex justify-end">
            <Button type="submit" loading={busy("add")} disabled={!who}>Save exception</Button>
          </div>
        </form>
      ) : null}

      <div>
        <h3 className="mb-2 text-[14px] font-semibold text-ink">Upcoming</h3>
        {!groups.length ? (
          <EmptyState compact icon={<CalendarOff className="size-5" />} title="No days off or exceptions coming up" description="Everyone's weekly hours apply as set." />
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {groups.map((g) => (
              <li key={g.key} className="flex flex-wrap items-start justify-between gap-3 px-3 py-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-ink">
                    <span className="tabular-nums">{dateLabel(g.date)}</span>
                    {g.userId === null ? <Badge tone="violet">Everyone</Badge> : <span className="text-ink-2">{nameOf(g.userId, overrides.find((o) => o.userId === g.userId)?.person)}</span>}
                  </p>
                  <p className="mt-0.5 text-[13px] text-muted">
                    {g.closed ? "Closed all day" : `Only ${g.windows.map(rangeLabel).join(", ")}`}
                    {g.reason ? ` · ${g.reason}` : ""}
                  </p>
                </div>
                {mayRemove(g) && (
                  <Button variant="ghost" size="sm" onClick={() => { setRemoving(g); setRemoveOpen(true); }} aria-label={`Remove the exception on ${dateLabel(g.date)} for ${nameOf(g.userId)}`}>
                    <Trash2 className="size-4" />Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog open={removeOpen} onOpenChange={setRemoveOpen} title="Remove this exception?" confirmLabel="Remove" danger loading={busy("remove")}
        description={removing ? `${dateLabel(removing.date)}, ${nameOf(removing.userId)}. The usual weekly hours apply again that day.` : undefined}
        onConfirm={async () => { if (removing && (await run("remove", () => clearDayExceptionAction(scope.orgId, { userId: removing.userId, date: removing.date }), "Exception removed."))) setRemoveOpen(false); }} />
    </div>
  );
}
