// @vitest-environment jsdom
// The agency's runtime controls for a client workspace. The component decides nothing: every press asks the server and shows what the SERVER said. Here the server actions are stand-ins, so
// the test proves what the page itself is responsible for: it renders for nobody but a Super Admin looking at a real client (the page passes it null otherwise), a control whose deployment
// switch is off is disabled with the reason and cannot be pressed, a confirmation says what will happen (containment, not deletion), the confirmation will not go ahead without a reason of
// five characters, and the result shown is the server's own, success or refusal.
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RuntimeControls, SWITCHED_OFF_REASON, type RuntimeControlsData } from "@/components/admin/runtime-controls";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  requeue: vi.fn(),
  deprovision: vi.fn(),
  fleet: vi.fn(),
  revoke: vi.fn(),
  tiers: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/app/(admin)/admin/actions", () => ({ requeueProvisioningAction: mocks.requeue }));
vi.mock("@/app/(admin)/admin/provisioning-actions", () => ({ requestDeprovisionAction: mocks.deprovision, requestFleetSyncAction: mocks.fleet }));
vi.mock("@/app/actions/client-business-access", () => ({ revokeClientBusinessAccess: mocks.revoke, setClientBusinessToolsAction: mocks.tiers }));

vi.mock("@/components/ui/button", async () => {
  const React = await import("react");
  type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; variant?: string; size?: string };
  const Button = React.forwardRef<HTMLButtonElement, Props>(function Button({ loading: _loading, variant: _variant, size: _size, ...props }, ref) {
    return <button {...props} ref={ref} />;
  });
  return { Button };
});
vi.mock("@/components/ui/overlays", async () => {
  const React = await import("react");
  type DialogProps = { open: boolean; title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode; footer?: React.ReactNode };
  function Dialog({ open, title, description, children, footer }: DialogProps) {
    if (!open) return null;
    return <section role="dialog" aria-label={typeof title === "string" ? title : undefined}><h2>{title}</h2>{description && <p>{description}</p>}{children}<footer>{footer}</footer></section>;
  }
  return { Dialog };
});
vi.mock("@/components/ui/primitives", async () => {
  const React = await import("react");
  type DivProps = React.HTMLAttributes<HTMLDivElement>;
  const Card = ({ children }: DivProps) => <div>{children}</div>;
  const CardHeader = ({ children }: DivProps) => <header>{children}</header>;
  const CardContent = ({ children }: DivProps) => <div>{children}</div>;
  const CardTitle = ({ children }: DivProps) => <h2>{children}</h2>;
  const CardDescription = ({ children }: DivProps) => <p>{children}</p>;
  const Badge = ({ children }: React.HTMLAttributes<HTMLSpanElement>) => <span>{children}</span>;
  const Field = ({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) => <label htmlFor={htmlFor}><span>{label}</span>{children}</label>;
  const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(props, ref) { return <textarea {...props} ref={ref} />; });
  return { Card, CardHeader, CardContent, CardTitle, CardDescription, Badge, Field, Textarea };
});

const ORG = "11111111-1111-4111-8111-111111111111";
const data = (over: Partial<RuntimeControlsData> = {}): RuntimeControlsData => ({
  orgId: ORG,
  flags: { provisioner: true, deprovision: true, clientTools: true },
  tiers: { tools: false, proposals: false },
  employees: [
    { id: "a1", name: "Lead Hunter", enabled: true, hasProfile: true },
    { id: "a2", name: "Sales Assistant", enabled: true, hasProfile: true },
    { id: "a3", name: "CRM Manager", enabled: true, hasProfile: false },
    { id: "a4", name: "Performance Analyst", enabled: false, hasProfile: false },
  ],
  ...over,
});

async function press(buttonName: string, reason: string, confirmName: string) {
  fireEvent.click(screen.getByRole("button", { name: buttonName }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: reason } });
  fireEvent.click(within(dialog).getByRole("button", { name: confirmName }));
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});
afterEach(() => cleanup());

