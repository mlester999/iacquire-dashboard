"use client";

import { ChevronDown, Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";

/** Compact, factual disclosure for the internal Operations Manager's read-only context. */
export function OperationsSnapshotDisclosure({ agentName }: { agentName: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="group inline-flex h-8 max-w-full items-center gap-2 rounded-full border border-line bg-surface/80 px-3 text-[11.5px] font-medium text-ink-2 shadow-[0_2px_8px_-5px_rgb(20_30_60/.24)] transition-[background-color,border-color,color,box-shadow] duration-200 hover:border-line-strong hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <Info className="size-3.5 shrink-0 text-muted transition-colors group-hover:text-primary" aria-hidden />
          <span className="truncate">Read-only workspace snapshot</span>
          <ChevronDown className="size-3 shrink-0 text-faint transition-transform duration-200 group-data-[state=open]:rotate-180 motion-reduce:transition-none" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(360px,calc(100vw-24px))] p-4 sm:w-80">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-ink">
            <Info className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold tracking-tight text-ink">Read-only workspace snapshot</h2>
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
              Before each authorized run, {agentName} receives a fresh, bounded snapshot of the internal records they are allowed to read. It stays point-in-time; there is no live refresh during a run.
            </p>
          </div>
        </div>
        <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2.5 text-[12px] leading-relaxed text-ink-2">
          {agentName} can discuss and summarize that context in chat. They cannot create or update records, take other write actions, create or decide approvals, save workspace summaries, or send messages externally.
        </p>
      </PopoverContent>
    </Popover>
  );
}
