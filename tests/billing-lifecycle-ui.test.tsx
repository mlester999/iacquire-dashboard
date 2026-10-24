// @vitest-environment jsdom
// What the agency's plan card says about a paid period that ended with no payment recorded (Phase 7, M2): a plain, honest line for a person to act on, only while the plan is still
// running, and never a claim that a payment failed or was detected. The actions are stand-ins; their rules are tested against the real services in billing-lifecycle.
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/app/(admin)/admin/maintenance/actions", () => ({
  recordPaymentFailedAction: vi.fn(async () => ({ ok: true as const, data: {} })),
  recordVerifiedPaymentAction: vi.fn(async () => ({ ok: true as const, data: {} })),
  expireSubscriptionAction: vi.fn(async () => ({ ok: true as const, data: {} })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }) }));

import { PlanLifecycle, type PlanLifecycleInfo } from "@/components/admin/plan-lifecycle";
import { TooltipProvider } from "@/components/ui/overlays";

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const info = (over: Partial<PlanLifecycleInfo> = {}): PlanLifecycleInfo => ({ pastDueSince: null, graceEndsAt: null, expiredAt: null, paidThroughOn: "2026-10-01", lastPaymentVerifiedAt: null, lastPaymentVerifiedBy: null, studioWorkflows: 1, studioPaused: 0, ...over });
const show = (status: string, i: PlanLifecycleInfo) => render(<TooltipProvider><PlanLifecycle subscriptionId="s1" status={status} info={i} /></TooltipProvider>);

describe("a paid period that ended and nobody recorded anything since", () => {
  it("says so in plain words, says the plan is still active, and offers the two things a person can do", () => {
    show("active", info({ periodEndedDaysAgo: 3 }));
    const line = screen.getByRole("status");
    expect(line.textContent).toBe("The paid period ended 3 days ago and no payment has been recorded since. The plan is still active. Record the payment, or record a failed payment to start the grace period.");
    expect(screen.getByRole("button", { name: /Record verified payment/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Record failed payment/ })).toBeTruthy();
    expect(line.textContent).not.toMatch(/failed on|didn't go through|was charged|detected|automatically/i);
  });

  it("reads right for one day, and for a plan whose cancellation is waiting to be confirmed", () => {
    show("cancel_requested", info({ periodEndedDaysAgo: 1 }));
    expect(screen.getByRole("status").textContent).toMatch(/ended 1 day ago and/);
  });

  it.each([
    ["no days", { periodEndedDaysAgo: null }],
    ["zero days", { periodEndedDaysAgo: 0 }],
    ["a count the page predates", {}],
  ] as const)("shows nothing for %s", (_name, over) => {
    show("active", info(over));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each(["past_due", "expired", "requested"])("shows nothing on a plan that is %s, even if a count is passed", (status) => {
    show(status, info({ periodEndedDaysAgo: 4 }));
    expect(screen.queryByText(/paid period ended/)).toBeNull();
  });
});