describe("who sees the controls", () => {
  it("renders nothing at all when the page gives it nothing (not a Super Admin, an agency workspace, a demo)", () => {
    const { container } = render(<RuntimeControls data={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("lists a retry for every employee in the plan, and a containment control only for an employee that has a runtime profile", () => {
    render(<RuntimeControls data={data()} />);
    expect(screen.getAllByRole("button", { name: /^Retry setup:/ }).map((b) => b.getAttribute("aria-label"))).toEqual(["Retry setup: Lead Hunter", "Retry setup: Sales Assistant", "Retry setup: CRM Manager"]);
    expect(screen.getAllByRole("button", { name: /^Contain:/ }).map((b) => b.getAttribute("aria-label"))).toEqual(["Contain: Lead Hunter", "Contain: Sales Assistant"]);
    expect(screen.getByRole("button", { name: "Synchronize: The whole client runtime" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "End access: All business-tool access" })).toBeTruthy();
  });
});

describe("a control behind a switch that is off", () => {
  it("is disabled with the reason beside it and cannot be pressed", () => {
    render(<RuntimeControls data={data({ flags: { provisioner: false, deprovision: false, clientTools: false } })} />);
    for (const name of ["Contain: Lead Hunter", "Contain: Sales Assistant", "Synchronize: The whole client runtime", "Turn on: Business tools (reads)", "Turn on: Change proposals"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled, name).toBe(true);
      fireEvent.click(button);
    }
    expect(screen.getAllByText(SWITCHED_OFF_REASON).length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByRole("dialog")).toBeNull();
    for (const mock of [mocks.deprovision, mocks.fleet, mocks.tiers]) expect(mock).not.toHaveBeenCalled();
  });

  it("leaves the controls that do not depend on a switch usable", () => {
    render(<RuntimeControls data={data({ flags: { provisioner: false, deprovision: false, clientTools: false } })} />);
    expect((screen.getByRole("button", { name: "End access: All business-tool access" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Retry setup: Lead Hunter" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("pressing a control", () => {
  it("shows a confirmation that says containment is not deletion, and will not go ahead without a reason of five characters", async () => {
    render(<RuntimeControls data={data()} />);
    fireEvent.click(screen.getByRole("button", { name: "Contain: Lead Hunter" }));
    const dialog = await screen.findByRole("dialog", { name: "Contain Lead Hunter's runtime profile?" });
    expect(dialog.textContent).toMatch(/containment, not deletion/i);
    expect(dialog.textContent).toMatch(/key is replaced/i);
    expect(dialog.textContent).toMatch(/profile, its history and its settings stay/i);
    const confirm = within(dialog).getByRole("button", { name: "Contain" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "four" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "fives" } });
    expect(confirm.disabled).toBe(false);
    expect(mocks.deprovision).not.toHaveBeenCalled();
  });

  it("calls the server action once with the workspace, the employee and the reason, and shows the server's own success", async () => {
    mocks.deprovision.mockResolvedValue({ ok: true, data: { jobId: "j1", alreadyOpen: false, replaced: 0 } });
    render(<RuntimeControls data={data()} />);
    await press("Contain: Lead Hunter", "  The client left the programme.  ", "Contain");
    await waitFor(() => expect(mocks.deprovision).toHaveBeenCalledTimes(1));
    expect(mocks.deprovision).toHaveBeenCalledWith(ORG, "a1", "The client left the programme.");
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Containment was requested\. Nothing is changed until the worker proves it/)));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/^Done: Containment was requested/);
  });

  it("says so when the server reports that the request was already open, rather than claiming a new one", async () => {
    mocks.deprovision.mockResolvedValue({ ok: true, data: { jobId: "j1", alreadyOpen: true, replaced: 0 } });
    render(<RuntimeControls data={data()} />);
    await press("Contain: Lead Hunter", "Pressed twice by mistake.", "Contain");
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/already open.*nothing new was requested/)));
  });

  it("shows the server's refusal in its own words, changes nothing on the page, and does not refresh", async () => {
    mocks.deprovision.mockResolvedValue({ ok: false, error: "Containment is turned off in this deployment." });
    render(<RuntimeControls data={data()} />);
    await press("Contain: Lead Hunter", "Trying anyway for the audit.", "Contain");
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Containment is turned off in this deployment."));
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Not done: Containment is turned off in this deployment.");
    // The confirmation stays open so the person can read it and cancel.
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("reports a server that could not be reached as not done, never as a success", async () => {
    mocks.fleet.mockRejectedValue(new Error("network"));
    render(<RuntimeControls data={data()} />);
    await press("Synchronize: The whole client runtime", "Runtime updated today.", "Synchronize");
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(expect.stringMatching(/could not be sent\. Nothing was changed/)));
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});

describe("the other controls", () => {
  it("retries a setup through the existing action with the reason", async () => {
    mocks.requeue.mockResolvedValue({ ok: true });
    render(<RuntimeControls data={data()} />);
    await press("Retry setup: CRM Manager", "The first attempt timed out.", "Retry setup");
    await waitFor(() => expect(mocks.requeue).toHaveBeenCalledWith(ORG, "a3", "The first attempt timed out."));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/new setup request was opened/)));
  });

  it("reports a fleet synchronization with the server's real counts and says when there is more to do", async () => {
    mocks.fleet.mockResolvedValue({ ok: true, data: { queued: [{}, {}, {}], alreadyOpen: 2, skipped: 1, truncated: true } });
    render(<RuntimeControls data={data()} />);
    await press("Synchronize: The whole client runtime", "Runtime updated today.", "Synchronize");
    await waitFor(() => expect(mocks.fleet).toHaveBeenCalledWith("Runtime updated today."));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Asked for 3 synchronizations; 2 employees were already waiting and 1 had nothing to synchronize\. More employees qualify.*press it again/)));
  });

  it("ends business-tool access with the reason and reports how many credentials the server ended", async () => {
    mocks.revoke.mockResolvedValue({ ok: true, data: { revoked: 6 } });
    render(<RuntimeControls data={data()} />);
    await press("End access: All business-tool access", "Suspected leak of a profile file.", "End access");
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith({ orgId: ORG, reason: "Suspected leak of a profile file." }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Ended 6 credentials."));
  });

  it("switches a tier the other way round from where it is, with the reason, and reports what the server did", async () => {
    mocks.tiers.mockResolvedValue({ ok: true, data: { changed: true, queued: 4 } });
    render(<RuntimeControls data={data({ tiers: { tools: true, proposals: false } })} />);
    await press("Turn off: Business tools (reads)", "Pausing tools while we review.", "Turn off");
    await waitFor(() => expect(mocks.tiers).toHaveBeenCalledWith({ orgId: ORG, tools: false, reason: "Pausing tools while we review." }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Switched off; 4 synchronizations were requested."));
    mocks.tiers.mockClear();
    mocks.tiers.mockResolvedValue({ ok: true, data: { changed: false, queued: 0 } });
    cleanup();
    render(<RuntimeControls data={data({ tiers: { tools: false, proposals: false } })} />);
    await press("Turn on: Change proposals", "Trying the proposals phase.", "Turn on");
    await waitFor(() => expect(mocks.tiers).toHaveBeenCalledWith({ orgId: ORG, proposals: true, reason: "Trying the proposals phase." }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("It was already that way, so nothing changed."));
  });
});
