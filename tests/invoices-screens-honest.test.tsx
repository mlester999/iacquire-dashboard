// @vitest-environment jsdom
// Three owner screens that could say something false, or let one person's old screen overwrite another's work, and the controls of the payment account card on a phone.
//  * The draft editor: a teammate saves while you are typing. Your fields must stay yours, Save must refuse to put them over the newer text, and a refresh the page does by itself
//    (every deal search used to cause one) must never move the version your save is checked against.
//  * Invoice settings: a refresh brings the saved row, and the next number goes with a save only when the person changed it.
//  * "What the provider has sent": a failed load says it failed, it never says nothing arrived.
// No browser here: classes and markup are asserted, the layout itself is for the browser run. Server actions are replaced by recorders.
import * as fs from "node:fs";
import * as path from "node:path";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  const names = [
    "createInvoiceDraftAction", "updateInvoiceDraftAction", "discardInvoiceDraftAction", "searchInvoiceDealsAction", "submitInvoiceAction", "withdrawInvoiceAction", "requestInvoiceChangesAction",
    "issueInvoiceAction", "voidInvoiceAction", "writeOffInvoiceAction", "recordPaymentAction", "recordRefundAction", "recordDisputeOpenedAction", "recordDisputeResultAction", "getInvoiceLinkAction", "rotateInvoiceLinkAction", "saveInvoiceSettingsAction",
    "authorizeRemindersAction", "switchOffRemindersAction", "connectProviderAction", "saveWebhookSecretAction", "replaceKeysAction", "recheckConnectionAction", "confirmLiveAction",
    "pauseConnectionAction", "disconnectConnectionAction", "recentDeliveriesAction", "startTestPaymentAction",
  ] as const;
  return { actions: Object.fromEntries(names.map((n) => [n, vi.fn()])) as Record<(typeof names)[number], ReturnType<typeof vi.fn>>, refresh: vi.fn(), push: vi.fn() };
});
const page = vi.hoisted(() => ({
  settings: {
    legalName: "Harbor Home Services", addressLines: ["14 Quay Road"], taxLabel: "VAT", taxId: null, replyToEmail: null, numberPrefix: "INV-", nextNumber: 5, defaultCurrency: null, paymentTermsDays: 14,
    defaultPaymentInstructions: null, footerNote: null, approvalRequiredForCreators: true, remindersEnabled: false, reminderOffsetsDays: [-3, 0, 3, 10], reminderMax: 4, reminderChannels: ["email"],
    remindersAuthorizedAt: null, remindersAuthorizedBy: null, remindersBodyHash: null, closeRule: "none", countManualAsVerified: false, version: 7,
  },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh, back: vi.fn() }), usePathname: () => "/invoices" }));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function Link({ href, ...props }, ref) { return <a {...props} href={href} ref={ref} />; });
  return { default: Link };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/invoices", () => mocks.actions);
vi.mock("@/app/actions/crm", () => ({ searchContactsAction: vi.fn(async () => ({ ok: true, data: [] })) }));
vi.mock("motion/react", async () => {
  const React = await import("react");
  const Div = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown; transition?: unknown }>(function Div({ initial: _i, animate: _a, transition: _t, ...props }, ref) { return <div {...props} ref={ref} />; });
  return { motion: { div: Div } };
});
vi.mock("@/components/ui/overlays", async () => {
  const React = await import("react");
  function Dialog({ open, title, description, children, footer }: { open: boolean; title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode; footer?: React.ReactNode }) {
    if (!open) return null;
    return <section role="dialog" aria-label={typeof title === "string" ? title : undefined}><h2>{title}</h2>{description && <div>{description}</div>}{children}<footer>{footer}</footer></section>;
  }
  return { Dialog };
});
vi.mock("@/server/tenancy/context", () => ({ requireOrgContext: vi.fn(async () => ({ can: () => true, org: { timezone: "UTC" } })) }));
vi.mock("@/server/invoices/settings", () => ({ getInvoiceSettings: vi.fn(async () => page.settings) }));
vi.mock("@/server/invoices/reminders", () => ({ getReminderOverview: vi.fn(async () => ({})) }));

