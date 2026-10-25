import Link from "next/link";
import { ArrowLeft, CalendarDays, CalendarX2, Milestone } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { loadWorkloadGate } from "@/server/staff-workload/overview";
import { loadTeamCalendar } from "@/server/staff-workload/calendar";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { ButtonLink } from "@/components/ui/button";
import { SourceBadge } from "@/components/staff-workload/bits";
import { WorkloadDenied, WorkloadHeader, WorkloadOff, TeamOnly } from "@/components/staff-workload/shell";
import { enableStaffWorkloadFormAction } from "@/app/actions/staff-workload";
import { workloadItemHref } from "@/lib/staff-workload/screens";
import { cn } from "@/lib/utils";

export const metadata = { title: "Workload calendar" };
export const dynamic = "force-dynamic";

function dayLabel(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  return date.toLocaleDateString("en", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/** The horizon's dated work and milestones, plus what is already overdue and what nobody dated. */
export default async function WorkloadCalendarPage() {
  const user = await requireAgency();
  const gate = await loadWorkloadGate(user);
  const showSettings = user.platformRole === "agency_super_admin";
  if (gate.kind === "off") {
    return (
      <div className="space-y-5">
        <WorkloadHeader active="calendar" showTeam={false} showSettings={showSettings} />
        <WorkloadOff canEnable={gate.canEnable} enableAction={enableStaffWorkloadFormAction} />
      </div>
    );
  }
  if (gate.kind === "denied") {
    return (
      <div className="space-y-5">
        <WorkloadHeader active="calendar" showTeam={false} showSettings={showSettings} />
        <WorkloadDenied />
      </div>
    );
  }
  if (gate.kind === "mine") {
    return (
      <div className="space-y-5">
        <WorkloadHeader active="calendar" showTeam={gate.mine.caps.team} showSettings={showSettings} />
        <TeamOnly what="The team calendar" />
      </div>
    );
  }
  const data = await loadTeamCalendar(user);
  const names = new Map(gate.team.people.map((p) => [p.userId, p.name]));
  return (
    <div className="space-y-5">
      <WorkloadHeader active="calendar" showTeam showSettings={showSettings} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted">
          {data.calendar.from} to {data.calendar.to} · {data.timeZone}. Milestones carry no points; they are here so a delivery date is not missed.
        </p>
        <ButtonLink href="/admin/workload" variant="ghost" size="sm">
          <ArrowLeft className="size-3.5" aria-hidden /> Overview
        </ButtonLink>
      </div>
      {data.hidden > 0 && <p className="rounded-xl border border-line bg-surface-2 px-4 py-2 text-[12.5px] text-muted">{data.hidden} more {data.hidden === 1 ? "entry is" : "entries are"} counted but hidden from you.</p>}
      {data.calendar.overdue.length > 0 && (
        <Card className="border-danger/30">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-[14px] text-danger-ink">
              <CalendarX2 className="size-4" aria-hidden /> Already overdue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {data.calendar.overdue.map((entry) => (
                <li key={`${entry.source}:${entry.id}`} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                  <span className="min-w-0">
                    {entry.kind === "item" && entry.source !== "milestone" ? (
                      <Link href={workloadItemHref(entry.source, entry.id, entry.orgId)} className="font-medium text-ink hover:text-primary hover:underline">
                        {entry.title}
                      </Link>
                    ) : (
                      <span className="font-medium text-ink">{entry.title}</span>
                    )}
                    <span className="ml-2 text-[12px] text-muted">{entry.assigneeId ? names.get(entry.assigneeId) ?? "Someone" : "Unassigned"}</span>
                  </span>
                  <Badge tone="danger">{entry.day}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <div className="grid gap-3 md:grid-cols-5">
        {data.calendar.days.map((day) => (
          <Card key={day.day} className={cn("min-h-40", day.day === data.today && "border-primary/40 bg-primary-soft/20")}>
            <CardHeader className="pb-1.5">
              <CardTitle className="flex items-center justify-between gap-2 text-[12.5px]">
                <span>{dayLabel(day.day)}</span>
                {day.day === data.today && <Badge tone="primary">Today</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {day.entries.length ? (
                <ul className="space-y-2">
                  {day.entries.map((entry) => (
                    <li key={`${entry.source}:${entry.id}`} className="rounded-lg border border-line bg-surface px-2 py-1.5">
                      <p className="line-clamp-2 text-[12px] font-medium leading-snug text-ink">
                        {entry.kind === "item" && entry.source !== "milestone" ? (
                          <Link href={workloadItemHref(entry.source, entry.id, entry.orgId)} className="hover:text-primary hover:underline">
                            {entry.title}
                          </Link>
                        ) : (
                          entry.title
                        )}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[12px] text-muted">
                        {entry.kind === "milestone" || entry.source === "milestone" ? (
                          <span className="inline-flex items-center gap-1">
                            <Milestone className="size-3" aria-hidden /> Milestone
                          </span>
                        ) : (
                          <SourceBadge source={entry.source} />
                        )}
                        <span>{entry.assigneeId ? names.get(entry.assigneeId) ?? "Someone" : "Unassigned"}</span>
                        {entry.overdue && <span className="font-medium text-danger-ink">overdue</span>}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-2 text-[12px] text-muted">Nothing due.</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      {data.calendar.undated.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-[14px]">
              <CalendarDays className="size-4 text-muted" aria-hidden /> No date recorded
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-1.5 text-[12.5px] text-ink-2 sm:grid-cols-2">
              {data.calendar.undated.map((item) => (
                <li key={`${item.source}:${item.itemId}`}>
                  ·{" "}
                  <Link href={workloadItemHref(item.source, item.itemId, item.orgId)} className="hover:text-primary hover:underline">
                    {item.title}
                  </Link>{" "}
                  <span className="text-muted">({item.orgName})</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[12px] text-muted">These cannot become overdue; the board and the person pages still count their points.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
