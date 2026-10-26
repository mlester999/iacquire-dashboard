import Link from "next/link";
import { ArrowRight, CalendarClock, CircleDot, Flame, FolderKanban, Layers, ShieldAlert, Timer, UserRoundX, Users } from "lucide-react";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { ButtonLink } from "@/components/ui/button";
import { AssignDialog } from "@/components/staff-workload/assign-dialog";
import { LabelPill, LoadMeter, SourceBadge, StatTile } from "@/components/staff-workload/bits";
import { WorkloadDenied, WorkloadOff } from "@/components/staff-workload/shell";
import { DUE_LABELS, WORK_SOURCES } from "@/lib/staff-workload/sources";
import { LABELS, LABEL_TEXT, labelRank } from "@/lib/staff-workload/labels";
import { HEALTH_TEXT } from "@/lib/staff-workload/health";
import { formatPoints } from "@/lib/staff-workload/rules";
import { workloadItemHref } from "@/lib/staff-workload/screens";
import type { WorkloadHome } from "@/server/staff-workload/overview";
import type { ItemView, MyWorkload, PersonView, TeamWorkload } from "@/server/staff-workload/view";
import type { ProjectsHealth } from "@/server/staff-workload/projects";
import type { Escalations } from "@/server/staff-workload/escalations";
import { cn, relativeTime } from "@/lib/utils";

// The team overview and the person's own view. Everything drawn here was already filtered by the services: a hidden item is only ever a count, never a title or a client.

function dueText(item: ItemView): string {
  if (!item.dueDay && !item.dueAt) return "No due date";
  const day = item.dueDay ?? (item.dueAt ? item.dueAt.slice(0, 10) : null);
  const label = item.dueKind ? DUE_LABELS[item.dueKind] : "Due";
  return `${label}: ${day}`;
}

