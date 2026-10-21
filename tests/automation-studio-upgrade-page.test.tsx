// @vitest-environment jsdom
// The Automation Studio upgrade page (a workspace without the plan): it states the real price once, the terms and allowances in full, says
// plainly what keeps working without the plan, and sends every call to action to the Maintenance page where the real request is made, labelled
// for what that person can do there. Its example is a fixed script: these tests check that the script is a workflow the real spec accepts, in
// the real canvas's words, that its drawing never overlaps, and that playing it (to the end, every control) calls nothing and sends nothing.
import * as fs from "node:fs";
import * as path from "node:path";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }>(function Link({ href, prefetch: _p, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link };
});

import { UpgradePage, ctaCopy, type UpgradeProps } from "@/components/automation-studio/upgrade-page";
import { BuilderDemo } from "@/components/automation-studio/demo/builder-demo";
import {
  BEATS, CHAPTER_START, CHAPTERS, DEMO_EDGES, DEMO_MESSAGES, DEMO_NODES, DEMO_TEMPLATE_NAME, LAST, edgePath, nodeBox, phoneDelay, stageFrame, viewOf,
  type DemoLayout, type DemoNodeId, type DemoStage,
} from "@/components/automation-studio/demo/script";
import { STUDIO_DEFAULT_LIMITS, STUDIO_LAPSE_POLICY, STUDIO_PLAN_MONTHLY_USD, STUDIO_SETUP_FEE_USD } from "@/lib/automation-studio/plan";
import { TRIGGERS, validateDefinition, type WorkflowDefinition } from "@/lib/crm/workflow/spec";
import { kindLabel, namesFrom, stepSummary } from "@/components/crm/workflows/summaries";

let reducedMotion = false;
let intersect: ((entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void) | null = null;

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("reduce") ? reducedMotion : false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  reducedMotion = false;
  intersect = null;
  // @ts-expect-error -- each test decides whether the browser has one
  delete globalThis.IntersectionObserver;
});

const props = (over: Partial<UpgradeProps> = {}): UpgradeProps => ({
  state: "none", reason: "Automation Studio is part of the optional plan.", monthlyUsd: STUDIO_PLAN_MONTHLY_USD, setupFeeUsd: STUDIO_SETUP_FEE_USD,
  requestAllowance: 4, canRequest: true, requestNote: null, saved: [], ...over,
});

const USD = (n: number) => `$${n.toLocaleString("en-US")}`;

