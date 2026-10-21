"use client";

import * as React from "react";
import type { KindChoice } from "@/components/crm/workflows/editor-logic";

/** What the lines on the canvas need from the editor: the kinds a "+" can add, and how to add one. Held in context so a custom edge stays a plain component. */
export interface CanvasActions {
  kinds: KindChoice[];
  readOnly: boolean;
  /** Adds a step of this kind on the line from `source` (through `via`), so what followed it now follows the new step. */
  insertOnEdge: (kind: string, source: string, via: "next" | "yes" | "no") => void;
}

export const CanvasActionsContext = React.createContext<CanvasActions | null>(null);
export const useCanvasActions = () => React.useContext(CanvasActionsContext);
