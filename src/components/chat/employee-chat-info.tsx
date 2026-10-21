"use client";

import { Info } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import type { EmployeeReadiness } from "@/lib/workforce-readiness";

/** Optional details for the current employee; agency-only limits stay scoped to agency chat. */
export function EmployeeChatInfo({ agentName, roleTitle, readiness, operationsSnapshot, hasPendingReview, canConfigure, profileHref, manageHref }: {
  agentName: string;
  roleTitle: string;
  readiness: EmployeeReadiness;
  operationsSnapshot: boolean;
  hasPendingReview: boolean;
  canConfigure: boolean;
  profileHref: string;
  manageHref: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Employee information" className="size-10 motion-reduce:transition-none">
          <Info className="size-4" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Employee information" align="end" className="max-h-[min(560px,calc(100dvh-100px))] w-[min(360px,calc(100vw-24px))] overflow-y-auto p-4">
        <h2 className="break-words text-[14px] font-semibold text-ink">{agentName}</h2>
        {agentName !== roleTitle && <p className="mt-0.5 text-[12px] text-muted">{roleTitle}</p>}
        <p className="mt-3 text-[12px] font-medium text-ink-2">{readiness.label}</p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{readiness.description}</p>
        {hasPendingReview && <p className="mt-3 text-[12px] text-warning-ink">Configuration review pending. The requested changes are not active.</p>}
        {operationsSnapshot && (
          <div className="mt-3 border-t border-line pt-3">
            <h3 className="text-[13px] font-semibold tracking-tight text-ink">Read-only workspace snapshot</h3>
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
              Before each authorized run, {agentName} receives a fresh, bounded snapshot of the internal records they are allowed to read. It stays point-in-time; there is no live refresh during a run.
            </p>
            <p className="mt-3 text-[12px] leading-relaxed text-ink-2">
              {agentName} can discuss and summarize that context in chat. They cannot create or update records, take other write actions, create or decide approvals, save workspace summaries, or send messages externally.
            </p>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
          <ButtonLink href={profileHref} prefetch={false} variant="secondary" size="sm">View employee</ButtonLink>
          {canConfigure && <ButtonLink href={manageHref} prefetch={false} variant="ghost" size="sm">Manage employee</ButtonLink>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
