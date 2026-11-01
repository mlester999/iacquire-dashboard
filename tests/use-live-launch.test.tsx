// @vitest-environment jsdom
// How the launch panel keeps itself current: when it asks the server again, how it backs off, and when it speaks. Every timing here is driven by fake timers, so a wait that is wrong by
// a second fails. The reads are fakes; the readiness objects are the real judge's output.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { deriveLaunchReadiness, fingerprintOf, type EmployeeFact, type LaunchFacts, type LaunchReadiness } from "@/lib/launch-readiness";
import { BACKOFF_CAP_MS, FAST_POLL_MS, SLOW_POLL_MS, describeLaunch, pollIntervalMs, updatedAgoText, useLiveLaunch, type LaunchFetcher } from "@/components/setup/use-live-launch";

const employee = (role: (typeof AGENT_ROLE_KEYS)[number], over: Partial<EmployeeFact> = {}): EmployeeFact => ({
  role, entitled: true, provisioning: "succeeded", provisioningDetail: null, attempts: 1, maxAttempts: 3, nextRetryAt: null, healthFailed: false, healthDetail: null, heldForReview: false, configVersion: 3,
  readiness: { state: "ready", chatAvailable: true, workReady: true, description: "Ready.", blocking: [] }, ...over,
});
const inProgress = (role: (typeof AGENT_ROLE_KEYS)[number]) =>
  employee(role, { provisioning: "in_progress", readiness: { state: "pending_setup", chatAvailable: false, workReady: false, description: "Not ready.", blocking: [] } });

function facts(over: Partial<LaunchFacts> = {}): LaunchFacts {
  return {
    submitted: true, paymentCleared: true, canOpenBilling: true,
    profile: { companyName: true, industry: true, description: true, timezone: "America/Chicago", timezoneAnswered: true },
    knowledge: { approved: 3, pending: 0 },
    crm: { mode: "native", blueprint: "verified", pipelineReady: true, records: { state: "in_place", tags: 2, contactFields: 1, forms: 1 }, providerConnected: false },
    appointments: { wanted: false, calendar: null, externalCalendarConnected: false },
    channels: [],
    employees: AGENT_ROLE_KEYS.map((role) => employee(role)),
    verification: AGENT_ROLE_KEYS.map((role) => ({ role, state: "passed" as const, configVersion: 3, detail: null })),
    ...over,
  };
}
const profileMissing = { companyName: false, industry: true, description: true, timezone: "America/Chicago", timezoneAnswered: true };
/** Every required check passed: nothing will change by itself. */
const ready = () => deriveLaunchReadiness(facts());
/** Only the client has something to do (the company details are not all saved): nothing is running. */
const clientOnly = () => deriveLaunchReadiness(facts({ profile: profileMissing }));
/** A required step is running by itself and nothing is needed from the client. */
const running = () => deriveLaunchReadiness(facts({ employees: AGENT_ROLE_KEYS.map((role) => (role === "lead_hunter" ? inProgress(role) : employee(role))) }));
/** The client has something to do AND the system is still working. */
const blockedWhileRunning = () => deriveLaunchReadiness(facts({ profile: profileMissing, employees: AGENT_ROLE_KEYS.map((role) => (role === "lead_hunter" ? inProgress(role) : employee(role))) }));

const answer = (readiness: LaunchReadiness) => ({ readiness, fingerprint: fingerprintOf(readiness) });

let visibility: "visible" | "hidden" = "visible";
let onLine = true;
beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  onLine = true;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => onLine });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(document, "visibilityState");
  Reflect.deleteProperty(navigator, "onLine");
});

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const settle = () => act(async () => { await Promise.resolve(); });

function mount(initial: LaunchReadiness | null, impl: LaunchFetcher, enabled = true) {
  const fetcher = vi.fn(impl);
  const view = renderHook(() => useLiveLaunch({ initial, fetcher, enabled }));
  return { fetcher, view };
}

