// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/overview", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("motion/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("motion/react")>(),
  useReducedMotion: () => true,
}));

import { TutorialStage } from "@/components/aqi/tutorial/tutorial-stage";
import { previewTutorialDraft, resetGuidanceForTests } from "@/components/aqi/tutorial/tutorial-store";

const definition = {
  title: "Stage test tour",
  description: "A tour used to test the stage.",
  category: "Testing",
  routePrefix: "/overview",
  roles: [],
  priority: 1,
  requiresCrm: null,
  aliases: [],
  keywords: [],
  steps: [
    { key: "hero", title: "This is the hero", body: "It explains the page.", targetId: "overview.hero", route: null },
    { key: "kpis", title: "These are the numbers", body: "They are real.", targetId: "overview.kpis", route: null },
  ],
  completion: { kind: "finish" },
} as unknown as Parameters<typeof previewTutorialDraft>[0];

function addTarget(id: string): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("data-aqi-target", id);
  element.style.opacity = "1";
  element.getBoundingClientRect = () => ({ left: 100, top: 120, width: 300, height: 80, right: 400, bottom: 200, x: 100, y: 120, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(element);
  return element;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
  window.matchMedia = globalThis.matchMedia;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  resetGuidanceForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("walkthrough stage", () => {
  it("shows the step beside a target that exists, with Next available", async () => {
    addTarget("overview.hero");
    previewTutorialDraft(definition);
    render(<TutorialStage />);
    await advance(600);
    expect(screen.getByRole("heading", { name: "This is the hero" })).toBeTruthy();
    expect(document.querySelector("[data-aqi-highlight]")).toBeTruthy();
    expect(screen.queryByText(/couldn.t find that control/i)).toBeNull();
    expect((screen.getByRole("button", { name: "Next step" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says so, and offers Retry, when the target never appears", async () => {
    previewTutorialDraft(definition);
    render(<TutorialStage />);
    await advance(9000);
    expect(screen.getByText(/couldn.t find that control/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next step" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector("[data-aqi-highlight]")).toBeNull();
  });

  it("clears the notice and re-enables Next when the target appears after the search gave up", async () => {
    previewTutorialDraft(definition);
    render(<TutorialStage />);
    await advance(9000);
    expect(screen.getByText(/couldn.t find that control/i)).toBeTruthy();
    // The page finished loading (or a dialog opened) and the control is now there: no Retry needed.
    addTarget("overview.hero");
    await advance(800);
    expect(screen.queryByText(/couldn.t find that control/i)).toBeNull();
    expect((screen.getByRole("button", { name: "Next step" }) as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector("[data-aqi-highlight]")).toBeTruthy();
  });
});
