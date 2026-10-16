"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, LockKeyhole, PlugZap } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { StatusPill } from "@/components/ui/status";
import { openHelp } from "@/components/help/help-widget";

export function NotConnected({ title, body, canRequest = true }: { title: string; body: string; canRequest?: boolean }) {
  return (
    <Card className="relative overflow-hidden">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[3px] bg-gradient-to-r from-warning to-warning/10" />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-warning-soft/70 to-transparent" />
      <div aria-hidden className="dot-grid absolute inset-0 opacity-50 [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]" />
      <div className="relative grid gap-6 px-5 py-7 sm:px-7 lg:grid-cols-[1fr_260px] lg:items-center">
        <div className="min-w-0">
          <div className="mb-4 flex items-center gap-3">
            <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-2xl bg-warning-soft text-warning-ink ring-1 ring-inset ring-warning/25">
              <PlugZap className="size-5" />
            </span>
            <StatusPill tone="warning">Connection needed</StatusPill>
          </div>
          <h2 className="text-[21px] font-semibold tracking-[-0.025em]">{title}</h2>
          <p className="mt-3 max-w-xl text-[14px] leading-[1.7] text-muted">{body}</p>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {canRequest && (
              <Button variant="brand" onClick={() => openHelp("human")}>
                Request connection
              </Button>
            )}
            <ButtonLink href="/settings/integrations" variant="secondary">
              View integration status <ArrowRight className="size-3.5" />
            </ButtonLink>
          </div>
        </div>
        <div className="rounded-2xl bg-surface-2/70 p-5 ring-1 ring-inset ring-line">
          <span aria-hidden className="grid size-10 place-items-center rounded-xl bg-primary-soft text-primary-ink ring-1 ring-inset ring-primary/20">
            <LockKeyhole className="size-5" />
          </span>
          <h3 className="mt-3 text-sm font-semibold">Your team handles the technical setup.</h3>
          <p className="mt-2 text-xs leading-relaxed text-muted">iAcquire configures secure access and checks readiness. You complete simple business approvals.</p>
          <Link href="/setup" className="mt-4 inline-flex min-h-10 items-center gap-1 text-xs font-medium text-primary-ink hover:underline">
            Follow your setup
            <ArrowRight className="size-3" />
          </Link>
        </div>
      </div>
    </Card>
  );
}