function withObserver() {
  globalThis.IntersectionObserver = class {
    constructor(cb: (entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void) { intersect = cb; }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
}
const onScreen = () => act(() => intersect!([{ isIntersecting: true, intersectionRatio: 0.6 }]));
const offScreen = () => act(() => intersect!([{ isIntersecting: false, intersectionRatio: 0 }]));
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const playToEnd = () => { for (let i = 0; i <= LAST; i++) advance(3_000); };

/** The conversation as shown (each message's text, without the screen-reader "You:" / "Builder:"). */
const shownMessages = () => [...document.querySelectorAll('[data-message][data-shown="true"]')].map((el) => el.querySelector("p")!.textContent!.replace(/^(You|Builder): /, ""));
const shownNodes = () => [...document.querySelectorAll("[data-node]")].map((el) => el.getAttribute("data-node"));
const caption = () => document.querySelector("[data-caption]")!.textContent;

describe("Automation Studio upgrade page", () => {
  it("states the monthly price once, the one-time setup separately, and the provisional allowances in full", () => {
    const { container } = render(<UpgradePage {...props()} />);
    const text = container.textContent ?? "";
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Describe an automation. Watch it get built.");
    expect(text.split(USD(STUDIO_PLAN_MONTHLY_USD)).length - 1).toBe(1);
    expect(text).toContain(USD(STUDIO_SETUP_FEE_USD));
    expect(text).toMatch(/provisional/i);
    for (const n of [STUDIO_DEFAULT_LIMITS.monthlyRuns, STUDIO_DEFAULT_LIMITS.monthlySteps, STUDIO_DEFAULT_LIMITS.monthlyBuilderMessages, STUDIO_DEFAULT_LIMITS.maxActiveWorkflows]) expect(text).toContain(n.toLocaleString("en-US"));
    expect(text).toMatch(/charged from your usage credits/);
    expect(text).toMatch(/7 days/);
    expect(text).toMatch(/quoted separately/);
  });

  it("shows the price and request allowance it is given (the published plan's), not a fixed figure", () => {
    const { container } = render(<UpgradePage {...props({ monthlyUsd: 349, requestAllowance: 6 })} />);
    const text = container.textContent ?? "";
    expect(text).toContain("$349");
    expect(text).not.toContain(USD(STUDIO_PLAN_MONTHLY_USD));
    expect(text).toMatch(/6 requests a month/);
    cleanup();
    const again = render(<UpgradePage {...props({ requestAllowance: null })} />);
    expect(again.container.textContent).not.toMatch(/requests? a month/);
  });

  it("says what keeps working without the plan, and that lapsed automations are paused, not deleted", () => {
    const { container } = render(<UpgradePage {...props()} />);
    const table = screen.getByRole("table");
    const kept = within(table).getAllByRole("row").filter((r) => within(r).queryAllByText(/included$/).length === 2 && within(r).getAllByText(/: included$/).length === 2);
    const keptText = kept.map((r) => r.textContent).join(" ");
    expect(keptText).toMatch(/CRM, its workflow builder/);
    expect(keptText).toMatch(/AI employees/);
    expect(keptText).toMatch(/n8n, Zapier and Make/);
    const added = within(table).getAllByRole("row").filter((r) => within(r).queryAllByText(/Now: not included/).length === 1).map((r) => r.textContent).join(" ");
    expect(added).toMatch(/AI Automation Builder/);
    expect(added).toMatch(/4 requests a month/);
    expect(container.textContent).toContain(STUDIO_LAPSE_POLICY.kept);
    expect(container.textContent).toMatch(/paused, not deleted/);
  });

  it("sends every call to action to the Maintenance page, labelled for what that person can do there", () => {
    render(<UpgradePage {...props()} />);
    const ctas = screen.getAllByRole("link", { name: /Review and request the plan/ });
    expect(ctas).toHaveLength(3);
    for (const a of ctas) expect(a.getAttribute("href")).toBe("/maintenance");
    expect(screen.getAllByText(/iAcquire confirms it before anything is billed/)).toHaveLength(3);
    expect(screen.getByText("Nothing is charged from this page")).toBeTruthy();
    cleanup();

    render(<UpgradePage {...props({ state: "pending", reason: "Your request is waiting for iAcquire to activate the plan." })} />);
    expect(screen.getAllByRole("link", { name: /View your request/ }).every((a) => a.getAttribute("href") === "/maintenance")).toBe(true);
    expect(screen.getByRole("note").textContent).toMatch(/waiting for iAcquire/);
    cleanup();

    render(<UpgradePage {...props({ state: "expired", reason: "Your plan has expired.", saved: [{ id: "w1", name: "Welcome new leads" }] })} />);
    expect(screen.getAllByRole("link", { name: /Reactivate the plan/ })).toHaveLength(3);
    expect(screen.getByRole("link", { name: /Welcome new leads/ }).getAttribute("href")).toBe("/automation-studio/w1");
  });

  it("tells someone who can't request the plan why, and never promises them a request", () => {
    const note = "Only the owner of your workspace can request the plan. Ask them to open the Maintenance page.";
    render(<UpgradePage {...props({ canRequest: false, requestNote: note })} />);
    expect(screen.getAllByText(note)).toHaveLength(3);
    expect(screen.getAllByRole("link", { name: /Open the Maintenance page/ })).toHaveLength(3);
    expect(screen.queryByRole("link", { name: /request the plan|Reactivate/i })).toBeNull();
    // The words for each state, in one place.
    expect(ctaCopy({ state: "declined", canRequest: true, requestNote: null }).label).toBe("Review and request the plan");
    expect(ctaCopy({ state: "cancelled", canRequest: false, requestNote: "Not yet." })).toMatchObject({ label: "Open the Maintenance page", note: "Not yet." });
    expect(ctaCopy({ state: "pending", canRequest: false, requestNote: null }).label).toBe("View your request");
  });

  it("labels the example as one, with nothing in it that leads anywhere or takes input", () => {
    const { container } = render(<UpgradePage {...props()} />);
    expect(screen.getByText("Interactive example", { exact: false }).textContent).toMatch(/Nothing is saved or sent/);
    expect(screen.getByText("Example", { exact: true })).toBeTruthy();
    const demo = screen.getByRole("list", { name: "Example conversation" }).closest(".\\@container")!;
    expect(demo.querySelectorAll("a[href], form, input, textarea, select, [contenteditable]")).toHaveLength(0);
    const buttons = within(demo as HTMLElement).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(buttons.every((b) => /the example$|^Go to chapter/.test(b ?? ""))).toBe(true);
    expect(container.querySelector(".react-flow")).toBeNull();
  });
});

describe("the example's script", () => {
  it("only ever adds to the conversation, ends complete, and every line joins two nodes it shows", () => {
    for (let i = 1; i < BEATS.length; i++) {
      expect(BEATS[i].messages).toBeGreaterThanOrEqual(BEATS[i - 1].messages);
      expect(BEATS[i].chapter).toBeGreaterThanOrEqual(BEATS[i - 1].chapter);
    }
    for (const b of BEATS) {
      for (const e of b.edges) expect(b.nodes.includes(DEMO_EDGES[e].from) && b.nodes.includes(DEMO_EDGES[e].to)).toBe(true);
      for (const f of b.focus ?? []) expect(b.nodes).toContain(f);
      if (b.status) expect(["Reading your workflow…", "Working on it…", "Checking the changes…"]).toContain(b.status);
      expect(b.caption.length).toBeGreaterThan(10);
    }
    const last = BEATS[LAST];
    expect(last.messages).toBe(DEMO_MESSAGES.length);
    expect(last.nodes).toHaveLength(Object.keys(DEMO_NODES).length);
    expect(last.next).toBe(true);
    expect(CHAPTER_START).toHaveLength(CHAPTERS.length);
    CHAPTER_START.forEach((b, c) => expect(BEATS[b].chapter).toBe(c));
    // The builder answers before the canvas changes, as the real one does: a reply is shown no later than the steps it describes.
    expect(BEATS.findIndex((b) => b.messages >= 2)).toBeLessThan(BEATS.findIndex((b) => b.nodes.length > 0));
  });

  it("is an automation the real workflow spec accepts, in the real canvas's words", () => {
    const templateId = "00000000-0000-4000-8000-0000000000a1";
    const steps = {
      text: { key: "text", kind: "send_message", name: DEMO_NODES.text.title, config: { templateId, contentHash: "a".repeat(64), channel: "sms", sendAs: "sales_assistant", businessHoursOnly: true } },
      task: { key: "task", kind: "create_task", name: DEMO_NODES.task.title, config: { title: "Follow-up call", priority: "high", assignee: "contact_owner", dueIn: { amount: 1, unit: "days" } } },
      wait: { key: "wait", kind: "wait", name: DEMO_NODES.wait.title, config: { mode: "duration", amount: 1, unit: "days" } },
      check: { key: "check", kind: "branch", name: DEMO_NODES.check.title, config: { subject: "contact", filter: { op: "and", conditions: [] }, reply: "not_replied" } },
      end: { key: "end", kind: "end", name: DEMO_NODES.end.title, config: {} },
    };
    const draft = { trigger: { type: "contact.created" }, steps: [{ ...steps.text, next: "task" }, { ...steps.task, next: null }] };
    const changed = {
      trigger: { type: "contact.created" },
      steps: [{ ...steps.text, next: "wait" }, { ...steps.task, next: null }, { ...steps.wait, next: "check" }, { ...steps.check, next: null, branches: { yes: "task", no: "end" } }, { ...steps.end, next: null }],
    };
    for (const def of [draft, changed]) expect(validateDefinition(def, null).filter((i) => i.level === "error")).toEqual([]);

    const names = namesFrom({ templates: [{ id: templateId, name: DEMO_TEMPLATE_NAME, channel: "sms" }] });
    expect(DEMO_NODES.trigger.title).toBe(TRIGGERS["contact.created"].label);
    for (const s of Object.values(steps)) {
      const node = DEMO_NODES[s.key as DemoNodeId];
      expect(node.kind).toBe(s.kind);
      expect(node.summary).toBe(stepSummary(s as unknown as WorkflowDefinition["steps"][number], names));
      expect(node.meta.endsWith(kindLabel(s.kind))).toBe(true);
    }
    // The edges are the changed automation's own: each "next" and each branch side.
    const graph = new Set(changed.steps.flatMap((s) => [s.next ? `${s.key}>${s.next}` : null, ...(("branches" in s && s.branches) ? [`${s.key}>${s.branches.yes}`, `${s.key}>${s.branches.no}`] : [])]).filter(Boolean));
    graph.add("trigger>text");
    expect(new Set(BEATS[LAST].edges)).toEqual(graph);
  });

  it("never draws two nodes on top of each other, or a label on a node, in either arrangement", () => {
    const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, gap = 0) =>
      a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
    for (const layout of ["wide", "narrow"] as DemoLayout[]) {
      for (const stage of ["a", "b"] as DemoStage[]) {
        const ids = (Object.keys(DEMO_NODES) as DemoNodeId[]).filter((id) => nodeBox(layout, stage, id));
        const boxes = ids.map((id) => nodeBox(layout, stage, id)!);
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j], 16), `${layout}/${stage}: ${ids[i]} and ${ids[j]}`).toBe(false);
        const frame = stageFrame(layout, stage);
        for (const b of boxes) expect(b.x >= frame.x && b.y >= frame.y && b.x + b.w <= frame.x + frame.w && b.y + b.h <= frame.y + frame.h).toBe(true);
        for (const e of Object.values(DEMO_EDGES)) {
          const p = edgePath(layout, stage, e);
          if (!p?.label) continue;
          const label = { x: p.label[0] - 18, y: p.label[1] - 9, w: 36, h: 18 };
          for (const b of boxes) expect(overlap(label, b), `${layout}/${stage}: ${e.id} label`).toBe(false);
        }
      }
      // The phone arrangement fits a 300-pixel-wide canvas at life size.
      expect(stageFrame("narrow", "b").w).toBeLessThanOrEqual(300);
    }
  });

  it("is about one half at a time, so a phone showing the chat and the canvas in turns misses nothing, and has time to read each reply", () => {
    for (let i = 1; i < BEATS.length; i++) {
      const [a, b] = [BEATS[i - 1], BEATS[i]];
      const canvas = a.stage !== b.stage || a.nodes.join() !== b.nodes.join() || a.edges.join() !== b.edges.join();
      const chat = a.messages !== b.messages || a.status !== b.status || Boolean(a.next) !== Boolean(b.next);
      expect(canvas && chat, `beat ${i} changes both halves`).toBe(false);
      if (canvas) expect(viewOf(b), `beat ${i}`).toBe("canvas");
      if (chat) expect(viewOf(b), `beat ${i}`).toBe("chat");
      // Where the canvas takes over from a reply, a phone leaves time to read it; everywhere else the pace is the same as beside the canvas.
      if (viewOf(b) === "canvas" && viewOf(a) === "chat") expect(phoneDelay(i), `beat ${i}`).toBeGreaterThanOrEqual(4000);
      else expect(phoneDelay(i), `beat ${i}`).toBe(b.after);
    }
    // The builder replies to the change before it makes it, as it does to the request.
    const reply = BEATS.findIndex((b) => b.messages >= 4);
    expect(BEATS[reply].stage).toBe("a");
    expect(BEATS[reply + 1].stage).toBe("b");
  });

  it("keeps the whole automation readable in a phone-high canvas", () => {
    const frame = stageFrame("narrow", "b");
    // 13px titles (the phone card's 14px) at the scale a 500-pixel-high canvas fits it at.
    expect(14 * Math.min(1, (500 - 28) / frame.h)).toBeGreaterThanOrEqual(12);
  });

  it("keeps everything the page sends to the browser for the example free of the builder, the server and the network", () => {
    const dir = path.resolve(__dirname, "../src/components/automation-studio/demo");
    for (const f of fs.readdirSync(dir).filter((n) => /\.tsx?$/.test(n))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      expect(src, f).not.toMatch(/@\/server|@\/app\/actions|fetch\(|EventSource|WebSocket|sendBeacon|localStorage/);
    }
  });
});

