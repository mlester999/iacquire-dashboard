"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, LockKeyhole, PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { openHelp } from "@/components/help/help-widget";

export function NotConnected({ title, body, canRequest = true }: { title: string; body: string; canRequest?: boolean }) {
  return (
    <Card className="relative overflow-hidden">
      <div aria-hidden className="dot-grid absolute inset-0 opacity-50 [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]" />
      <div className="relative grid gap-6 px-5 py-7 sm:px-7 lg:grid-cols-[1fr_240px] lg:items-center">
        <div><span className="mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-muted"><PlugZap className="size-3.5" /> Connection needed</span>
        <h2 className="text-[21px] font-semibold tracking-tight">{title}</h2>
        <p className="mt-3 max-w-xl text-[14px] leading-[1.7] text-muted">{body}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          {canRequest && (
            <Button variant="brand" size="sm" onClick={() => openHelp("human")}>
              Request connection
            </Button>
          )}
          <Link href="/settings/integrations" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
            View integration status <ArrowRight className="size-3.5" />
          </Link>
        </div>
        </div><div className="rounded-2xl border border-line bg-surface-2/70 p-5"><LockKeyhole className="size-6 text-primary-ink" /><h3 className="mt-3 text-sm font-semibold">Your team handles the technical setup.</h3><p className="mt-2 text-xs leading-relaxed text-muted">iAcquire configures secure access and checks readiness. You complete simple business approvals.</p><Link href="/setup" className="mt-4 inline-flex min-h-9 items-center gap-1 text-xs font-medium text-primary-ink">Follow your setup<ArrowRight className="size-3" /></Link></div>
      </div>
    </Card>
  );
}
