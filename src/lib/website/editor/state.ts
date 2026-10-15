// The visual editor's state: the document, undo/redo history, the selection, the page and the device being edited. A document is
// never changed in place, so a history entry is just a reference to an earlier document and costs almost nothing to keep.
import { homePage, type SiteContent } from "../doc";
import { findNode } from "../ops";

export type Device = "desktop" | "tablet" | "mobile";
export const DEVICES: Array<{ id: Device; label: string; width: number }> = [
  { id: "desktop", label: "Desktop", width: 1440 },
  { id: "tablet", label: "Tablet", width: 768 },
  { id: "mobile", label: "Phone", width: 390 },
];
export const deviceWidth = (d: Device) => DEVICES.find((x) => x.id === d)!.width;

export interface EditorState {
  doc: SiteContent;
  past: SiteContent[];
  future: SiteContent[];
  selection: string | null;
  pageId: string;
  device: Device;
  /** The key of the last change, so a burst of typing or a slider drag becomes one undo step. */
  lastKey: string | null;
  lastAt: number;
  /** Increases with every real change to the document. */
  rev: number;
}

export type EditorAction =
  | { type: "commit"; doc: SiteContent; coalesce?: string; at?: number; select?: string | null; page?: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "select"; id: string | null }
  | { type: "page"; id: string }
  | { type: "device"; device: Device }
  /** Replaces the document without touching history (after a save returns a normalized copy). */
  | { type: "adopt"; doc: SiteContent }
  /** Starts over from a different document (a restored version). History is cleared. */
  | { type: "reset"; doc: SiteContent };

export const MAX_HISTORY = 120;
export const COALESCE_MS = 1200;

export function initialState(doc: SiteContent, pageId?: string): EditorState {
  const page = doc.pages.find((p) => p.id === pageId) ?? homePage(doc);
  return { doc, past: [], future: [], selection: null, pageId: page.id, device: "desktop", lastKey: null, lastAt: 0, rev: 0 };
}

/** Keeps the selection and page pointing at things that still exist. */
function settle(state: EditorState, doc: SiteContent): Pick<EditorState, "selection" | "pageId"> {
  const pageId = doc.pages.some((p) => p.id === state.pageId) ? state.pageId : homePage(doc).id;
  const selection = state.selection && findNode(doc, state.selection) ? state.selection : null;
  return { pageId, selection };
}

export function reducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "commit": {
      if (action.doc === state.doc) return state;
      const at = action.at ?? Date.now();
      const merge = Boolean(action.coalesce) && action.coalesce === state.lastKey && at - state.lastAt < COALESCE_MS && state.past.length > 0;
      const past = merge ? state.past : [...state.past, state.doc].slice(-MAX_HISTORY);
      const next: EditorState = { ...state, doc: action.doc, past, future: [], lastKey: action.coalesce ?? null, lastAt: at, rev: state.rev + 1 };
      if (action.select !== undefined) next.selection = action.select;
      if (action.page) next.pageId = action.page;
      return { ...next, ...settleWith(next, action) };
    }
    case "undo": {
      const prev = state.past[state.past.length - 1];
      if (!prev) return state;
      const next: EditorState = { ...state, doc: prev, past: state.past.slice(0, -1), future: [state.doc, ...state.future].slice(0, MAX_HISTORY), lastKey: null, rev: state.rev + 1 };
      return { ...next, ...settle(next, prev) };
    }
    case "redo": {
      const nxt = state.future[0];
      if (!nxt) return state;
      const next: EditorState = { ...state, doc: nxt, past: [...state.past, state.doc].slice(-MAX_HISTORY), future: state.future.slice(1), lastKey: null, rev: state.rev + 1 };
      return { ...next, ...settle(next, nxt) };
    }
    case "select":
      return state.selection === action.id ? state : { ...state, selection: action.id };
    case "page":
      return state.doc.pages.some((p) => p.id === action.id) ? { ...state, pageId: action.id, selection: null } : state;
    case "device":
      return { ...state, device: action.device };
    case "adopt":
      return { ...state, doc: action.doc };
    case "reset": {
      const next: EditorState = { ...initialState(action.doc, state.pageId), device: state.device, rev: state.rev + 1 };
      return next;
    }
  }
}

function settleWith(next: EditorState, action: Extract<EditorAction, { type: "commit" }>): Pick<EditorState, "selection" | "pageId"> {
  const s = settle(next, next.doc);
  return { pageId: action.page && next.doc.pages.some((p) => p.id === action.page) ? action.page : s.pageId, selection: s.selection };
}

export const canUndo = (s: EditorState) => s.past.length > 0;
export const canRedo = (s: EditorState) => s.future.length > 0;