describe("the example played back", () => {
  it("shows the finished example to people who ask for reduced motion, never starts on its own, and can still be stepped through", () => {
    reducedMotion = true;
    withObserver();
    render(<BuilderDemo />);
    expect(shownMessages()).toEqual(DEMO_MESSAGES.map((m) => m.text));
    expect(shownNodes()).toHaveLength(Object.keys(DEMO_NODES).length);
    onScreen();
    expect(shownMessages()).toHaveLength(DEMO_MESSAGES.length);
    expect(screen.getByRole("button", { name: "Replay the example" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous step of the example" }));
    expect(caption()).toBe(BEATS[LAST - 1].caption);
    expect(document.querySelector("[aria-live]")!.textContent).toBe(BEATS[LAST - 1].caption);
  });

  it("shows the finished example where it can't tell it's on screen", () => {
    render(<BuilderDemo />);
    expect(shownMessages()).toHaveLength(DEMO_MESSAGES.length);
    expect(document.querySelector('[data-next="shown"]')).not.toBeNull();
  });

  it("plays once it scrolls into view: the reply first, then each step, then the change, and nothing is fetched", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.useFakeTimers();
    withObserver();
    render(<BuilderDemo />);
    expect(shownMessages()).toEqual([]);
    expect(shownNodes()).toEqual([]);
    expect(screen.getByText("The automation appears here as it’s built")).toBeTruthy();

    onScreen();
    advance(BEATS[1].after);
    expect(shownMessages()).toEqual([DEMO_MESSAGES[0].text]);
    advance(BEATS[2].after);
    expect(screen.getByRole("status").textContent).toMatch(/Reading your workflow/);

    const firstNode = BEATS.findIndex((b) => b.nodes.length > 0);
    for (let i = 3; i <= firstNode; i++) advance(BEATS[i].after);
    expect(shownMessages()).toHaveLength(2);
    expect(shownNodes()).toEqual(["trigger"]);
    expect(document.querySelector('[data-node="trigger"]')!.hasAttribute("data-enter")).toBe(true);
    expect(document.querySelector('[data-node="trigger"]')!.hasAttribute("data-active")).toBe(true);

    playToEnd();
    expect(shownMessages()).toEqual(DEMO_MESSAGES.map((m) => m.text));
    expect(new Set(shownNodes())).toEqual(new Set(Object.keys(DEMO_NODES)));
    expect(document.querySelector('[data-next="shown"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Replay the example" })).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    // Finished, nothing is left running.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can be paused and resumed, and pauses by itself while it's off screen", () => {
    vi.useFakeTimers();
    withObserver();
    render(<BuilderDemo />);
    onScreen();
    advance(BEATS[1].after);
    fireEvent.click(screen.getByRole("button", { name: "Pause the example" }));
    advance(20_000);
    expect(shownMessages()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Resume the example" }));
    advance(BEATS[2].after);
    expect(screen.getByRole("status")).toBeTruthy();

    offScreen();
    const at = caption();
    advance(20_000);
    expect(caption()).toBe(at);
    expect(vi.getTimerCount()).toBe(0);
    onScreen();
    expect(screen.getByRole("button", { name: "Pause the example" })).toBeTruthy();
    playToEnd();
    expect(shownMessages()).toHaveLength(DEMO_MESSAGES.length);
  });

  it("plays a chapter from its start once the example has ended, but keeps still when the person paused it", () => {
    vi.useFakeTimers();
    withObserver();
    render(<BuilderDemo />);
    onScreen();
    playToEnd();
    fireEvent.click(screen.getByRole("button", { name: /Go to chapter 2/ }));
    expect(caption()).toBe(BEATS[CHAPTER_START[1]].caption);
    expect(screen.getByRole("button", { name: "Pause the example" })).toBeTruthy();
    advance(BEATS[CHAPTER_START[1] + 1].after);
    expect(caption()).toBe(BEATS[CHAPTER_START[1] + 1].caption);

    fireEvent.click(screen.getByRole("button", { name: "Pause the example" }));
    fireEvent.click(screen.getByRole("button", { name: /Go to chapter 3/ }));
    advance(20_000);
    expect(caption()).toBe(BEATS[CHAPTER_START[2]].caption);
    expect(screen.getByRole("button", { name: "Resume the example" })).toBeTruthy();
  });

  it("shows the half the beat is about, and a half the person chooses stays until the example moves on to the other by itself", () => {
    vi.useFakeTimers();
    withObserver();
    render(<BuilderDemo />);
    const on = () => [...document.querySelectorAll("[data-panel]")].filter((p) => !p.hasAttribute("data-off")).map((p) => p.getAttribute("data-panel"));
    const chat = screen.getByRole("button", { name: "Show the chat of the example" });
    const canvas = screen.getByRole("button", { name: "Show the canvas of the example" });
    onScreen();
    advance(BEATS[1].after);
    expect(on()).toEqual(["chat"]);
    expect(chat.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(canvas);
    expect(on()).toEqual(["canvas"]);
    expect(canvas.getAttribute("aria-pressed")).toBe("true");
    advance(BEATS[2].after);
    expect(on()).toEqual(["canvas"]);
    // What the chat got meanwhile is marked on its switch.
    expect(chat.querySelector("[data-unseen]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Pause the example" })).toBeTruthy();

    const firstNode = BEATS.findIndex((b) => b.nodes.length > 0);
    for (let i = 3; i <= firstNode; i++) advance(BEATS[i].after);
    expect(on()).toEqual(["canvas"]);
    const nextChat = BEATS.findIndex((b, i) => i > firstNode && viewOf(b) === "chat");
    for (let i = firstNode + 1; i <= nextChat; i++) advance(BEATS[i].after);
    // The example moved on to the canvas by itself, so the choice ended there: it follows the example back to the chat.
    expect(on()).toEqual(["chat"]);
    expect(document.querySelector("[data-unseen]")).toBeNull();
  });

  it("steps with a sideways swipe, and leaves an up-and-down one to the page", () => {
    withObserver();
    render(<BuilderDemo />);
    const stage = document.querySelector("[data-panel='chat']")!.parentElement!;
    const swipe = (dx: number, dy: number) => {
      fireEvent.pointerDown(stage, { pointerType: "touch", clientX: 200, clientY: 300 });
      fireEvent.pointerUp(stage, { pointerType: "touch", clientX: 200 + dx, clientY: 300 + dy });
    };
    swipe(-120, 10);
    expect(caption()).toBe(BEATS[1].caption);
    swipe(-120, 0);
    expect(caption()).toBe(BEATS[2].caption);
    swipe(130, -8);
    expect(caption()).toBe(BEATS[1].caption);
    swipe(30, 200);
    expect(caption()).toBe(BEATS[1].caption);
    expect(screen.getByRole("button", { name: "Resume the example" })).toBeTruthy();
  });

  it("steps one beat at a time, jumps between chapters, and replays from the start", () => {
    vi.useFakeTimers();
    withObserver();
    render(<BuilderDemo />);
    expect(screen.getByRole("button", { name: "Previous step of the example" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Next step of the example" }));
    expect(caption()).toBe(BEATS[1].caption);
    expect(shownMessages()).toEqual([DEMO_MESSAGES[0].text]);
    advance(20_000);
    expect(caption()).toBe(BEATS[1].caption);

    fireEvent.click(screen.getByRole("button", { name: /Go to chapter 3/ }));
    expect(caption()).toBe(BEATS[CHAPTER_START[2]].caption);
    expect(screen.getByRole("button", { name: /Go to chapter 3/ }).getAttribute("aria-current")).toBe("step");
    expect(shownMessages()).toHaveLength(3);
    expect(shownNodes()).toEqual(BEATS[CHAPTER_START[2]].nodes);
    // A jump places what's there without replaying each entrance.
    expect(document.querySelectorAll("[data-enter]")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /Go to chapter 4/ }));
    expect(screen.getByRole("button", { name: "Next step of the example" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Replay the example" }));
    expect(shownMessages()).toEqual([]);
    playToEnd();
    expect(shownMessages()).toHaveLength(DEMO_MESSAGES.length);
  });
});