describe("when the panel asks again", () => {
  it("names the wait from the state: fast while something is running or iAcquire has something open, slow while only the client acts, never at 100%", () => {
    expect(pollIntervalMs(running())).toBe(FAST_POLL_MS);
    expect(pollIntervalMs(blockedWhileRunning())).toBe(FAST_POLL_MS);
    expect(pollIntervalMs(clientOnly())).toBe(SLOW_POLL_MS);
    expect(pollIntervalMs(ready())).toBeNull();
    // Waiting only on iAcquire's review is iAcquire's open item: fast.
    expect(pollIntervalMs(deriveLaunchReadiness(facts({ knowledge: { approved: 0, pending: 2 } })))).toBe(FAST_POLL_MS);
    // Before the questionnaire is submitted nothing happens by itself; a failed first read is asked for again, slowly.
    expect(pollIntervalMs(deriveLaunchReadiness(facts({ submitted: false })))).toBeNull();
    expect(pollIntervalMs(null)).toBe(SLOW_POLL_MS);
  });

  it("does not count a line that is not required: an open informational line never keeps the fast rate", () => {
    const busy = running();
    expect(pollIntervalMs(busy)).toBe(FAST_POLL_MS);
    // The same reading, but the lines that were running are only information: nothing the percentage is made of is open, so nothing is asked for.
    const informational: LaunchReadiness = { ...busy, steps: busy.steps.map((s) => ({ ...s, items: s.items.map((i) => (i.state === "in_progress" ? { ...i, required: false } : i)) })) };
    expect(pollIntervalMs(informational)).toBeNull();
  });

  it("polls every 5 s while a required step is running, even when the client also has something to do", async () => {
    const { fetcher } = mount(blockedWhileRunning(), async () => answer(blockedWhileRunning()));
    await tick(FAST_POLL_MS - 1);
    expect(fetcher).not.toHaveBeenCalled();
    await tick(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await tick(FAST_POLL_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("waits 30 s while only the client has something to do", async () => {
    const { fetcher } = mount(clientOnly(), async () => answer(clientOnly()));
    await tick(SLOW_POLL_MS - 1);
    expect(fetcher).not.toHaveBeenCalled();
    await tick(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("slows down when what it read says only the client is left, and stops when it reads 100%", async () => {
    const answers = [clientOnly(), ready()];
    const { fetcher, view } = mount(running(), async () => answer(answers.shift() ?? ready()));
    await tick(FAST_POLL_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Now clientOnly is on screen (slow wait): the next read is 30 s away, not 5.
    await tick(FAST_POLL_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await tick(SLOW_POLL_MS - FAST_POLL_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(view.result.current.readiness?.state).toBe("ready_to_launch");
    // At 100% nothing is asked again, however long the page stays open.
    await tick(60 * 60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never asks at 100% or when it is turned off (the design preview)", async () => {
    const done = mount(ready(), async () => answer(ready()));
    await tick(10 * 60_000);
    expect(done.fetcher).not.toHaveBeenCalled();
    cleanup();
    const off = mount(running(), async () => answer(running()), false);
    await tick(10 * 60_000);
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(off.fetcher).not.toHaveBeenCalled();
    expect(off.view.result.current.connection).toBe("ok");
  });

  it("asks at once when the tab regains focus, becomes visible or comes back online, and asks once when they happen together", async () => {
    let release!: (v: ReturnType<typeof answer>) => void;
    let first = true;
    const { fetcher } = mount(clientOnly(), () => {
      if (!first) return Promise.resolve(answer(clientOnly()));
      first = false;
      return new Promise((resolve) => { release = resolve; });
    });
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // The same moment fires visibilitychange and online too: one read is already on its way, so they join it.
    act(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("online")); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { release(answer(clientOnly())); });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await settle();
    act(() => { window.dispatchEvent(new Event("online")); });
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not ask from a tab nobody is looking at, and asks the moment it is shown", async () => {
    const { fetcher } = mount(running(), async () => answer(running()));
    visibility = "hidden";
    await tick(5 * FAST_POLL_MS);
    expect(fetcher).not.toHaveBeenCalled();
    visibility = "visible";
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("when a read fails", () => {
  it("doubles the wait each time, up to a ceiling, and goes back to the normal wait after a good read", async () => {
    let failing = true;
    const { fetcher, view } = mount(running(), async () => {
      if (failing) throw new Error("down");
      return answer(running());
    });
    await tick(FAST_POLL_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(view.result.current.connection).toBe("error");
    await tick(2 * FAST_POLL_MS - 1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await tick(4 * FAST_POLL_MS - 1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    // It recovers: the failure flag clears and the wait is 5 s again.
    failing = false;
    await tick(8 * FAST_POLL_MS);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(view.result.current.connection).toBe("ok");
    await tick(FAST_POLL_MS);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("never waits longer than the ceiling", async () => {
    const { fetcher } = mount(running(), async () => { throw new Error("down"); });
    for (let i = 0; i < 12; i += 1) await tick(BACKOFF_CAP_MS);
    const calls = fetcher.mock.calls.length;
    await tick(BACKOFF_CAP_MS);
    expect(fetcher.mock.calls.length).toBe(calls + 1);
  });

  it("says offline from the browser's own word, and online again with the same word", async () => {
    const { view } = mount(clientOnly(), async () => answer(clientOnly()));
    expect(view.result.current.connection).toBe("ok");
    onLine = false;
    act(() => { window.dispatchEvent(new Event("offline")); });
    expect(view.result.current.connection).toBe("offline");
    onLine = true;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(view.result.current.connection).toBe("ok");
  });

  it("keeps showing what it last read while reads fail", async () => {
    const first = running();
    const { view } = mount(first, async () => { throw new Error("down"); });
    await tick(FAST_POLL_MS);
    expect(view.result.current.readiness).toEqual(first);
  });

  it("recovers a page whose first read failed: it asks again by itself and then shows the state", async () => {
    const { fetcher, view } = mount(null, async () => answer(clientOnly()));
    expect(view.result.current.readiness).toBeNull();
    await tick(SLOW_POLL_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(view.result.current.readiness?.state).toBe("action_required");
    // The first state after a failed read is not an announcement: nothing was on screen to change.
    expect(view.result.current.announcement).toBe("");
  });
});

describe("what is announced", () => {
  it("speaks only when the fingerprint changes, in one sentence with the percent and what is the client's own", async () => {
    const answers = [running(), running(), blockedWhileRunning()];
    const { view } = mount(clientOnly(), async () => answer(answers.shift() ?? ready()));
    expect(view.result.current.announcement).toBe("");
    await tick(SLOW_POLL_MS);
    // A different state: announced.
    expect(view.result.current.announcement).toBe(describeLaunch(running()));
    expect(view.result.current.announcement).toMatch(/^Launch readiness \d+ percent/);
    const first = view.result.current.announcement;
    // The same state read again: not announced again.
    await tick(FAST_POLL_MS);
    expect(view.result.current.announcement).toBe(first);
    // The client has a thing to do again: announced, with the count.
    await tick(FAST_POLL_MS);
    expect(view.result.current.announcement).toBe(describeLaunch(blockedWhileRunning()));
    expect(view.result.current.announcement).toContain("1 thing needs you");
  });

  it("does not speak for new wording, a new count or a new time when no state or owner moved, but still shows the new reading", async () => {
    const before = running();
    const reworded: LaunchReadiness = { ...before, percent: before.percent + 1, detail: "Different words.", steps: before.steps.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i, detail: `${i.detail} (reworded)` })) })) };
    expect(fingerprintOf(reworded)).toBe(fingerprintOf(before));
    const { view } = mount(before, async () => answer(reworded));
    await tick(FAST_POLL_MS);
    expect(view.result.current.readiness?.detail).toBe("Different words.");
    expect(view.result.current.announcement).toBe("");
  });

  it("trusts the fingerprint the server sent, not its own", async () => {
    const same = running();
    const { view } = mount(same, async () => ({ readiness: same, fingerprint: "a-different-fingerprint" }));
    await tick(FAST_POLL_MS);
    expect(view.result.current.announcement).toBe(describeLaunch(same));
  });
});

describe("its text", () => {
  it("says how long ago the state was read, in whole seconds, never negative", () => {
    expect(updatedAgoText(1_000, 1_000)).toBe("Updated just now");
    expect(updatedAgoText(1_000, 4_999)).toBe("Updated just now");
    expect(updatedAgoText(1_000, 13_000)).toBe("Updated 12 s ago");
    expect(updatedAgoText(1_000, 61_000)).toBe("Updated 1 min ago");
    expect(updatedAgoText(1_000, 1_000 + 190_000)).toBe("Updated 3 min ago");
    expect(updatedAgoText(5_000, 1_000)).toBe("Updated just now");
  });
});

describe("what the hook is allowed to import", () => {
  it("imports only react and @/lib, so a client bundle never reaches server code through it", () => {
    const source = readFileSync(path.join(process.cwd(), "src", "components", "setup", "use-live-launch.ts"), "utf8");
    const specs = [...source.matchAll(/^import\s[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(spec === "react" || spec.startsWith("@/lib/"), spec).toBe(true);
  });
});
