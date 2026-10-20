// The workflow screens: the canvas layout and edits over the step graph, plain-language step and trigger summaries, the approval preview,
// the activation rules the editor explains, server-rendered screens with data from the real services, and who may use which action.
// Synthetic workspaces only (pglite in memory); nothing here sends a message or calls an outside system.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

const who = vi.hoisted(() => ({ actor: null as null | import("@/server/crm/actor").CrmActor }));
// The actions resolve their actor from the session; here the test chooses who is acting, and the permission check still runs.
vi.mock("@/server/crm/request", async () => {
  const { assertCan } = await import("@/server/crm/actor");
  return {
    resolveCrmActor: async (_orgId: string | null, permission: import("@/lib/permissions").Permission) => {
      if (!who.actor) throw new Error("No actor chosen for this test.");
      assertCan(who.actor, permission);
      return who.actor;
    },
  };
});
// Screens are rendered to HTML without a browser: navigation is an inert stand-in, and notFound / redirect throw as Next's do.
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  usePathname: () => "/crm/workflows",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));

import { agencyActor, startSupportSession, type CrmActor } from "@/server/crm/actor";
import { scopeFor } from "@/server/crm/page";
import { createContact } from "@/server/crm/contacts";
import { createFolder, createTag } from "@/server/crm/tags";
import { approveTemplate, createTemplate } from "@/server/crm/message-templates";
import { createWorkflow, getWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { startManualRun, startTestRun } from "@/server/crm/workflows/runs";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { WorkflowActivityView, WorkflowsView } from "@/components/crm/views/workflows-view";
import { WorkflowRunView, WorkflowView } from "@/components/crm/views/workflow-view";
import {
  cancelRunAction, cloneWorkflowAction, createWorkflowAction, publishWorkflowAction, requestWorkflowApprovalAction, retryRunStepAction, saveWorkflowDraftAction,
  setWorkflowStatusAction, startTestRunAction,
} from "@/app/actions/crm-workflows";
import { navFor } from "@/lib/crm/nav";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";
import {
  branchJoin, branchMembers, canInsert, canMove, freshKey, insertStep, layoutCanvas, moveStep, orderedKeys, predecessorCounts, removeStep, type CanvasItem, type GraphStep,
} from "@/components/crm/workflows/graph";
import { amountText, clockText, conditionsText, durationText, listText, namesFrom, stepSummary, triggerLine, triggerSummary, weekdaysText } from "@/components/crm/workflows/summaries";
import { STEP_KIND_LIST, validateDefinition, type WorkflowDefinition, type WorkflowStep } from "@/lib/crm/workflow/spec";
import { activationBlocker, effectItems, groupIssues, kindChoices, missingTemplateInputs, newStep, validationContextOf } from "@/components/crm/workflows/editor-logic";
import { runQueryFor, stepResultDetails, toTestRunView, triggerLabelOf } from "@/components/crm/workflows/run-format";
import type { EditorOptions, VersionItem } from "@/components/crm/workflows/types";
import { TriggerPanel } from "@/components/crm/workflows/trigger-panel";
import { StepPanel } from "@/components/crm/workflows/step-panel";

const s = (key: string, kind: string, next: string | null = null, branches?: { yes?: string | null; no?: string | null }): GraphStep => ({ key, kind, next, ...(branches ? { branches } : {}) });
/** A compact picture of a layout: step keys, [branch yes | no], "+" for an insert point, "end"/"END", "→k" for a jump, "join". */
function sketch(items: readonly CanvasItem[]): string {
  return items
    .map((it) => {
      switch (it.type) {
        case "insert":
          return "+";
        case "step":
          return it.key;
        case "branch":
          return `${it.key}[${sketch(it.yes)} | ${sketch(it.no)}]`;
        case "end":
          return it.explicit ? "END" : "end";
        case "join":
          return "join";
        case "jump":
          return `→${it.to}`;
        case "missing":
          return `?${it.to}`;
      }
    })
    .join(" ");
}
const keys = (steps: readonly GraphStep[]) => steps.map((x) => x.key);
const at = (steps: readonly GraphStep[], k: string) => steps.find((x) => x.key === k)!;

describe("canvas layout", () => {
  it("draws a straight path with an insert point before and after every step", () => {
    const { items, unreachable } = layoutCanvas([s("a", "add_tag", "b"), s("b", "wait", "c"), s("c", "create_task")]);
    expect(sketch(items)).toBe("+ a + b + c + end");
    expect(unreachable).toEqual([]);
    expect(sketch(layoutCanvas([]).items)).toBe("+ end");
  });

  it("puts an if / else's two paths side by side and stops at an End step", () => {
    const steps = [s("check", "branch", null, { yes: "tag", no: "stop" }), s("tag", "add_tag", "task"), s("task", "create_task"), s("stop", "end")];
    expect(sketch(layoutCanvas(steps).items)).toBe("+ check[+ tag + task + end | + stop END]");
    expect(orderedKeys(layoutCanvas(steps).items)).toEqual(["check", "tag", "task", "stop"]);
  });

  it("draws the step where both paths meet once, below them", () => {
    const steps = [s("a", "wait", "check"), s("check", "branch", null, { yes: "y1", no: "n1" }), s("y1", "add_tag", "join"), s("n1", "remove_tag", "join"), s("join", "create_task")];
    expect(branchJoin(steps, "check")).toBe("join");
    expect(sketch(layoutCanvas(steps).items)).toBe("+ a + check[+ y1 + join | + n1 + join] join + end");
    // A path straight into the join is an empty path that carries on below.
    const direct = [s("check", "branch", null, { yes: "t", no: "after" }), s("t", "add_tag", "after"), s("after", "create_task")];
    expect(sketch(layoutCanvas(direct).items)).toBe("+ check[+ t + join | + join] after + end");
  });

  it("handles nested branches and finds the outer join past the inner one", () => {
    const steps = [
      s("outer", "branch", null, { yes: "inner", no: "n" }),
      s("inner", "branch", null, { yes: "iy", no: "in" }),
      s("iy", "add_tag", "meet"), s("in", "remove_tag", "meet"),
      s("meet", "wait", "last"), s("n", "notify_team", "last"), s("last", "create_task"),
    ];
    expect(branchJoin(steps, "inner")).toBe("meet");
    expect(branchJoin(steps, "outer")).toBe("last");
    expect(sketch(layoutCanvas(steps).items)).toBe("+ outer[+ inner[+ iy + join | + in + join] meet + join | + n + join] last + end");
    expect(branchMembers(steps, "outer").sort()).toEqual(["in", "inner", "iy", "meet", "n"]);
  });

  it("shows a loop back through a wait as a jump, and reports missing and unreachable steps", () => {
    const loop = [s("w", "wait", "check"), s("check", "branch", null, { yes: "w", no: null })];
    expect(sketch(layoutCanvas(loop).items)).toBe("+ w + check[+ →w | + end]");
    const broken = [s("a", "add_tag", "ghost"), s("orphan", "create_task")];
    const out = layoutCanvas(broken);
    expect(sketch(out.items)).toBe("+ a + ?ghost");
    expect(out.unreachable).toEqual(["orphan"]);
  });
});

describe("canvas edits", () => {
  const base = [s("a", "add_tag", "b"), s("b", "create_task")];

  it("inserts at the start, between steps and at the end, keeping the entry first", () => {
    const first = insertStep(base, { after: null }, s("x", "wait"));
    expect(keys(first)[0]).toBe("x");
    expect(at(first, "x").next).toBe("a");
    const mid = insertStep(base, { after: "a", via: "next" }, s("x", "wait"));
    expect([at(mid, "a").next, at(mid, "x").next]).toEqual(["x", "b"]);
    expect(keys(mid)[0]).toBe("a");
    const end = insertStep(base, { after: "b", via: "next" }, s("x", "notify_team"));
    expect(at(end, "x").next).toBeNull();
    expect(base.map((x) => x.next)).toEqual(["b", null]); // inputs untouched
  });

  it("moves what followed onto the Yes path when an if / else is inserted mid-path", () => {
    const out = insertStep(base, { after: "a", via: "next" }, s("check", "branch"));
    expect(at(out, "check")).toMatchObject({ next: null, branches: { yes: "b", no: null } });
    expect(sketch(layoutCanvas(out).items)).toBe("+ a + check[+ b + end | + end]");
    const side = insertStep(out, { after: "check", via: "no" }, s("n", "remove_tag"));
    expect(at(side, "check").branches).toEqual({ yes: "b", no: "n" });
  });

  it("only puts an End step where nothing follows", () => {
    expect(canInsert(base, { after: "a", via: "next" }, "end")).toBe(false);
    expect(insertStep(base, { after: "a", via: "next" }, s("e", "end"))).toEqual(base);
    expect(canInsert(base, { after: "b", via: "next" }, "end")).toBe(true);
    expect(canInsert(base, { after: "missing", via: "next" }, "add_tag")).toBe(false);
  });

  it("removes a step and reconnects its neighbours, including the entry", () => {
    expect(removeStep(base, "a").map((x) => [x.key, x.next])).toEqual([["b", null]]);
    const three = [s("a", "add_tag", "b"), s("b", "wait", "c"), s("c", "create_task")];
    expect(at(removeStep(three, "b"), "a").next).toBe("c");
  });

  it("removes an if / else with its paths and continues at the join", () => {
    const steps = [s("a", "wait", "check"), s("check", "branch", null, { yes: "y", no: "n" }), s("y", "add_tag", "j"), s("n", "remove_tag", "j"), s("j", "create_task")];
    const out = removeStep(steps, "check");
    expect(keys(out)).toEqual(["a", "j"]);
    expect(at(out, "a").next).toBe("j");
    // As the first step: the join becomes the entry.
    const entry = removeStep(steps.slice(1), "check");
    expect(keys(entry)).toEqual(["j"]);
  });

  it("moves plain steps up and down but never across a branch or a join", () => {
    const three = [s("a", "add_tag", "b"), s("b", "wait", "c"), s("c", "create_task")];
    const down = moveStep(three, "a", "down");
    expect(keys(down)[0]).toBe("b");
    expect([at(down, "b").next, at(down, "a").next, at(down, "c").next]).toEqual(["a", "c", null]);
    const up = moveStep(three, "c", "up");
    expect([at(up, "a").next, at(up, "c").next, at(up, "b").next]).toEqual(["c", "b", null]);
    expect(canMove(three, "a", "up")).toBe(false);
    expect(canMove(three, "c", "down")).toBe(false);
    const joined = [s("check", "branch", null, { yes: "y", no: "j" }), s("y", "add_tag", "j"), s("j", "create_task")];
    expect(predecessorCounts(joined).get("j")).toBe(2);
    expect(canMove(joined, "y", "down")).toBe(false);
    expect(canMove(joined, "j", "up")).toBe(false);
    expect(canMove(joined, "check", "down")).toBe(false);
  });

  it("makes fresh, valid, lower-case keys", () => {
    expect(freshKey([s("send_message", "send_message")], "send_message")).toBe("send_message_2");
    expect(freshKey([], "Weird Kind!")).toBe("weird_kind_");
    expect(freshKey([], "n8n")).toBe("n8n");
  });
});

describe("summaries", () => {
  const names = namesFrom({
    tags: [{ id: "t1", name: "VIP" }, { id: "t2", name: "Hot lead" }, { id: "t3", name: "Webinar" }],
    members: [{ id: "u1", name: "Ana Reyes" }],
    pipelines: [{ id: "p1", name: "Sales", stages: [{ id: "s1", name: "New" }, { id: "s2", name: "Won" }] }],
    contactFields: [{ id: "f1", label: "Renewal date" }],
    templates: [{ id: "m1", name: "Quote follow-up", channel: "sms" }],
    assignmentRules: [{ id: "r1", name: "Website leads" }],
    n8nMappings: [{ id: "n1", label: "Sync to Sheets" }],
    webhooks: [{ id: "w1", name: "Billing system" }],
    employees: [{ roleKey: "sales_assistant", name: "Sales Assistant" }],
  });
  const step = (kind: string, config: Record<string, unknown>) => ({ kind, config }) as unknown as WorkflowStep;

  it("says what each kind of step will do, by name, and what's missing", () => {
    expect(stepSummary(step("wait", { mode: "duration", amount: 2, unit: "days" }), names)).toBe("Wait 2 days");
    expect(stepSummary(step("wait", { mode: "until_time", time: "09:30", weekdays: [1, 2, 3, 4, 5] }), names)).toBe("Wait until 9:30 AM on weekdays");
    expect(stepSummary(step("wait", { mode: "until_date", source: "contact_field", fieldId: "f1", offset: { amount: 1, unit: "days", direction: "before" }, ifMissing: "end" }), names)).toBe("Wait until 1 day before Renewal date (ends the run if there's no date)");
    expect(stepSummary(step("add_tag", { tagIds: ["t1", "t2", "t3"] }), names)).toBe("Add VIP, Hot lead and 1 more");
    expect(stepSummary(step("remove_tag", { tagIds: [] }), names)).toBe("Choose tags");
    expect(stepSummary(step("assign", { subject: "contact", to: "rule", ruleId: "r1", onlyIfUnassigned: true }), names)).toBe("Assign the contact to the next person in “Website leads” if it has no owner");
    expect(stepSummary(step("create_task", { title: "Call {{contact.first_name}}", priority: "high", assignee: "user", userId: "u1", dueIn: { amount: 4, unit: "hours" } }), names)).toBe("Task “Call {{contact.first_name}}” for Ana Reyes, due in 4 hours (high priority)");
    expect(stepSummary(step("update_field", { subject: "contact", field: "lead_status", value: "qualified" }), names)).toBe("Set the contact's lead status to Qualified");
    expect(stepSummary(step("move_stage", { pipelineId: "p1", stageId: "s2" }), names)).toBe("Move the deal to Sales › Won");
    expect(stepSummary(step("send_message", { templateId: "m1", contentHash: "x", channel: "sms", sendAs: "sales_assistant", businessHoursOnly: true }), names)).toBe("Send SMS “Quote follow-up” as Sales Assistant, in business hours");
    expect(stepSummary(step("send_message", { templateId: "gone", contentHash: "x", channel: "email", sendAs: "sales_assistant", businessHoursOnly: false }), names)).toContain("no longer approved");
    expect(stepSummary(step("n8n", { mappingId: "n1", includeContact: false }), names)).toBe("Start n8n automation “Sync to Sheets”");
    expect(stepSummary(step("webhook", { subscriptionId: "w1", includeContact: true }), names)).toBe("Send a signed request to “Billing system” with the contact's details");
    expect(stepSummary(step("notify_team", { roles: ["owner", "admin"], title: "New lead" }), names)).toBe("Notify the owner, managers: “New lead”");
    expect(stepSummary(step("end", {}), names)).toBe("Stop the workflow here");
  });

  it("describes conditions with names instead of ids", () => {
    expect(conditionsText({ op: "and", conditions: [{ field: "tags", op: "has_any", value: ["t1"] }, { field: "lead_score", op: "gt", value: 50 }] }, "contact", names)).toBe("Tags has any of VIP and Lead score > 50");
    expect(conditionsText({ op: "or", conditions: [{ field: "stage", op: "in", value: ["s2"] }, { field: "value", op: "gte", value: 1000 }] }, "opportunity", names)).toBe("Stage is any of Won or Value ≥ 1000");
    expect(stepSummary(step("branch", { subject: "contact", filter: { op: "and", conditions: [] }, reply: "not_replied" }), names)).toBe("If they haven't replied since this run started");
  });

  it("summarizes triggers with their filters", () => {
    expect(triggerSummary({ type: "opportunity.stage_changed", filters: { pipelineId: "p1", stageIds: ["s2"] } }, names)).toEqual({ title: "Deal moved to a stage", detail: "in Sales · into Won" });
    expect(triggerLine({ type: "contact.tag_added", filters: { tagIds: ["t1"] }, reentry: "once" }, names)).toBe("Tag added · VIP · once per contact");
    expect(triggerLine({ type: "schedule", schedule: { frequency: "weekly", time: "08:00", weekdays: [1] } }, names)).toBe("On a schedule · on Mon at 8:00 AM");
    expect(triggerSummary(null, names).title).toBe("Choose what starts this workflow");
  });

  it("formats amounts, days, clocks, lists and durations", () => {
    expect(amountText({ amount: 1, unit: "hours" })).toBe("1 hour");
    expect(weekdaysText([0, 6])).toBe("on weekends");
    expect(weekdaysText(undefined)).toBe("every day");
    expect(clockText("00:05")).toBe("12:05 AM");
    expect(clockText("13:00")).toBe("1:00 PM");
    expect(listText(["x", "y"], () => undefined, ["tag", "tags"])).toBe("2 tags");
    expect(durationText("2026-10-16T00:00:00Z", "2026-10-16T00:02:05Z")).toBe("2 min 5 s");
    expect(durationText("2026-10-16T00:00:00Z", "2026-10-16T00:00:00.400Z")).toBe("under a second");
  });
});

// ---------------------------------------------------------------------------
// Editor rules, the approval preview and the run formatter (pure)
// ---------------------------------------------------------------------------

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function editorOptions(over: Partial<EditorOptions> = {}): EditorOptions {
  return {
    tags: [{ id: U(1), name: "VIP", color: "#123456" }],
    members: [{ id: U(2), name: "Ana Reyes", role: "owner" }],
    pipelines: [{ id: U(3), name: "Sales", stages: [{ id: U(4), name: "New", kind: "open" }, { id: U(5), name: "Won", kind: "won" }, { id: U(6), name: "Lost", kind: "lost" }] }],
    contactFields: [],
    opportunityFields: [],
    assignmentRules: [{ id: U(7), name: "Website leads", entity: "contact", active: true }],
    assignmentRuleRefs: [{ id: U(7), entity: "contact" }],
    templates: [{ id: U(8), key: "quote", name: "Quote follow-up", channel: "sms", purpose: "service", version: 2, subject: null, body: "Hi {{contact.first_name}}, any questions about your quote?", contentHash: HASH }],
    unapprovedTemplates: [],
    n8nMappings: [{ id: U(9), label: "Sync to Sheets", workflowId: "wf1", problem: null }],
    webhooks: [{ id: U(10), name: "Billing", host: "billing.example.com", active: true }],
    employees: [{ roleKey: "sales_assistant", name: "Sales Assistant", mode: "approval_required", enabled: true, ready: true, connected: true, liveRuns: true }],
    calendars: [],
    appointmentTypes: [],
    folders: [],
    ...over,
  };
}

function version(over: Partial<VersionItem> = {}): VersionItem {
  return {
    id: U(20), version: 3, publishedAt: "2026-10-16T00:00:00.000Z", publishedByName: null, effects: [], contentHash: HASH, current: true, approval: "not_needed", approvalId: null,
    approvedByName: null, approvedAt: null, definition: { trigger: { type: "contact.created" }, steps: [] }, ...over,
  };
}

describe("editor rules", () => {
  it("validates against the editor's options, grouping problems by step and trigger", () => {
    const o = editorOptions();
    const msg = { key: "msg", kind: "send_message", config: { templateId: U(8), contentHash: OTHER_HASH, channel: "sms", sendAs: "sales_assistant", businessHoursOnly: true }, next: null };
    const tag = { key: "tag", kind: "add_tag", config: { tagIds: [U(1)] }, next: "msg" };
    const def = { trigger: { type: "contact.tag_added", filters: { tagIds: [U(99)] } }, steps: [tag, msg] };
    const g = groupIssues(validateDefinition(def, validationContextOf(o)));
    expect(g.trigger.map((i) => i.code)).toContain("missing_tag");
    expect(g.byStep.msg.map((i) => i.code)).toEqual(["template_changed"]);
    expect(g.byStep.tag).toBeUndefined();
    expect(g.errors).toBe(2);
    expect(g.warnings).toBe(0);
    // With the template chosen again and a tag that exists, nothing stops publishing; adding the very tag that starts it is a warning.
    const fixed = groupIssues(validateDefinition({ trigger: { type: "contact.tag_added", filters: { tagIds: [U(1)] } }, steps: [tag, { ...msg, config: { ...msg.config, contentHash: HASH } }] }, validationContextOf(o)));
    expect(fixed.errors).toBe(0);
    expect(fixed.byStep.tag.map((i) => i.code)).toEqual(["self_trigger"]);
  });

  it("says why a step kind can't do anything yet, and starts new steps from sensible choices", () => {
    const bare = editorOptions({ templates: [], n8nMappings: [], webhooks: [{ id: U(10), name: "Old", host: "x.example.com", active: false }], employees: [], tags: [] });
    const notes = Object.fromEntries(kindChoices(bare).map((c) => [c.kind, c.note]));
    expect(notes.send_message).toMatch(/approved message template/);
    expect(notes.n8n).toMatch(/agency/);
    expect(notes.webhook).toMatch(/webhook endpoint/);
    expect(notes.ai_task).toMatch(/AI employees/);
    expect(notes.add_tag).toMatch(/tags/);
    expect(notes.wait).toBeNull();
    expect(kindChoices(bare).map((c) => c.kind)).toEqual([...STEP_KIND_LIST]);

    const o = editorOptions();
    expect(newStep([], "create_opportunity", o).config).toMatchObject({ pipelineId: U(3), stageId: U(4) });
    const msg = newStep([{ key: "send_message", kind: "send_message" } as WorkflowStep], "send_message", o);
    expect(msg.key).toBe("send_message_2");
    expect(msg.config).toMatchObject({ templateId: U(8), contentHash: HASH, channel: "sms", sendAs: "sales_assistant" });
  });

  it("explains why a workflow can't be switched on", () => {
    const gate = { pausedReason: null, ownerProblem: null };
    expect(activationBlocker({ status: "draft", publishedVersion: null, gate })).toBe("Publish a version first.");
    expect(activationBlocker({ status: "draft", publishedVersion: version(), gate })).toBeNull();
    expect(activationBlocker({ status: "draft", publishedVersion: version({ effects: ["send_sms"], approval: "needed" }), gate })).toMatch(/owner approves it first/);
    expect(activationBlocker({ status: "paused", publishedVersion: version({ effects: ["send_sms"], approval: "pending" }), gate })).toMatch(/Waiting for the owner/);
    expect(activationBlocker({ status: "draft", publishedVersion: version({ effects: ["send_sms"], approval: "rejected" }), gate })).toMatch(/declined/);
    expect(activationBlocker({ status: "draft", publishedVersion: version({ effects: ["send_sms"], approval: "approved" }), gate })).toBeNull();
    expect(activationBlocker({ status: "archived", publishedVersion: version(), gate })).toBe("Restore it first.");
    expect(activationBlocker({ status: "draft", publishedVersion: version(), gate: { pausedReason: null, ownerProblem: "Managed in GoHighLevel." } })).toBe("Managed in GoHighLevel.");
    // A workspace pause holds runs but doesn't stop switching on.
    expect(activationBlocker({ status: "draft", publishedVersion: version(), gate: { pausedReason: "Workflows are paused.", ownerProblem: null } })).toBeNull();
  });

  it("shows exactly what an approval allows: the wording, who it goes to, and what leaves iAcquire", () => {
    const o = editorOptions();
    const def = {
      trigger: { type: "contact.created" },
      steps: [
        { key: "msg", kind: "send_message", config: { templateId: U(8), contentHash: HASH, channel: "sms", sendAs: "sales_assistant", businessHoursOnly: true }, next: "hook", requireApproval: true },
        { key: "hook", kind: "webhook", config: { subscriptionId: U(10), includeContact: false }, next: "n8n" },
        { key: "n8n", kind: "n8n", config: { mappingId: U(9), includeContact: true }, next: "ai" },
        { key: "ai", kind: "ai_task", config: { roleKey: "sales_assistant", instruction: "Review this lead and add a note." }, next: "tag" },
        { key: "tag", kind: "add_tag", config: { tagIds: [U(1)] }, next: null },
      ],
    } as WorkflowDefinition;
    const items = effectItems(def, o);
    expect(items.map((i) => [i.stepNumber, i.kind])).toEqual([[1, "send_message"], [2, "webhook"], [3, "n8n"], [4, "ai_task"]]);
    expect(items[0].message?.body).toBe("Hi {{contact.first_name}}, any questions about your quote?");
    expect(items[0].lines.find((l) => l.label === "To")?.value).toMatch(/agreed to service messages by SMS and haven't opted out/);
    expect(items[0].asksFirst).toBe(true);
    expect(items[0].warning).toBeNull();
    expect(items[1].lines.find((l) => l.label === "Sends")?.value).toMatch(/no contact details/);
    expect(items[2].lines.find((l) => l.label === "Sends")?.value).toMatch(/name, email and phone/);
    expect(items[3].lines.find((l) => l.label === "Its mode")?.value).toMatch(/Asks you/);
    // A template whose approved wording changed, or an endpoint switched off, is flagged rather than silently allowed.
    const changed = effectItems(def, editorOptions({ templates: [{ ...o.templates[0], contentHash: OTHER_HASH }], webhooks: [{ ...o.webhooks[0], active: false }] }));
    expect(changed[0].warning).toMatch(/wording changed/);
    expect(changed[1].warning).toMatch(/isn't active/);
  });

  it("offers the growth triggers with their call filters, and configuration values in a step's own texts", () => {
    const o = editorOptions({ customValues: [{ key: "callback_window", label: "Callback window" }] });
    const noop = () => undefined;
    const trigger = renderToStaticMarkup(React.createElement(TriggerPanel, {
      trigger: { type: "call.completed", filters: { callStatuses: ["no_answer"], callDirections: ["inbound"] } }, options: o, issues: [], readOnly: false, inboundUrl: null, onChange: noop,
    }));
    expect(trigger).toContain('label="Growth"');
    for (const label of ["Campaign finished", "Review requested", "Private feedback received", "Call ended"]) expect(trigger).toContain(label);
    expect(trigger).toContain("Only calls that ended as");
    expect(trigger).toContain("No answer");
    expect(trigger).toContain("Incoming");
    const def = { trigger: { type: "contact.created" }, steps: [{ key: "t", kind: "create_task", config: { title: "Call in {{custom_values.callback_window}}", priority: "low", assignee: "none" }, next: null }] } as WorkflowDefinition;
    const panel = renderToStaticMarkup(React.createElement(StepPanel, { step: def.steps[0], number: 1, definition: def, options: o, issues: [], readOnly: false, base: "/crm", onChange: noop, onRemove: noop }));
    expect(panel).toContain('label="Configuration values"');
    expect(panel).toContain('value="custom_values.callback_window"');
    // The editor checks configuration values against the workspace's own, like publishing does.
    expect(validateDefinition(def, validationContextOf(o))).toEqual([]);
    const unknown = { ...def, steps: [{ ...def.steps[0], config: { ...def.steps[0].config, title: "Call in {{custom_values.office_hours}}" } }] } as WorkflowDefinition;
    expect(validateDefinition(unknown, validationContextOf(o)).map((i) => i.code)).toEqual(["unknown_token"]);
  });

  it("lists a template's missing required choices", () => {
    const t = { inputs: [{ key: "tag", label: "Starting tag", help: "", kind: "tag" as const, required: true }, { key: "message", label: "Message", help: "", kind: "message_template" as const, required: false }] };
    expect(missingTemplateInputs(t, {})).toEqual(["Starting tag"]);
    expect(missingTemplateInputs(t, { tag: U(1) })).toEqual([]);
  });
});

describe("navigation", () => {
  it("lists Workflows and Workflow Activity under Automation for people who can see automations, keeping AI Employees", () => {
    const automation = (can: (p: string) => boolean, mode: "client" | "agency") => navFor(can as (p: import("@/lib/permissions").Permission) => boolean, mode).find((s) => s.key === "automation")?.items.map((i) => i.path) ?? [];
    expect(automation((p) => p === "workflows.view" || p === "agents.use", "client")).toEqual(["/workflows", "/workflows/activity", "/employees"]);
    // The agency's view has no AI workforce link (it leaves the CRM), but keeps the workflow screens.
    expect(automation((p) => p === "workflows.view" || p === "agents.use", "agency")).toEqual(["/workflows", "/workflows/activity"]);
    expect(automation((p) => p === "crm.view", "client")).toEqual([]);
  });
});

describe("run formatting", () => {
  const names = namesFrom(editorOptions());
  const ctx = { names, base: "/crm", formatTime: (iso: string) => `at ${iso.slice(11, 16)}`, conversations: { [U(30)]: U(31) }, inboxLinks: true };

  it("puts each step's result in words, with links to what it created", () => {
    expect(stepResultDetails("create_task", { taskId: U(40), title: "Call Dana" }, { contactId: U(41) }, ctx)).toEqual({ details: [{ label: "Task", value: "Call Dana" }], links: [{ label: "Open task", href: `/crm/tasks?task=${U(40)}` }] });
    const msg = stepResultDetails("send_message", { status: "queued", messageId: U(30), template: "Quote follow-up", version: 2 }, { contactId: U(41) }, ctx);
    expect(msg.details).toEqual([{ label: "Template", value: "Quote follow-up (v2)" }, { label: "Status", value: "Queued to send" }]);
    expect(msg.links).toEqual([{ label: "Open conversation", href: `/inbox?conversation=${U(31)}` }]);
    // The agency's view has no inbox; it points at the contact instead.
    expect(stepResultDetails("send_message", { status: "sent", messageId: U(30) }, { contactId: U(41) }, { ...ctx, inboxLinks: false }).links).toEqual([{ label: "Open contact", href: `/crm/contacts/${U(41)}` }]);
    const blocked = stepResultDetails("send_message", { outcome: "blocked", reason: "no_consent", detail: "No consent on record. It wasn't sent." }, { contactId: U(41) }, ctx);
    expect(blocked.details).toEqual([{ label: "Why", value: "No consent on record" }, { label: "Detail", value: "No consent on record. It wasn't sent." }]);
    expect(stepResultDetails("branch", { matched: false, path: "no", detail: "Tags has any of VIP" }, { contactId: null }, ctx).details).toEqual([{ label: "Path taken", value: "No" }, { label: "Checked", value: "Tags has any of VIP" }]);
    expect(stepResultDetails("move_stage", { opportunityId: U(42), stageId: U(5), changed: true }, { contactId: null }, ctx)).toEqual({ details: [{ label: "Stage", value: "Won" }], links: [{ label: "Open deal", href: `/crm/opportunities/${U(42)}` }] });
    expect(stepResultDetails("wait", { until: "2026-10-17T09:00:00.000Z" }, { contactId: null }, ctx).details).toEqual([{ label: "Continues at", value: "at 09:00" }]);
    expect(stepResultDetails("n8n", { mappingId: U(9), outcome: "unknown" }, { contactId: null }, ctx).details.map((d) => d.label)).toEqual(["Outcome", "Automation"]);
  });

  it("maps filters to the engine's run queries and test results to their labels", () => {
    expect(runQueryFor("open")).toEqual({ status: "live" });
    expect(runQueryFor("failed")).toEqual({ status: "problems" });
    expect(runQueryFor("test")).toEqual({ startedVia: "test" });
    expect(runQueryFor("")).toEqual({});
    const t = toTestRunView({
      runId: null, source: "draft", contact: { id: U(41), name: "Dana" }, issues: [],
      steps: [{ stepKey: "a", kind: "branch", label: "If / else", outcome: "branch_no", detail: "Tags has any of VIP" }, { stepKey: "b", kind: "send_message", label: "Send message", outcome: "would_skip", detail: "No consent." }],
    });
    expect(t.steps.map((x) => [x.outcomeLabel, x.tone])).toEqual([["No path", "neutral"], ["Would skip", "neutral"]]);
    expect(t.contactName).toBe("Dana");
    expect(triggerLabelOf("contact.tag_added", "event")).toBe("Tag added");
    expect(triggerLabelOf("test", "test")).toBe("Test run");
    expect(triggerLabelOf(null, "manual")).toBe("Started by a person");
  });
});

// ---------------------------------------------------------------------------
// Screens rendered on the server with data from the real services, and who may use which action
// ---------------------------------------------------------------------------

describe("workflow screens and actions", () => {
  const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");
  let a: CrmOrg;
  let b: CrmOrg;
  let vip: { id: string };
  let welcomed: { id: string };
  let contactId: string;
  let welcomeId: string;
  let quoteId: string;
  let draftId: string;
  let runId: string;
  let testRunId: string;
  /** Someone who can see automations but not change them (the role matrix gives both to owners and managers). */
  const viewerOf = (o: CrmOrg): CrmActor => {
    const owner = o.actor("owner");
    return { ...owner, can: (p) => p !== "workflows.manage" && owner.can(p) };
  };

  beforeAll(async () => {
    a = await crmOrg({ name: "Flow Co" });
    b = await crmOrg({ name: "Other Flow Co" });
    const owner = a.actor("owner");
    vip = await createTag(owner, { name: "VIP" });
    welcomed = await createTag(owner, { name: "Welcomed" });
    contactId = (await createContact(owner, { firstName: "Dana", lastName: "Cruz", email: `dana.${Date.now()}@example.test` })).id;
    const folder = await createFolder(owner, { kind: "workflow", name: "Onboarding" });

    welcomeId = (await createWorkflow(owner, {
      name: "Welcome VIPs",
      folderId: folder.id,
      definition: {
        trigger: { type: "contact.tag_added", filters: { tagIds: [vip.id] } },
        steps: [
          { key: "tag", kind: "add_tag", config: { tagIds: [welcomed.id] }, next: "task" },
          { key: "task", kind: "create_task", config: { title: "Welcome {{contact.full_name}}", priority: "high", assignee: "none" }, next: null },
        ],
      },
    })).id;
    await publishWorkflow(owner, welcomeId);
    await setWorkflowStatus(owner, welcomeId, "active");

    const t = await createTemplate(owner, { name: "Quote follow-up", channel: "sms", body: "Hi {{contact.first_name}}, any questions about your quote?" });
    await approveTemplate(owner, t.id, { version: 1, contentHash: t.contentHash });
    quoteId = (await createWorkflow(owner, {
      name: "Quote follow-up",
      definition: {
        trigger: { type: "contact.created" },
        steps: [
          { key: "msg", kind: "send_message", config: { templateId: t.id, contentHash: t.contentHash, channel: "sms", sendAs: "sales_assistant", businessHoursOnly: true }, next: "wait" },
          { key: "wait", kind: "wait", config: { mode: "duration", amount: 2, unit: "days" }, next: "check" },
          { key: "check", kind: "branch", config: { subject: "contact", filter: { op: "and", conditions: [] }, reply: "not_replied" }, branches: { yes: "call", no: null } },
          { key: "call", kind: "create_task", config: { title: "Call {{contact.first_name}}", priority: "normal", assignee: "contact_owner" }, next: null },
        ],
      },
    })).id;
    await publishWorkflow(owner, quoteId);
    draftId = (await createWorkflow(owner, { name: "Half-built idea" })).id;

    testRunId = (await startTestRun(owner, welcomeId, { contactId, source: "published" })).runId!;
    runId = (await startManualRun(owner, welcomeId, { contactId })).runId;
    await processWorkflowRuns({ limit: 10 });
  });

  it("lists workflows with their trigger, state, approval and last day, grouped by folder", async () => {
    const owner = a.actor("owner");
    const page = html(await WorkflowsView({ actor: owner, scope: await scopeFor(owner, "/crm"), searchParams: {} }));
    expect(page).toContain(">Workflows<");
    expect(page).toContain("Welcome VIPs");
    expect(page).toContain("Tag added · VIP · 2 steps");
    expect(page).toContain(`href="/crm/workflows/${welcomeId}"`);
    expect(page).toContain("Onboarding");
    expect(page).toContain("Needs owner approval");
    expect(page).toContain("Sends SMS");
    expect(page).toContain("Half-built idea");
    expect(page).toContain("no steps yet");
    expect(page).toContain("New workflow");
    expect(page).toContain(`aria-label="Actions for Welcome VIPs"`);
    // Someone who can only look gets no building controls, and is told why.
    const viewer = viewerOf(a);
    const readOnly = html(await WorkflowsView({ actor: viewer, scope: await scopeFor(viewer, "/crm"), searchParams: {} }));
    expect(readOnly).toContain("Welcome VIPs");
    expect(readOnly).not.toContain("New workflow");
    expect(readOnly).toContain("Build and change automations");
    // People without the automations permission can't open the screen at all, and another workspace sees none of it.
    await expect(WorkflowsView({ actor: a.actor("sales"), scope: await scopeFor(a.actor("sales"), "/crm") })).rejects.toThrow();
    const other = html(await WorkflowsView({ actor: b.actor("owner"), scope: await scopeFor(b.actor("owner"), "/crm"), searchParams: {} }));
    expect(other).not.toContain("Welcome VIPs");
    expect(other).toContain("No workflows yet");
  });

  it("opens the editor on a readable canvas with numbered steps, insert points and what it can do", async () => {
    const owner = a.actor("owner");
    const page = html(await WorkflowView({ actor: owner, scope: await scopeFor(owner, "/crm"), id: quoteId, searchParams: {} }));
    expect(page).toContain("Quote follow-up");
    expect(page).toContain("Starts when");
    expect(page).toContain("Contact created");
    expect(page).toContain("Send SMS “Quote follow-up” as");
    expect(page).toContain("Wait 2 days");
    expect(page).toContain("If they haven&#x27;t replied since this run started");
    expect(page).toContain('aria-label="Add a step after step 1"');
    expect(page).toContain('aria-label="Add a step at the start of the “no” path of step 3"');
    expect(page).toContain("Version 1 needs the owner&#x27;s approval before it runs");
    expect(page).toContain("Review and request approval");
    expect(page).toContain("Can&#x27;t turn on yet: Version 1 sends messages or calls outside systems, so the owner approves it first.");
    expect(page).toContain(">Publish<");
    expect(page).toContain("Save draft");
    // The runs tab lists this workflow's runs; the welcome workflow has a finished run and a test run.
    const runs = html(await WorkflowView({ actor: owner, scope: await scopeFor(owner, "/crm"), id: welcomeId, searchParams: { tab: "runs" } }));
    expect(runs).toContain(`href="/crm/workflows/${welcomeId}/runs/${runId}"`);
    expect(runs).toContain(`href="/crm/workflows/${welcomeId}/runs/${testRunId}"`);
    expect(runs).toContain("Completed");
    expect(runs).toContain("Started by a person");
    // Read-only for someone who can only look: no add, move or publish controls.
    const viewer = viewerOf(a);
    const ro = html(await WorkflowView({ actor: viewer, scope: await scopeFor(viewer, "/crm"), id: quoteId, searchParams: {} }));
    expect(ro).not.toContain('aria-label="Add a step after step 1"');
    expect(ro).not.toContain(">Publish<");
    expect(ro).toContain("Build and change automations");
    // Another workspace's workflow doesn't exist here.
    await expect(WorkflowView({ actor: b.actor("owner"), scope: await scopeFor(b.actor("owner"), "/crm"), id: quoteId })).rejects.toThrow(/NOT_FOUND/);
    // An archived workflow is kept as it was: it can be restored or cloned, not edited.
    await setWorkflowStatus(owner, draftId, "archived");
    const archived = html(await WorkflowView({ actor: owner, scope: await scopeFor(owner, "/crm"), id: draftId, searchParams: {} }));
    expect(archived).toContain(">Restore<");
    expect(archived).not.toContain("Save draft");
    expect(archived).not.toContain('aria-label="Add the first step"');
    await setWorkflowStatus(owner, draftId, "draft");
    const restored = html(await WorkflowView({ actor: owner, scope: await scopeFor(owner, "/crm"), id: draftId, searchParams: {} }));
    expect(restored).toContain('aria-label="Add the first step"');
    expect(restored).toContain("Not published yet");
  });

  it("shows a run step by step with what each step did and links to what it created", async () => {
    const owner = a.actor("owner");
    const page = html(await WorkflowRunView({ actor: owner, scope: await scopeFor(owner, "/crm"), workflowId: welcomeId, runId }));
    expect(page).toContain("Completed");
    expect(page).toContain("Add tag");
    expect(page).toContain("Add Welcomed");
    expect(page).toContain("Create task");
    expect(page).toMatch(/href="\/crm\/tasks\?task=[0-9a-f-]{36}"/);
    expect(page).toContain(`href="/crm/contacts/${contactId}"`);
    expect(page).toContain("Started by a person");
    expect(page).not.toContain("Cancel run");
    const test = html(await WorkflowRunView({ actor: owner, scope: await scopeFor(owner, "/crm"), workflowId: welcomeId, runId: testRunId }));
    expect(test).toContain("Test run");
    expect(test).toContain("It sent nothing");
    // The run must belong to the workflow in the address.
    await expect(WorkflowRunView({ actor: owner, scope: await scopeFor(owner, "/crm"), workflowId: quoteId, runId })).rejects.toThrow(/NOT_FOUND/);
  });

  it("lists activity across workflows and opens a run from a notification link", async () => {
    const owner = a.actor("owner");
    const scope = await scopeFor(owner, "/crm");
    const page = html(await WorkflowActivityView({ actor: owner, scope, searchParams: {} }));
    expect(page).toContain("Workflow activity");
    expect(page).toContain(`href="/crm/workflows/${welcomeId}/runs/${runId}"`);
    expect(page).toContain("Welcome VIPs");
    const tests = html(await WorkflowActivityView({ actor: owner, scope, searchParams: { status: "test" } }));
    expect(tests).toContain(`/runs/${testRunId}"`);
    expect(tests).not.toContain(`/runs/${runId}"`);
    await expect(WorkflowActivityView({ actor: owner, scope, searchParams: { run: runId } })).rejects.toThrow(`NEXT_REDIRECT /crm/workflows/${welcomeId}/runs/${runId}`);
  });

  it("mirrors the screens for the agency under the client's admin path", async () => {
    const agency = await agencyPeople();
    await startSupportSession(agency.superAdmin, a.org.id, { mode: "read", reason: "Checking the client's automations" });
    const actor = await agencyActor(agency.superAdmin, a.org.id);
    const scope = await scopeFor(actor, `/admin/clients/${a.org.id}/crm`);
    const page = html(await WorkflowsView({ actor, scope, searchParams: {} }));
    expect(page).toContain(`href="/admin/clients/${a.org.id}/crm/workflows/${welcomeId}"`);
    expect(page).not.toContain("New workflow");
    const run = html(await WorkflowRunView({ actor, scope, workflowId: welcomeId, runId }));
    expect(run).not.toContain("/inbox?");
  });

  it("lets people who build automations change them, and nobody else", async () => {
    const owner = a.actor("owner");
    // Looking isn't building.
    who.actor = viewerOf(a);
    expect(await createWorkflowAction(null, { name: "Nope" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await setWorkflowStatusAction(null, welcomeId, "paused")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await startTestRunAction(null, welcomeId, { contactId })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await cancelRunAction(null, runId)).toMatchObject({ ok: false, code: "forbidden" });
    who.actor = a.actor("sales");
    expect(await retryRunStepAction(null, runId)).toMatchObject({ ok: false, code: "forbidden" });

    who.actor = a.actor("manager");
    const created = await createWorkflowAction(null, { name: "Manager's flow" });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.data.id : "";
    expect(await createWorkflowAction(null, { name: "x", folderId: "not-a-folder" })).toMatchObject({ ok: false, code: "invalid_input" });
    const def = { trigger: { type: "contact.created" }, steps: [{ key: "tag", kind: "add_tag", config: { tagIds: [vip.id] }, next: null }] };
    const saved = await saveWorkflowDraftAction(null, id, { definition: def, expectedRevision: 1 });
    expect(saved).toMatchObject({ ok: true, data: { revision: 2 } });
    // Saving over a newer save is refused, nothing overwritten.
    expect(await saveWorkflowDraftAction(null, id, { definition: { ...def, steps: [] }, expectedRevision: 1 })).toMatchObject({ ok: false, code: "conflict" });
    expect(await publishWorkflowAction(null, id, { expectedRevision: 2 })).toMatchObject({ ok: true, data: { version: 1, needsApproval: false } });
    expect(await setWorkflowStatusAction(null, id, "active")).toMatchObject({ ok: true, data: { status: "active" } });
    const test = await startTestRunAction(null, id, { contactId, source: "draft" });
    expect(test).toMatchObject({ ok: true, data: { runId: null, source: "draft", contactName: "Dana Cruz" } });
    expect(test.ok && test.data.steps.map((s) => s.outcomeLabel)).toEqual(["Would do"]);

    // A version that sends messages can't be switched on until the owner approves it; asking puts it in the owner's Approval Center.
    expect(await setWorkflowStatusAction(null, quoteId, "active")).toMatchObject({ ok: false, code: "conflict" });
    const quote = await getWorkflow(owner, quoteId);
    const asked = await requestWorkflowApprovalAction(null, quoteId, quote.publishedVersionId!, { activate: true });
    expect(asked).toMatchObject({ ok: true, data: { status: "requested" } });
    expect((await getWorkflow(owner, quoteId)).approval).toBe("pending");
    expect(await requestWorkflowApprovalAction(null, quoteId, quote.publishedVersionId!)).toMatchObject({ ok: true, data: { status: "pending" } });

    // Runs: a finished run can't be cancelled or retried; ids are checked before anything runs.
    expect(await cancelRunAction(null, runId)).toMatchObject({ ok: false, code: "conflict" });
    expect(await retryRunStepAction(null, runId)).toMatchObject({ ok: false, code: "conflict" });
    expect(await cancelRunAction(null, "not-an-id")).toMatchObject({ ok: false, code: "invalid_input" });
    // Another workspace's workflow is invisible to this one.
    who.actor = b.actor("owner");
    expect(await cloneWorkflowAction(null, welcomeId)).toMatchObject({ ok: false, code: "not_found" });
    who.actor = null;
  });
});
