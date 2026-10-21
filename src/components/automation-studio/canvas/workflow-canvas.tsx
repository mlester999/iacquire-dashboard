"use client";

import * as React from "react";
import {
  Background, BackgroundVariant, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow,
  type Connection, type Edge, type Node, type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@/components/automation-studio/canvas/studio.css";
import { LayoutGrid } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { kindChoices, newStep } from "@/components/crm/workflows/editor-logic";
import type { Names } from "@/components/crm/workflows/summaries";
import type { EditorOptions } from "@/components/crm/workflows/types";
import { STEP_KINDS, type StepKind } from "@/lib/crm/workflow/spec";
import { CanvasActionsContext } from "@/components/automation-studio/canvas/canvas-context";
import { edgeTypes } from "@/components/automation-studio/canvas/edges";
import { nodeTypes } from "@/components/automation-studio/canvas/nodes";
import { TRIGGER_ID, positions, sourceHandles, toFlow, type StudioNode } from "@/components/automation-studio/canvas/flow-model";
import { onConnect, onEdgeDelete, onInsertAfter, onNodeDelete, onNodeDragStop, onPaletteDrop, onTidy, type Gesture } from "@/components/automation-studio/canvas/gestures";
import type { StudioEditor } from "@/components/automation-studio/editor/use-studio-editor";

export const PALETTE_MIME = "application/x-automation-studio-kind";

export interface WorkflowCanvasProps {
  editor: StudioEditor;
  names: Names;
  options: EditorOptions;
  /** A step's key, or TRIGGER_ID. */
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  /** Bump to fit the whole workflow in view. */
  fitSignal?: number;
  className?: string;
}

const REMOVED_MS = 420;

function Canvas({ editor, names, options, selectedKey, onSelect, fitSignal = 0, className }: WorkflowCanvasProps) {
  const rf = useReactFlow();
  const locked = editor.readOnly || editor.locked;
  const flow = React.useMemo(
    () => toFlow({ def: editor.definition, names, issues: editor.issues, marks: editor.marks, addedEdges: editor.addedEdges, readOnly: locked }),
    [editor.definition, names, editor.issues, editor.marks, editor.addedEdges, locked],
  );

  // React Flow holds the dragged position while a node is moving; everything else comes from the definition.
  const [nodes, setNodes] = React.useState<StudioNode[]>(flow.nodes);
  const dragging = React.useRef(false);
  const previous = React.useRef<StudioNode[]>(flow.nodes);
  const [ghosts, setGhosts] = React.useState<StudioNode[]>([]);
  React.useEffect(() => {
    if (dragging.current) return;
    const ids = new Set(flow.nodes.map((n) => n.id));
    const gone = previous.current.filter((n) => !ids.has(n.id) && n.id !== TRIGGER_ID);
    previous.current = flow.nodes;
    if (gone.length && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      const fading = gone.map((n) => ({ ...n, selectable: false, draggable: false, connectable: false, deletable: false, data: { ...n.data, mark: "removed", readOnly: true } }) as StudioNode);
      setGhosts((g) => [...g, ...fading]);
      const done = new Set(gone.map((n) => n.id));
      setTimeout(() => setGhosts((g) => g.filter((n) => !done.has(n.id))), REMOVED_MS);
    }
    setNodes(flow.nodes);
  }, [flow.nodes]);

  const shown = React.useMemo(
    () => [...nodes, ...ghosts].map((n) => (n.id === selectedKey && !n.selected ? ({ ...n, selected: true } as StudioNode) : n.id !== selectedKey && n.selected ? ({ ...n, selected: false } as StudioNode) : n)),
    [nodes, ghosts, selectedKey],
  );

  const refuse = React.useCallback((g: Gesture) => {
    if (!g.ok) toast.message(g.message);
  }, []);
  const run = React.useCallback((g: Gesture, coalesceKey?: string) => {
    const r = editor.gesture(g, coalesceKey);
    if (!r.ok && r.message) toast.message(r.message);
    return r.ok;
  }, [editor]);

  const handleNodesChange = React.useCallback((changes: NodeChange<StudioNode>[]) => {
    // Only a drag in progress is kept here; selecting, removing and everything else goes through the definition.
    const moves = changes.filter((c) => c.type === "position" || c.type === "dimensions");
    if (moves.length) setNodes((prev) => applyNodeChanges(moves, prev));
  }, []);

  const connect = React.useCallback((c: Connection) => {
    run(onConnect(editor.definition, { source: c.source, sourceHandle: c.sourceHandle, target: c.target }));
  }, [editor.definition, run]);
  const isValidConnection = React.useCallback((c: Edge | Connection) => {
    if (!c.source || !c.target || c.source === c.target) return false;
    const from = editor.definition.steps.find((s) => s.key === c.source);
    if (c.source !== TRIGGER_ID && !from) return false;
    return c.source === TRIGGER_ID || sourceHandles(from!.kind).includes((c.sourceHandle ?? "next") as "next");
  }, [editor.definition]);

  // Deleting with the keyboard: cancelled here and done as an operation instead, so a removal is one undoable change with a reason when refused.
  const beforeDelete = React.useCallback(async ({ nodes: gone, edges: lines }: { nodes: Node[]; edges: Edge[] }) => {
    const ids = new Set(gone.map((n) => n.id));
    for (const n of gone) {
      if (n.id === TRIGGER_ID) continue;
      const g = onNodeDelete(editor.definition, n.id);
      if (g.ok && run(g)) {
        toast.message(g.label, { action: { label: "Undo", onClick: () => { const r = editor.undo(); if (!r.ok && r.message) toast.message(r.message); } } });
      }
    }
    for (const e of lines) {
      if (ids.has(e.source) || ids.has(e.target)) continue;
      const g = onEdgeDelete(editor.definition, { source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null });
      if (g.ok) run(g);
      else refuse(g);
    }
    return false;
  }, [editor, run, refuse]);

  const seed = React.useCallback((kind: StepKind) => newStep(editor.definition.steps, kind, options).config as Record<string, unknown>, [editor.definition.steps, options]);
  const actions = React.useMemo(() => ({
    kinds: kindChoices(options),
    readOnly: locked,
    insertOnEdge: (kind: string, source: string, via: "next" | "yes" | "no") => {
      if (!(kind in STEP_KINDS)) return;
      run(onInsertAfter(editor.definition, kind as StepKind, source === TRIGGER_ID ? null : source, via, seed(kind as StepKind)));
    },
  }), [options, locked, editor.definition, run, seed]);

  const onDrop = React.useCallback((e: React.DragEvent) => {
    const kind = e.dataTransfer.getData(PALETTE_MIME);
    if (!kind) return;
    e.preventDefault();
    if (!(kind in STEP_KINDS)) return;
    const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    // The node's centre lands under the pointer.
    run(onPaletteDrop(editor.definition, kind as StepKind, { x: Math.round(at.x - 132), y: Math.round(at.y - 36) }, seed(kind as StepKind)));
  }, [rf, editor.definition, run, seed]);

  // Fit the whole workflow when it first appears, when asked, and when the builder has finished drawing a change.
  const fit = React.useCallback((duration = 450) => { void rf.fitView({ padding: 0.22, duration, maxZoom: 1.05, minZoom: 0.35 }); }, [rf]);
  React.useEffect(() => { const t = setTimeout(() => fit(0), 60); return () => clearTimeout(t); }, [fit]);
  React.useEffect(() => { if (fitSignal) fit(); }, [fitSignal, fit]);
  const wasAnimating = React.useRef(false);
  React.useEffect(() => {
    if (wasAnimating.current && !editor.animating) fit();
    wasAnimating.current = editor.animating;
  }, [editor.animating, fit]);

  const [gliding, setGliding] = React.useState(false);
  const tidy = () => {
    setGliding(true);
    if (run(onTidy(editor.definition, positions(editor.definition, { ignoreSaved: true })))) setTimeout(() => fit(), 480);
    setTimeout(() => setGliding(false), 700);
  };

  return (
    <CanvasActionsContext.Provider value={actions}>
      <div className={cn("h-full w-full", className)} onDragOver={(e) => { if (e.dataTransfer.types.includes(PALETTE_MIME)) e.preventDefault(); }} onDrop={onDrop}>
        <ReactFlow<StudioNode>
          className={cn("studio-flow", (editor.animating || gliding) && "is-animating", locked && "is-read-only")}
          nodes={shown}
          edges={flow.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={handleNodesChange}
          onNodeClick={(_, n) => onSelect(n.id)}
          onPaneClick={() => onSelect(null)}
          onNodeDragStart={() => { dragging.current = true; }}
          onNodeDragStop={(_, n) => { dragging.current = false; run(onNodeDragStop(editor.definition, n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }), `drag:${n.id}`); }}
          onConnect={connect}
          isValidConnection={isValidConnection}
          onBeforeDelete={beforeDelete as never}
          nodesDraggable={!locked}
          nodesConnectable={!locked}
          deleteKeyCode={locked ? null : ["Backspace", "Delete"]}
          zoomOnDoubleClick={false}
          minZoom={0.25}
          maxZoom={1.6}
          attributionPosition="bottom-center"
          aria-label="Automation canvas"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
          <Controls showInteractive={false} position="bottom-left" aria-label="Canvas controls" />
          {/* An overview is for workflows too big to see at once; on a small one it only sits on top of the steps. */}
          {editor.definition.steps.length >= 8 && <MiniMap pannable zoomable position="bottom-right" className="!hidden lg:!block" style={{ width: 132, height: 88 }} nodeColor="var(--primary)" ariaLabel="Overview of the automation" />}
          {!locked && (
            <Panel position="top-right">
              <Button variant="secondary" size="sm" onClick={tidy} aria-label="Tidy up the steps"><LayoutGrid className="size-3.5" aria-hidden />Tidy up</Button>
            </Panel>
          )}
        </ReactFlow>
      </div>
    </CanvasActionsContext.Provider>
  );
}

/** The interactive canvas: every node, line, drag, drop and delete is one of the workflow operations; nothing here changes the definition on its own. */
export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
