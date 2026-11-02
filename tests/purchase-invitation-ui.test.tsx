// @vitest-environment jsdom
// The Super Admin's invitation screens, in a browser-like document with the server replaced by a recorder: the form emails the buyer by default and asks first; it never claims an email was
// delivered, and says plainly when none was sent (handing over the link to share); a double press or a retry is one request with one key; the new invitation is in the list at once; and
// "send again" and "make a new link" are one request per press, with the pause and the limits reported in words. The server rules behind them are in purchase-invitation-delivery.test.ts.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ create: vi.fn(), resend: vi.fn(), toggle: vi.fn(), checkEmail: vi.fn(), refresh: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: mocks.success, error: mocks.error, warning: mocks.warning, info: mocks.info }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }) }));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function Link({ href, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link };
});
vi.mock("@/app/actions/purchase-intents", () => ({
  createPurchaseIntentAction: mocks.create, resendPurchaseInvitationAction: mocks.resend, setPurchaseCheckoutEnabledAction: mocks.toggle, checkEmailSetupAction: mocks.checkEmail,
}));

import { CreatePurchaseIntentForm } from "@/components/purchase-intents/create-form";
import { PurchaseIntentsWorkspace } from "@/components/purchase-intents/workspace";
import { CheckoutSwitch } from "@/components/purchase-intents/checkout-switch";
import { DeliveryActions } from "@/components/purchase-intents/delivery-panel";
import { IDEMPOTENCY_KEY } from "@/lib/purchase-intents/delivery";
import { sampleDelivery, sampleHealth, sampleIntent, sampleSwitch } from "./support/payment-samples";

const READY = { ready: true, sender: "iAcquire <no-reply@iacquire.online>", problems: [], warnings: [] };
const NOT_READY = { ready: false, sender: "iAcquire <no-reply@iacquire.local>", problems: ["EMAIL_PROVIDER is \"capture\", so messages are stored and never sent. Set EMAIL_PROVIDER=resend.", "RESEND_API_KEY is not set."], warnings: [] };
const TOKEN_PATH = "/purchase/SAMPLEtokenSAMPLEtokenSAMPLEtokenSAMPLEtoken1";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});
afterEach(cleanup);

const created = (over: Record<string, unknown> = {}) => ({
  ok: true as const,
  data: { replayed: false, intent: sampleIntent({ delivery: sampleDelivery() }), path: TOKEN_PATH, delivery: sampleDelivery(), ...over },
});

function fill(over: Partial<Record<"Buyer name" | "Buyer email" | "Company", string>> = {}) {
  fireEvent.change(screen.getByLabelText("Buyer name"), { target: { value: over["Buyer name"] ?? "Bailey Buyer" } });
  fireEvent.change(screen.getByLabelText("Buyer email"), { target: { value: over["Buyer email"] ?? "bailey@harborview.example" } });
  fireEvent.change(screen.getByLabelText("Company"), { target: { value: over.Company ?? "Harborview Realty Group" } });
}
const submit = () => fireEvent.submit(screen.getByRole("form", { name: "Invite a buyer" }));
const emailBox = () => screen.getByRole("checkbox", { name: /Email the invitation to the buyer now/ }) as HTMLInputElement;

