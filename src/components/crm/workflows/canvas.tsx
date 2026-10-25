"use client";

import * as React from "react";
import { AlertTriangle, ArrowDown, ArrowUp, CornerDownRight, Hand, MoreHorizontal, OctagonX, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { StepIcon, stepTone, TriggerIcon } from "@/components/crm/workflows/parts";
import { kindLabel } from "@/components/crm/workflows/summaries";
import type { CanvasItem, InsertPoint } from "@/components/crm/workflows/graph";

export interface CanvasIssue {
  severity: "error" | "warning";
  message: string;
}

export interface CanvasProps {
  items: CanvasItem[];
  kinds: Record<string, string>;
  summaries: Record<string, string>;
  /** Labels for a branch's two sides, e.g. "Has tag VIP" / "Otherwise". */
  branchLabels?: Record<string, { yes: string; no: string }>;
  issues: Record<string, CanvasIssue[]>;
  numbers: Record<string, number>;
  /** Steps that wait for a person's approval each time they run. */
  asks?: Record<string, boolean>;
  trigger: { title: string; summary: string; issues: CanvasIssue[] };
  selected: string | null;
  onSelect: (key: string) => void;
  readOnly: boolean;
  /** Renders the "add a step here" control for an insert point (a menu of step kinds). */
  renderAdd?: (at: InsertPoint, label: string) => React.ReactNode;
  canMove?: (key: string, dir: "up" | "down") => boolean;
  onMove?: (key: string, dir: "up" | "down") => void;
  onRemove?: (key: string) => void;
}

/**
 * The workflow as a readable vertical list of cards: the trigger, then each step, with a branch's two paths side by side (stacked on
 * phones and when nested deeply). Every card is a button that opens its settings; moving and removing are menu actions, so nothing needs
 * dragging.
 */
export function WorkflowCanvas(props: CanvasProps) {
  const { trigger, selected, onSelect } = props;
  const triggerSelected = selected === "trigger";
  return (
    <div role="group" className="mx-auto w-full max-w-3xl" aria-label="Workflow steps">
      <div className={cn("rounded-2xl border bg-surface shadow-soft transition-shadow", triggerSelected ? "border-primary ring-4 ring-primary/12" : "border-line")}>
        <button
          type="button"
          onClick={() => onSelect("trigger")}
          aria-pressed={triggerSelected}
          data-step-card="trigger"
          className="flex w-full items-start gap-3 rounded-2xl px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-ink text-surface dark:bg-ink dark:text-bg"><TriggerIcon /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-semibold uppercase tracking-wider text-faint">Starts when</span>
            <span className="block text-[14px] font-semibold text-ink">{trigger.title}</span>
            {trigger.summary && <span className="mt-0.5 block text-[13px] text-muted">{trigger.summary}</span>}
          </span>
          <IssueMark issues={trigger.issues} />
        </button>
      </div>
      <Lane {...props} items={props.items} depth={0} />
    </div>
  );
}

/** A card's problems in words, for screen readers: "2 problems to fix: …" or "1 warning: …". Empty when there are none. */
export function issuesText(issues: readonly CanvasIssue[]): string {
  if (!issues.length) return "";
  const errors = issues.filter((i) => i.severity === "error").length;
  const what = errors ? `${errors} ${errors === 1 ? "problem" : "problems"} to fix` : `${issues.length} ${issues.length === 1 ? "warning" : "warnings"}`;
  return `${what}: ${issues.map((i) => i.message).join(" ")}`;
}

function IssueMark({ issues }: { issues: CanvasIssue[] }) {
  if (!issues.length) return null;
  const errors = issues.filter((i) => i.severity === "error").length;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold", errors ? "bg-danger-soft text-danger-ink" : "bg-warning-soft text-warning-ink")}>
      <AlertTriangle className="size-3.5" aria-hidden />
      <span aria-hidden>{issues.length}</span>
      <span className="sr-only">{issuesText(issues)}</span>
    </span>
  );
}

function Connector({ short }: { short?: boolean }) {
  return <span aria-hidden className={cn("mx-auto block w-px bg-line-strong", short ? "h-3" : "h-5")} />;
}

