// @vitest-environment jsdom
// The signing screens as a person meets them: the Signature tab of a proposal, the connection card in the settings, and the places the rest of the proposal screens mention signing.
// What is offered, what is said, what is sent to the server, in the components themselves with the server actions replaced by spies. The server's rules are in the other signing
// tests; the browser-only things (layout at 375 and 1280 pixels, focus rings, light and dark, the clipboard) are for the lead's check.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProposalActions } from "@/components/proposals/actions-panel";
import { DeliveryPanel } from "@/components/proposals/delivery-panel";
import { SignaturePanel } from "@/components/proposals/signature-panel";
import { SigningConnectionCard } from "@/components/proposals/signing-connection-card";
import { ProposalWorkspace } from "@/components/proposals/workspace";
import { parseWorkspaceTab, WORKSPACE_TABS } from "@/lib/proposals/list";
import { ESIGN_NOT_ENABLED_MESSAGE, PROVIDER_LABELS } from "@/lib/esign/state";
import type { CatalogChoice } from "@/lib/proposals/editor";
import { connection, detailFixture, FILE_CERT, FILE_SIGNED, PID, REQ, request, signature } from "./support/esign-screens";

const mocks = vi.hoisted(() => {
  const names = [
    "updateProposalAction", "submitForApprovalAction", "decideProposalAction", "sendProposalAction", "withdrawProposalAction", "reviseProposalAction", "duplicateProposalAction", "recordOfflineDecisionAction",
    "getShareUrlAction", "renewShareLinkAction", "createProposalAction", "draftWithAiAction", "searchDealsAction", "saveProposalSettingsAction", "createCatalogItemAction", "updateCatalogItemAction",
    "createTaxRateAction", "updateTaxRateAction", "createTemplateAction", "saveTemplateAction", "approveTemplateAction", "archiveTemplateAction", "connectPandaDocAction", "connectSimulatedSigningAction",
    "checkSigningConnectionAction", "getSigningWebhookUrlAction", "disconnectSigningAction", "requestSignatureAction", "voidSignatureRequestAction", "actAsSimulatedSignerAction",
    "previewDeliveryAction", "sendDeliveryAction",
  ] as const;
  const a = Object.fromEntries(names.map((n) => [n, vi.fn()])) as Record<(typeof names)[number], ReturnType<typeof vi.fn>>;
  return { push: vi.fn(), refresh: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn(), a };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/proposals",
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string; prefetch?: boolean }>(function Link({ href, prefetch: _p, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link, useLinkStatus: () => ({ pending: false }) };
});
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/app/actions/proposals", () => mocks.a);
vi.mock("@/app/actions/crm", () => ({ searchContactsAction: async () => ({ ok: true, data: [] }) }));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
beforeEach(() => {
  mocks.push.mockReset();
  mocks.refresh.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  for (const m of Object.values(mocks.a)) m.mockReset();
  // The Delivery tab reads the message when it opens; these tests are about signing, so it is left reading.
  mocks.a.previewDeliveryAction.mockImplementation(() => new Promise(() => {}));
});
afterEach(cleanup);

const BAD =/undefined|NaN|\[object Object\]/;
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const change = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const ok = <T,>(data: T) => ({ ok: true as const, data });
const panel = (over: Parameters<typeof detailFixture>[0] = {}, tz = "UTC") => render(<SignaturePanel detail={detailFixture(over)} tz={tz} />);

describe("the Signature tab: asking", () => {
  it("offers the form to someone who can send, with the customer already filled in, and says what asking does and does not do", () => {
    panel();
    expect((screen.getByLabelText("Who should sign") as HTMLInputElement).value).toBe("Maria Santos");
    expect((screen.getByLabelText("Their email address") as HTMLInputElement).value).toBe("maria@example.test");
    expect(screen.getByLabelText("Who should sign").className).toContain("text-[16px]");
    expect(screen.getByLabelText("Their email address").className).toContain("text-[16px]");
    expect(screen.getByText(/emails the signer a link to sign version 1 of the proposal. iAcquire does not send that email/)).toBeTruthy();
    expect(screen.getByText(/it is marked accepted only when the simulated signing service reports the signature/i)).toBeTruthy();
    expect(button("Ask for a signature").disabled).toBe(false);
    expect(document.body.textContent).not.toMatch(BAD);
  });

  it("sends exactly what was typed, tells the person it was asked, and does not promise the email has gone", async () => {
    mocks.a.requestSignatureAction.mockResolvedValue(ok({ requestId: REQ, created: true }));
    panel();
    change(screen.getByLabelText("Who should sign"), "Jose Reyes");
    change(screen.getByLabelText("Their email address"), "jose@example.test");
    fireEvent.click(button("Ask for a signature"));
    await waitFor(() => expect(mocks.a.requestSignatureAction).toHaveBeenCalledWith(PID, { signerName: "Jose Reyes", signerEmail: "jose@example.test" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Asked. It is sent to the signing service shortly."));
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("says when a request is already out instead of claiming a new one was made", async () => {
    mocks.a.requestSignatureAction.mockResolvedValue(ok({ requestId: REQ, created: false }));
    panel();
    fireEvent.click(button("Ask for a signature"));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("A signing request is already out for this version."));
  });

  it("shows the server's refusal as it is and keeps what was typed", async () => {
    mocks.a.requestSignatureAction.mockResolvedValue({ ok: false, error: "That address opted out or bounced, so a signing request can't be sent to it.", code: "conflict" });
    panel();
    change(screen.getByLabelText("Their email address"), "gone@example.test");
    fireEvent.click(button("Ask for a signature"));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("That address opted out or bounced, so a signing request can't be sent to it."));
    expect((screen.getByLabelText("Their email address") as HTMLInputElement).value).toBe("gone@example.test");
  });

  it("will not send without a name and an address", () => {
    panel();
    change(screen.getByLabelText("Who should sign"), "   ");
    expect(button("Ask for a signature").disabled).toBe(true);
    change(screen.getByLabelText("Who should sign"), "Jose");
    change(screen.getByLabelText("Their email address"), "");
    expect(button("Ask for a signature").disabled).toBe(true);
  });

  it("shows only the reason, no form, when a request cannot be made right now, whoever is looking", () => {
    panel({ signature: signature({ canRequest: false, blocked: "A signing request is already out for this version." }) });
    expect(screen.queryByLabelText("Who should sign")).toBeNull();
    expect(screen.getAllByRole("status").map((s) => s.textContent)).toContain("A signing request is already out for this version.");
    cleanup();
    panel({ signature: signature({ canRequest: false, blocked: null }) });
    expect(screen.getAllByRole("status").map((s) => s.textContent)).toContain("Only someone who can send proposals can ask for a signature.");
  });

  it("points out the other way to finish a signing when none can be asked for: record it, as the business's word", () => {
    panel({ signature: signature({ canRequest: false, blocked: "No signing service is connected. Connect one in the proposal settings.", connection: null }) });
    expect(screen.getByText(/the owner or a manager can record it as their own word under .Record the customer's answer. above. That is not verified by anyone/)).toBeTruthy();
  });

  it("does not pretend a proposal that asks for no signature can be signed", () => {
    panel({ requiresSignature: false });
    expect(screen.getByText(/This proposal doesn't ask for a signature/)).toBeTruthy();
    expect(screen.queryByLabelText("Who should sign")).toBeNull();
  });
});

describe("the Signature tab: the signing service", () => {
  it("says that signing is not switched on, in the server's words, and shows nothing else about a service", () => {
    panel({ signature: signature({ enabled: false, connection: null, blocked: ESIGN_NOT_ENABLED_MESSAGE, canRequest: false }) });
    expect(screen.getByText(ESIGN_NOT_ENABLED_MESSAGE)).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
    // Said once, and no form to ask with.
    expect(screen.queryByLabelText("Who should sign")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Ask the customer to sign" })).toBeNull();
  });

  it("names the connected service, its state and the notice that says what it is (a stand-in, a sandbox, or a real service whose sending is off here)", () => {
    const { rerender } = panel();
    expect(screen.getByText("the simulated signing service")).toBeTruthy();
    expect(screen.getAllByText("Simulated").length).toBeGreaterThan(0);
    expect(screen.getByText(/Simulated: no real document is sent and nothing here is legally binding/)).toBeTruthy();
    rerender(<SignaturePanel detail={detailFixture({ signature: signature({ connection: connection({ provider: "pandadoc", providerLabel: "PandaDoc", mode: "sandbox", label: "Acme", notice: "Sandbox: this is a test account at the signing service, not a live one." }), simulated: false }) })} tz="UTC" />);
    expect(screen.getByText("PandaDoc, Acme")).toBeTruthy();
    expect(screen.getByText("Sandbox", { selector: "span" })).toBeTruthy();
    expect(screen.getByText(/this is a test account at the signing service, not a live one/)).toBeTruthy();
    rerender(<SignaturePanel detail={detailFixture({ signature: signature({ connection: connection({ provider: "pandadoc", providerLabel: "PandaDoc", mode: "live", status: "needs_attention", statusDetail: "PandaDoc no longer accepts the saved key. Connect it again.", notice: null, usable: false }), simulated: false }) })} tz="UTC" />);
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("PandaDoc no longer accepts the saved key. Connect it again.")).toBeTruthy();
  });

  it("sends the owner to the settings to connect one, and tells everyone else who can", () => {
    panel({ signature: signature({ connection: null, canConnect: true, canRequest: false, blocked: "No signing service is connected. Connect one in the proposal settings." }) });
    expect(screen.getByRole("link", { name: "proposal settings" }).getAttribute("href")).toBe("/proposals/settings");
    cleanup();
    panel({ signature: signature({ connection: null, canConnect: false, canRequest: false, blocked: "No signing service is connected. Connect one in the proposal settings." }) });
    expect(screen.queryByRole("link", { name: "proposal settings" })).toBeNull();
    expect(screen.getByText(/The business owner or a manager can connect one in the proposal settings/)).toBeTruthy();
  });
});

describe("the Signature tab: what happened to each request", () => {
  it("says no request has been made when none has", () => {
    panel();
    expect(screen.getByText("No signing request has been made for this proposal.")).toBeTruthy();
  });

  it("describes a request that is out in the service's words, with the times in the workspace's zone, and never calls it signed", () => {
    panel({ signature: signature({ requests: [request()], canRequest: false, blocked: "A signing request is already out for this version." }) });
    const item = within(screen.getAllByRole("listitem").find((li) => li.textContent?.includes("Sent for signing")) as HTMLElement);
    expect(item.getByText("Sent for signing")).toBeTruthy();
    expect(item.getByText(/PandaDoc has been asked to send the document to Maria Santos. Nothing is signed yet./)).toBeTruthy();
    expect(item.getByText("Maria Santos, maria@example.test")).toBeTruthy();
    expect(item.getByText("Oct 23, 2026, 9:00 AM")).toBeTruthy();
    expect(item.getByText("Sent by PandaDoc")).toBeTruthy();
    expect(item.queryByText(/reports signed/)).toBeNull();
    expect(screen.queryByText(/The signature was applied/)).toBeNull();
  });

  it("shows an applied signature as applied, with the signed copy and its certificate to download, attributed to the service", () => {
    panel({ status: "accepted", signatureState: "completed", signature: signature({ canRequest: false, blocked: "Only a proposal that has been sent can be sent for signing.", requests: [request({
      status: "completed", statusLabel: "Signed", explain: "PandaDoc reports that Maria Santos signed. The signature itself is held by PandaDoc.", completedAt: "2026-10-23T11:00:00.000Z", applied: true,
      signedFileId: FILE_SIGNED, certificateFileId: FILE_CERT, canVoid: false,
    })] }) });
    expect(screen.getByText("PandaDoc reports signed")).toBeTruthy();
    expect(screen.getByText("The signature was applied: the proposal is accepted.")).toBeTruthy();
    const signed = screen.getByRole("link", { name: "Download the signed copy" });
    expect(signed.getAttribute("href")).toBe(`/api/files/${FILE_SIGNED}`);
    expect(screen.getByRole("link", { name: "Download the completion certificate" }).getAttribute("href")).toBe(`/api/files/${FILE_CERT}`);
    expect(screen.queryByRole("button", { name: "Withdraw this request" })).toBeNull();
  });

  it("shows a signature that was set aside with the reason, and does not say the proposal is accepted", () => {
    panel({ signature: signature({ requests: [request({
      status: "completed", statusLabel: "Signed", completedAt: "2026-10-23T11:00:00.000Z", applied: false, notAppliedReason: "superseded", current: false, proposalVersion: 1,
      notAppliedText: "The signer signed an older version. The proposal was revised after the request was sent, so this signature was not applied to the new version.", canVoid: false, copyPending: true,
    })] }) });
    expect(screen.getByText(/The signer signed an older version/)).toBeTruthy();
    expect(screen.getByText(/Version 1 \(an older version\)/)).toBeTruthy();
    expect(screen.queryByText(/The signature was applied/)).toBeNull();
    expect(screen.getByText(/The signed copy has not been fetched from PandaDoc yet; this is tried again automatically/)).toBeTruthy();
  });

  it("says when the signed copy could not be fetched, and where to get it", () => {
    panel({ signature: signature({ requests: [request({ status: "completed", statusLabel: "Signed", applied: true, completedAt: "2026-10-23T11:00:00.000Z", copyGaveUp: true, canVoid: false })] }) });
    expect(screen.getByText("The signature is recorded, but iAcquire could not fetch the signed copy. Download it from PandaDoc.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Download/ })).toBeNull();
  });

  it("shows why a request could not be sent, what was withdrawn, and what is left to do at the service", () => {
    panel({ signature: signature({ requests: [
      request({ id: "a1", status: "failed", statusLabel: "Could not be sent", explain: "PandaDoc did not accept the request, so nothing was sent to Maria Santos.", lastError: "PandaDoc refused this request (HTTP 400).", canVoid: false }),
      request({ id: "a2", status: "voided", statusLabel: "Withdrawn", voidReason: "Withdrawn by a person.", cancelNote: "iAcquire cannot withdraw it at PandaDoc. Withdraw the document there too; a signature that arrives for it is not applied to the proposal.", canVoid: false }),
    ] }) });
    expect(screen.getByText("PandaDoc refused this request (HTTP 400).")).toBeTruthy();
    expect(screen.getByText("Withdrawn by a person.")).toBeTruthy();
    expect(screen.getByText(/iAcquire cannot withdraw it at PandaDoc. Withdraw the document there too/)).toBeTruthy();
  });

  it("keeps the history behind a disclosure, with who said what in words and the time, and nothing printed raw", () => {
    panel({ signature: signature({ requests: [request({ events: [
      { id: 3, at: "2026-10-23T09:05:00.000Z", kind: "viewed", source: "provider_webhook", detail: { from: "sent" } },
      { id: 2, at: "2026-10-23T09:01:00.000Z", kind: "sent", source: "system", detail: {} },
      { id: 1, at: "2026-10-23T09:00:00.000Z", kind: "created", source: "user", detail: { by: "someone", signer: "m***@example.test" } },
      { id: 0, at: "2026-10-23T08:59:00.000Z", kind: "brand_new_kind", source: "system", detail: {} },
    ] })] }) });
    const details = document.querySelector("details") as HTMLElement;
    expect(within(details).getByText("History (4)")).toBeTruthy();
    expect(details.textContent).toContain("The signing service: The signing service reports that the signer opened the document.");
    expect(details.textContent).toContain("iAcquire: The signing service reports that the signer has been asked to sign.");
    expect(details.textContent).toContain("A person: Asked for a signature.");
    expect(details.textContent).toContain("brand new kind");
    expect(details.textContent).not.toMatch(BAD);
    expect(details.textContent).not.toContain("someone");
  });
});

describe("the Signature tab: withdrawing", () => {
  it("withdraws a request only after saying that a signature that still arrives is not applied, and that the proposal stays sent", async () => {
    mocks.a.voidSignatureRequestAction.mockResolvedValue(ok(true));
    panel({ signature: signature({ requests: [request()] }) });
    fireEvent.click(button("Withdraw this request"));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/a signature that still arrives for it is/)).toBeTruthy();
    expect(dialog.getByText(/The proposal stays sent, and you can ask again/)).toBeTruthy();
    expect(dialog.getByText(/iAcquire cannot withdraw the document at PandaDoc: withdraw it there too/)).toBeTruthy();
    expect(mocks.a.voidSignatureRequestAction).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(mocks.a.voidSignatureRequestAction).toHaveBeenCalledWith(REQ));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Withdrawn."));
  });

  it("does not offer it to someone who cannot send, or for a request that is over", () => {
    panel({ signature: signature({ requests: [request({ canVoid: false })] }) });
    expect(screen.queryByRole("button", { name: "Withdraw this request" })).toBeNull();
    cleanup();
    panel({ signature: signature({ requests: [request({ status: "declined", statusLabel: "Declined", canVoid: true })] }) });
    expect(screen.queryByRole("button", { name: "Withdraw this request" })).toBeNull();
  });
});

describe("the Signature tab: the stand-in service's own controls", () => {
  it("are offered only for a request made through the stand-in that is still out, labelled as testing, and send exactly the action chosen", async () => {
    mocks.a.actAsSimulatedSignerAction.mockResolvedValue(ok({ status: "viewed", note: "x" }));
    panel({ signature: signature({ simulated: true, requests: [request({ provider: "simulated", providerLabel: "the simulated signing service", mode: "simulated" })] }) });
    expect(screen.getByText("Simulated signing service (testing only)")).toBeTruthy();
    expect(screen.getByText(/Nothing real is sent/)).toBeTruthy();
    for (const [label, action] of [["Hand it over now", "send_now"], ["Signer opens it", "view"], ["Signer signs", "sign"], ["Signer declines", "decline"], ["Request runs out", "expire"]] as const) {
      mocks.a.actAsSimulatedSignerAction.mockClear();
      fireEvent.click(button(label));
      await waitFor(() => expect(mocks.a.actAsSimulatedSignerAction).toHaveBeenCalledWith(REQ, action));
    }
  });

  it("are not there for a real service, or for a request that is over", () => {
    panel({ signature: signature({ simulated: false, requests: [request()] }) });
    expect(screen.queryByText("Simulated signing service (testing only)")).toBeNull();
    cleanup();
    panel({ signature: signature({ simulated: true, requests: [request({ provider: "simulated", mode: "simulated", status: "completed", statusLabel: "Signed", canVoid: false })] }) });
    expect(screen.queryByText("Simulated signing service (testing only)")).toBeNull();
  });
});

describe("the connection card in the settings", () => {
  const card = (over: Partial<React.ComponentProps<typeof SigningConnectionCard>> = {}) =>
    render(<SigningConnectionCard enabled connection={null} canConnect simulatedAvailable={false} tz="UTC" {...over} />);

  it("says signing is not switched on, in the server's words, and offers nothing", () => {
    card({ enabled: false });
    expect(screen.getByText(ESIGN_NOT_ENABLED_MESSAGE)).toBeTruthy();
    expect(screen.queryByLabelText("PandaDoc API key")).toBeNull();
  });

  it("asks for the two keys as secrets, labelled, and says what connecting does and does not do", () => {
    card();
    const key = screen.getByLabelText("PandaDoc API key") as HTMLInputElement;
    const wh = screen.getByLabelText("Webhook shared key") as HTMLInputElement;
    for (const el of [key, wh]) {
      expect(el.type).toBe("password");
      expect(el.getAttribute("autocomplete")).toBe("off");
      expect(el.className).toContain("text-[16px]");
      expect(el.value).toBe("");
    }
    expect(screen.getByText(/any cost is on your PandaDoc plan/)).toBeTruthy();
    expect(screen.getByText(/saves it only if PandaDoc accepts it. Connecting sends nothing to anyone/)).toBeTruthy();
    expect(screen.getByLabelText("Is this a test key?")).toBeTruthy();
    expect(button("Connect PandaDoc").disabled).toBe(true);
    // The stand-in is not offered where it does not exist.
    expect(screen.queryByText("Connect the simulated service")).toBeNull();
  });

  it("sends the keys once, as typed, and empties the fields once they are saved so the page never holds them", async () => {
    mocks.a.connectPandaDocAction.mockResolvedValue(ok({ ...connection({ provider: "pandadoc", providerLabel: "PandaDoc", mode: "sandbox" }) }));
    card();
    change(screen.getByLabelText("PandaDoc API key"), "pd_sandbox_api_key_0123456789");
    change(screen.getByLabelText("Webhook shared key"), "wh_shared_key");
    change(screen.getByLabelText("Name for this connection"), "Acme");
    expect(button("Connect PandaDoc").disabled).toBe(false);
    fireEvent.click(button("Connect PandaDoc"));
    await waitFor(() => expect(mocks.a.connectPandaDocAction).toHaveBeenCalledWith({ apiKey: "pd_sandbox_api_key_0123456789", webhookKey: "wh_shared_key", mode: "sandbox", label: "Acme" }));
    await waitFor(() => expect((screen.getByLabelText("PandaDoc API key") as HTMLInputElement).value).toBe(""));
    expect((screen.getByLabelText("Webhook shared key") as HTMLInputElement).value).toBe("");
  });

  it("keeps what was typed when PandaDoc did not accept the key, and shows its reason", async () => {
    mocks.a.connectPandaDocAction.mockResolvedValue({ ok: false, error: "PandaDoc did not accept this key. PandaDoc no longer accepts the saved key. Connect it again.", code: "invalid_input" });
    card();
    change(screen.getByLabelText("PandaDoc API key"), "pd_sandbox_api_key_0123456789");
    change(screen.getByLabelText("Webhook shared key"), "wh_shared_key");
    fireEvent.click(button("Connect PandaDoc"));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(expect.stringMatching(/PandaDoc did not accept this key/)));
    expect((screen.getByLabelText("PandaDoc API key") as HTMLInputElement).value).toBe("pd_sandbox_api_key_0123456789");
  });

  it("offers the stand-in service only where it exists, labelled as testing", async () => {
    mocks.a.connectSimulatedSigningAction.mockResolvedValue(ok(connection()));
    card({ simulatedAvailable: true });
    expect(screen.getByText(/does not exist in production/)).toBeTruthy();
    fireEvent.click(button("Connect the simulated service"));
    await waitFor(() => expect(mocks.a.connectSimulatedSigningAction).toHaveBeenCalledTimes(1));
  });

  it("tells someone who cannot connect that the owner or a manager can, and shows them the state of a connection that is there", () => {
    card({ canConnect: false });
    expect(screen.getByText(/The business owner or a manager can connect one here/)).toBeTruthy();
    expect(screen.queryByLabelText("PandaDoc API key")).toBeNull();
    cleanup();
    card({ canConnect: false, connection: connection({ provider: "pandadoc", providerLabel: "PandaDoc", mode: "live", notice: null, accountLabel: "Acme Dental" }) });
    expect(screen.getByText("Account: Acme Dental")).toBeTruthy();
    expect(screen.getByText("Only the business owner or a manager can change or disconnect it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  it("shows a connection's state and notice, and checks the key on request", async () => {
    mocks.a.checkSigningConnectionAction.mockResolvedValue(ok(connection()));
    card({ connection: connection({ provider: "pandadoc", providerLabel: "PandaDoc", mode: "sandbox", notice: "Sending signing requests to a real signing service is switched off in this environment. Ask your iAcquire contact when it will be switched on.", status: "needs_attention", statusDetail: "PandaDoc no longer accepts the saved key. Connect it again." }) });
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("PandaDoc no longer accepts the saved key. Connect it again.");
    expect(screen.getByText(/switched off in this environment/)).toBeTruthy();
    expect(screen.getByText(/The saved keys cannot be shown again/)).toBeTruthy();
    fireEvent.click(button("Check the key now"));
    await waitFor(() => expect(mocks.a.checkSigningConnectionAction).toHaveBeenCalledTimes(1));
  });

  it("shows the notice address only on request, as a read-only field, with what it is for and that it is private", async () => {
    mocks.a.getSigningWebhookUrlAction.mockResolvedValue(ok({ url: "https://app.example.test/api/webhooks/esign/TOKEN-0123456789", provider: "pandadoc" }));
    card({ connection: connection({ provider: "pandadoc", providerLabel: "PandaDoc", mode: "sandbox" }) });
    expect(screen.queryByDisplayValue(/webhooks\/esign/)).toBeNull();
    fireEvent.click(button("Show the notice address"));
    const field = (await screen.findByLabelText("Notice address for PandaDoc")) as HTMLInputElement;
    expect(field.value).toBe("https://app.example.test/api/webhooks/esign/TOKEN-0123456789");
    expect(field.readOnly).toBe(true);
    expect(screen.getByText(/Keep it private. A notice is accepted only if it is signed with your shared key/)).toBeTruthy();
  });

  it("disconnects only after saying what that does: the keys are deleted, requests that are out end, and what is waiting at the service has to be withdrawn there", async () => {
    mocks.a.disconnectSigningAction.mockResolvedValue(ok({ ended: 0 }));
    card({ connection: connection() });
    fireEvent.click(button("Disconnect"));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/The saved keys are deleted. Signing requests that are out are ended/)).toBeTruthy();
    expect(dialog.getByText(/withdraw it there/)).toBeTruthy();
    expect(mocks.a.disconnectSigningAction).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(mocks.a.disconnectSigningAction).toHaveBeenCalledTimes(1));
  });
});

describe("where the rest of the proposal screens mention signing", () => {
  const delivery = (over: Parameters<typeof detailFixture>[0] = {}, onOpenTab?: (t: string) => void) => render(<DeliveryPanel detail={detailFixture(over)} canSend tz="UTC" onOpenTab={onOpenTab} />);

  it("tells the delivery tab's reader what stands in the way, or what follows, and links to the Signature tab", () => {
    const open = vi.fn();
    const { rerender } = delivery({}, open);
    // Connected and nothing asked yet.
    expect(screen.getByText(/The customer signs at your signing service, not on the proposal page: ask for it on the/)).toBeTruthy();
    fireEvent.click(button("Signature tab"));
    expect(open).toHaveBeenCalledWith("signature");
    rerender(<DeliveryPanel detail={detailFixture({ signatureState: "requested" })} canSend tz="UTC" onOpenTab={open} />);
    expect(screen.getByText(/A signing request is out. The customer signs at the signing service, not on their proposal page/)).toBeTruthy();
    rerender(<DeliveryPanel detail={detailFixture({ signatureState: "completed", status: "accepted" })} canSend tz="UTC" onOpenTab={open} />);
    expect(screen.getByText(/A signing service reported that the customer signed/)).toBeTruthy();
    rerender(<DeliveryPanel detail={detailFixture({ signatureState: "failed" })} canSend tz="UTC" onOpenTab={open} />);
    expect(screen.getByText(/The last signing request ended without a signature/)).toBeTruthy();
    rerender(<DeliveryPanel detail={detailFixture({ signatureState: "recorded_offline" })} canSend tz="UTC" onOpenTab={open} />);
    expect(screen.getByText("The signing was recorded as done offline by a person. It was not verified by a signing service.")).toBeTruthy();
  });

  it("says there is no way to sign online while no signing service is connected, and what to do instead", () => {
    delivery({ signature: signature({ connection: null, canRequest: false, blocked: "No signing service is connected. Connect one in the proposal settings." }) });
    expect(screen.getByText(/No signing service is connected, so the customer cannot sign online. Record the signing as done offline when it happens, or turn the requirement off and send a new version/)).toBeTruthy();
    cleanup();
    delivery({ signature: signature({ enabled: false, connection: null, canRequest: false, blocked: ESIGN_NOT_ENABLED_MESSAGE }) });
    expect(screen.getByText(/No signing service is connected, so the customer cannot sign online/)).toBeTruthy();
  });

  it("says nothing about signing for a proposal that does not ask for one", () => {
    delivery({ requiresSignature: false });
    expect(screen.queryByText(/signing service/i)).toBeNull();
  });

  it("labels an answer given by a signing service as exactly that on the delivery tab", () => {
    delivery({ status: "accepted", signatureState: "completed", decisions: [{
      id: "d1", version: 1, decision: "accepted", method: "provider_signature", decidedName: "Maria Santos", decidedEmail: "maria@example.test", note: null, acknowledgementVersion: null, contentHash: "a".repeat(64),
      recordedByName: null, decidedAt: "2026-10-23T11:00:00.000Z",
    }] });
    expect(screen.getByText("Signed through a signing service.")).toBeTruthy();
    expect(screen.queryByText(/not verified by the client/)).toBeNull();
  });

  it("points a sent proposal that needs a signature to the Signature tab, and says it is accepted only when the service reports it", () => {
    const onOpenTab = vi.fn();
    render(<ProposalActions detail={detailFixture()} can={{ create: true, approve: true, send: true, record: true }} twoPerson={false} dirty={false} tz="UTC" onOpenTab={onOpenTab} />);
    expect(screen.getByText(/which the customer gives at your signing service, not on their proposal page/)).toBeTruthy();
    expect(screen.getByText(/It is accepted only when the signing service reports the signature/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Signature tab" })[0]);
    expect(onOpenTab).toHaveBeenCalledWith("signature");
    cleanup();
    render(<ProposalActions detail={detailFixture({ requiresSignature: false })} can={{ create: true, approve: true, send: true, record: true }} twoPerson={false} dirty={false} tz="UTC" onOpenTab={onOpenTab} />);
    expect(screen.queryByText(/signing service/)).toBeNull();
  });

  it("warns, before a withdrawal or a revision, that a signing request which is out is ended too and a late signature is not applied", () => {
    const live = detailFixture({ signature: signature({ requests: [request()] }) });
    const props = { can: { create: true, approve: true, send: true, record: true }, twoPerson: false, dirty: false, tz: "UTC", onOpenTab: vi.fn() };
    render(<ProposalActions detail={live} {...props} />);
    fireEvent.click(button("Withdraw"));
    expect(within(screen.getByRole("dialog")).getByText(/A signing request that is out is withdrawn too, and a signature that still arrives for it is not applied/)).toBeTruthy();
    cleanup();
    render(<ProposalActions detail={live} {...props} />);
    fireEvent.click(button("Revise"));
    expect(within(screen.getByRole("dialog")).getByText(/a signature that still arrives for it is never applied to the new version/)).toBeTruthy();
    cleanup();
    render(<ProposalActions detail={detailFixture()} {...props} />);
    fireEvent.click(button("Withdraw"));
    expect(within(screen.getByRole("dialog")).queryByText(/signing request/)).toBeNull();
  });
});

describe("the proposal's tabs", () => {
  const catalog: CatalogChoice[] = [];
  const work = (over: Parameters<typeof detailFixture>[0] = {}, initialTab?: string) =>
    render(<ProposalWorkspace detail={detailFixture(over)} catalog={catalog} taxRates={[]} can={{ create: true, approve: true, send: true, record: true, discount: true }} twoPerson={false} tz="UTC" initialTab={initialTab} />);

  it("shows a Signature tab for a proposal that asks for a signature, and for one that has had a request, and no other", () => {
    work();
    expect(screen.getByRole("tab", { name: "Signature" })).toBeTruthy();
    cleanup();
    work({ requiresSignature: false });
    expect(screen.queryByRole("tab", { name: "Signature" })).toBeNull();
    cleanup();
    work({ requiresSignature: false, signature: signature({ requests: [request({ status: "voided", statusLabel: "Withdrawn", canVoid: false })] }) });
    expect(screen.getByRole("tab", { name: "Signature" })).toBeTruthy();
  });

  it("opens on the Signature tab from an address that names it (a notification links there), and falls back to the first tab when the tab is not there", () => {
    expect(parseWorkspaceTab("signature")).toBe("signature");
    expect(WORKSPACE_TABS).toContain("signature");
    work({}, "signature");
    expect(screen.getByRole("tab", { name: "Signature" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText("Who should sign")).toBeTruthy();
    cleanup();
    work({ requiresSignature: false }, "signature");
    expect(screen.getByRole("tab", { name: "Details" }).getAttribute("aria-selected")).toBe("true");
  });

  it("moves to the Signature tab from the delivery tab's link", () => {
    work();
    fireEvent.click(screen.getByRole("tab", { name: "Delivery" }));
    fireEvent.click(within(screen.getByRole("tabpanel", { name: "Delivery" })).getByRole("button", { name: "Signature tab" }));
    expect(screen.getByRole("tab", { name: "Signature" }).getAttribute("aria-selected")).toBe("true");
  });

  it("prints nothing odd anywhere on the tab", () => {
    work({ signature: signature({ requests: [request(), request({ id: "b", status: "completed", statusLabel: "Signed", applied: true, completedAt: "2026-10-23T11:00:00.000Z", signedFileId: FILE_SIGNED, canVoid: false })] }) }, "signature");
    expect(document.body.textContent).not.toMatch(BAD);
    expect(PROVIDER_LABELS.pandadoc).toBe("PandaDoc");
  });
});