describe("the invitation form", () => {
  it("emails the buyer by default and says so in plain words, naming who it is sent from", () => {
    render(<CreatePurchaseIntentForm email={READY} timeZone="America/Chicago" />);
    expect(emailBox().checked).toBe(true);
    expect(screen.getByText(/Creating the invitation will send them a branded email with their secure purchase link/)).toBeTruthy();
    expect(screen.getByText(/Sent from iAcquire <no-reply@iacquire.online>/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create and email invitation/ })).toBeTruthy();
  });

  it("asks before it emails, sends once with a request key, and says handed to the email provider, never delivered", async () => {
    mocks.create.mockResolvedValue(created());
    const onCreated = vi.fn();
    render(<CreatePurchaseIntentForm email={READY} timeZone="America/Chicago" onCreated={onCreated} defaults={{ prospectId: "11111111-1111-4111-8111-111111111111" }} />);
    fill();
    submit();
    // Nothing is sent until the Super Admin confirms: the dialog names the recipient and the sender.
    expect(mocks.create).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Create the invitation and email the buyer\?/)).toBeTruthy();
    expect(dialog.textContent).toContain("bailey@harborview.example");
    expect(dialog.textContent).toContain("iAcquire <no-reply@iacquire.online>");
    const confirm = within(dialog).getByRole("button", { name: /Create and email/ });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    const sent = mocks.create.mock.calls[0][0];
    expect(sent).toMatchObject({ buyerName: "Bailey Buyer", buyerEmail: "bailey@harborview.example", company: "Harborview Realty Group", sendEmail: true, prospectId: "11111111-1111-4111-8111-111111111111" });
    expect(sent.idempotencyKey).toMatch(IDEMPOTENCY_KEY);
    await screen.findByText(/was created and emailed/);
    expect(screen.getAllByText("Sent to the email provider").length).toBeGreaterThan(0);
    expect(document.body.textContent).toMatch(/does not reach the inbox|not that it reached the inbox/i);
    expect(document.body.textContent).not.toMatch(/\bDelivered\b/);
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ reference: "PUR-SAMPLE2345" }));
    // The link is kept behind a button when the email went out.
    const reveal = screen.getByText(/Show the link/).closest("details") as HTMLDetailsElement;
    expect(reveal.open).toBe(false);
  });

  it("hands over the link to share, open, when the email did not go out, and says why", async () => {
    mocks.create.mockResolvedValue(created({ delivery: sampleDelivery({ status: "failed", reason: "provider_refused", error: "Provider responded 403: The iacquire.online domain is not verified." }) }));
    render(<CreatePurchaseIntentForm email={READY} timeZone="America/Chicago" />);
    fill();
    submit();
    fireEvent.click(await screen.findByRole("button", { name: "Create and email" }));
    await screen.findByText(/was created, but nothing was emailed/);
    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain("domain is not verified");
    const reveal = screen.getByText(/Share this link with the buyer yourself/).closest("details") as HTMLDetailsElement;
    expect(reveal.open).toBe(true);
    expect(reveal.textContent).toContain(TOKEN_PATH);
    expect(mocks.warning).toHaveBeenCalled();
  });

  it("does not ask, and says exactly what is missing, when email is not set up: the invitation is still made and the link is handed over", async () => {
    mocks.create.mockResolvedValue(created({ delivery: sampleDelivery({ status: "manual", reason: "email_off", provider: "capture" }) }));
    render(<CreatePurchaseIntentForm email={NOT_READY} timeZone="America/Chicago" />);
    expect(screen.getByText(/Email is not set up in this environment/)).toBeTruthy();
    expect(document.body.textContent).toContain("EMAIL_PROVIDER");
    expect(document.body.textContent).toContain("RESEND_API_KEY");
    expect(screen.getByRole("button", { name: /^Create invitation$/ })).toBeTruthy();
    fill();
    submit();
    expect(screen.queryByRole("dialog")).toBeNull();
    await screen.findByText(/was created, but nothing was emailed/);
    expect(screen.getAllByText("Manual sharing required").length).toBeGreaterThan(0);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("makes an invitation with no email when the Super Admin unticks the box, and never asks", async () => {
    mocks.create.mockResolvedValue(created({ delivery: sampleDelivery({ status: "manual", reason: "chosen", provider: "none" }) }));
    render(<CreatePurchaseIntentForm email={READY} timeZone="America/Chicago" />);
    fireEvent.click(emailBox());
    expect(screen.getByRole("button", { name: /^Create invitation$/ })).toBeTruthy();
    fill();
    submit();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0][0].sendEmail).toBe(false);
  });

  it("keeps one request key across a retry, and uses a new one for the next invitation", async () => {
    mocks.create.mockRejectedValueOnce(new Error("network")).mockResolvedValue(created());
    render(<CreatePurchaseIntentForm email={READY} timeZone="America/Chicago" />);
    fireEvent.click(emailBox());
    fill();
    submit();
    expect((await screen.findByRole("alert")).textContent).toMatch(/will not make a second invitation or send a second email/);
    submit();
    await screen.findByText(/was created/);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    const [first, second] = mocks.create.mock.calls.map((c) => c[0].idempotencyKey);
    expect(second).toBe(first);
    // The next invitation is a different request.
    fireEvent.click(screen.getByRole("button", { name: /Create another/ }));
    fireEvent.click(emailBox());
    fill({ "Buyer email": "next@harborview.example" });
    submit();
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(3));
    expect(mocks.create.mock.calls[2][0].idempotencyKey).not.toBe(first);
  });

  it("reports a refusal in words and keeps the form", async () => {
    mocks.create.mockResolvedValue({ ok: false, error: "That buyer already has an open purchase (PUR-ABC). Use its existing link or cancel it first.", code: "conflict" });
    render(<CreatePurchaseIntentForm email={NOT_READY} timeZone="America/Chicago" />);
    fill();
    submit();
    expect((await screen.findByRole("alert")).textContent).toMatch(/already has an open purchase/);
    expect(screen.getByLabelText("Buyer name")).toBeTruthy();
  });

  it("says an invitation made again with the same key is the same one, with no link to show twice", async () => {
    mocks.create.mockResolvedValue(created({ replayed: true, path: null }));
    render(<CreatePurchaseIntentForm email={READY} timeZone="America/Chicago" />);
    fireEvent.click(emailBox());
    fill();
    submit();
    await screen.findByText(/was already made/);
    expect(document.body.textContent).toMatch(/no second email was sent/);
    expect(screen.queryByText(/Share this link with the buyer yourself/)).toBeNull();
    expect(mocks.info).toHaveBeenCalled();
  });
});

