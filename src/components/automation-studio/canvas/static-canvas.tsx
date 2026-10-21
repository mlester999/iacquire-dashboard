"use client";

import * as React from "react";
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@/components/automation-studio/canvas/studio.css";
import { cn } from "@/lib/utils";
import { namesFrom } from "@/components/crm/workflows/summaries";
import type { WorkflowDefinition } from "@/lib/crm/workflow/spec";
import { edgeTypes } from "@/components/automation-studio/canvas/edges";
import { nodeTypes } from "@/components/automation-studio/canvas/nodes";
import { toFlow, type StudioNode } from "@/components/automation-studio/canvas/flow-model";

/**
 * The canvas, look-only: for showing what an automation looks like (the upgrade page's example). It cannot be dragged, connected or changed, it
 * does not take over the page's scrolling, and it is always shown with a label that says it is an example.
 */
export function StaticCanvas({ definition, label, className }: { definition: WorkflowDefinition; label: string; className?: string }) {
  const flow = React.useMemo(() => toFlow({ def: definition, names: namesFrom({}), issues: [], readOnly: true }), [definition]);
  return (
    <div className={cn("relative h-[440px] w-full overflow-hidden rounded-2xl border border-line bg-surface-2", className)} role="group" aria-label={label}>
      <ReactFlowProvider>
        <ReactFlow<StudioNode>
          className="studio-flow is-read-only"
          nodes={flow.nodes}
          edges={flow.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 0.95 }}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          attributionPosition="bottom-right"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
        </ReactFlow>
      </ReactFlowProvider>
      <span className="pointer-events-none absolute left-3 top-3 rounded-full border border-line bg-surface px-3 py-1 text-[11.5px] font-semibold uppercase tracking-wider text-muted shadow-sm">Example</span>
    </div>
  );
}
