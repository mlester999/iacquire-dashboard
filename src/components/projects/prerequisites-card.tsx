import { CheckCircle2, CircleDashed, ClipboardCheck, MinusCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { StatusPill } from "@/components/ui/status";
import { PREREQUISITE_KIND_LABEL, PREREQUISITE_STATUS_LABEL, clientPrerequisiteSentence } from "@/lib/project-prerequisites";
import { formatDate } from "@/lib/utils";
import type { PrerequisiteView } from "@/server/projects/shared";

// "Before we start": what the iAcquire team confirms before work on a custom project starts (or before it is handed over). A read-only list for the client. It says what is
// asked and whether it is done; it never shows who confirmed it, what they wrote down or any payment detail. Nothing here detects a payment or charges anyone.

const ICON = {
  pending: <CircleDashed className="size-5 text-faint" aria-hidden />,
  satisfied: <CheckCircle2 className="size-5 text-success" aria-hidden />,
  waived: <MinusCircle className="size-5 text-muted" aria-hidden />,
} as const;

export function PrerequisitesCard({ items, timeZone }: { items: PrerequisiteView[]; timeZone: string }) {
  if (!items.length) return null;
  const waiting = items.filter((p) => p.required && p.status === "pending").length;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary ring-1 ring-inset ring-primary/15 [&>svg]:size-4"><ClipboardCheck /></span>
          <span className="min-w-0">Before we start</span>
        </CardTitle>
        {waiting > 0 ? <StatusPill tone="warning" size="sm">{waiting} waiting</StatusPill> : <StatusPill tone="success" size="sm">All confirmed</StatusPill>}
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {items.map((p) => (
            <li key={p.id} className="flex gap-3">
              <span className="mt-0.5 shrink-0">{ICON[p.status]}</span>
              <div className="min-w-0">
                <p className="text-[13.5px] font-medium text-ink">{p.label}</p>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">
                  <span className="mr-1.5 font-medium text-ink-2">{PREREQUISITE_KIND_LABEL[p.kind]} · {PREREQUISITE_STATUS_LABEL[p.status]}.</span>
                  {clientPrerequisiteSentence(p)}
                  {p.satisfiedAt ? ` Confirmed ${formatDate(p.satisfiedAt, timeZone)}.` : p.waivedAt ? ` Decided ${formatDate(p.waivedAt, timeZone)}.` : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[12px] leading-relaxed text-muted">A person on the iAcquire team checks each item and writes down what they checked. Nothing here takes a payment.</p>
      </CardContent>
    </Card>
  );
}
