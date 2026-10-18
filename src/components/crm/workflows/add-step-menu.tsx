"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { StepIcon, stepTone } from "@/components/crm/workflows/parts";
import type { KindChoice } from "@/components/crm/workflows/editor-logic";

/** The round "+" between two steps: a menu of step kinds, grouped, with a note next to any that isn't ready to use yet. */
export function AddStepMenu({ label, choices, onPick, compact }: { label: string; choices: KindChoice[]; onPick: (kind: string) => void; compact?: boolean }) {
  const groups = [...new Set(choices.map((c) => c.group))];
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className={cn(
            "inline-flex items-center justify-center rounded-full border border-line-strong bg-surface text-muted shadow-soft transition-colors hover:border-primary hover:bg-primary-soft hover:text-primary-ink",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary data-[state=open]:border-primary data-[state=open]:bg-primary-soft data-[state=open]:text-primary-ink",
            compact ? "size-11 sm:size-7" : "size-11 sm:size-8",
          )}
        >
          <Plus className="size-4" aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent align="center" className="max-h-[min(70dvh,560px)] w-[min(92vw,340px)] overflow-y-auto">
        {groups.map((g, gi) => (
          <React.Fragment key={g}>
            {gi > 0 && <MenuSeparator />}
            <MenuLabel>{g}</MenuLabel>
            {choices.filter((c) => c.group === g).map((c) => (
              <MenuItem key={c.kind} onSelect={() => onPick(c.kind)} className="items-start">
                <span className={cn("mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg", stepTone(c.kind))}><StepIcon kind={c.kind} className="size-3.5" /></span>
                <span className="min-w-0">
                  <span className="block font-medium text-ink">{c.label}</span>
                  <span className="block text-[12px] leading-snug text-muted">{c.description}</span>
                  {c.note && <span className="mt-0.5 block text-[12px] leading-snug text-warning-ink">{c.note}</span>}
                </span>
              </MenuItem>
            ))}
          </React.Fragment>
        ))}
      </MenuContent>
    </Menu>
  );
}
