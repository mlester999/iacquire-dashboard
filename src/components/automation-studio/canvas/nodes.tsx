"use client";

import * as React from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { AlertTriangle, ExternalLink, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { StepIcon, stepTone, TriggerIcon } from "@/components/crm/workflows/parts";
import { kindLabel } from "@/components/crm/workflows/summaries";
import { NODE_WIDTH, type StepNodeData, type TriggerNodeData } from "@/components/automation-studio/canvas/flow-model";

/** The trigger: what starts the workflow. It has no input, and one line out to the first step. */
export function TriggerNode({ data, selected }: NodeProps<Node<TriggerNodeData, "trigger">>) {
  return (
    <div
      data-mark={data.mark ?? undefined}
      className={cn("studio-node rounded-2xl border bg-surface p-3 shadow-soft", selected ? "border-primary ring-2 ring-primary/30" : "border-line-strong", data.errors > 0 && "border-danger/60")}
      style={{ width: NODE_WIDTH }}
    >
      <div className="flex items-start gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl brand-gradient text-white"><TriggerIcon /></span>
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-wider text-faint">When this happens</p>
          <p className="truncate text-[13.5px] font-semibold text-ink" title={data.title}>{data.title}</p>
          {data.detail && <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted">{data.detail}</p>}
        </div>
      </div>
      {data.errors > 0 && data.firstProblem && <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-danger-soft px-2 py-1.5 text-[12px] leading-snug text-danger-ink"><AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />{data.firstProblem}</p>}
      <Handle id="next" type="source" position={Position.Bottom} isConnectable={!data.readOnly} title="Connect the trigger to a step" />
    </div>
  );
}

/** One step. Branches (if / else) have two outputs, Yes and No; an End has none. */
export function StepNode({ data, selected }: NodeProps<Node<StepNodeData, "step">>) {
  const branch = data.kind === "branch";
  const end = data.kind === "end";
  const problem = data.errors > 0;
  return (
    <div
      data-mark={data.mark ?? undefined}
      data-kind={data.kind}
      className={cn(
        "studio-node group rounded-2xl border bg-surface p-3 shadow-soft transition-shadow hover:shadow-md",
        selected ? "border-primary ring-2 ring-primary/30" : problem ? "border-danger/60" : "border-line-strong",
      )}
      style={{ width: NODE_WIDTH }}
    >
      <Handle id="in" type="target" position={Position.Top} isConnectable={!data.readOnly} title={`Connect a line to ${data.title}`} />
      <div className="flex items-start gap-3">
        <span className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-xl", stepTone(data.kind))}><StepIcon kind={data.kind} /></span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-faint">
            <span className="tabular-nums">{data.entry ? "First step" : `Step ${data.number}`}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{kindLabel(data.kind)}</span>
          </p>
          <p className="truncate text-[13.5px] font-semibold text-ink" title={data.title}>{data.title}</p>
          {data.summary && <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted">{data.summary}</p>}
        </div>
      </div>
      {(problem || data.warnings > 0 || data.asksApproval || data.outside) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {problem && <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[12px] font-medium text-danger-ink" title={data.firstProblem ?? undefined}><AlertTriangle className="size-3" aria-hidden />Needs attention</span>}
          {!problem && data.warnings > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-[12px] font-medium text-warning-ink" title={data.firstProblem ?? undefined}><AlertTriangle className="size-3" aria-hidden />Heads up</span>}
          {data.asksApproval && <span className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-0.5 text-[12px] font-medium text-ink-2"><ShieldCheck className="size-3" aria-hidden />Asks first</span>}
          {data.outside && <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-[12px] font-medium text-primary-ink"><ExternalLink className="size-3" aria-hidden />Reaches out</span>}
        </div>
      )}
      {!end && !branch && <Handle id="next" type="source" position={Position.Bottom} isConnectable={!data.readOnly} title={`Connect ${data.title} to the next step`} />}
      {branch && (
        <>
          {/* Which output is which: a short Yes and No inside the card, each straight above its own handle, so no line or handle ever runs
              through them. The condition is the summary above; hovering a label shows it in full and a screen reader hears it with the label. */}
          <div className="relative -mx-3 mt-2.5 h-5">
            <BranchOutput side="yes" condition={data.branchLabels?.yes} />
            <BranchOutput side="no" condition={data.branchLabels?.no} />
          </div>
          <Handle id="yes" type="source" position={Position.Bottom} style={{ left: "24%" }} isConnectable={!data.readOnly} title={`Connect the Yes path of ${data.title}`} />
          <Handle id="no" type="source" position={Position.Bottom} style={{ left: "76%" }} isConnectable={!data.readOnly} title={`Connect the No path of ${data.title}`} />
        </>
      )}
    </div>
  );
}

/** One output label of an if / else, centred over its handle (24% and 76% of the card, like the handles). */
function BranchOutput({ side, condition }: { side: "yes" | "no"; condition: string | undefined }) {
  const word = side === "yes" ? "Yes" : "No";
  return (
    <span
      data-branch-side={side}
      title={condition ? `${word}: ${condition}` : undefined}
      className={cn(
        "absolute top-0 inline-flex h-5 -translate-x-1/2 items-center rounded-full px-2 text-[12px] font-bold uppercase tracking-wider",
        side === "yes" ? "left-[24%] bg-success-soft text-success-ink" : "left-[76%] bg-surface-3 text-ink-2",
      )}
    >
      {word}
      {condition && <span className="sr-only normal-case">: {condition}</span>}
    </span>
  );
}

export const nodeTypes = { step: StepNode, trigger: TriggerNode };