describe("checking the email setup", () => {
  const found = (over: Record<string, unknown> = {}) => ({
    ok: true as const,
    data: {
      ok: false, checkedAt: "2026-11-02T12:00:00.000Z", sender: "iAcquire <no-reply@iacquire.online>",
      headline: "Email can be sent, but delivery notices are not confirmed (RESEND_WEBHOOK_SECRET isn't configured in this deployment). Invitations will stay at \"Sent to the email provider\" until they are.",
      checks: [
        { label: "Configuration", ok: true, detail: "EMAIL_PROVIDER, RESEND_API_KEY and EMAIL_FROM are set." },
        { label: "Sending", ok: true, detail: "iacquire.online is verified for sending in Resend." },
        { label: "Webhooks", ok: false, detail: "RESEND_WEBHOOK_SECRET isn't configured in this deployment, so Resend's delivery events and replies would be refused." },
      ],
      ...over,
    },
  });

  it("asks the server on one press, draws every finding as passed or not passed, and neither creates nor sends anything", async () => {
    mocks.checkEmail.mockResolvedValue(found());
    render(<CreatePurchaseIntentForm email={READY} timeZone="America/Chicago" />);
    fireEvent.click(screen.getByRole("button", { name: "Check email setup" }));
    await screen.findByText(/Email can be sent, but delivery notices are not confirmed/);
    expect(mocks.checkEmail).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    const items = screen.getAllByRole("listitem").filter((li) => /Configuration|Sending|Webhooks/.test(li.textContent ?? ""));
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain(": passed.");
    expect(items[2].textContent).toContain("Webhooks");
    expect(items[2].textContent).toContain(": not passed.");
    expect(items[2].textContent).toContain("RESEND_WEBHOOK_SECRET");
  });

  it("shows a refusal or a failure to run as a failure, never as a result", async () => {
    mocks.checkEmail.mockResolvedValueOnce({ ok: false as const, error: "The email setup was checked several times already. Try again in 40 minutes.", code: "rate_limited" });
    render(<CreatePurchaseIntentForm email={READY} timeZone="America/Chicago" />);
    fireEvent.click(screen.getByRole("button", { name: "Check email setup" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/checked several times already/);
    expect(screen.queryByText(/Email can be sent/)).toBeNull();
    mocks.checkEmail.mockRejectedValueOnce(new Error("network"));
    fireEvent.click(screen.getByRole("button", { name: "Check email setup" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/could not be run/));
  });

  it("is offered when email is not set up too (it then says what is missing), and states that nothing is sent", () => {
    render(<CreatePurchaseIntentForm email={NOT_READY} timeZone="America/Chicago" />);
    expect(screen.getByRole("button", { name: "Check email setup" })).toBeTruthy();
    expect(screen.getByText(/Nothing is sent\./)).toBeTruthy();
  });
});

describe("the list of invitations", () => {
  const existing = [sampleIntent({ id: "6f1f0d9e-0000-4000-8000-0000000000a2", reference: "PUR-OLDER0001", company: "Older Co", delivery: sampleDelivery({ status: "manual", reason: "chosen", provider: "none" }) })];

  it("shows a new invitation at the top the moment it is made, with the count, without reloading the page", async () => {
    mocks.create.mockResolvedValue(created());
    render(<PurchaseIntentsWorkspace intents={existing} email={READY} timeZone="America/Chicago" />);
    expect(screen.getByLabelText("1 invitation").textContent).toBe("1");
    fireEvent.click(emailBox());
    fill();
    submit();
    await screen.findByText(/was created/);
    expect(screen.getByLabelText("2 invitations").textContent).toBe("2");
    const list = screen.getByRole("region", { name: /Invitations/ });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Harborview Realty Group");
    expect(rows[0].textContent).toContain("Sent to the email provider");
    expect(rows[0].textContent).toContain("PUR-SAMPLE2345");
    expect(rows[1].textContent).toContain("Manual sharing required");
    expect(within(rows[0]).getByRole("link").getAttribute("href")).toBe("/admin/purchase-intents/6f1f0d9e-0000-4000-8000-0000000000a1");
  });

  it("prefers the server's copy once the page's own refresh brings it, and does not list an invitation twice", async () => {
    mocks.create.mockResolvedValue(created());
    const { rerender } = render(<PurchaseIntentsWorkspace intents={existing} email={READY} timeZone="America/Chicago" />);
    fireEvent.click(emailBox());
    fill();
    submit();
    await screen.findByText(/was created/);
    rerender(<PurchaseIntentsWorkspace intents={[sampleIntent({ company: "Harborview Realty Group (from the server)" }), ...existing]} email={READY} timeZone="America/Chicago" />);
    const rows = within(screen.getByRole("region", { name: /Invitations/ })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("from the server");
  });

  it("says plainly when there are none, and shows each invitation's expiry in the signed-in person's zone", () => {
    const { rerender } = render(<PurchaseIntentsWorkspace intents={[]} email={READY} timeZone="America/Chicago" />);
    expect(screen.getByText(/No invitations yet/)).toBeTruthy();
    rerender(<PurchaseIntentsWorkspace intents={[sampleIntent({ expiresAt: "2026-11-16T12:00:00.000Z" })]} email={READY} timeZone="Asia/Manila" />);
    expect(screen.getByRole("listitem").textContent).toContain("Nov 16, 2026, 8:00 PM");
  });
});

describe("sending again and making a new link", () => {
  it("sends one request per press with its own key, says what the new link replaced, and reports the pause in words", async () => {
    mocks.resend.mockResolvedValueOnce({ ok: false, error: "A link was made a moment ago. Wait 40 seconds before making another: each new link replaces the last one.", code: "rate_limited" });
    mocks.resend.mockResolvedValue({ ok: true, data: { replayed: false, intent: sampleIntent(), path: TOKEN_PATH, delivery: sampleDelivery({ kind: "resend" }) } });
    const onChanged = vi.fn();
    render(<DeliveryActions intent={sampleIntent()} emailReady onChanged={onChanged} />);
    const again = screen.getByRole("button", { name: /Send the invitation again/ });
    fireEvent.click(again);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Wait 40 seconds/);
    fireEvent.click(again);
    fireEvent.click(again);
    await waitFor(() => expect(mocks.resend).toHaveBeenCalledTimes(2));
    expect(mocks.resend.mock.calls[0][0]).toMatchObject({ id: sampleIntent().id, email: true });
    // The refused press and its retry are the same request; a double press is one.
    expect(mocks.resend.mock.calls[1][0].idempotencyKey).toBe(mocks.resend.mock.calls[0][0].idempotencyKey);
    await screen.findByText(/New link made/);
    expect(document.body.textContent).toMatch(/earlier link stops working at once/);
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ path: TOKEN_PATH }));
    // After a success, the next press is a new request.
    fireEvent.click(screen.getByRole("button", { name: /Send the invitation again/ }));
    await waitFor(() => expect(mocks.resend).toHaveBeenCalledTimes(3));
    expect(mocks.resend.mock.calls[2][0].idempotencyKey).not.toBe(mocks.resend.mock.calls[1][0].idempotencyKey);
  });

  it("makes a link for hand sharing without emailing, and says email is not set up when it is not", async () => {
    mocks.resend.mockResolvedValue({ ok: true, data: { replayed: false, intent: sampleIntent(), path: TOKEN_PATH, delivery: sampleDelivery({ kind: "rotation", status: "manual", reason: "chosen", provider: "none" }) } });
    render(<DeliveryActions intent={sampleIntent()} emailReady={false} />);
    expect(document.body.textContent).toMatch(/Email is not set up here, so sending again will only make the link for you to share/);
    fireEvent.click(screen.getByRole("button", { name: /Make a new link to share by hand/ }));
    await screen.findByText(/New link made/);
    expect(mocks.resend.mock.calls[0][0]).toMatchObject({ email: false });
    expect(screen.getByText(/Share this link with the buyer yourself/).closest("details")!.hasAttribute("open")).toBe(true);
  });

  it("offers nothing once the link can no longer be replaced (a paid or cancelled purchase)", () => {
    render(<DeliveryActions intent={sampleIntent({ can: { start: false, verify: false, provision: false, cancel: false, rotate: false, release: false } })} emailReady />);
    expect(screen.queryByRole("button", { name: /Send the invitation again/ })).toBeNull();
  });
});