export function OpenWorkList({ items, canAssign, showAssignee = false }: { items: readonly ItemView[]; canAssign: boolean; showAssignee?: boolean }) {
  if (!items.length) return <p className="rounded-xl border border-line bg-surface-2 px-4 py-5 text-[14px] text-muted">Nothing here right now.</p>;
  return (
    <ul className="divide-y divide-line">
      {items.map((item) => {
        const href = workloadItemHref(item.source, item.itemId, item.orgId);
        return (
          <li key={`${item.source}:${item.itemId}`} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <SourceBadge source={item.source} />
                {item.overdue && <Badge tone="danger">Overdue</Badge>}
                {item.escalated && <Badge tone="danger">Escalated</Badge>}
                {item.blocked && <Badge tone="warning">Blocked</Badge>}
                {item.waitingOnClient && <Badge tone="outline">Waiting on client</Badge>}
                {item.ref && <span className="text-[12px] tabular-nums text-muted">{item.ref}</span>}
              </div>
              <Link href={href} className="mt-1 block text-[14px] font-medium text-ink hover:text-primary hover:underline">
                {item.title}
              </Link>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted">
                <span>{item.orgName}</span>
                <span aria-hidden>·</span>
                <span className={cn(item.overdue && "font-medium text-danger-ink")}>{dueText(item)}</span>
                {showAssignee && item.assigneeId && <span>· assigned</span>}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <span className="rounded-lg border border-line bg-surface-2 px-2 py-1 text-[12px] tabular-nums text-ink-2">{formatPoints(item.points * 100)} pts</span>
              {canAssign && <AssignDialog source={item.source} itemId={item.itemId} title={item.title} orgName={item.orgName} assigneeId={item.assigneeId} />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function PersonCard({ person, canTeam }: { person: PersonView; canTeam: boolean }) {
  const inner = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-medium text-ink">{person.name}</p>
          <p className="text-[12px] capitalize text-muted">{person.role.replaceAll("_", " ")}</p>
        </div>
        <LabelPill result={person.result} />
      </div>
      <div className="mt-3">
        <LoadMeter result={person.result} compact />
      </div>
      {person.hiddenItems > 0 && <p className="mt-2 text-[12px] text-muted">{person.hiddenItems} more {person.hiddenItems === 1 ? "item is" : "items are"} counted but hidden from you.</p>}
    </>
  );
  return canTeam ? (
    <li className="rounded-xl border border-line bg-surface p-3 shadow-soft transition hover:border-line-strong">
      <Link href={`/admin/workload/people/${person.userId}`} className="block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
        {inner}
      </Link>
    </li>
  ) : (
    <li className="rounded-xl border border-line bg-surface p-3 shadow-soft">{inner}</li>
  );
}

function Summary({ team }: { team: TeamWorkload }) {
  const unassigned = WORK_SOURCES.reduce((n, s) => n + team.unassigned.totals[s], 0);
  return (
    <div role="group" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6" aria-label="Team at a glance">
      <StatTile label="People" value={team.summary.people} detail={`${team.summary.away} away`} />
      <StatTile label="Overdue items" value={team.summary.overdueItems} tone={team.summary.overdueItems ? "text-danger-ink" : "text-ink"} />
      <StatTile label="Unassigned" value={unassigned} detail={unassigned ? "work nobody owns" : "everything has an owner"} tone={unassigned ? "text-warning-ink" : "text-ink"} />
      <StatTile label="Overloaded" value={team.summary.byLabel.overloaded} tone={team.summary.byLabel.overloaded ? "text-danger-ink" : "text-ink"} />
      <StatTile label="Critical" value={team.summary.byLabel.critical} tone={team.summary.byLabel.critical ? "text-danger-ink" : "text-ink"} />
      <StatTile label="No capacity set" value={team.summary.noLabel} detail="no label is shown" />
    </div>
  );
}

function Attention({ escalations, now }: { escalations: Escalations; now: number }) {
  const entries = escalations.entries.slice(0, 6);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-[14px]">
          <ShieldAlert className="size-4 text-danger-ink" aria-hidden /> Needs attention
        </CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length ? (
          <ul className="divide-y divide-line">
            {entries.map((e) => (
              <li key={`${e.kind}:${e.id}`} className="py-2.5 first:pt-0 last:pb-0">
                <Link href={e.link} className="group flex items-start gap-2">
                  {e.critical ? <Flame className="mt-0.5 size-4 shrink-0 text-danger-ink" aria-hidden /> : <Timer className="mt-0.5 size-4 shrink-0 text-warning-ink" aria-hidden />}
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium text-ink group-hover:text-primary">{e.title}</span>
                    <span className="mt-0.5 block text-[12px] text-muted">
                      {e.orgName ? `${e.orgName} · ` : ""}
                      {e.kind.replaceAll("_", " ")} · {relativeTime(e.since, now)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-3 text-[14px] leading-relaxed text-muted">Nothing is escalated or past its response target. This is from the same records the Requests page uses, not a separate count.</p>
        )}
        {escalations.hidden > 0 && <p className="mt-2 text-[12px] text-muted">{escalations.hidden} more {escalations.hidden === 1 ? "entry is" : "entries are"} counted but hidden from you.</p>}
        {escalations.supportTargetsOff && <p className="mt-2 text-[12px] leading-relaxed text-muted">Support response targets are switched off, so no support request can show as overdue here.</p>}
      </CardContent>
    </Card>
  );
}

function Distribution({ team }: { team: TeamWorkload }) {
  const totalPoints = team.people.reduce((n, p) => n + p.result.pointsCenti, 0);
  const withCapacity = team.people.filter((p) => p.result.capacity !== null);
  const averageShare = withCapacity.length ? Math.round(withCapacity.reduce((n, p) => n + (p.result.ratioPercent ?? 0), 0) / withCapacity.length) : null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-[14px]">
          <Layers className="size-4 text-primary" aria-hidden /> How the work is shared
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-surface-2 px-3 py-2">
            <p className="text-[18px] font-semibold tabular-nums text-ink">{Math.round(totalPoints / 100)}</p>
            <p className="text-[12px] text-muted">open points across the team</p>
          </div>
          <div className="rounded-xl bg-surface-2 px-3 py-2">
            <p className="text-[18px] font-semibold tabular-nums text-ink">{averageShare === null ? "—" : `${averageShare}%`}</p>
            <p className="text-[12px] text-muted">average share of capacity</p>
          </div>
        </div>
        <ul className="space-y-1.5" aria-label="People by label">
          {LABELS.map((label) => (
            <li key={label} className="flex items-center justify-between gap-2 text-[13px]">
              <span className="flex items-center gap-2 text-ink-2">
                <span className={cn("size-2 rounded-full", label === "available" && "bg-success", label === "balanced" && "bg-primary", label === "busy" && "bg-warning", label === "overloaded" && "bg-danger", label === "critical" && "bg-danger")} aria-hidden />
                {LABEL_TEXT[label]}
              </span>
              <span className="tabular-nums text-muted">{team.summary.byLabel[label]}</span>
            </li>
          ))}
        </ul>
        <p className="text-[12px] leading-relaxed text-muted">
          {team.summary.noLabel ? `${team.summary.noLabel} ${team.summary.noLabel === 1 ? "person has" : "people have"} no capacity set, so no label. ` : ""}
          {team.unassigned.items.length ? `${team.unassigned.items.length} shown items have no owner.` : "Every shown item has an owner."} Open work above capacity is not moved automatically; a manager decides.
        </p>
      </CardContent>
    </Card>
  );
}

function ProjectHealth({ health }: { health: ProjectsHealth }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-[14px]">
          <FolderKanban className="size-4 text-primary" aria-hidden /> Project health
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div role="group" className="mb-3 flex flex-wrap gap-2" aria-label="Projects by health">
          {(["off_track", "at_risk", "not_enough_data", "on_track"] as const).map((state) => (
            <Badge key={state} tone={state === "off_track" ? "danger" : state === "at_risk" ? "warning" : state === "on_track" ? "success" : "outline"}>
              {HEALTH_TEXT[state]}: {health.byState[state]}
            </Badge>
          ))}
        </div>
        {health.projects.length ? (
          <ul className="divide-y divide-line">
            {health.projects.slice(0, 6).map((p) => (
              <li key={p.requestId} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <Link href={`/admin/projects/${p.requestId}`} className="min-w-0 text-[14px] font-medium text-ink hover:text-primary hover:underline">
                    {p.title}
                  </Link>
                  <Badge tone={p.health.state === "off_track" ? "danger" : p.health.state === "at_risk" ? "warning" : p.health.state === "on_track" ? "success" : "outline"}>{HEALTH_TEXT[p.health.state]}</Badge>
                </div>
                <p className="mt-0.5 text-[12px] text-muted">
                  {p.orgName}
                  {p.assigneeName ? ` · ${p.assigneeName}` : " · unassigned"}
                  {p.health.progress ? ` · ${p.health.progress.done}/${p.health.progress.total} milestones` : ""}
                  {p.health.waiting === "client" ? " · waiting on the client" : p.health.waiting === "hold" ? " · on hold" : ""}
                </p>
                {p.health.reasons.length > 0 && <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-muted">{p.health.reasons[0]}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-3 text-[14px] text-muted">No open custom projects are visible to you.</p>
        )}
        {health.hidden > 0 && <p className="mt-2 text-[12px] text-muted">{health.hidden} more {health.hidden === 1 ? "project is" : "projects are"} counted but hidden from you.</p>}
      </CardContent>
    </Card>
  );
}

function TeamHome({ team, projects, escalations }: { team: TeamWorkload; projects: ProjectsHealth; escalations: Escalations }) {
  const people = [...team.people].sort((a, b) => labelRank(a.result.label) - labelRank(b.result.label) || (b.result.ratioPercent ?? -1) - (a.result.ratioPercent ?? -1) || a.name.localeCompare(b.name));
  const unassignedShown = team.unassigned.items.slice(0, 8);
  return (
    <div className="space-y-5">
      <Summary team={team} />
      {team.frame.ruleProblems.length > 0 && (
        <p role="alert" className="rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-[14px] text-warning-ink">
          The saved workload rules could not be read ({team.frame.ruleProblems.slice(0, 2).join("; ")}). The defaults in code are in force until a Super Admin saves them again.
        </p>
      )}
      {team.frame.noTeamDefaultCapacity && (
        <p className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13px] leading-relaxed text-ink-2">
          No team default capacity is set, so people without their own capacity have no label. A manager can set a person&apos;s capacity on their page; a Super Admin can set a team default in the rules.
        </p>
      )}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-[14px]">
              <Users className="size-4 text-primary" aria-hidden /> Team load
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2.5 sm:grid-cols-2" aria-label="Team members by load">
              {people.map((person) => (
                <PersonCard key={person.userId} person={person} canTeam />
              ))}
            </ul>
            {people.length === 0 && <p className="text-[14px] text-muted">No active agency people are visible.</p>}
          </CardContent>
        </Card>
        <div className="space-y-5">
          <Attention escalations={escalations} now={new Date(team.frame.now).getTime()} />
          <Distribution team={team} />
        </div>
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <ProjectHealth health={projects} />
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between gap-2 text-[14px]">
              <span className="flex items-center gap-2">
                <CircleDot className="size-4 text-warning-ink" aria-hidden /> Unassigned work
              </span>
              <ButtonLink href="/admin/workload/board" variant="ghost" size="sm">
                Open the board <ArrowRight className="size-3.5" aria-hidden />
              </ButtonLink>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <OpenWorkList items={unassignedShown} canAssign={team.caps.assign} />
            {team.unassigned.items.length > unassignedShown.length && (
              <p className="mt-2 text-[12px] text-muted">Showing {unassignedShown.length} of {team.unassigned.items.length} shown items; the board lists all of them.</p>
            )}
            {team.unassigned.hidden > 0 && <p className="mt-2 text-[12px] text-muted">{team.unassigned.hidden} more {team.unassigned.hidden === 1 ? "item is" : "items are"} counted but hidden from you.</p>}
          </CardContent>
        </Card>
      </div>
      {team.orphaned.items.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-[14px]">
              <UserRoundX className="size-4 text-warning-ink" aria-hidden /> Work held by someone who left
            </CardTitle>
          </CardHeader>
          <CardContent>
            <OpenWorkList items={team.orphaned.items.slice(0, 8)} canAssign={team.caps.assign} showAssignee />
            {team.orphaned.hidden > 0 && <p className="mt-2 text-[12px] text-muted">{team.orphaned.hidden} more {team.orphaned.hidden === 1 ? "item is" : "items are"} hidden from you.</p>}
          </CardContent>
        </Card>
      )}
      <FrameNotes team={team} />
    </div>
  );
}

function FrameNotes({ team }: { team: TeamWorkload }) {
  return (
    <details className="rounded-xl border border-line bg-surface px-4 py-3 text-[12px] leading-relaxed text-muted">
      <summary className="cursor-pointer font-medium text-ink-2">How these numbers are worked out</summary>
      <ul className="mt-2 space-y-1.5">
        {team.frame.notes.statements.map((s) => (
          <li key={s}>· {s}</li>
        ))}
        <li>· {team.frame.notes.countsOnly}</li>
        <li>· {team.frame.notes.notAScore}</li>
      </ul>
      <p className="mt-2">Planning days: {team.frame.dates[0]} to {team.frame.dates[team.frame.dates.length - 1]} ({team.frame.horizonDays} working days, {team.frame.timeZone}).</p>
    </details>
  );
}

export function MyWorkloadView({ mine }: { mine: MyWorkload }) {
  const { me, frame } = mine;
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-[14px]">
              <CalendarClock className="size-4 text-primary" aria-hidden /> Your load
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[14px] font-medium text-ink">{me.name}</p>
              <LabelPill result={me.result} />
            </div>
            <LoadMeter result={me.result} />
            <ul className="space-y-1.5 text-[13px] leading-relaxed text-ink-2">
              {me.result.reasons.map((r) => (
                <li key={r}>· {r}</li>
              ))}
            </ul>
            {me.result.quality.itemsWithoutDueDate > 0 && <p className="text-[12px] text-muted">{me.result.quality.itemsWithoutDueDate} open {me.result.quality.itemsWithoutDueDate === 1 ? "item has" : "items have"} no due date, so they cannot be overdue.</p>}
            {me.result.quality.supportOverdueUnknown > 0 && <p className="text-[12px] text-muted">Support response targets are off, so {me.result.quality.supportOverdueUnknown} support {me.result.quality.supportOverdueUnknown === 1 ? "request" : "requests"} cannot show as overdue.</p>}
            {me.profile && (
              <div className="rounded-xl bg-surface-2 px-3 py-2 text-[12px] text-muted">
                <p>Capacity: {me.profile.capacityPoints ?? "not set"} points over the horizon{me.result.capacitySource === "default" ? " (team default)" : ""}.</p>
                <p>Working days: {me.profile.workingDays.map((d) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d - 1]).join(", ")}.</p>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-[14px]">
              <CircleDot className="size-4 text-primary" aria-hidden /> Your open work
            </CardTitle>
          </CardHeader>
          <CardContent>
            <OpenWorkList items={me.items} canAssign={false} />
            {me.hiddenItems > 0 && <p className="mt-2 text-[12px] text-muted">{me.hiddenItems} more {me.hiddenItems === 1 ? "item is" : "items are"} counted but not shown to you.</p>}
          </CardContent>
        </Card>
      </div>
      <details className="rounded-xl border border-line bg-surface px-4 py-3 text-[12px] leading-relaxed text-muted">
        <summary className="cursor-pointer font-medium text-ink-2">How your labels are worked out</summary>
        <ul className="mt-2 space-y-1.5">
          {frame.notes.statements.map((s) => (
            <li key={s}>· {s}</li>
          ))}
          <li>· {frame.notes.countsOnly}</li>
          <li>· {frame.notes.notAScore}</li>
        </ul>
      </details>
    </div>
  );
}

export function WorkloadHomeView({ data, enableAction }: { data: WorkloadHome; enableAction: () => Promise<void> }) {
  if (data.kind === "off") return <WorkloadOff canEnable={data.canEnable} enableAction={enableAction} />;
  if (data.kind === "denied") return <WorkloadDenied />;
  if (data.kind === "mine") return <MyWorkloadView mine={data.mine} />;
  return <TeamHome team={data.team} projects={data.projects} escalations={data.escalations} />;
}
