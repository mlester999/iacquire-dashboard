// @vitest-environment jsdom
// The agency's plan controls: each action asks first, a payment can only be recorded after the person says they verified it, and the screen never
// claims a payment was taken or detected. The actions are stand-ins; their rules are tested against the real services in automation-studio-operations.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const actions = vi.hoisted(() => ({
  recordPaymentFailedAction: vi.fn(async (_id: string, _days?: number) => ({ ok: true as const, data: {} })),
  recordVerifiedPaymentAction: vi.fn(async (_id: string, _through: string, _confirmed: boolean) => ({ ok: true as const, data: {} })),
  expireSubscriptionAction: vi.fn(async (_id: string) => ({ ok: true as const, data: {} })),
}));
vi.mock("@/app/(admin)/admin/maintenance/actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }) }));

import { PlanLifecycle, type PlanLifecycleInfo } from "@/components/admin/plan-lifecycle";
import { TooltipProvider } from "@/components/ui/overlays";

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const info = (over: Partial<PlanLifecycleInfo> = {}): PlanLifecycleInfo => ({ pastDueSince: null, graceEndsAt: null, expiredAt: null, paidThroughOn: null, lastPaymentVerifiedAt: null, lastPaymentVerifiedBy: null, studioWorkflows: 2, studioPaused: 0, ...over });
const ui = (status: string, i = info()) => render(<TooltipProvider><PlanLifecycle subscriptionId="s1" status={status} info={i} /></TooltipProvider>);
const day = 86_400_000;

describe("plan lifecycle controls", () => {
  it("shows where the money side stands as recorded, never as detected", () => {
    const { container } = ui("active", info({ paidThroughOn: "2026-11-20", lastPaymentVerifiedAt: "2026-10-20T10:00:00Z", lastPaymentVerifiedBy: "Agency Admin" }));
    expect(container.textContent).toMatch(/Paid through/);
    expect(container.textContent).toMatch(/by Agency Admin/);
    expect(container.textContent).toMatch(/2 Studio workflows|Studio workflows2/);
    expect(container.textContent).not.toMatch(/payment received|was charged|collected|automatically|detected/i);
  });

  it("records a failed payment only after asking, with the grace period the agency sees and can change", async () => {
    ui("active");
    fireEvent.click(screen.getByRole("button", { name: /Record failed payment/ }));
    const dialog = await screen.findByRole("dialog");
    const days = within(dialog).getByLabelText("Grace period (days)") as HTMLInputElement;
    expect(days.value).toBe("7");
    expect(dialog.textContent).toMatch(/paused, not deleted/);
    expect(actions.recordPaymentFailedAction).not.toHaveBeenCalled();
    fireEvent.change(days, { target: { value: "10" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record it" }));
    await waitFor(() => expect(actions.recordPaymentFailedAction).toHaveBeenCalledWith("s1", 10));
  });

  it("will not record a payment until the person confirms they verified it, and sends that confirmation with it", async () => {
    ui("past_due", info({ pastDueSince: new Date(Date.now() - day).toISOString(), graceEndsAt: new Date(Date.now() + 5 * day).toISOString() }));
    expect(screen.getByRole("status").textContent).toMatch(/keeps Automation Studio until/);
    fireEvent.click(screen.getByRole("button", { name: /Record verified payment/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/does not charge cards or detect payments/);
    const record = within(dialog).getByRole("button", { name: "Record payment" }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I confirmed this payment in our billing records/ }));
    expect(record.disabled).toBe(false);
    fireEvent.click(record);
    await waitFor(() => expect(actions.recordVerifiedPaymentAction).toHaveBeenCalledWith("s1", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), true));
  });

  it("explains an expired plan: paused, not deleted, and nothing switches itself back on", () => {
    ui("expired", info({ expiredAt: "2026-10-01T00:00:00Z", studioPaused: 2 }));
    expect(screen.getByRole("status").textContent).toMatch(/paused \(nothing is deleted\)/);
    expect(screen.getByRole("status").textContent).toMatch(/turns each workflow on again after reviewing it/);
    expect(screen.queryByRole("button", { name: /Record failed payment/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /End plan now/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Record verified payment/ })).toBeTruthy();
  });

  it("asks before ending a plan and says what is and isn't affected", async () => {
    ui("past_due", info({ graceEndsAt: new Date(Date.now() + 2 * day).toISOString() }));
    fireEvent.click(screen.getByRole("button", { name: "End plan now" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/paused straight away \(nothing is deleted\)/);
    expect(dialog.textContent).toMatch(/CRM, AI employees and external automations are not affected/);
    expect(actions.expireSubscriptionAction).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "End plan" }));
    await waitFor(() => expect(actions.expireSubscriptionAction).toHaveBeenCalledWith("s1"));
  });
});
