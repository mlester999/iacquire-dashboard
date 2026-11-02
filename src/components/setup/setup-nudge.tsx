"use client";

import Link from "next/link";
import { ArrowRight, ClipboardCheck } from "lucide-react";
import { Badge, Card, ProgressBar } from "@/components/ui/primitives";
import { useShell } from "@/components/shell/shell-context";

/**
 * Overview entry point to the Setup Center. Shows only while setup is under way. The headline is the launch readiness the ledger last recorded (the same number and label as the Setup
 * page's launch panel); the old checklist's percentage is iAcquire's own preparation and is never shown here as the client's progress. Until the ledger has a state to report there is
 * no number: the card says what it is for instead.
 */
export function SetupNudge() {
  const { setup } = useShell();
  if (!setup.visible) return null;
  const launch = setup.launch;
  const needsYou = launch ? launch.needsYou : setup.needsAttention;
  return (
    <Link href="/setup" className="group block rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
      <Card className="flex flex-col gap-4 p-5 transition-[box-shadow,transform,border-color] duration-200 group-hover:-translate-y-0.5 group-hover:border-primary/30 group-hover:shadow-card sm:flex-row sm:items-center">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary-soft text-primary">
          <ClipboardCheck className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium uppercase tracking-wider text-primary">Your launch</p>
          <h2 className="mt-0.5 flex flex-wrap items-center gap-2 text-[16px] font-semibold tracking-tight text-ink">
            {launch ? `Launch readiness is ${launch.percent}%` : "See what we're setting up for you"}
            {launch && <Badge tone={launch.state === "ready_to_launch" ? "success" : launch.state === "action_required" ? "warning" : launch.state === "ready_for_review" ? "violet" : "primary"}>{launch.label}</Badge>}
          </h2>
          <p className="mt-0.5 text-[14px] text-muted">
            {needsYou > 0 ? `${needsYou} ${needsYou === 1 ? "thing needs" : "things need"} your attention.` : "Follow what the iAcquire team is building for you."}
          </p>
          {launch && <ProgressBar value={launch.percent} tone={launch.state === "ready_to_launch" ? "success" : "primary"} className="mt-3 max-w-md" label="Launch readiness" />}
        </div>
        <span className="inline-flex items-center gap-1.5 text-[14px] font-medium text-primary">
          Open setup <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </span>
      </Card>
    </Link>
  );
}
