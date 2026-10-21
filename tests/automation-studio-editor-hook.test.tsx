// @vitest-environment jsdom
// The editor state both Automation Studio modes share, rendered the way the development server renders it (React StrictMode mounts, unmounts and
// mounts every component once more). The first browser run found that a "still mounted" flag that was only ever cleared stopped the builder's changes
// from reaching the canvas and stopped saves from finishing, in development only. These tests keep that from coming back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { WorkflowOperation } from "@/lib/crm/workflow/operations";
import type { WorkflowDefinition } from "@/lib/crm/workflow/spec";
import type { EditorOptions } from "@/components/crm/workflows/types";

const save = vi.hoisted(() => vi.fn());
vi.mock("@/app/actions/automation-studio", () => ({ saveStudioDraftAction: save }));

import { useStudioEditor } from "@/components/automation-studio/editor/use-studio-editor";
import { onPaletteDrop } from "@/components/automation-studio/canvas/gestures";

const options = { tags: [], members: [], pipelines: [], contactFields: [], opportunityFields: [], assignmentRules: null, assignmentRuleRefs: [], templates: [], unapprovedTemplates: [], n8nMappings: [], webhooks: [], employees: [], calendars: [], appointmentTypes: [], forms: [], customValues: [], folders: [] } as unknown as EditorOptions;
const empty: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: [] };

const FLOW: WorkflowOperation[] = [
  { op: "add_step", kind: "create_task", key: "welcome", name: "Welcome the lead", config: { title: "Welcome {{contact.full_name}}", priority: "high", assignee: "contact_owner" }, at: { after: null } },
  { op: "add_step", kind: "wait", key: "wait_2d", config: { mode: "duration", amount: 2, unit: "days" }, at: { after: "welcome", via: "next" } },
  { op: "add_step", kind: "internal_note", key: "note", config: { subject: "contact", body: "Waited" }, at: { after: "wait_2d", via: "next" } },
];

// (Testing Library's own switch: a StrictMode wrapper around a hook does not double-invoke its effects.)
const strict = { reactStrictMode: true } as never;
const mount = () => renderHook(() => useStudioEditor({ workflowId: "wf", definition: empty, revision: 1, history: [], options, readOnly: false }), strict);

beforeEach(() => {
  save.mockReset();
  save.mockImplementation(async (_id: string, input: { expectedRevision: number }) => ({ ok: true, data: { revision: input.expectedRevision + 1, issues: [], draftHash: null, seq: 1 } }));
  // Reduced motion: the replay runs without its pauses, which is all these tests need.
  window.matchMedia = ((query: string) => ({ matches: query.includes("prefers-reduced-motion"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("the editor hook under React StrictMode", () => {
  it("replays every operation the builder made, then settles on what the server saved", async () => {
    const { result } = mount();
    const final: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: [
      { key: "welcome", kind: "create_task", name: "Welcome the lead", config: { title: "Welcome {{contact.full_name}}", priority: "high", assignee: "contact_owner" }, next: "wait_2d" },
      { key: "wait_2d", kind: "wait", config: { mode: "duration", amount: 2, unit: "days" }, next: "note" },
      { key: "note", kind: "internal_note", config: { subject: "contact", body: "Waited" }, next: null },
    ] as never };
    await act(async () => { await result.current.replay(FLOW, final, 4, "Built it"); });
    expect(result.current.definition.steps.map((s) => s.key)).toEqual(["welcome", "wait_2d", "note"]);
    expect(result.current.revision).toBe(4);
    expect(result.current.saveState).toBe("saved");
    expect(result.current.animating).toBe(false);
    // The replay is not a second save: the server already has it.
    expect(save).not.toHaveBeenCalled();
    expect(result.current.canUndo).toBe(true);
  });

  it("finishes a save that was started by a change made by hand", async () => {
    const { result } = mount();
    const g = onPaletteDrop(empty, "wait", { x: 0, y: 0 }, { mode: "duration", amount: 1, unit: "days" });
    act(() => { expect(result.current.gesture(g).ok).toBe(true); });
    expect(result.current.definition.steps).toHaveLength(1);
    await waitFor(() => expect(result.current.saveState).toBe("saved"), { timeout: 4000 });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][1]).toMatchObject({ expectedRevision: 1, source: "manual" });
    expect(result.current.revision).toBe(2);
  });

  it("goes back and forward over its own changes", async () => {
    const { result } = mount();
    const g = onPaletteDrop(empty, "wait", { x: 0, y: 0 }, { mode: "duration", amount: 1, unit: "days" });
    act(() => { result.current.gesture(g); });
    await waitFor(() => expect(result.current.saveState).toBe("saved"), { timeout: 4000 });
    act(() => { expect(result.current.undo().ok).toBe(true); });
    expect(result.current.definition.steps).toHaveLength(0);
    act(() => { expect(result.current.redo().ok).toBe(true); });
    expect(result.current.definition.steps).toHaveLength(1);
  });

  it("refuses changes by hand while the builder is working, and when the workflow is read-only", () => {
    const { result } = mount();
    const g = onPaletteDrop(empty, "wait", { x: 0, y: 0 }, { mode: "duration", amount: 1, unit: "days" });
    act(() => result.current.setLocked(true));
    expect(result.current.gesture(g)).toMatchObject({ ok: false, message: expect.stringMatching(/builder is working/) });
    const ro = renderHook(() => useStudioEditor({ workflowId: "wf", definition: empty, revision: 1, history: [], options, readOnly: true }), strict);
    expect(ro.result.current.gesture(g).ok).toBe(false);
  });
});
