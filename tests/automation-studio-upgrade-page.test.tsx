// @vitest-environment jsdom
// The Automation Studio upgrade page (a workspace without the plan): it states the real price, terms and allowances, says plainly what keeps working
// without the plan, sends every call to action to the Maintenance page where the real request is made, and plays its example on the real canvas
// without React Flow's corner link, pausable, and finished from the start for people who ask for reduced motion.
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

import { UpgradePage, type UpgradeProps } from "@/components/automation-studio/upgrade-page";
import { BEATS, BuilderDemo, DEMO_MESSAGES, exampleDefinition } from "@/components/automation-studio/builder-demo";
import { STUDIO_DEFAULT_LIMITS, STUDIO_LAPSE_POLICY, STUDIO_PLAN_MONTHLY_USD, STUDIO_SETUP_FEE_USD } from "@/lib/automation-studio/plan";
import { TRIGGER_ID } from "@/components/automation-studio/canvas/flow-model";

let reducedMotion = false;
let intersect: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("reduce") ? reducedMotion : false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.DOMMatrixReadOnly ??= class { m22 = 1; constructor() {} } as unknown as typeof DOMMatrixReadOnly;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  reducedMotion = false;
  intersect = null;
  // @ts-expect-error -- each test decides whether the browser has one
  delete globalThis.IntersectionObserver;
});

const props = (over: Partial<UpgradeProps> = {}): UpgradeProps => ({
  state: "none", reason: "Automation Studio is part of the optional plan.", monthlyUsd: STUDIO_PLAN_MONTHLY_USD, setupFeeUsd: STUDIO_SETUP_FEE_USD,
  canRequest: true, requestNote: null, saved: [], ...over,
});

const USD = (n: number) => `$${n.toLocaleString("en-US")}`;

function withObserver() {
  globalThis.IntersectionObserver = class {
    constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) { intersect = cb; }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
}

const shownMessages = () =>
  within(screen.getByRole("list", { name: "Example conversation" })).getAllByRole("listitem").map((li) => li.querySelector("p")!).filter((p) => !p.className.includes("invisible")).map((p) => p.textContent);

describe("Automation Studio upgrade page", () => {
  it("shows the monthly price and the one-time setup separately, and the provisional allowances in full", () => {
    const { container } = render(<UpgradePage {...props()} />);
    const text = container.textContent ?? "";
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Describe an automation. Watch it get built.");
    expect(text).toContain(USD(STUDIO_PLAN_MONTHLY_USD));
    expect(text).toContain(USD(STUDIO_SETUP_FEE_USD));
    expect(text).toMatch(/provisional/i);
    for (const n of [STUDIO_DEFAULT_LIMITS.monthlyRuns, STUDIO_DEFAULT_LIMITS.monthlySteps, STUDIO_DEFAULT_LIMITS.monthlyBuilderMessages, STUDIO_DEFAULT_LIMITS.maxActiveWorkflows]) expect(text).toContain(n.toLocaleString("en-US"));
    expect(text).toMatch(/charged from your usage credits/);
    expect(text).toMatch(/7 days/);
  });

  it("says what keeps working without the plan, and that lapsed automations are paused, not deleted", () => {
    const { container } = render(<UpgradePage {...props()} />);
    const without = screen.getByRole("heading", { name: "Without the plan" }).closest("div")!;
    expect(without.textContent).toMatch(/CRM, its workflow builder/);
    expect(without.textContent).toMatch(/AI employees/);
    expect(without.textContent).toMatch(/n8n, Zapier and Make/);
    expect(container.textContent).toContain(STUDIO_LAPSE_POLICY.kept);
    expect(container.textContent).toMatch(/paused, not deleted/);
  });

  it("sends every call to action to the Maintenance page, labelled for the plan's state", () => {
    const { unmount } = render(<UpgradePage {...props()} />);
    const ctas = screen.getAllByRole("link", { name: /Request Automation Studio/ });
    expect(ctas).toHaveLength(2);
    for (const a of ctas) expect(a.getAttribute("href")).toBe("/maintenance");
    expect(screen.getAllByText(/Nothing is charged from this page/)).toHaveLength(2);
    unmount();

    render(<UpgradePage {...props({ state: "pending", reason: "Your request is waiting for iAcquire to activate the plan." })} />);
    expect(screen.getAllByRole("link", { name: /View your request/ }).every((a) => a.getAttribute("href") === "/maintenance")).toBe(true);
    expect(screen.getByRole("note").textContent).toMatch(/waiting for iAcquire/);
    cleanup();

    render(<UpgradePage {...props({ state: "expired", reason: "Your plan has expired.", saved: [{ id: "w1", name: "Welcome new leads" }] })} />);
    expect(screen.getAllByRole("link", { name: /Reactivate the plan/ })).toHaveLength(2);
    expect(screen.getByRole("link", { name: /Welcome new leads/ }).getAttribute("href")).toBe("/automation-studio/w1");
  });

  it("tells someone who can't request the plan why, instead of promising a request", () => {
    render(<UpgradePage {...props({ canRequest: false, requestNote: "Only the owner of your workspace can request the plan. Ask them to open the Maintenance page." })} />);
    expect(screen.getAllByText(/Only the owner of your workspace can request the plan/)).toHaveLength(2);
    expect(screen.queryByText(/You’ll review the terms and send the request/)).toBeNull();
  });

  it("draws the example on the canvas without React Flow's corner link", () => {
    const { container } = render(<UpgradePage {...props()} />);
    expect(container.querySelector(".react-flow")).not.toBeNull();
    expect(container.querySelector(".react-flow__attribution")).toBeNull();
    expect(container.querySelectorAll("a[href*='reactflow']")).toHaveLength(0);
    expect(screen.getByText("Example", { exact: true })).toBeTruthy();
  });
});

