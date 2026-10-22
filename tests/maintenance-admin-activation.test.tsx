// @vitest-environment jsdom
// Starting a managed maintenance plan (which includes Automation Studio) needs a person to say they verified the client's payment, and for what period.
// The screen won't send the activation until they have, and it sends exactly what they said. The action here is a stand-in; the rules behind it are
// tested against the real service in maintenance.test.ts.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const actions = vi.hoisted(() => ({
  activateMaintenanceAction: vi.fn(async (_id: string, _start: string | undefined, _through: string, _confirmed: boolean) => ({ ok: true as const, data: undefined })),
  resolveMaintenanceAction: vi.fn(async () => ({ ok: true as const, data: undefined })),
  updateMaintenanceRequestAction: vi.fn(async () => ({ ok: true as const, data: undefined })),
}));
vi.mock("@/app/(admin)/admin/maintenance/actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import { MaintenanceAdmin } from "@/components/admin/maintenance-admin";
import { TooltipProvider } from "@/components/ui/overlays";

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const requested = (over: Record<string, unknown> = {}) => ({
  id: "sub-1", status: "requested" as const, monthlyPriceCents: 29_900, currency: "USD", monthlyRequestAllowance: 4, termsVersion: "v1", acceptedAt: "2026-10-01T00:00:00Z",
  activatedAt: null, billingStartOn: null, renewalOn: null, cancelRequestedAt: null, orgId: "org-1", orgName: "Acme Roofing", used: 0, requestNote: null, cancelNote: null, eligible: true, ...over,
});
const ui = (sub = requested()) => render(<TooltipProvider><MaintenanceAdmin subscriptions={[sub] as never} requests={[]} /></TooltipProvider>);

describe("activating a managed maintenance plan", () => {
  it("won't start until the person confirms they verified the payment, then sends the period they entered", async () => {
    ui();
    const activate = screen.getByRole("button", { name: /Activate plan/ }) as HTMLButtonElement;
    expect(activate.disabled, "disabled until the payment is confirmed").toBe(true);
    fireEvent.click(activate);
    expect(actions.activateMaintenanceAction).not.toHaveBeenCalled();

    const through = screen.getByLabelText("Payment covers through") as HTMLInputElement;
    expect(through.value, "a month ahead by default").toMatch(/^\d{4}-\d{2}-\d{2}$/);
    fireEvent.change(through, { target: { value: "2026-12-01" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /confirmed this client's payment in our billing records/ }));
    expect(activate.disabled).toBe(false);
    fireEvent.click(activate);
    await waitFor(() => expect(actions.activateMaintenanceAction).toHaveBeenCalledTimes(1));
    const [id, start, paidThrough, confirmed] = actions.activateMaintenanceAction.mock.calls[0];
    expect(id).toBe("sub-1");
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(paidThrough).toBe("2026-12-01");
    expect(confirmed).toBe(true);
  });

  it("says plainly that iAcquire doesn't detect payments, and stays disabled for a client whose core system isn't active yet", () => {
    const { container } = ui(requested({ eligible: false }));
    expect(container.textContent).toMatch(/doesn.t detect payments/);
    fireEvent.click(screen.getByRole("checkbox", { name: /confirmed this client's payment/ }));
    expect((screen.getByRole("button", { name: /Activate plan/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
