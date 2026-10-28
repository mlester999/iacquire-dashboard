import * as React from "react";
import { Check, CircleDashed, Minus } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { provedCapabilityCount, type CapabilityCheck, type CapabilityState } from "@/lib/employee-capability-status";
import { cn } from "@/lib/utils";

const GLYPH: Record<CapabilityState, { icon: React.ReactNode; className: string; word: string }> = {
  yes: { icon: <Check className="size-3.5" aria-hidden />, className: "bg-success-soft text-success-ink ring-success/25", word: "Yes" },
  no: { icon: <Minus className="size-3.5" aria-hidden />, className: "bg-surface-2 text-muted ring-line", word: "No" },
  not_verified: { icon: <CircleDashed className="size-3.5" aria-hidden />, className: "bg-warning-soft text-warning-ink ring-warning/25", word: "Not confirmed" },
};

/**
 * What this employee can actually do right now, one plain line per fact. Customers see the plain sentence; administrators also get the evidence behind it. A fact is only "Yes" when
 * it has been recorded, so this never repeats a green badge it cannot back.
 */
export function CapabilityChecklist({ checks, audience }: { checks: CapabilityCheck[]; audience: "customer" | "admin" }) {
  const { proved, total } = provedCapabilityCount(checks);
  return (
    <Card id="employee-capabilities">
      <CardHeader>
        <div>
          <CardTitle>What this employee can do right now</CardTitle>
          <CardDescription>{proved} of {total} confirmed. Only what has actually been recorded is marked Yes.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {checks.map((check) => {
            const glyph = GLYPH[check.state];
            return (
              <li key={check.key} className="flex items-start gap-3">
                <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ring-1 ring-inset", glyph.className)}>{glyph.icon}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-ink">
                    {check.label} <span className="font-normal text-muted">· {glyph.word}</span>
                  </p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{check.customer}</p>
                  {audience === "admin" && <p className="mt-0.5 text-[12px] leading-relaxed text-faint">{check.admin}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
