import { requireAgency } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { describeRulesForUser, staffWorkloadEnabled } from "@/server/staff-workload/settings";
import { loadWorkloadActor } from "@/server/staff-workload/access";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { WorkloadDenied, WorkloadHeader, WorkloadOff } from "@/components/staff-workload/shell";
import { disableStaffWorkloadFormAction, enableStaffWorkloadFormAction } from "@/app/actions/staff-workload";
import type { WorkloadCaps } from "@/lib/staff-workload/visibility";

export const metadata = { title: "Workload settings" };
export const dynamic = "force-dynamic";

type Rules = Awaited<ReturnType<typeof describeRulesForUser>>;

/** The module switch (Super Admin only) and the rules in force. Editing the rules is a later, separately reviewed change; this page never pretends a proposal is a decision. */
export default async function WorkloadSettingsPage() {
  const user = await requireAgency();
  const superAdmin = user.platformRole === "agency_super_admin";
  const enabled = await staffWorkloadEnabled();
  let rules: Rules | null = null;
  let caps: WorkloadCaps | null = null;
  if (enabled) {
    try {
      const actor = await loadWorkloadActor(user);
      rules = await describeRulesForUser(user);
      caps = actor.caps;
    } catch (error) {
      if (!(error instanceof AppError) || (error.code !== "forbidden" && error.code !== "not_enabled")) throw error;
    }
  }
  return (
    <div className="space-y-5">
      <WorkloadHeader active="settings" showTeam={caps?.team ?? false} showSettings={superAdmin} />
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between gap-2 text-[15px]">
            <span>Module switch</span>
            <Badge tone={enabled ? "success" : "outline"}>{enabled ? "On for the agency workspace" : "Off"}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[13px] leading-relaxed text-muted">
            Staff workload is internal. Switching it on connects nothing, sends nothing and changes no client workspace; the scheduled history job still runs only when the
            scheduler does and only when it is named. Switching it off hides these pages and refuses every request; it deletes nothing.
          </p>
          {superAdmin ? (
            <form action={enabled ? disableStaffWorkloadFormAction : enableStaffWorkloadFormAction}>
              <Button type="submit" variant={enabled ? "secondary" : "brand"}>
                {enabled ? "Switch staff workload off" : "Switch staff workload on"}
              </Button>
            </form>
          ) : (
            <p className="text-[12.5px] text-muted">Only a Super Admin can change this switch.</p>
          )}
        </CardContent>
      </Card>
      {!enabled && !superAdmin && <WorkloadOff canEnable={false} enableAction={enableStaffWorkloadFormAction} />}
      {!enabled && superAdmin && <p className="text-[12.5px] text-muted">The rules below appear once the module is on.</p>}
      {enabled && !caps && <WorkloadDenied />}
      {enabled && caps && rules && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-[15px]">
              <span>Rules in force</span>
              <Badge tone="outline">Revision {rules.revision}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="rounded-xl border border-warning/40 bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-warning-ink">
              Every number below is a proposal from the audit, not a founder-approved rule. Changing them is deliberately not on this page yet.
            </p>
            {rules.problems.length > 0 && (
              <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger-ink">
                The saved rules could not be read, so the defaults are in force: {rules.problems.join("; ")}
              </p>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              {rules.groups.map((group) => (
                <section key={group.group} aria-label={group.group}>
                  <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted">{group.group}</h3>
                  <dl className="divide-y divide-line text-[12.5px]">
                    {group.rows.map((row) => (
                      <div key={row.path} className="flex items-baseline justify-between gap-3 py-1.5">
                        <dt className="min-w-0">
                          <span className="text-ink-2">{row.label}</span>
                          {row.changed && <Badge tone="primary" className="ml-1.5 h-5 px-1.5 text-[10px]">changed</Badge>}
                          {row.help && <span className="mt-0.5 block text-[11px] leading-snug text-muted">{row.help}</span>}
                        </dt>
                        <dd className="shrink-0 font-medium tabular-nums text-ink">{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
