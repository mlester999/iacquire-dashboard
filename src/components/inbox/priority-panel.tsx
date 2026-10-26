"use client";

import * as React from "react";
import Link from "next/link";
import { Gauge, PhoneMissed } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { PriorityBadge } from "@/components/crm/priority/priority-ui";
import { LEAD_LABEL_TEXT } from "@/lib/lead-scoring/types";
import { caseStatusLabel } from "@/lib/missed-calls/state";
import { relativeTime } from "@/lib/utils";
import type { PriorityView } from "@/server/lead-scoring/priority";
import type { CaseView } from "@/server/missed-calls/ops";

// The two things the team needs next to a conversation: how promising this lead is and why, and whether a missed call from them is still waiting for
// an answer. Short on purpose; the full explanation lives on the contact, and the follow-up on the Calls page.

function Card({ title, icon: Icon, action, children }: { title: string; icon: React.ComponentType<{ className?: string }>; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-[14px] font-semibold"><Icon className="size-4 text-muted" aria-hidden />{title}</h2>
        {action}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

export function InboxPriorityCard({ view, contactHref }: { view: PriorityView; contactHref: string; timeZone?: string }) {
  const a = view.assessment;
  const top = (a?.factors ?? []).filter((f) => f.points !== 0 && f.dimension !== "completeness").slice(0, 3);
  const missing = (a?.missing ?? []).filter((m) => m.dimension !== "completeness").slice(0, 3);
  return (
    <Card title="Lead priority" icon={Gauge} action={<Link href={contactHref} className="-mx-2 -my-2 inline-block px-2 py-2 text-[12px] text-primary">Why</Link>}>
      <div className="space-y-2 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <PriorityBadge label={view.label} score={view.score} source={view.source} />
          {view.evaluatedAt && <span className="text-muted">checked {relativeTime(view.evaluatedAt)}</span>}
        </div>
        {view.reason && <p className="leading-relaxed text-ink-2">{view.reason}</p>}
        {view.override && view.engineSays && (
          <p className="text-muted">The rules say {LEAD_LABEL_TEXT[view.engineSays.label]}{view.engineSays.score !== null ? ` (${view.engineSays.score})` : ""}; {view.override.setBy ?? "a teammate"}&apos;s call stays.</p>
        )}
        {top.length > 0 && (
          <ul className="space-y-0.5">
            {top.map((f) => (
              <li key={f.key} className="flex gap-2">
                <span className={f.points > 0 ? "text-success-ink" : "text-danger-ink"} aria-hidden>{f.points > 0 ? "+" : "-"}</span>
                <span className="text-ink-2">{f.label}<span className="sr-only">, {f.points > 0 ? "adds" : "subtracts"} {Math.abs(f.points)} points</span></span>
              </li>
            ))}
          </ul>
        )}
        {missing.length > 0 && <p className="text-muted">Would help to know: {missing.map((m) => m.label.toLowerCase()).join(", ")}.</p>}
        {a?.nextAction?.label && <p className="rounded-lg bg-surface-2 px-2.5 py-1.5"><span className="font-medium text-ink">Next:</span> <span className="text-ink-2">{a.nextAction.label}</span></p>}
        {!view.label && <p className="text-muted">Not assessed yet. It will be checked shortly.</p>}
      </div>
    </Card>
  );
}

export function InboxMissedCallCard({ view }: { view: CaseView; timeZone?: string }) {
  return (
    <Card title="Missed call" icon={PhoneMissed} action={<Link href={`/crm/calls?tab=recovery&case=${view.id}`} className="-mx-2 -my-2 inline-block px-2 py-2 text-[12px] text-primary">Open</Link>}>
      <div className="space-y-1.5 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="warning">{caseStatusLabel(view.state, view.stateReason)}</Badge>
          {view.paused && <Badge tone="outline">Paused</Badge>}
          {view.afterHours && <Badge tone="outline">After hours</Badge>}
        </div>
        <p className="text-ink-2">{view.classificationLabel}, {relativeTime(view.lastCalledAt)}{view.callCount > 1 ? ` (${view.callCount} calls)` : ""}.</p>
        <p className="text-muted">{view.owner.name ? `Owner: ${view.owner.name}.` : "Nobody owns this yet."}{view.attempts ? ` ${view.attempts} text${view.attempts === 1 ? "" : "s"} tried.` : ""}</p>
      </div>
    </Card>
  );
}
