"use client";

import * as React from "react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/overlays";
import { StepIcon } from "@/components/crm/workflows/parts";
import { useCanvasActions } from "@/components/automation-studio/canvas/canvas-context";
import { TRIGGER_ID, type StudioEdgeData } from "@/components/automation-studio/canvas/flow-model";

/** A line between two steps, with a "+" at its middle to put a step on it. A line the builder just drew is drawn into place. */
export function StudioEdge({ id, source, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data, selected, style }: EdgeProps & { data?: StudioEdgeData }) {
  const actions = useCanvasActions();
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 18 });
  const groups = React.useMemo(() => {
    const out = new Map<string, NonNullable<typeof actions>["kinds"]>();
    for (const k of actions?.kinds ?? []) out.set(k.group, [...(out.get(k.group) ?? []), k]);
    return [...out];
  }, [actions?.kinds]);
  return (
    <>
      <path
        id={`${id}-draw`}
        d={path}
        pathLength={1}
        fill="none"
        className="studio-edge-path"
        data-mark={data?.mark ?? undefined}
        stroke="var(--primary)"
        strokeWidth={2.25}
        style={{ display: data?.mark === "added" ? undefined : "none" }}
      />
      <BaseEdge path={path} markerEnd={markerEnd} style={style} interactionWidth={22} />
      {actions && !actions.readOnly && (
        <EdgeLabelRenderer>
          <div className={cn("nodrag nopan pointer-events-auto absolute transition-opacity", selected ? "opacity-100" : "opacity-0 focus-within:opacity-100 hover:opacity-100")} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            <Menu>
              <MenuTrigger asChild>
                <button type="button" aria-label="Add a step here" className="inline-flex size-6 items-center justify-center rounded-full border border-line-strong bg-surface text-ink-2 shadow-soft hover:border-primary hover:text-primary focus-visible:opacity-100"><Plus className="size-3.5" aria-hidden /></button>
              </MenuTrigger>
              <MenuContent align="center" className="max-h-[360px] w-72 overflow-y-auto">
                {groups.map(([group, items]) => (
                  <React.Fragment key={group}>
                    <MenuLabel>{group}</MenuLabel>
                    {items.map((k) => (
                      <MenuItem key={k.kind} onSelect={() => actions.insertOnEdge(k.kind, source === TRIGGER_ID ? TRIGGER_ID : source, data?.via ?? "next")}>
                        <StepIcon kind={k.kind} /><span className="min-w-0"><span className="block truncate">{k.label}</span>{k.note && <span className="block truncate text-[12px] text-warning-ink">{k.note}</span>}</span>
                      </MenuItem>
                    ))}
                  </React.Fragment>
                ))}
              </MenuContent>
            </Menu>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = { studio: StudioEdge };