import { InvoiceForm } from "@/components/invoices/invoice-form";
import { InvoiceSettingsPanel, RemindersPanel } from "@/components/invoices/settings-panel";
import { ConnectionsPanel } from "@/components/invoices/connections-panel";
import { emptyFormState, type InvoiceFormState } from "@/lib/invoices/form-state";
import InvoiceSettingsPage from "@/app/(portal)/invoices/settings/page";
import type { ConnectionView, DeliveryView } from "@/server/customer-payments/connections";
import type { InvoiceSettings } from "@/server/invoices/settings";

const ok = (data: unknown = true) => ({ ok: true, data });
const update = mocks.actions.updateInvoiceDraftAction;
const saveSettings = mocks.actions.saveInvoiceSettingsAction;
const deliveries = mocks.actions.recentDeliveriesAction;

beforeEach(() => {
  for (const fn of Object.values(mocks.actions)) fn.mockReset();
  mocks.refresh.mockReset();
  mocks.push.mockReset();
});
afterEach(cleanup);

// ---------------------------------------------------------------------------------------------
// #23 The draft editor
// ---------------------------------------------------------------------------------------------

const ID = "11111111-1111-4111-8111-111111111111";
const stateOf = (description: string, over: Partial<InvoiceFormState> = {}) => emptyFormState({
  currency: "PHP", contact: { id: "c1", name: "Mara Villanueva" }, lines: [{ description, quantity: "1", unitPrice: "1500.00", discountPercent: "", discountAmount: "", taxPercent: "" }], ...over,
});
const editor = (version: number, initial: InvoiceFormState) => <InvoiceForm mode={{ kind: "edit", id: ID, version }} initial={initial} termsDays={14} />;
const description = () => screen.getByLabelText("Line 1 description") as HTMLInputElement;
const typeDescription = (value: string) => fireEvent.change(description(), { target: { value } });
const saveButton = () => screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;

describe("the draft editor when a teammate saves first", () => {
  it("keeps what you typed, says the invoice changed, and will not save it over the newer version until you load that one", async () => {
    update.mockResolvedValue(ok({ version: 5 }));
    const { rerender } = render(editor(3, stateOf("Boiler service")));
    typeDescription("Boiler service (my wording)");
    // The page comes back with the teammate's save: version 4, different text.
    rerender(editor(4, stateOf("Boiler service and flue check")));
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("Someone changed this invoice while you were editing it");
    expect(banner.textContent).toContain("version 3");
    expect(banner.textContent).toContain("version 4");
    expect(description().value).toBe("Boiler service (my wording)");
    expect(saveButton().disabled).toBe(true);
    fireEvent.submit(screen.getByRole("form", { name: "Edit invoice" }));
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load the latest version" }));
    expect(description().value).toBe("Boiler service and flue check");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    // Checked against the version the fields now come from.
    expect(update.mock.calls[0][0]).toBe(ID);
    expect(update.mock.calls[0][2]).toBe(4);
  });

  it("is still refused on the second click after a refused save and the page's own refresh, which used to put the old fields on the new version", async () => {
    update.mockResolvedValueOnce({ ok: false, error: "Someone changed this invoice. Reload to see their changes, then try again.", code: "conflict" });
    const { rerender } = render(editor(3, stateOf("Boiler service")));
    typeDescription("Boiler service (my wording)");
    fireEvent.click(saveButton());
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][2]).toBe(3);
    expect(mocks.refresh).toHaveBeenCalled();
    // router.refresh() brings the page back with the teammate's version; the fields in the browser are still the old ones.
    rerender(editor(4, stateOf("The teammate's wording")));
    expect(screen.getByRole("alert").textContent).toContain("Someone changed this invoice");
    expect(saveButton().disabled).toBe(true);
    fireEvent.submit(screen.getByRole("form", { name: "Edit invoice" }));
    expect(update).toHaveBeenCalledTimes(1);
    expect(description().value).toBe("Boiler service (my wording)");
  });

  it("needs no conflict to move the version: a re-render with a newer version while you have typed something is still caught", () => {
    const { rerender } = render(editor(3, stateOf("Boiler service")));
    typeDescription("Boiler service (my wording)");
    rerender(editor(4, stateOf("Boiler service", { notes: "Added by the teammate" })));
    expect(screen.getByRole("alert").textContent).toContain("Someone changed this invoice");
    expect(saveButton().disabled).toBe(true);
  });

  it("follows a newer version without a word when nothing was typed, and saves against it", async () => {
    update.mockResolvedValue(ok({ version: 5 }));
    const { rerender } = render(editor(3, stateOf("Boiler service")));
    rerender(editor(4, stateOf("The teammate's wording")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(description().value).toBe("The teammate's wording");
    fireEvent.click(saveButton());
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][2]).toBe(4);
  });

  it("does not call it a conflict when the newer version is your own text coming back", async () => {
    update.mockResolvedValue(ok({ version: 5 }));
    const { rerender } = render(editor(3, stateOf("Boiler service")));
    typeDescription("Boiler service (my wording)");
    rerender(editor(4, stateOf("Boiler service (my wording)")));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][2]).toBe(4);
  });

  it("shows no warning in the moment between your own successful save and the page leaving, even though the server tidied your text", async () => {
    update.mockResolvedValue(ok({ version: 4 }));
    const { rerender } = render(editor(3, stateOf("Boiler service")));
    typeDescription("  Boiler   service  ");
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(`/invoices/${ID}`));
    rerender(editor(4, stateOf("Boiler service")));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("has no version to reconcile on a new invoice", () => {
    const { rerender } = render(<InvoiceForm mode={{ kind: "new" }} initial={stateOf("Boiler service")} termsDays={14} />);
    typeDescription("Boiler service (my wording)");
    rerender(<InvoiceForm mode={{ kind: "new" }} initial={stateOf("Something else")} termsDays={14} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(description().value).toBe("Boiler service (my wording)");
  });
});

