import { ArrowLeft, LayoutGrid, UserRoundCheck } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { loadWorkloadGate } from "@/server/staff-workload/overview";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { ButtonLink } from "@/components/ui/button";
import { OpenWorkList, PersonCard } from "@/components/staff-workload/home";
import { WorkloadDenied, WorkloadHeader, WorkloadOff, TeamOnly } from "@/components/staff-workload/shell";
import { enableStaffWorkloadFormAction } from "@/app/actions/staff-workload";
import { SOURCE_PLURAL, WORK_SOURCES } from "@/lib/staff-workload/sources";

export const metadata = { title: "Workload board" };
export const dynamic = "force-dynamic";

/** The assignment board: the unassigned lane and everyone's load. Assigning goes through the module that owns the item, never through a second write. */
export default async function WorkloadBoardPage() {
  const user = await requireAgency();
  const gate = await loadWorkloadGate(user);
  const showSettings = user.platformRole === "agency_super_admin";
  if (gate.kind === "off") {
    return (
      <div className="space-y-5">
        <WorkloadHeader active="board" showTeam={false} showSettings={showSettings} />
        <WorkloadOff canEnable={gate.canEnable} enableAction={enableStaffWorkloadFormAction} />
      </div>
    );
  }
  if (gate.kind === "denied") {
    return (
      <div className="space-y-5">
        <WorkloadHeader active="board" showTeam={false} showSettings={showSettings} />
        <WorkloadDenied />
      </div>
    );
  }
  if (gate.kind === "mine") {
    return (
      <div className="space-y-5">
        <WorkloadHeader active="board" showTeam={gate.mine.caps.team} showSettings={showSettings} />
        <TeamOnly what="The assignment board" />
      </div>
    );
  }
  const team = gate.team;
  return (
    <div className="space-y-5">
      <WorkloadHeader active="board" showTeam showSettings={showSettings} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[14px] text-muted">
          {team.unassigned.items.length} shown {team.unassigned.items.length === 1 ? "item has" : "items have"} no owner. Only people who can open the client and hold the module&apos;s permission are offered.
        </p>
        <ButtonLink href="/admin/workload" variant="ghost" size="sm">
          <ArrowLeft className="size-3.5" aria-hidden /> Overview
        </ButtonLink>
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-[14px]">
              <LayoutGrid className="size-4 text-warning-ink" aria-hidden /> Unassigned
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="mb-3 flex flex-wrap gap-1.5 text-[12px] text-muted" aria-label="Unassigned by kind">
              {WORK_SOURCES.map((source) => (
                <li key={source} className="rounded-full border border-line bg-surface-2 px-2.5 py-1">
                  {team.unassigned.totals[source]} {SOURCE_PLURAL[source]}
                </li>
              ))}
            </ul>
            <OpenWorkList items={team.unassigned.items} canAssign={team.caps.assign} />
            {team.unassigned.hidden > 0 && <p className="mt-2 text-[12px] text-muted">{team.unassigned.hidden} more {team.unassigned.hidden === 1 ? "item is" : "items are"} counted but hidden from you.</p>}
            {!team.caps.assign && <p className="mt-2 text-[12px] text-muted">Your role can see the board but not give work to others.</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-[14px]">
              <UserRoundCheck className="size-4 text-primary" aria-hidden /> Who has room
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2.5" aria-label="Team load">
              {team.people.map((person) => (
                <PersonCard key={person.userId} person={person} canTeam />
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
      {team.orphaned.items.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-[14px]">Work held by someone who left</CardTitle>
          </CardHeader>
          <CardContent>
            <OpenWorkList items={team.orphaned.items} canAssign={team.caps.assign} showAssignee />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
