"use client";

import * as React from "react";
import { ExternalLink, OctagonX } from "lucide-react";
import { cn } from "@/lib/utils";
import { StepIcon, stepTone, TriggerIcon } from "@/components/crm/workflows/parts";
import { DEMO_EDGES, DEMO_NODES, edgePath, nodeBox, stageFrame, type Beat, type Box, type DemoLayout, type DemoNode, type DemoStage } from "@/components/automation-studio/demo/script";

// A drawing of the canvas for the upgrade page's example: the real canvas's node vocabulary (icons, colours, "Reaches out") without the editor
// behind it. Nothing here can be dragged, connected, selected or saved, and nothing reacts to a pointer. The camera frames everything the current
// stage will show, so nodes appearing one by one never move the view; it moves once, smoothly, when the change makes the automation longer.

/** Below this width the canvas uses the phone arrangement. */
const NARROW_BELOW = 480;
const PAD: Record<DemoLayout, { x: number; y: number }> = { wide: { x: 32, y: 22 }, narrow: { x: 12, y: 14 } };

/** The camera for a stage: as large as fits (never above life size), centred across, and with the trigger kept where the longer stage puts it. */
function camera(layout: DemoLayout, stage: DemoStage, size: { w: number; h: number }) {
  const pad = PAD[layout];
  const scaleFor = (f: Box) => Math.min(1, (size.w - pad.x * 2) / f.w, (size.h - pad.y * 2) / f.h);
  const frame = stageFrame(layout, stage);
  const longest = stageFrame(layout, "b");
  const s = scaleFor(frame);
  const top = pad.y + Math.max(0, (size.h - pad.y * 2 - longest.h * scaleFor(longest)) / 2);
  return { s, x: (size.w - frame.w * s) / 2 - frame.x * s, y: top - frame.y * s };
}

function NodeCard({ node, layout }: { node: DemoNode; layout: DemoLayout }) {
  const narrow = layout === "narrow";
  if (node.category === "end") {
    return (
      <div className="demo-node-card flex h-full items-center justify-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-[12px] font-semibold text-ink-2 shadow-soft">
        <OctagonX className="size-3.5 shrink-0 text-muted" aria-hidden />
        {node.title}
        <span className="sr-only">: {node.summary}.</span>
      </div>
    );
  }
  return (
    <div className={cn("demo-node-card relative flex h-full items-start gap-2.5 rounded-2xl border border-line-strong bg-surface shadow-soft", narrow ? "p-2.5" : "p-3")}>
      <span aria-hidden className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-xl", node.category === "trigger" ? "brand-gradient text-white" : stepTone(node.kind))}>
        {node.category === "trigger" ? <TriggerIcon /> : <StepIcon kind={node.kind} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[10px] font-semibold uppercase leading-4 tracking-wider text-faint">{node.meta}</p>
        <p className={cn("truncate font-semibold leading-5 text-ink", narrow ? "text-[13px]" : "text-[13.5px]")}>{node.title}</p>
        <p className={cn("leading-snug text-muted", narrow ? "truncate text-[11.5px]" : "line-clamp-2 text-[12px]")} title={narrow ? node.summary : undefined}>{node.summary}</p>
      </div>
      {node.reachesOut && (
        <span className="absolute -top-2.5 right-3 inline-flex items-center gap-1 rounded-full border border-surface bg-primary-soft px-2 py-px text-[10.5px] font-medium text-primary-ink">
          <ExternalLink className="size-3" aria-hidden />Reaches out
        </span>
      )}
      {node.category === "condition" && <span className="sr-only">Yes: the follow-up task. No: the run ends.</span>}
    </div>
  );
}

export function DemoCanvas({ beat, fresh, className }: { beat: Beat; fresh: { nodes: ReadonlySet<string>; edges: ReadonlySet<string> }; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [size, setSize] = React.useState<{ w: number; h: number } | null>(null);
  // The first frame is placed without motion; after that, a change of stage (or of size) glides.
  const [settled, setSettled] = React.useState(false);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (!width || !height) return;
      setSize((s) => (s && Math.abs(s.w - width) < 1 && Math.abs(s.h - height) < 1 ? s : { w: width, h: height }));
      if (!frame) frame = requestAnimationFrame(() => setSettled(true));
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  const layout: DemoLayout = size && size.w < NARROW_BELOW ? "narrow" : "wide";
  const cam = size ? camera(layout, beat.stage, size) : null;

  return (
    <div ref={ref} className={cn("demo-canvas relative overflow-hidden", className)} role="group" aria-label="Example workflow canvas">
      <div
        className="demo-world"
        data-ready={cam ? "" : undefined}
        data-settled={settled ? "" : undefined}
        style={cam ? { transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.s})` } : undefined}
      >
        <svg aria-hidden className="demo-edges" width="1" height="1" overflow="visible">
          {beat.edges.map((id) => {
            const p = edgePath(layout, beat.stage, DEMO_EDGES[id]);
            if (!p) return null;
            const [x, y] = p.end;
            return (
              <g key={id} className="demo-edge" data-fresh={fresh.edges.has(id) ? "" : undefined}>
                <path className="demo-edge-line" d={p.d} pathLength={1} />
                <path className="demo-edge-head" d={`M${x - 5},${y - 8} L${x + 5},${y - 8} L${x},${y - 1} Z`} />
              </g>
            );
          })}
        </svg>
        {beat.edges.map((id) => {
          const edge = DEMO_EDGES[id];
          const p = edgePath(layout, beat.stage, edge);
          if (!p?.label) return null;
          return (
            <span
              key={`${id}-label`}
              aria-hidden
              className={cn("demo-edge-label absolute left-0 top-0 rounded-full px-2 py-px text-[10.5px] font-semibold", edge.via === "yes" ? "bg-success-soft text-success-ink" : "bg-surface-3 text-ink-2")}
              data-fresh={fresh.edges.has(id) ? "" : undefined}
              style={{ transform: `translate(${p.label[0]}px, ${p.label[1]}px) translate(-50%, -50%)` }}
            >
              {edge.via === "yes" ? "Yes" : "No"}
            </span>
          );
        })}
        <ol aria-label="Steps in the example">
          {beat.nodes.map((id) => {
            const box = nodeBox(layout, beat.stage, id);
            if (!box) return null;
            return (
              <li
                key={id}
                className="demo-node"
                data-node={id}
                data-enter={fresh.nodes.has(id) ? "" : undefined}
                data-active={beat.focus?.includes(id) ? "" : undefined}
                style={{ width: box.w, height: box.h, transform: `translate(${box.x}px, ${box.y}px)` }}
              >
                <NodeCard node={DEMO_NODES[id]} layout={layout} />
              </li>
            );
          })}
        </ol>
      </div>
      <p aria-hidden className={cn("pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-[13px] text-faint transition-opacity duration-300", beat.nodes.length ? "opacity-0" : "opacity-100")}>
        The automation appears here as it’s built
      </p>
    </div>
  );
}
