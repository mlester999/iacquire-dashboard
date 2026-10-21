"use client";

import * as React from "react";
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider, useReactFlow, useStore } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@/components/automation-studio/canvas/studio.css";
import { cn } from "@/lib/utils";
import { namesFrom } from "@/components/crm/workflows/summaries";
import type { WorkflowDefinition } from "@/lib/crm/workflow/spec";
import { edgeTypes } from "@/components/automation-studio/canvas/edges";
import { nodeTypes } from "@/components/automation-studio/canvas/nodes";
import { NODE_WIDTH, toFlow, type ChangeMark, type StudioNode } from "@/components/automation-studio/canvas/flow-model";

/** A node's height is only known once it is drawn; framing to this estimate lets the view be set before (and whatever) is shown. */
const NODE_HEIGHT_ESTIMATE = 96;

/**
 * Frames the whole graph, every node counted whether it is shown yet or not, so steps appearing one by one never move the view; and again
 * whenever the canvas changes size. Nothing here reacts to a pointer.
 */
function FitToGraph({ bounds, padding, onFitted }: { bounds: { x: number; y: number; width: number; height: number }; padding: number; onFitted: () => void }) {
  const { fitBounds } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  React.useEffect(() => {
    if (!width || !height) return;
    void fitBounds(bounds, { padding, duration: 0 }).then(onFitted);
  }, [bounds, padding, width, height, fitBounds, onFitted]);
  return null;
}

/**
 * The canvas, look-only: for showing what an automation looks like (the upgrade page's example). It cannot be dragged, connected or changed, it
 * does not take over the page's scrolling, and it is always shown with a label that says it is an example. `visible` (by node key, the trigger is
 * "@trigger") limits which nodes are drawn so far, and `marks` / `addedEdges` play the same change motion the editor uses.
 */
export function StaticCanvas({ definition, label, className, visible, marks, addedEdges, fitPadding = 0.08 }: {
  definition: WorkflowDefinition;
  label: string;
  className?: string;
  visible?: ReadonlySet<string>;
  marks?: ReadonlyMap<string, ChangeMark>;
  addedEdges?: ReadonlySet<string>;
  /** Space kept around the graph, as a fraction of its size. */
  fitPadding?: number;
}) {
  const flow = React.useMemo(() => toFlow({ def: definition, names: namesFrom({}), issues: [], readOnly: true, marks, addedEdges }), [definition, marks, addedEdges]);
  const nodes = React.useMemo(() => (visible ? flow.nodes.map((n) => ({ ...n, hidden: !visible.has(n.id) })) : flow.nodes), [flow.nodes, visible]);
  const bounds = React.useMemo(() => {
    const xs = flow.nodes.map((n) => n.position.x);
    const ys = flow.nodes.map((n) => n.position.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) + NODE_WIDTH - x, height: Math.max(...ys) + NODE_HEIGHT_ESTIMATE - y };
  }, [flow.nodes]);
  const [fitted, setFitted] = React.useState(false);
  const onFitted = React.useCallback(() => setFitted(true), []);
  return (
    <div className={cn("relative h-[440px] w-full overflow-hidden rounded-2xl border border-line bg-surface-2", className)} role="group" aria-label={label}>
      <ReactFlowProvider>
        <ReactFlow<StudioNode>
          className={cn("studio-flow is-read-only transition-opacity duration-300", fitted ? "opacity-100" : "opacity-0")}
          nodes={nodes}
          edges={flow.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          minZoom={0.3}
          maxZoom={1}
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
          // React Flow's own switch for its corner link. The library is MIT licensed; its authors ask (but don't require) a Pro subscription when it's hidden.
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
          <FitToGraph bounds={bounds} padding={fitPadding} onFitted={onFitted} />
        </ReactFlow>
      </ReactFlowProvider>
      <span className="pointer-events-none absolute left-3 top-3 rounded-full border border-line bg-surface px-3 py-1 text-[11.5px] font-semibold uppercase tracking-wider text-muted shadow-sm">Example</span>
    </div>
  );
}
