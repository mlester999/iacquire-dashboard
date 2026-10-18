"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertCircle, CheckCircle2, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { activateCalendarAction, applyCalendarHoursTemplateAction, verifyCalendarAction } from "@/app/actions/crm-calendar-activation";
import { useCrmAction } from "@/components/crm/ui";
import { DRAFT_EXPLAINER, DraftBadge } from "@/components/crm/scheduling/settings/shared";
import { WEEK_ORDER, WEEKDAY_NAMES, rangeLabel } from "@/components/crm/scheduling/settings/hours";
import { dateTimeIn } from "@/components/crm/scheduling/format";
import type { CalendarCheck, CalendarVerification } from "@/server/calendars/activation";
import type { CalendarView } from "@/server/calendars/setup";
import type { CrmScope } from "@/server/crm/page";

/** Where to fix each failing check. */
function fixFor(c: CalendarCheck, base: string, calendarId: string, onEditHosts?: () => void): { label: string; href?: string; onClick?: () => void } | null {
  if (c.ok) return null;
  const person = c.people?.[0]?.userId;
  switch (c.key) {
    case "hosts":
      return onEditHosts ? { label: "Choose hosts", onClick: onEditHosts } : null;
    case "hours":
    case "timezone":
      return { label: "Open availability", href: `${base}/availability${person ? `?person=${person}` : ""}` };
    case "types":
      return { label: "Add an appointment type", href: `${base}/calendars/${calendarId}#types-h` };
    case "connections":
      return { label: "Calendar connections", href: `${base}/calendar-connections` };
    case "slot":
      return { label: "Open availability", href: `${base}/availability` };
  }
}

/** The Blueprint's suggested weekly hours, one line per open day, Monday first. */
function hoursSummary(rules: CalendarView["hoursTemplate"]): string[] {
  return WEEK_ORDER.filter((d) => rules.some((r) => r.weekday === d)).map((d) => `${WEEKDAY_NAMES[d]}: ${rules.filter((r) => r.weekday === d).map(rangeLabel).join(", ")}`);
}

/**
 * A draft calendar's way to go live: what a draft is, every activation check with what to fix, the Blueprint's suggested hours, and the
 * Activate button. The checks come from the server (run when the page loads, and again on "Check again"); Activate re-runs them all on the
 * server and only activates when every one passes.
 */
export function VerifyPanel({ scope, calendar, verification, onEditHosts }: { scope: CrmScope; calendar: CalendarView; verification: CalendarVerification | null; onEditHosts?: () => void }) {
  const { run, busy } = useCrmAction();
  const canManage = !!scope.can["calendars.manage"] && !scope.readOnly;
  const [current, setCurrent] = React.useState(verification);
  const [seen, setSeen] = React.useState(verification);
  // A refreshed page brings fresh checks; show them.
  if (verification !== seen) {
    setSeen(verification);
    setCurrent(verification);
  }
  const tz = scope.timezone || "UTC";
  const suggested = hoursSummary(calendar.hoursTemplate);
  const passing = current?.checks.filter((c) => c.ok).length ?? 0;

  async function checkAgain() {
    const v = await run("verify", () => verifyCalendarAction(scope.orgId, calendar.id));
    if (v && typeof v === "object") setCurrent(v);
  }

  async function activate() {
    const res = await run("activate", () => activateCalendarAction(scope.orgId, calendar.id), (r) => (r.activated ? `${calendar.name} is active and can take bookings.${r.madeDefault ? " It is now your default calendar." : ""}` : null));
    if (res && typeof res === "object") {
      setCurrent(res.verification);
      if (!res.activated && !res.alreadyActive) toast.error("Not every check passes yet. Fix what's listed, then activate.");
    }
  }

  return (
    <Card className="p-5" id="verify">
      <section aria-labelledby="verify-h" className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldCheck className="size-4 text-muted" aria-hidden />
              <h2 id="verify-h" className="text-[15px] font-semibold tracking-tight text-ink">Verify and activate</h2>
              <DraftBadge />
            </div>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted">
              {DRAFT_EXPLAINER} {calendar.origin === "blueprint" ? "It was created from a Blueprint, which never carries people or connections, so this workspace sets those up here." : ""}
            </p>
          </div>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={checkAgain} loading={busy("verify")}><RefreshCw className="size-4" />Check again</Button>
              <Button size="sm" onClick={activate} loading={busy("activate")} disabled={!current?.ok}>Activate calendar</Button>
            </div>
          )}
        </div>

        {suggested.length > 0 && (
          <div className="rounded-xl border border-line bg-surface-2/60 p-3 text-[12.5px] text-ink-2">
            <p className="font-medium text-ink">Suggested working hours{calendar.suggestedTimezone ? ` (${calendar.suggestedTimezone})` : ""}</p>
            <ul className="mt-1 space-y-0.5">{suggested.map((line) => <li key={line}>{line}</li>)}</ul>
            <p className="mt-1.5 text-muted">Hours belong to each person and apply to every calendar they host, so only hosts with no weekly hours yet receive these.</p>
            {canManage && (
              <Button className="mt-2" variant="secondary" size="sm" loading={busy("hours")}
                onClick={() => run("hours", () => applyCalendarHoursTemplateAction(scope.orgId, calendar.id), (r) => (r.applied.length ? `Suggested hours given to ${r.applied.length} ${r.applied.length === 1 ? "host" : "hosts"}.` : "Every host already has their own hours, so nothing changed."))}>
                Use for hosts without hours
              </Button>
            )}
          </div>
        )}

        {current ? (
          <div>
            <p className="text-[12.5px] text-muted" role="status">{passing} of {current.checks.length} checks pass{current.ok ? ". Ready to activate." : "."}</p>
            <ul className="mt-2 divide-y divide-line rounded-xl border border-line" aria-label="Activation checks">
              {current.checks.map((c) => {
                const fix = canManage ? fixFor(c, scope.base, calendar.id, onEditHosts) : null;
                return (
                  <li key={c.key} className="flex items-start gap-3 px-3 py-2.5">
                    {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> : <AlertCircle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />}
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-ink">{c.label}<span className="sr-only">: {c.ok ? "passes" : "needs attention"}</span></p>
                      <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-2">{c.detail}</p>
                      {c.key === "slot" && c.ok && current.firstOpenTime && <p className="mt-0.5 text-[12.5px] text-muted">First open time: {dateTimeIn(current.firstOpenTime.start, tz)}.</p>}
                    </div>
                    {fix && (fix.href
                      ? <Link href={fix.href} className="shrink-0 text-[12.5px] font-medium text-primary hover:underline">{fix.label}</Link>
                      : <button type="button" onClick={fix.onClick} className="shrink-0 text-[12.5px] font-medium text-primary hover:underline">{fix.label}</button>)}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <p className="text-[12.5px] text-muted">{canManage ? "Run the checks to see what this calendar still needs." : "Someone who manages calendars verifies and activates it."}</p>
        )}
        {canManage && !current && <Button variant="secondary" size="sm" onClick={checkAgain} loading={busy("verify")}>Run the checks</Button>}
      </section>
    </Card>
  );
}