// ---------------------------------------------------------------------------------------------
// #40 Invoice settings
// ---------------------------------------------------------------------------------------------

const settings = (over: Partial<InvoiceSettings> = {}) => ({ ...page.settings, version: 4, ...over }) as unknown as InvoiceSettings;
const nextField = () => screen.getByLabelText("Next number") as HTMLInputElement;
const saveSettingsButton = () => screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement;
const typeIn = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("invoice settings", () => {
  it("is keyed to the saved version on its page, as the reminders below it are, so a refresh brings the saved row instead of stale fields under a new version", async () => {
    const tree = await InvoiceSettingsPage();
    const found: React.ReactElement[] = [];
    const walk = (node: React.ReactNode) => React.Children.forEach(node, (c) => {
      if (!React.isValidElement(c)) return;
      found.push(c);
      walk((c.props as { children?: React.ReactNode }).children);
    });
    walk(tree);
    const panel = found.find((e) => e.type === InvoiceSettingsPanel)!;
    const reminders = found.find((e) => e.type === RemindersPanel)!;
    // Each follows the saved version, and the two are different strings: siblings that share a key make React drop or duplicate one of them.
    expect(panel.key).toBe(`settings-${page.settings.version}`);
    expect(reminders.key).toBe(`reminders-${page.settings.version}`);
    expect(panel.key).not.toBe(reminders.key);
  });

  it("does not send the next number with a save unless the person changed it", async () => {
    saveSettings.mockResolvedValue(ok({ version: 5 }));
    render(<InvoiceSettingsPanel settings={settings()} canEdit />);
    typeIn(/Business name on invoices/, "Harbor Home");
    fireEvent.click(saveSettingsButton());
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    const [patch, version] = saveSettings.mock.calls[0];
    expect(version).toBe(4);
    expect(patch.legalName).toBe("Harbor Home");
    expect("nextNumber" in patch).toBe(false);
  });

  it("sends the next number when the person raised it", async () => {
    saveSettings.mockResolvedValue(ok({ version: 5 }));
    render(<InvoiceSettingsPanel settings={settings()} canEdit />);
    fireEvent.change(nextField(), { target: { value: "9" } });
    fireEvent.click(saveSettingsButton());
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    expect(saveSettings.mock.calls[0][0].nextNumber).toBe(9);
  });

  it("does not turn an unrelated save into a refusal when invoices were issued since the page opened", async () => {
    saveSettings.mockResolvedValue(ok({ version: 5 }));
    const { rerender } = render(<InvoiceSettingsPanel settings={settings({ nextNumber: 5 })} canEdit />);
    // Issuing an invoice raises the counter and does not touch the settings version.
    rerender(<InvoiceSettingsPanel settings={settings({ nextNumber: 8 })} canEdit />);
    // The field the person has not touched shows the counter as the page knows it, not the number it was opened with.
    expect(nextField().value).toBe("8");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveSettingsButton().disabled).toBe(false);
    typeIn(/Business name on invoices/, "Harbor Home");
    fireEvent.click(saveSettingsButton());
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    expect("nextNumber" in saveSettings.mock.calls[0][0]).toBe(false);
  });

  it("still refuses a number lower than the counter it knows, before anything is sent, and a number that is not a whole number", () => {
    render(<InvoiceSettingsPanel settings={settings({ nextNumber: 8 })} canEdit />);
    fireEvent.change(nextField(), { target: { value: "6" } });
    expect(screen.getByRole("alert").textContent).toContain("raised but not lowered (it is 8)");
    expect(saveSettingsButton().disabled).toBe(true);
    fireEvent.change(nextField(), { target: { value: "abc" } });
    expect(screen.getByRole("alert").textContent).toContain("whole number");
    expect(saveSettingsButton().disabled).toBe(true);
    fireEvent.change(nextField(), { target: { value: "8" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveSettingsButton().disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// #41 What the provider has sent
// ---------------------------------------------------------------------------------------------

const connectionView = (over: Partial<ConnectionView> = {}): ConnectionView => ({
  id: "c1", provider: "paymongo", providerLabel: "PayMongo", providerNote: "Built from PayMongo's documentation and tested against recorded fixtures. It has not run against a PayMongo account yet.", mode: "test", status: "connected",
  statusLabel: "Connected", statusExplain: "The key was accepted by the provider and the webhook signing secret is saved.", accountLabel: null, supportedCurrencies: ["PHP"],
  webhookUrl: "https://app.example/api/webhooks/customer-payments/paymongo/cpk_abcdefghij0123456789", environment: null, webhookSecretSaved: true, credentialsReadable: true, authorizedAt: "2026-10-20T01:00:00.000Z",
  authorizationVersion: "draft-2026-10-23", liveConfirmedAt: null, lastEventAt: null, lastCheckedAt: "2026-10-23T01:00:00.000Z", lastError: null, createdAt: "2026-10-20T01:00:00.000Z",
  hasConfirmedTestPayment: false, teamCheckoutBlock: null, customerCheckoutBlock: { code: "test_mode_public", message: "This account is in test mode, so customers are not sent to it." }, liveConfirmBlock: "This connection uses test keys. Replace them with your live keys first.", ...over,
});
const delivery = (over: Partial<DeliveryView> = {}): DeliveryView => ({ id: "d1", at: "2026-10-23T01:00:00.000Z", type: "checkout_session.payment.paid", outcome: "processed", note: null, attempts: 1, ...over });
const panel = (connections: ConnectionView[] = [connectionView()], providers: Array<"paymongo" | "paypal" | "simulated"> = []) => <ConnectionsPanel connections={connections} providers={providers} callsEnabled liveEnabled={false} tz="UTC" />;
// jsdom fires `toggle` itself, a moment after the `open` attribute changes, as a browser does: the test only changes `open` and lets that event run.
const setDeliveriesOpen = async (container: HTMLElement, open: boolean) => {
  container.querySelector("details")!.open = open;
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
};
const openDeliveries = (container: HTMLElement) => setDeliveriesOpen(container, true);
const NOTHING = /Nothing has arrived from this provider yet/;

describe("what the provider has sent", () => {
  it("says it could not load, with the reason and a way to try again, when the server refuses, and never says nothing has arrived", async () => {
    deliveries.mockResolvedValueOnce({ ok: false, error: "Your role doesn't allow this action. Ask a workspace owner for access.", code: "forbidden" });
    const { container } = render(panel());
    await openDeliveries(container);
    expect(deliveries).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Could not load what the provider has sent/)).toBeTruthy();
    expect(screen.getByText(/Your role doesn't allow this action/)).toBeTruthy();
    expect(screen.queryByText(NOTHING)).toBeNull();
    expect(screen.queryByText("Loading…")).toBeNull();
    // Trying again asks again and shows what the second answer says.
    deliveries.mockResolvedValueOnce(ok([]));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(NOTHING)).toBeTruthy();
    expect(deliveries).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Could not load what the provider has sent/)).toBeNull();
  });

  it("says so too when the call itself fails, instead of staying on Loading for ever", async () => {
    deliveries.mockRejectedValueOnce(new Error("offline"));
    const { container } = render(panel());
    await openDeliveries(container);
    expect(deliveries).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Could not load what the provider has sent/)).toBeTruthy();
    expect(screen.getByText(/Check your connection and try again/)).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.queryByText(NOTHING)).toBeNull();
    deliveries.mockResolvedValueOnce(ok([delivery({ id: "d9", type: "payment.refunded", outcome: "error", note: "No payment of ours matched this." })]));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("payment.refunded")).toBeTruthy();
    expect(screen.getByText("No payment of ours matched this.")).toBeTruthy();
  });

  it("asks again when the list is opened again after a failure, not only through the button, and not again once it has loaded", async () => {
    deliveries.mockResolvedValueOnce({ ok: false, error: "Server error", code: "internal" });
    const { container } = render(panel());
    await openDeliveries(container);
    expect(screen.getByText(/Could not load what the provider has sent/)).toBeTruthy();
    expect(deliveries).toHaveBeenCalledTimes(1);
    await setDeliveriesOpen(container, false);
    expect(deliveries).toHaveBeenCalledTimes(1);
    deliveries.mockResolvedValueOnce(ok([delivery()]));
    await openDeliveries(container);
    expect(screen.getByText("checkout_session.payment.paid")).toBeTruthy();
    expect(deliveries).toHaveBeenCalledTimes(2);
    // Loaded: closing and opening it again keeps what it has.
    await setDeliveriesOpen(container, false);
    await openDeliveries(container);
    expect(deliveries).toHaveBeenCalledTimes(2);
  });

  it("says nothing has arrived only when the server answered with an empty list", async () => {
    deliveries.mockResolvedValueOnce(ok([]));
    const { container } = render(panel());
    await openDeliveries(container);
    expect(screen.getByText(NOTHING)).toBeTruthy();
    expect(screen.queryByText(/Could not load/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(deliveries).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Q7 The payment account card's controls, and Q9 the checkboxes and radio buttons
// ---------------------------------------------------------------------------------------------

const tokens = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
const field = (el: Element) => el as HTMLInputElement;

function everyControlIsAPhoneControl(root: ParentNode) {
  const controls = [...root.querySelectorAll("button, input, select, textarea")];
  expect(controls.length).toBeGreaterThan(0);
  for (const el of controls) {
    const t = tokens(el);
    const who = `${el.tagName.toLowerCase()} ${field(el).type ?? ""} ${el.id || el.textContent || ""}`.trim();
    if (el.tagName === "BUTTON") {
      expect(t.includes("h-11") || t.includes("h-12") || t.includes("w-11"), `${who}: a 44 px button`).toBe(true);
      continue;
    }
    if (el.tagName === "INPUT" && (field(el).type === "checkbox" || field(el).type === "radio")) {
      // The whole row, through its label, is the 44 px target; the control itself must not be squeezed by a long label.
      expect(t, `${who}: cannot shrink`).toContain("shrink-0");
      expect(t, `${who}: 20 px`).toContain("size-5");
      expect(tokens(el.closest("label")!), `${who}: the row is the target`).toContain("min-h-11");
      continue;
    }
    expect(t, `${who}: 44 px tall`).toContain("h-11");
    expect(t.some((x) => x === "text-[16px]"), `${who}: 16 px text, so iOS does not zoom`).toBe(true);
    const labelled = (field(el).labels?.length ?? 0) > 0 || el.hasAttribute("aria-label");
    expect(labelled, `${who}: has a label`).toBe(true);
  }
}

describe("the payment account card on a phone", () => {
  it("is made of the design system's buttons, fields and selects: every control 44 px tall, 16 px text, labelled", () => {
    const paypal = connectionView({ id: "c2", provider: "paypal", providerLabel: "PayPal", environment: "sandbox", webhookSecretSaved: false });
    const { container } = render(panel([connectionView({ webhookSecretSaved: false }), paypal]));
    everyControlIsAPhoneControl(container);
    // The webhook secret and the webhook ID are fields with their own labels.
    expect(screen.getByLabelText("Webhook signing secret")).toBeTruthy();
    expect(screen.getByLabelText("Webhook ID")).toBeTruthy();
  });

  it("does the same in the form that connects an account, for each provider", () => {
    for (const provider of ["paymongo", "paypal", "simulated"] as const) {
      const { container, unmount } = render(panel([], [provider]));
      everyControlIsAPhoneControl(container);
      unmount();
    }
    const { container } = render(panel([], ["paypal", "paymongo"]));
    expect(screen.getByLabelText("Provider")).toBeTruthy();
    expect(screen.getByLabelText("PayPal app")).toBeTruthy();
    everyControlIsAPhoneControl(container);
  });

  it("does the same inside the replace-the-keys dialog", () => {
    const paypal = connectionView({ id: "c2", provider: "paypal", providerLabel: "PayPal", environment: "sandbox" });
    render(panel([paypal]));
    fireEvent.click(screen.getByRole("button", { name: "Replace the keys" }));
    const dialog = screen.getByRole("dialog", { name: "Replace the keys" });
    for (const label of ["PayPal app", "Client ID", "Client secret", /Webhook ID/]) expect(within(dialog).getByLabelText(label)).toBeTruthy();
    everyControlIsAPhoneControl(dialog);
  });

  it("stacks its actions as full-width buttons on a phone, side by side from the small breakpoint up", () => {
    render(panel());
    for (const name of ["Check the keys now", "Replace the keys", "Pause online payments", "Disconnect"]) {
      const t = tokens(screen.getByRole("button", { name }));
      expect(t, name).toContain("w-full");
      expect(t, name).toContain("sm:w-auto");
    }
  });

  it("makes the link to start a test invoice and the list of deliveries 44 px targets, not a line of text", () => {
    render(panel());
    expect(tokens(screen.getByRole("link", { name: "Start a test invoice" }))).toContain("min-h-11");
    expect(tokens(screen.getByText("What the provider has sent"))).toContain("min-h-11");
  });
});

describe("checkboxes and radio buttons in the invoice screens (Q9)", () => {
  it("are all written as 20 px controls that cannot shrink, in every component of the invoice screens, including the dialogs that only open on a click", () => {
    const root = path.resolve(__dirname, "../src/components/invoices");
    const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".tsx") ? [path.join(dir, e.name)] : []));
    let seen = 0;
    for (const file of files(root)) {
      const source = fs.readFileSync(file, "utf8");
      for (let at = source.indexOf("<input"); at !== -1; at = source.indexOf("<input", at + 1)) {
        const tag = source.slice(at, source.indexOf("/>", at));
        if (!/type="(checkbox|radio)"/.test(tag)) continue;
        seen += 1;
        const where = `${path.basename(file)}: ${tag.slice(0, 90)}`;
        expect(tag, where).toMatch(/className="[^"]*\bshrink-0\b/);
        expect(tag, where).toMatch(/className="[^"]*\bsize-5\b/);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(12);
  });

  it("cannot be squeezed to 13 px by a long label: the close-rule options, the reminder channels and the agreements", () => {
    const { container } = render(<InvoiceSettingsPanel settings={settings()} canEdit />);
    const boxes = [...container.querySelectorAll("input[type=radio], input[type=checkbox]")];
    expect(boxes.length).toBeGreaterThanOrEqual(5);
    for (const el of boxes) {
      expect(tokens(el), field(el).name || (el.parentElement?.textContent ?? "")).toContain("shrink-0");
      expect(tokens(el.closest("label")!)).toContain("min-h-11");
    }
  });
});