function Lane(props: CanvasProps & { items: CanvasItem[]; depth: number }) {
  const { items, depth, readOnly, renderAdd } = props;
  return (
    <ol className="flex flex-col items-stretch">
      {items.map((it) => {
        switch (it.type) {
          case "insert":
            return (
              <li key={it.id} className="flex flex-col items-center">
                <Connector short />
                {!readOnly && renderAdd ? renderAdd(it.at, insertLabel(it.at, props)) : null}
                <Connector short />
              </li>
            );
          case "step":
            return <li key={it.key}><StepCard stepKey={it.key} {...props} /></li>;
          case "branch":
            return (
              <li key={it.key}>
                <StepCard stepKey={it.key} {...props} />
                <Connector short />
                <div className={cn("grid gap-3", depth === 0 ? "sm:grid-cols-2" : depth === 1 ? "xl:grid-cols-2" : "")}>
                  {(["yes", "no"] as const).map((side) => (
                    <section
                      key={side}
                      aria-label={`${side === "yes" ? "If yes" : "If no"}: ${props.branchLabels?.[it.key]?.[side] ?? ""}`}
                      className={cn("min-w-0 rounded-2xl border border-dashed p-2 sm:p-3", side === "yes" ? "border-success/40 bg-success-soft/25" : "border-line-strong bg-surface-2/40")}
                    >
                      <p className="flex items-center gap-1.5 px-1 text-[12px] font-semibold text-ink-2">
                        <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[12px] font-bold uppercase tracking-wider", side === "yes" ? "bg-success-soft text-success-ink" : "bg-surface-3 text-ink-2")}>{side === "yes" ? "Yes" : "No"}</span>
                        <span className="truncate font-normal text-muted">{props.branchLabels?.[it.key]?.[side] ?? ""}</span>
                      </p>
                      <Lane {...props} items={side === "yes" ? it.yes : it.no} depth={depth + 1} />
                    </section>
                  ))}
                </div>
                {it.join && <Connector />}
              </li>
            );
          case "join":
            return (
              <li key={it.id} className="flex justify-center">
                <span className="inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium text-muted">
                  <ArrowDown className="size-3.5" aria-hidden />Continues below both paths
                </span>
              </li>
            );
          case "end":
            return (
              <li key={it.id} className="flex justify-center">
                <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 text-[12px] font-medium text-muted">
                  {it.explicit ? <><OctagonX className="size-3.5" aria-hidden />Ends here</> : depth === 0 ? "Workflow ends" : "Path ends"}
                </span>
              </li>
            );
          case "jump":
            return (
              <li key={it.id} className="flex justify-center">
                <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-warning/40 bg-warning-soft px-3 text-[12px] font-medium text-warning-ink">
                  <CornerDownRight className="size-3.5" aria-hidden />Continues at step {props.numbers[it.to] ?? "?"} ({kindLabel(props.kinds[it.to] ?? "")})
                </span>
              </li>
            );
          case "missing":
            return (
              <li key={it.id} className="flex justify-center">
                <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-danger/30 bg-danger-soft px-3 text-[12px] font-medium text-danger-ink">
                  <AlertTriangle className="size-3.5" aria-hidden />Points to a step that no longer exists
                </span>
              </li>
            );
        }
      })}
    </ol>
  );
}

function insertLabel(at: InsertPoint, props: CanvasProps): string {
  if (at.after === null) return "Add the first step";
  const n = props.numbers[at.after];
  if (at.via === "yes") return `Add a step at the start of the “yes” path of step ${n}`;
  if (at.via === "no") return `Add a step at the start of the “no” path of step ${n}`;
  return `Add a step after step ${n}`;
}

function StepCard({ stepKey, kinds, summaries, issues, numbers, asks, selected, onSelect, readOnly, canMove, onMove, onRemove }: CanvasProps & { stepKey: string }) {
  const kind = kinds[stepKey] ?? "";
  const isSelected = selected === stepKey;
  const stepIssues = issues[stepKey] ?? [];
  const n = numbers[stepKey];
  const label = kindLabel(kind);
  return (
    <div className={cn("flex items-start gap-1 rounded-2xl border bg-surface shadow-soft transition-shadow", isSelected ? "border-primary ring-4 ring-primary/12" : stepIssues.some((i) => i.severity === "error") ? "border-danger/40" : "border-line")}>
      <button
        type="button"
        onClick={() => onSelect(stepKey)}
        aria-pressed={isSelected}
        data-step-card={stepKey}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-2xl px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <span className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-xl", stepTone(kind))}><StepIcon kind={kind} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-faint">
            Step {n}
            {asks?.[stepKey] && <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-1.5 py-px text-[12px] normal-case tracking-normal text-warning-ink"><Hand className="size-3" aria-hidden />Asks first</span>}
          </span>
          <span className="block text-[14px] font-semibold text-ink">{label}</span>
          <span className="mt-0.5 block break-words text-[13px] text-muted">{summaries[stepKey] || "Not set up yet"}</span>
        </span>
        <IssueMark issues={stepIssues} />
      </button>
      {!readOnly && (onMove || onRemove) && (
        <div className="py-2 pr-2">
          <Menu>
            <MenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`More for step ${n}, ${label}`}><MoreHorizontal className="size-4" /></Button></MenuTrigger>
            <MenuContent>
              {onMove && (
                <>
                  <MenuItem disabled={!canMove?.(stepKey, "up")} onSelect={() => onMove(stepKey, "up")}><ArrowUp className="size-4" aria-hidden />Move up</MenuItem>
                  <MenuItem disabled={!canMove?.(stepKey, "down")} onSelect={() => onMove(stepKey, "down")}><ArrowDown className="size-4" aria-hidden />Move down</MenuItem>
                  <MenuSeparator />
                </>
              )}
              {onRemove && <MenuItem destructive onSelect={() => onRemove(stepKey)}><Trash2 className="size-4" aria-hidden />{kind === "branch" ? "Remove with both paths" : "Remove step"}</MenuItem>}
            </MenuContent>
          </Menu>
        </div>
      )}
    </div>
  );
}
