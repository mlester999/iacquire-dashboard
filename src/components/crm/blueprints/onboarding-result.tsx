import Link from "next/link";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlanAction } from "@/lib/crm/blueprints/types";
import type { OnboardingBlueprintResult } from "@/server/admin/tenants";
import { requirementLabels } from "@/components/crm/blueprints/labels";

/** "3 created, 2 already matched": only the actions that happened, in plain words. */
export function countsSummary(counts: Partial<Record<PlanAction, number>> | undefined): string {
  if (!counts) return "";
  const parts: string[] = [];
  const add = (n: number | undefined, label: string) => {
    if (n) parts.push(`${n} ${label}`);
  };
  add(counts.create, "created");
  add(counts.link, "already matched");
  add(counts.update, "updated");
  add(counts.skip, "kept as they were");
  add(counts.blocked, "blocked");
  add(counts.conflict, "need a decision");
  return parts.join(", ");
}

/**
 * What happened to the CRM setup chosen while creating a client, shown with the invitation link. The client and the invitation exist in
 * every case, so a failure says so and links to the library's apply flow for this client to try again.
 */
export function OnboardingBlueprintOutcome({ orgId, crmMode, result, chosenName }: { orgId: string; crmMode: "native" | "ghl"; result: OnboardingBlueprintResult | null; chosenName?: string | null }) {
  const checklist = `/admin/clients/${orgId}/crm/settings/blueprints`;
  if (crmMode === "ghl") {
    return (
      <Panel tone="info" title="GoHighLevel CRM">
        This client uses GoHighLevel as its CRM, so no Blueprint was applied. Map its GoHighLevel location on the{" "}
        <Link href={`/admin/clients/${orgId}?tab=integrations`} className="font-medium underline underline-offset-2">client&apos;s Integrations tab</Link>.
      </Panel>
    );
  }
  if (!result) {
    return (
      <Panel tone="info" title="Blank CRM">
        The client starts with an empty native CRM. You can apply a Blueprint later from{" "}
        <Link href="/admin/crm-blueprints" className="font-medium underline underline-offset-2">CRM Blueprints</Link>.
      </Panel>
    );
  }
  const name = result.blueprintName ?? chosenName ?? "The Blueprint";
  const version = result.version ? ` version ${result.version}` : "";
  const reqs = requirementLabels(result.requirements ?? []);
  if (result.status === "failed") {
    return (
      <Panel tone="danger" title="Blueprint not applied">
        <p>
          The client and the invitation were created, but {name}
          {version} wasn&apos;t applied{result.error ? `: ${result.error}` : "."}
        </p>
        <p className="mt-2">
          <Link href={result.retryPath} className="font-medium underline underline-offset-2">Review and apply it again</Link>
        </p>
      </Panel>
    );
  }
  const counts = countsSummary(result.counts);
  return (
    <Panel tone={result.status === "applied" ? "success" : "warning"} title={result.status === "applied" ? "Blueprint applied" : "Blueprint applied in part"}>
      <p>
        {name}
        {version} {result.status === "applied" ? "was copied into this client's CRM" : "was applied, but some items were skipped or blocked"}
        {counts ? ` (${counts}).` : "."} Calendars and workflows are drafts until they are checked and activated.
      </p>
      {reqs.length > 0 && (
        <div className="mt-2">
          <p className="font-medium">Still to set up</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {reqs.slice(0, 6).map((r) => <li key={r}>{r}</li>)}
            {reqs.length > 6 && <li>and {reqs.length - 6} more</li>}
          </ul>
        </div>
      )}
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        <Link href={checklist} className="font-medium underline underline-offset-2">Open the setup checklist</Link>
        {result.status === "partially_applied" && <Link href={result.retryPath} className="font-medium underline underline-offset-2">Review what was skipped</Link>}
      </p>
    </Panel>
  );
}

function Panel({ tone, title, children }: { tone: "info" | "success" | "warning" | "danger"; title: string; children: React.ReactNode }) {
  const Icon = tone === "success" ? CheckCircle2 : tone === "warning" ? AlertTriangle : tone === "danger" ? XCircle : Info;
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3 text-[14px] leading-relaxed",
        tone === "success" && "border-success/30 bg-success-soft text-success-ink",
        tone === "warning" && "border-warning/40 bg-warning-soft text-warning-ink",
        tone === "danger" && "border-danger/30 bg-danger-soft text-danger-ink",
        tone === "info" && "border-line bg-surface-2 text-ink-2",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        <div className="mt-0.5">{children}</div>
      </div>
    </div>
  );
}
