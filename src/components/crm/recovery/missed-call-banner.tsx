"use client";

import Link from "next/link";
import { PhoneMissed } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { RelativeTime } from "@/components/crm/relative-time";
import { caseStatusLabel } from "@/lib/missed-calls/state";
import type { CaseView } from "@/server/missed-calls/ops";
import type { CrmScope } from "@/server/crm/page";

/** A missed call from this contact that nobody has settled yet, with where it stands. Shown on the contact page. */
export function MissedCallBanner({ scope, view }: { scope: CrmScope; view: CaseView }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[14px] text-warning-ink" role="status">
      <PhoneMissed className="size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-medium">Missed call</span> <RelativeTime iso={view.lastCalledAt} timezone={scope.timezone} />{view.callCount > 1 ? ` (${view.callCount} calls)` : ""}. {view.classificationLabel}.
      </p>
      <Badge tone="outline">{caseStatusLabel(view.state, view.stateReason)}</Badge>
      {scope.can["calls.view"] && <Link href={`${scope.base}/calls?tab=recovery&case=${view.id}`} className="inline-flex min-h-11 items-center font-medium underline sm:min-h-0">Open</Link>}
    </div>
  );
}
