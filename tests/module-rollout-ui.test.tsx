// @vitest-environment jsdom
// The module rollout page in a browser-like document: a switch asks for confirmation (naming the module and the workspace and what it still needs) before anything is sent, a
// refusal is shown and keeps the dialog open, and a module that works on another cannot be switched until the other is right. The server action is replaced; the service and
// the permissions are tested in module-rollout-admin.test.tsx.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), action: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/app/(admin)/admin/module-rollout/actions", () => ({ setModuleSwitchAction: mocks.action }));

import { ModuleRolloutAdmin } from "@/app/(admin)/admin/module-rollout/module-rollout-admin";
import { MODULES, MODULE_KEYS, type EnvSwitchState, type ModuleKey, type ModuleRolloutRow } from "@/lib/admin/module-rollout";

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  mocks.action.mockReset();
  mocks.refresh.mockReset();
  mocks.success.mockReset();
  mocks.error.mockReset();
});
afterEach(cleanup);

const row = (orgId: string, name: string, on: ModuleKey[] = [], status = "active"): ModuleRolloutRow => ({
  orgId, name, status,
  modules: Object.fromEntries(MODULE_KEYS.map((k) => [k, on.includes(k) ? { on: true, since: "2026-10-24T09:00:00.000Z", byName: "Sasha Super" } : { on: false, since: null, byName: null }])) as ModuleRolloutRow["modules"],
  connections: { signing: 0, payments: 1, reviews: 0 },
});
const env = Object.fromEntries(MODULE_KEYS.map((k) => [k, [{ name: "ESIGN_WRITES_ENABLED", on: false, wantOn: true, ok: false, meaning: "Without it nothing is written to a real signing service." }] satisfies EnvSwitchState[]])) as Record<ModuleKey, EnvSwitchState[]>;

const page = (rows: ModuleRolloutRow[], truncated = false) => render(<ModuleRolloutAdmin rows={rows} truncated={truncated} env={env} />);
const ORG_A = "6f1f0d9e-0000-4000-8000-00000000000a";
const ORG_B = "6f1f0d9e-0000-4000-8000-00000000000b";

describe("switching a module", () => {
  it("asks first, naming the module and the workspace and what it still needs, and sends nothing until confirmed", async () => {
    mocks.action.mockResolvedValue({ ok: true, data: { orgId: ORG_A, key: "invoices", enabled: true, changed: true } });
    page([row(ORG_A, "Harbor Home Services")]);
    fireEvent.click(screen.getByRole("switch", { name: "Customer invoices and payments for Harbor Home Services" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Switch Customer invoices and payments on for Harbor Home Services?")).toBeTruthy();
    expect(within(dialog).getByText(/It still needs/)).toBeTruthy();
    expect(within(dialog).getByText(/never holds the money/)).toBeTruthy();
    expect(within(dialog).getByText("ESIGN_WRITES_ENABLED")).toBeTruthy();
    expect(mocks.action).not.toHaveBeenCalled();
    // Cancelling changes nothing.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.action).not.toHaveBeenCalled();
    // Confirming sends the workspace, the module, the direction and the confirmation, then refreshes the page's data.
    fireEvent.click(screen.getByRole("switch", { name: "Customer invoices and payments for Harbor Home Services" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Switch on" }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith(ORG_A, "invoices", true, true));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.success).toHaveBeenCalledWith("Switched on.");
    expect(mocks.action).toHaveBeenCalledTimes(1);
  });

  it("switches a module off with its own wording, and does not list what it needs", async () => {
    mocks.action.mockResolvedValue({ ok: true, data: { orgId: ORG_A, key: "proposals", enabled: false, changed: true } });
    page([row(ORG_A, "Harbor Home Services", ["proposals"])]);
    const toggle = screen.getByRole("switch", { name: "Proposals for Harbor Home Services" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Switch Proposals off for Harbor Home Services?")).toBeTruthy();
    expect(within(dialog).queryByText(/It still needs/)).toBeNull();
    expect(within(dialog).getByText(/What they already made is kept/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Switch off" }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith(ORG_A, "proposals", false, true));
    expect(mocks.success).toHaveBeenCalledWith("Switched off.");
  });

  it.each(MODULES.map((m) => m.key))("switching %s off tells the person what that does to the customers and the work, in that module's own words", async (key) => {
    mocks.action.mockResolvedValue({ ok: true, data: { orgId: ORG_A, key, enabled: false, changed: true } });
    const info = MODULES.find((m) => m.key === key)!;
    // Signing can only be switched off while proposals are on, and proposals only after signing: give each the state in which its own switch is free.
    page([row(ORG_A, "Harbor Home Services", key === "esign" ? ["proposals", "esign"] : [key])]);
    fireEvent.click(screen.getByRole("switch", { name: `${info.label} for Harbor Home Services` }));
    const dialog = await screen.findByRole("dialog");
    expect(info.whenOff.length).toBeGreaterThan(40);
    expect(dialog.textContent).toContain(info.whenOff);
    expect(dialog.textContent).toContain("When it is off");
    expect(within(dialog).queryByText(/It still needs/)).toBeNull();
  });

  it("shows a refusal from the server and keeps the dialog open so nothing looks done", async () => {
    mocks.action.mockResolvedValue({ ok: false, error: "Only a Super Admin can switch modules on or off for a workspace.", code: "forbidden" });
    page([row(ORG_A, "Harbor Home Services")]);
    fireEvent.click(screen.getByRole("switch", { name: "Proposals for Harbor Home Services" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Switch on" }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("Only a Super Admin can switch modules on or off for a workspace."));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("cannot switch signing on before proposals, or proposals off under signing, and says why", () => {
    page([row(ORG_A, "Alone Co"), row(ORG_B, "Both Co", ["proposals", "esign"])]);
    const signing = screen.getByRole("switch", { name: "Electronic signing for Alone Co" }) as HTMLButtonElement;
    expect(signing.disabled).toBe(true);
    fireEvent.click(signing);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Switch on Proposals first: Electronic signing works on it.")).toBeTruthy();
    expect((screen.getByRole("switch", { name: "Proposals for Both Co" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Switch off Electronic signing first: it works on Proposals.")).toBeTruthy();
    expect((screen.getByRole("switch", { name: "Electronic signing for Both Co" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("finding a workspace", () => {
  it("filters by name and by whether anything is on, and says when nothing matches", () => {
    page([row(ORG_A, "Harbor Home Services", ["invoices"]), row(ORG_B, "Brightside Roofing")], true);
    const list = () => screen.getByRole("list", { name: "Client workspaces" });
    expect(within(list()).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Search workspaces"), { target: { value: "bright" } });
    expect(within(list()).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list()).getByText("Brightside Roofing")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search workspaces"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "any" } });
    expect(within(list()).getByText("Harbor Home Services")).toBeTruthy();
    expect(within(list()).queryByText("Brightside Roofing")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search workspaces"), { target: { value: "zzz" } });
    expect(within(list()).getByText("No workspace matches.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Only the first 2 client workspaces are listed");
  });

  it("marks a workspace that is not active", () => {
    page([row(ORG_A, "Paused Co", [], "suspended")]);
    expect(screen.getByText("suspended")).toBeTruthy();
  });
});