describe("the online checkout switch", () => {
  it("says On, but blocked, over a checkout nobody can use, and will not be switched on until a provider is ready", () => {
    render(<CheckoutSwitch initial={sampleSwitch("blocked")} canManage />);
    expect(screen.getByText("On, but blocked")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("sample headline for blocked");
    expect(screen.getByRole("link", { name: /Set up and check the payment providers/ }).getAttribute("href")).toBe("/admin/billing?tab=providers");
    // The two providers show the same setup state the Billing screen shows.
    const list = screen.getByRole("list", { name: "Payment providers" });
    expect(within(list).getAllByText("Not connected")).toHaveLength(2);
    cleanup();
    render(<CheckoutSwitch initial={sampleSwitch("off", sampleHealth("none", "none", "off"))} canManage />);
    expect((screen.getByRole("switch", { name: "Allow buyers to pay online" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("allows switching on once a provider is ready, reports the mode, and calls the server once", async () => {
    mocks.toggle.mockResolvedValue({ ok: true, data: sampleSwitch("open_test") });
    render(<CheckoutSwitch initial={sampleSwitch("off", sampleHealth("verified", "none", "off"))} canManage />);
    const toggle = screen.getByRole("switch", { name: "Allow buyers to pay online" }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.toggle).toHaveBeenCalledWith(true));
    await screen.findByText("Open (test mode)");
    expect(screen.getAllByText("Test verified").length).toBeGreaterThan(0);
  });

  it("shows live as live, and reads the same for a person who may not change it", () => {
    render(<CheckoutSwitch initial={sampleSwitch("open_live")} canManage={false} />);
    expect(screen.getByText("Open (live)")).toBeTruthy();
    expect(screen.getAllByText("Ready for live payments").length).toBeGreaterThan(0);
    expect((screen.getByRole("switch", { name: "Allow buyers to pay online" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toMatch(/Only a Super Admin/);
  });
});

