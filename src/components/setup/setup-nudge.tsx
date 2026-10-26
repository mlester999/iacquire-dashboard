"use client";

import Link from "next/link";
import { ArrowRight, ClipboardCheck } from "lucide-react";
import { Card, ProgressBar } from "@/components/ui/primitives";
import { useShell } from "@/components/shell/shell-context";

/** Overview entry point to the Setup Center. Shows only while setup is under way. */
export function SetupNudge() {
  const { setup } = useShell();
  if (!setup.visible) return null;
  return (
    <Link href="/setup" className="group block rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
      <Card className="flex flex-col gap-4 p-5 transition-[box-shadow,transform,border-color] duration-200 group-hover:-translate-y-0.5 group-hover:border-primary/30 group-hover:shadow-card sm:flex-row sm:items-center">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary-soft text-primary">
          <ClipboardCheck className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium uppercase tracking-wider text-primary">Your setup</p>
          <h2 className="mt-0.5 text-[16px] font-semibold tracking-tight text-ink">
            {setup.percent === null ? "See what we're setting up for you" : `Your system is ${setup.percent}% set up`}
          </h2>
          <p className="mt-0.5 text-[14px] text-muted">
            {setup.needsAttention > 0 ? `${setup.needsAttention} ${setup.needsAttention === 1 ? "thing needs" : "things need"} your attention.` : "Follow what the iAcquire team is building for you."}
          </p>
          {setup.percent !== null && <ProgressBar value={setup.percent} className="mt-3 max-w-md" label="Setup progress" />}
        </div>
        <span className="inline-flex items-center gap-1.5 text-[14px] font-medium text-primary">
          Open setup <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </span>
      </Card>
    </Link>
  );
}
