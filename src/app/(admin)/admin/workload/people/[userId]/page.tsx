import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarOff, UserRound, Wrench } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { loadPersonWorkload, type PersonWorkload } from "@/server/staff-workload/view";
import { getProfile, listTimeOff, type ProfileView, type TimeOffView } from "@/server/staff-workload/profile";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { ButtonLink } from "@/components/ui/button";
import { LabelPill, LoadMeter } from "@/components/staff-workload/bits";
import { OpenWorkList } from "@/components/staff-workload/home";
import { WorkloadDenied, WorkloadHeader, WorkloadOff } from "@/components/staff-workload/shell";
import { enableStaffWorkloadFormAction } from "@/app/actions/staff-workload";
import { SKILLS, SKILL_LABELS, SKILL_LEVEL_LABELS } from "@/lib/staff-workload/sources";
import { formatPoints } from "@/lib/staff-workload/rules";

export const metadata = { title: "Person workload" };
export const dynamic = "force-dynamic";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default async function PersonWorkloadPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const user = await requireAgency();
  let data: PersonWorkload;
  try {
    data = await loadPersonWorkload(user, userId);
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") notFound();
    if (error instanceof AppError && error.code === "not_enabled") {
      return (
        <div className="space-y-5">
          <WorkloadHeader active="overview" showTeam={false} showSettings={user.platformRole === "agency_super_admin"} />
          <WorkloadOff canEnable={user.platformRole === "agency_super_admin"} enableAction={enableStaffWorkloadFormAction} />
        </div>
      );
    }
    if (error instanceof AppError && error.code === "forbidden") {
      return (
        <div className="space-y-5">
          <WorkloadHeader active="overview" showTeam={false} showSettings={user.platformRole === "agency_super_admin"} />
          <WorkloadDenied />
        </div>
      );
    }
    throw error;
  }
  let profile: ProfileView | null = null;
  let timeOff: TimeOffView[] = [];
  try {
    [profile, timeOff] = await Promise.all([getProfile(user, userId), listTimeOff(user, userId)]);
  } catch (error) {
    const code = error instanceof AppError ? error.code : null;
    if (code !== "forbidden" && code !== "not_found") throw error;
  }
  const person = data.person;
  return (
    <div className="space-y-5">
      <WorkloadHeader active="overview" showTeam={data.caps.team} showSettings={user.platformRole === "agency_super_admin"} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/admin/workload" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
          <ArrowLeft className="size-3.5" aria-hidden /> Team workload
        </Link>
        {data.caps.manage && (
          <ButtonLink href={`/admin/workload/people/${userId}/edit`} variant="secondary" size="sm">
            <Wrench className="size-3.5" aria-hidden /> Capacity, skills and time off
          </ButtonLink>
        )}
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-[15px]">
              <UserRound className="size-4 text-primary" aria-hidden /> {person.name}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[12px] capitalize text-muted">{person.role.replaceAll("_", " ")}</p>
              <LabelPill result={person.result} />
            </div>
            <LoadMeter result={person.result} />
            <ul className="space-y-1.5 text-[12.5px] leading-relaxed text-ink-2">
              {person.result.reasons.map((r) => (
                <li key={r}>· {r}</li>
              ))}
            </ul>
            {profile && (
              <div className="rounded-xl bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-muted">
                <p className="font-medium text-ink-2">Capacity and working days</p>
                <p>Capacity: {profile.capacityPoints === null ? "not set" : `${formatPoints(profile.capacityPoints * 100)} points over the horizon`}.</p>
                <p>Works: {profile.workingDays.map((d) => DAY_NAMES[d - 1]).join(", ")}.</p>
                <p className="mt-1 font-medium text-ink-2">Recorded skills</p>
                {SKILLS.filter((s) => profile.skills[s]).length ? (
                  <p>{SKILLS.filter((s) => profile.skills[s]).map((s) => `${SKILL_LABELS[s]} (${SKILL_LEVEL_LABELS[profile.skills[s] as number]})`).join(" · ")}</p>
                ) : (
                  <p>None recorded, so suggestions do not rank this person on skills.</p>
                )}
              </div>
            )}
            <p className="text-[12px] text-muted">The label counts only work recorded in iAcquire. It is not a score of this person.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-[15px]">Open work</CardTitle>
          </CardHeader>
          <CardContent>
            <OpenWorkList items={person.items} canAssign={data.caps.assign} />
            {person.hiddenItems > 0 && <p className="mt-2 text-[12px] text-muted">{person.hiddenItems} more {person.hiddenItems === 1 ? "item is" : "items are"} counted but hidden from you.</p>}
            {person.items.length === 0 && <p className="mt-2 text-[12px] text-muted">No open work is visible to you for this person.</p>}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-[15px]">
            <CalendarOff className="size-4 text-primary" aria-hidden /> Time off
          </CardTitle>
        </CardHeader>
        <CardContent>
          {timeOff.length ? (
            <ul className="divide-y divide-line text-[13px]">
              {timeOff.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
                  <span>
                    {entry.startsOn === entry.endsOn ? entry.startsOn : `${entry.startsOn} to ${entry.endsOn}`}
                    {entry.partDay ? " · half day" : ""}
                  </span>
                  <span className="flex items-center gap-2 text-[12px] text-muted">
                    {data.timeOffDetail && entry.kind && <Badge tone="outline">{entry.kind}</Badge>}
                    {data.timeOffDetail && entry.note ? entry.note : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">No time off recorded.</p>
          )}
          {!data.timeOffDetail && <p className="mt-2 text-[12px] text-muted">The kind and note of time off are visible only to the person and to the workload manage permission.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