describe("the example played back", () => {
  it("is a script that only ever adds, ends complete, and makes the one change the conversation asks for", () => {
    for (let i = 1; i < BEATS.length; i++) {
      expect(BEATS[i].messages).toBeGreaterThanOrEqual(BEATS[i - 1].messages);
      expect(BEATS[i - 1].nodes.every((n) => BEATS[i].nodes.includes(n))).toBe(true);
    }
    const last = BEATS[BEATS.length - 1];
    expect(last.messages).toBe(DEMO_MESSAGES.length);
    expect(last.nodes).toContain(TRIGGER_ID);
    expect(last.nodes).toHaveLength(exampleDefinition("wide", 3).steps!.length + 1);
    expect(last.waitDays).toBe(3);
    for (const layout of ["wide", "narrow"] as const) {
      const def = exampleDefinition(layout, 2);
      expect(def.steps!.map((s) => s.key)).toEqual(["welcome", "wait", "check", "done", "nudge"]);
      expect(def.steps!.every((s) => typeof s.ui?.x === "number" && typeof s.ui?.y === "number")).toBe(true);
    }
    expect(exampleDefinition("wide", 3).steps!.find((s) => s.key === "wait")!.config).toMatchObject({ amount: 3, unit: "days" });
  });

  it("shows the finished example to people who ask for reduced motion, and never starts on its own", () => {
    reducedMotion = true;
    withObserver();
    render(<BuilderDemo />);
    expect(shownMessages()).toEqual(DEMO_MESSAGES.map((m) => m.text));
    expect(intersect).toBeNull();
    expect(screen.getByRole("button", { name: "Replay the example" })).toBeTruthy();
  });

  it("shows the finished example where it can't tell it's on screen", () => {
    render(<BuilderDemo />);
    expect(shownMessages()).toHaveLength(DEMO_MESSAGES.length);
  });

  it("plays once it scrolls into view, can be paused and resumed, and replays from the start", () => {
    vi.useFakeTimers();
    withObserver();
    render(<BuilderDemo />);
    expect(shownMessages()).toEqual([]);
    expect(screen.getByText("The automation appears here as it’s built")).toBeTruthy();

    act(() => intersect!([{ isIntersecting: true }]));
    act(() => { vi.advanceTimersByTime(BEATS[1].after); });
    expect(shownMessages()).toEqual([DEMO_MESSAGES[0].text]);

    fireEvent.click(screen.getByRole("button", { name: "Pause the example" }));
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(shownMessages()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Resume the example" }));
    act(() => { vi.advanceTimersByTime(BEATS[2].after); });
    expect(screen.getByRole("status").textContent).toMatch(/Reading your request/);
    for (let i = 0; i < BEATS.length; i++) act(() => { vi.advanceTimersByTime(2_000); });
    expect(shownMessages()).toEqual(DEMO_MESSAGES.map((m) => m.text));

    fireEvent.click(screen.getByRole("button", { name: "Replay the example" }));
    expect(shownMessages()).toEqual([]);
    for (let i = 0; i < BEATS.length; i++) act(() => { vi.advanceTimersByTime(2_000); });
    expect(shownMessages()).toHaveLength(DEMO_MESSAGES.length);
  });
});
