// @vitest-environment jsdom
// The proposal screens as a person meets them: what is offered, what is said, what is sent to the server, in the components themselves with the server actions replaced by
// spies. The server's own rules are in the other proposals tests; this file is about what the screens do with them. The browser-only things (layout at 375 and 1280 pixels,
// focus rings, the sticky save bar, light and dark) are for the lead's check.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Sidebar } from "@/components/shell/sidebar";
import { ShellProvider } from "@/components/shell/shell-context";
import { TooltipProvider } from "@/components/ui/overlays";
import { ProposalActions, type ProposalActionsProps } from "@/components/proposals/actions-panel";
import { CatalogPanel } from "@/components/proposals/catalog-panel";
import { ProposalsPanel } from "@/components/proposals/crm-panel";
import { DeliveryPanel } from "@/components/proposals/delivery-panel";
import { ProposalEditor, type EditorProps } from "@/components/proposals/editor";
import { ActivityPanel, VersionsPanel } from "@/components/proposals/history-panels";
import { NewProposal, type NewProposalProps } from "@/components/proposals/new-proposal";
import { ProposalsClientOnly, ProposalsNotEnabled, PROPOSALS_NOT_ENABLED_TITLE } from "@/components/proposals/notices";
import { ProposalFilters, ProposalList } from "@/components/proposals/proposal-list";
import { ProposalSettingsPanel } from "@/components/proposals/settings-panel";
import { PanelTabs } from "@/components/proposals/tabs";
import { TemplateEditor } from "@/components/proposals/template-editor";
import { ProposalWorkspace, type WorkspaceProps } from "@/components/proposals/workspace";
import { ProposalsSubnav } from "@/components/proposals/subnav";
import { computeDocTotals } from "@/lib/proposals/money";
import type { ProposalDoc } from "@/lib/proposals/doc";
import type { CatalogChoice } from "@/lib/proposals/editor";
import { freeze } from "@/lib/proposals/snapshot";
import type { Permission } from "@/lib/permissions";
import type { ShellData } from "@/server/queries/shell";
import type { CatalogItemView, TaxRateView } from "@/server/proposals/catalog";
import type { ProposalSettings } from "@/server/proposals/settings";
import type { TemplateDetail } from "@/server/proposals/templates";
import type { ProposalDetail, ProposalSummary } from "@/server/proposals/view";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  pathname: undefined as string | undefined,
  a: {
    updateProposalAction: vi.fn(), submitForApprovalAction: vi.fn(), decideProposalAction: vi.fn(), sendProposalAction: vi.fn(), withdrawProposalAction: vi.fn(), reviseProposalAction: vi.fn(),
    duplicateProposalAction: vi.fn(), recordOfflineDecisionAction: vi.fn(), getShareUrlAction: vi.fn(), renewShareLinkAction: vi.fn(), createProposalAction: vi.fn(), draftWithAiAction: vi.fn(),
    searchDealsAction: vi.fn(), saveProposalSettingsAction: vi.fn(), createCatalogItemAction: vi.fn(), updateCatalogItemAction: vi.fn(), createTaxRateAction: vi.fn(), updateTaxRateAction: vi.fn(),
    createTemplateAction: vi.fn(), saveTemplateAction: vi.fn(), approveTemplateAction: vi.fn(), archiveTemplateAction: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => mocks.pathname ?? "/proposals",
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string | { pathname: string; query?: Record<string, string> }; prefetch?: boolean }>(function Link({ href, prefetch: _p, ...props }, ref) {
    const target = typeof href === "string" ? href : `${href.pathname}${href.query && Object.keys(href.query).length ? `?${new URLSearchParams(href.query).toString()}` : ""}`;
    return <a {...props} href={target} ref={ref} />;
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
});
afterEach(cleanup);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ME = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const ITEM2 = "33333333-3333-4333-8333-333333333333";
const TAX = "44444444-4444-4444-8444-444444444444";
const PID = "55555555-5555-4555-8555-555555555555";

const baseDoc = (): ProposalDoc => ({
  v: 1,
  sections: [{ id: "sec-intro01", heading: "Introduction", body: "Thank you for your time." }],
  lines: [{
    id: "line-book01", catalogItemId: ITEM, name: "Website build", description: "", unitLabel: "project", quantityMilli: 1000, unitPriceMinor: 150_000, catalogPriceMinor: 150_000, billing: "one_time",
    taxRateId: TAX, taxName: "Sales tax", taxBps: 1200, discount: null, note: "",
  }],
  terms: "Payment is due within 14 days.",
});

function detail(over: Partial<ProposalDetail> = {}): ProposalDetail {
  const doc = over.doc ?? baseDoc();
  return {
    id: PID, number: "P-0001", title: "Website proposal", status: "draft", origin: "human", clientName: "Maria Santos", clientCompany: "Santos Dental", currency: "USD",
    totals: { one_time: 168_000, monthly: 0, yearly: 0 }, validUntil: "2026-11-30", ownerId: ME, ownerName: "Alex Rivera", version: 1, requiresSignature: false, contactId: null, companyId: null,
    opportunityId: null, sentAt: null, closedAt: null, createdAt: "2026-10-20T10:00:00.000Z", updatedAt: "2026-10-21T10:00:00.000Z", doc, liveTotals: computeDocTotals(doc.lines).groups,
    clientEmail: "maria@example.test", internalNotes: null, templateId: null, templateVersion: null, approvedVersion: null, approvedByName: null, approvedAt: null, decisionNote: null,
    sentVersion: null, sentByName: null, signatureState: "none", problems: [], approval: { required: false, reasons: [] }, versions: [], decisions: [], events: [], share: null, preview: null,
    createdById: ME, viewer: { userId: ME, canEdit: true, isAuthor: true }, ai: null, ...over,
  };
}

const catalog = (): CatalogChoice[] => [
  { id: ITEM, name: "Website build", description: "Five pages", unitLabel: "project", unitPriceMinor: 150_000, currency: "USD", billing: "one_time", taxRateId: TAX, taxBps: 1200 },
  { id: ITEM2, name: "Logo design", description: "", unitLabel: "each", unitPriceMinor: 40_000, currency: "USD", billing: "one_time", taxRateId: null, taxBps: null },
  { id: "66666666-6666-4666-8666-666666666666", name: "Consultation", description: "", unitLabel: "hour", unitPriceMinor: 250_000, currency: "PHP", billing: "one_time", taxRateId: null, taxBps: null },
];
const taxRates = [{ id: TAX, name: "Sales tax", rateBps: 1200, archived: false }];

const allCan = { create: true, approve: true, send: true, record: true, discount: true };

function editor(over: Partial<EditorProps> = {}) {
  const props: EditorProps = { detail: detail(), catalog: catalog(), taxRates, canDiscount: true, editable: true, lockedReason: null, ...over };
  return render(<ProposalEditor {...props} />);
}
function actions(over: Partial<ProposalActionsProps> = {}) {
  const props: ProposalActionsProps = { detail: detail(), can: allCan, twoPerson: false, dirty: false, tz: "UTC", onOpenTab: vi.fn(), ...over };
  const view = render(<ProposalActions {...props} />);
  return { ...view, props };
}
const change = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

describe("the proposal editor", () => {
  it("shows what is saved in labelled fields, with the totals worked out", () => {
    editor();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Website proposal");
    expect((screen.getByLabelText("Customer's name") as HTMLInputElement).value).toBe("Maria Santos");
    expect((screen.getByLabelText("Valid until") as HTMLInputElement).value).toBe("2026-11-30");
    expect((screen.getByLabelText("Line 1 name") as HTMLInputElement).value).toBe("Website build");
    expect((screen.getByLabelText("Price per unit (USD)") as HTMLInputElement).value).toBe("1500.00");
    const totals = within(screen.getByText("Totals").closest("div") as HTMLElement);
    expect(totals.getByText("USD 1,500.00")).toBeTruthy();
    expect(totals.getByText("USD 180.00")).toBeTruthy();
    expect(totals.getByText("USD 1,680.00")).toBeTruthy();
    expect(button("Save changes").disabled).toBe(true);
    expect(screen.getByText("All changes saved.")).toBeTruthy();
  });

  it("works the totals out again as you type, with the same figures the server uses", () => {
    editor();
    change(screen.getByLabelText("Quantity"), "2");
    expect(screen.getByText("USD 3,360.00")).toBeTruthy();
    change(screen.getByLabelText("Quantity"), "abc");
    expect(screen.getByText(/A line is not complete yet, so it is left out of these totals/)).toBeTruthy();
    expect(screen.getByText("Nothing to add up yet.")).toBeTruthy();
  });

  it("saves exactly what was typed, against the version it started from, and then shows what the server stored", async () => {
    mocks.a.updateProposalAction.mockResolvedValue({ ok: true, data: detail({ title: "Renamed proposal", version: 2 }) });
    editor();
    change(screen.getByLabelText("Title"), "Renamed proposal");
    change(screen.getByLabelText("Customer's email"), "  Maria@Example.test ");
    expect(screen.getByText(/You have unsaved changes/)).toBeTruthy();
    fireEvent.click(button("Save changes"));
    await waitFor(() => expect(mocks.a.updateProposalAction).toHaveBeenCalledTimes(1));
    const [id, patch, version] = mocks.a.updateProposalAction.mock.calls[0];
    expect(id).toBe(PID);
    expect(version).toBe(1);
    expect(patch).toMatchObject({
      title: "Renamed proposal", clientEmail: "Maria@Example.test", currency: "USD", validUntil: "2026-11-30", requiresSignature: false, internalNotes: null,
      doc: { terms: "Payment is due within 14 days.", sections: [{ id: "sec-intro01", heading: "Introduction", body: "Thank you for your time." }], lines: [{ id: "line-book01", catalogItemId: ITEM, quantityMilli: 1000, unitPriceMinor: 150_000, discount: null, taxRateId: TAX }] },
    });
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Saved."));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Renamed proposal");
    expect(button("Save changes").disabled).toBe(true);
  });

  it("says what is wrong beside the field, and sends nothing, when a number does not make sense", async () => {
    editor();
    change(screen.getByLabelText("Price per unit (USD)"), "abc");
    change(screen.getByLabelText("Title"), "   ");
    expect(screen.getByText("Give the proposal a title.")).toBeTruthy();
    expect(screen.getByText(/Enter an amount such as 1500/)).toBeTruthy();
    expect(screen.getByText(/2 things need fixing before this can be saved/)).toBeTruthy();
    fireEvent.click(button("Save changes"));
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.a.updateProposalAction).not.toHaveBeenCalled();
  });

  it("leaves a catalog line's price to the price book unless the person may discount, and hides discounts from those who may not", () => {
    editor({ canDiscount: false });
    expect((screen.getByLabelText("Price per unit (USD)") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText("Set by the price book. The owner or a manager can change it.")).toBeTruthy();
    expect(screen.queryByLabelText("Discount")).toBeNull();
    cleanup();
    editor({ canDiscount: true });
    expect((screen.getByLabelText("Price per unit (USD)") as HTMLInputElement).readOnly).toBe(false);
    expect(screen.getByLabelText("Discount")).toBeTruthy();
  });

  it("shows a discount on a line that has one, read-only, to someone who cannot change it", () => {
    const doc = baseDoc();
    doc.lines[0].discount = { kind: "percent", bps: 1000 };
    editor({ detail: detail({ doc }), canDiscount: false });
    expect((screen.getByLabelText("Discount") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Percent off") as HTMLInputElement).value).toBe("10");
    expect(screen.getByText("Only the owner or a manager can change a discount.")).toBeTruthy();
    expect(screen.getAllByText("Discounted").length).toBeGreaterThan(0);
  });

  it("adds a line from the price book with its price, and one typed by hand without a price book link", async () => {
    mocks.a.updateProposalAction.mockResolvedValue({ ok: true, data: detail({ version: 2 }) });
    editor();
    const picker = screen.getByLabelText("Add an item from your price book");
    // Only items in the proposal's currency are offered.
    expect(within(picker).queryByText(/Consultation/)).toBeNull();
    change(picker, ITEM2);
    expect((screen.getByLabelText("Line 2 name") as HTMLInputElement).value).toBe("Logo design");
    fireEvent.click(button("Add a line by hand"));
    change(screen.getByLabelText("Line 3 name"), "Travel");
    change(screen.getAllByLabelText("Price per unit (USD)")[2], "75");
    fireEvent.click(button("Save changes"));
    await waitFor(() => expect(mocks.a.updateProposalAction).toHaveBeenCalled());
    const lines = mocks.a.updateProposalAction.mock.calls[0][1].doc.lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({ catalogItemId: ITEM2, name: "Logo design", unitPriceMinor: 40_000 });
    expect("id" in lines[1]).toBe(false);
    expect(lines[2]).toMatchObject({ catalogItemId: null, name: "Travel", unitPriceMinor: 7500, billing: "one_time" });
  });

  it("moves focus to what the person just added, and to the list when they remove something", () => {
    editor();
    change(screen.getByLabelText("Add an item from your price book"), ITEM2);
    expect(document.activeElement).toBe(screen.getByLabelText("Line 2 name"));
    fireEvent.click(button("Add a line by hand"));
    expect(document.activeElement).toBe(screen.getByLabelText("Line 3 name"));
    fireEvent.click(button("Add a section"));
    expect(document.activeElement).toBe(screen.getByLabelText("Section 2 heading"));
    fireEvent.click(button("Remove Logo design"));
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Priced lines" }));
    fireEvent.click(button("Remove Introduction"));
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Sections" }));
  });

  it("flags a price changed away from the price book", () => {
    editor();
    change(screen.getByLabelText("Price per unit (USD)"), "1400");
    expect(screen.getByText("Price differs from the price book")).toBeTruthy();
    expect(screen.getByText("Price book: USD 1,500.00")).toBeTruthy();
  });

  it("locks the currency once there are lines, and offers a placeholder list instead of free typing", () => {
    editor();
    expect((screen.getByLabelText("Currency") as HTMLSelectElement).disabled).toBe(true);
    const insert = screen.getByLabelText("Insert a placeholder into Introduction");
    change(insert, "client.name");
    expect((screen.getByLabelText("Wording") as HTMLTextAreaElement).value).toBe("Thank you for your time. {{client.name}}");
  });

  it("is read-only, says why, and offers no save when the proposal is out with the customer", () => {
    editor({ detail: detail({ status: "sent" }), editable: false, lockedReason: "This proposal has been sent, so its wording is fixed. Revise it to change it: that starts a new version and closes the old link." });
    expect(screen.getByText(/has been sent, so its wording is fixed/)).toBeTruthy();
    expect(screen.getByLabelText("Title").matches(":disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a section" })).toBeNull();
  });

  it("lists the problems of the last saved version, and says when they may be out of date", () => {
    editor({ detail: detail({ problems: [
      { level: "blocking", code: "no_lines", message: "Add at least one priced line.", stopsAt: "submit" },
      { level: "blocking", code: "signature_unavailable", message: "This proposal needs a signature but no signing service is connected.", stopsAt: "send" },
      { level: "warning", code: "valid_until_missing", message: "No valid-until date: the proposal never expires on its own.", stopsAt: "submit" },
    ] }) });
    const list = within(screen.getByRole("region", { name: "Checks for this proposal" }));
    expect(list.getByText(/Fix before approval:/)).toBeTruthy();
    expect(list.getByText(/Fix before sending:/)).toBeTruthy();
    expect(list.getByText(/Note:/)).toBeTruthy();
    expect(list.queryByText(/out of date/)).toBeNull();
    change(screen.getByLabelText("Title"), "Changed");
    expect(screen.getByText("These checks are for the last saved version. Save to check your changes.")).toBeTruthy();
  });

  it("warns that saving sends an approved or waiting proposal back to a draft", () => {
    editor({ detail: detail({ status: "pending_approval", approvedVersion: null }) });
    change(screen.getByLabelText("Title"), "Changed");
    expect(screen.getByText(/Saving sends this back to a draft, because the approval was of the earlier text/)).toBeTruthy();
  });

  it("keeps unsaved edits when a teammate saved a newer version, refuses to save over it, and loads theirs on request", () => {
    const view = editor();
    change(screen.getByLabelText("Title"), "My unsaved title");
    const newer = detail({ title: "Their title", version: 2 });
    view.rerender(<ProposalEditor detail={newer} catalog={catalog()} taxRates={taxRates} canDiscount editable lockedReason={null} />);
    expect(screen.getByRole("alert").textContent).toMatch(/Someone changed this proposal while you were editing it/);
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("My unsaved title");
    expect(button("Save changes").disabled).toBe(true);
    fireEvent.click(button("Load the latest version"));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Their title");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("follows a newer version silently when nothing was touched", () => {
    const view = editor();
    view.rerender(<ProposalEditor detail={detail({ title: "Their title", version: 2 })} catalog={catalog()} taxRates={taxRates} canDiscount editable lockedReason={null} />);
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Their title");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("tells its parent whether there are unsaved changes", () => {
    const seen: boolean[] = [];
    editor({ onDirtyChange: (d) => seen.push(d) });
    change(screen.getByLabelText("Title"), "Changed");
    change(screen.getByLabelText("Title"), "Website proposal");
    expect(seen).toEqual([false, true, false]);
  });
});

// ---------------------------------------------------------------------------
// What can be done with a proposal
// ---------------------------------------------------------------------------

describe("what is offered for a proposal right now", () => {
  it("lets a sender send a draft that needs no second look, after a confirmation that says nothing is emailed", async () => {
    mocks.a.sendProposalAction.mockResolvedValue({ ok: true, data: detail({ status: "sent" }) });
    const { props } = actions();
    expect(screen.getByText(/Nothing here needs a second look/)).toBeTruthy();
    fireEvent.click(button("Send to the customer"));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/iAcquire does not email it/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Mark as sent" }));
    await waitFor(() => expect(mocks.a.sendProposalAction).toHaveBeenCalledWith(PID, 1));
    await waitFor(() => expect(props.onOpenTab).toHaveBeenCalledWith("delivery"));
  });

  it("asks for approval, with the reasons in words, when a second look is needed", async () => {
    mocks.a.submitForApprovalAction.mockResolvedValue({ ok: true, data: detail({ status: "pending_approval" }) });
    actions({ detail: detail({ origin: "ai", approval: { required: true, reasons: ["ai_draft", "discount"] } }) });
    expect(screen.getByText("AI-written draft")).toBeTruthy();
    expect(screen.getByText("An AI draft always needs a person's approval.")).toBeTruthy();
    expect(screen.getByText("It gives a discount or sets a price below the price book.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send to the customer" })).toBeNull();
    fireEvent.click(button("Send for approval"));
    await waitFor(() => expect(mocks.a.submitForApprovalAction).toHaveBeenCalledWith(PID));
  });

  it("holds everything back while there are unsaved edits or a problem that would stop it, and says so", () => {
    const onOpenTab = vi.fn();
    actions({ dirty: true, onOpenTab });
    expect(button("Send to the customer").disabled).toBe(true);
    expect(button("Ask for approval first").disabled).toBe(true);
    expect(screen.getByText(/You have unsaved changes. Save them first/)).toBeTruthy();
    cleanup();
    actions({ detail: detail({ problems: [{ level: "blocking", code: "no_lines", message: "Add at least one priced line.", stopsAt: "submit" }] }), onOpenTab });
    expect(button("Send to the customer").disabled).toBe(true);
    expect(screen.getByText("Add at least one priced line.")).toBeTruthy();
    fireEvent.click(button("Open the editor"));
    expect(onOpenTab).toHaveBeenCalledWith("edit");
  });

  it("tells someone who can write but not send that another person has to approve", () => {
    actions({ can: { ...allCan, send: false } });
    expect(button("Send for approval")).toBeTruthy();
    expect(screen.getByText(/You can write proposals but not send them/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send to the customer" })).toBeNull();
  });

  it("says who may send it on when the viewer did not write it", () => {
    actions({ detail: detail({ viewer: { userId: ME, canEdit: false, isAuthor: false } }) });
    expect(screen.getByText("Only the person who wrote this proposal, or a manager, can send it on.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Send/ })).toBeNull();
  });

  it("gives a reviewer the decision, bound to the version, and requires a note to ask for changes", async () => {
    mocks.a.decideProposalAction.mockResolvedValue({ ok: true, data: detail({ status: "approved" }) });
    actions({ detail: detail({ status: "pending_approval", version: 3, viewer: { userId: "someone", canEdit: false, isAuthor: false } }) });
    expect(button("Request changes").disabled).toBe(true);
    fireEvent.click(button("Approve this version"));
    await waitFor(() => expect(mocks.a.decideProposalAction).toHaveBeenCalledWith(PID, { decision: "approve", version: 3, note: null }));
    mocks.a.decideProposalAction.mockClear();
    change(screen.getByLabelText(/Note to the writer/), "Please lower the setup fee.");
    fireEvent.click(button("Request changes"));
    await waitFor(() => expect(mocks.a.decideProposalAction).toHaveBeenCalledWith(PID, { decision: "request_changes", version: 3, note: "Please lower the setup fee." }));
    expect(screen.getByText(/Your approval is of version 3 exactly as it is in the Preview tab/)).toBeTruthy();
  });

  it("does not offer a writer the Approve button when the workspace asks for a second person, and keeps the other two", () => {
    actions({ detail: detail({ status: "pending_approval" }), twoPerson: true });
    expect(screen.queryByRole("button", { name: "Approve this version" })).toBeNull();
    expect(screen.getByText("Your workspace asks for a second person to approve each proposal. Ask another owner or manager.")).toBeTruthy();
    expect(button("Request changes")).toBeTruthy();
    expect(button("Reject")).toBeTruthy();
  });

  it("shows someone who cannot approve what is waiting and why they cannot decide", () => {
    actions({ detail: detail({ status: "pending_approval" }), can: { ...allCan, approve: false } });
    expect(screen.getByText("Only the business owner or a manager can approve proposals.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  });

  it("rejects only after a confirmation", async () => {
    mocks.a.decideProposalAction.mockResolvedValue({ ok: true, data: detail({ status: "rejected" }) });
    actions({ detail: detail({ status: "pending_approval", viewer: { userId: "x", canEdit: false, isAuthor: false } }) });
    fireEvent.click(button("Reject"));
    expect(mocks.a.decideProposalAction).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(mocks.a.decideProposalAction).toHaveBeenCalledWith(PID, { decision: "reject", version: 1, note: null }));
  });

  it("points a sent proposal at the Delivery tab for the link, and records an answer given outside the product as the person's word", async () => {
    mocks.a.recordOfflineDecisionAction.mockResolvedValue({ ok: true, data: detail({ status: "accepted" }) });
    const { props } = actions({ detail: detail({ status: "sent", sentVersion: 1 }) });
    expect(screen.getByText(/iAcquire has not sent it to anyone/)).toBeTruthy();
    fireEvent.click(button("Delivery tab"));
    expect(props.onOpenTab).toHaveBeenCalledWith("delivery");
    fireEvent.click(button("Record the customer's answer"));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/saved as your word and labelled that way everywhere/)).toBeTruthy();
    expect(dialog.getByText(/not an electronic signature/)).toBeTruthy();
    expect((dialog.getByRole("button", { name: "Record answer" }) as HTMLButtonElement).disabled).toBe(true);
    change(dialog.getByLabelText("What did the customer say?"), "accepted");
    change(dialog.getByLabelText("Note"), "Said yes on the phone.");
    fireEvent.click(dialog.getByRole("button", { name: "Record answer" }));
    await waitFor(() => expect(mocks.a.recordOfflineDecisionAction).toHaveBeenCalledWith(PID, { decision: "accepted", decidedName: "Maria Santos", decidedEmail: "maria@example.test", note: "Said yes on the phone.", version: 1 }));
  });

  it("does not offer to record an answer to someone who may not, and explains who can", () => {
    actions({ detail: detail({ status: "sent" }), can: { ...allCan, record: false } });
    expect(screen.queryByRole("button", { name: "Record the customer's answer" })).toBeNull();
    expect(screen.getByText(/the owner or a manager can record it/)).toBeTruthy();
  });

  it("offers a new version for a proposal that was declined, expired or withdrawn, and a copy for an accepted one", async () => {
    mocks.a.reviseProposalAction.mockResolvedValue({ ok: true, data: detail({ version: 2 }) });
    for (const status of ["declined", "expired", "withdrawn"] as const) {
      const { unmount, props } = actions({ detail: detail({ status }) });
      fireEvent.click(button("Revise"));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revise" }));
      await waitFor(() => expect(props.onOpenTab).toHaveBeenCalledWith("edit"));
      unmount();
    }
    expect(mocks.a.reviseProposalAction).toHaveBeenCalledTimes(3);
    actions({ detail: detail({ status: "accepted" }) });
    expect(screen.queryByRole("button", { name: "Revise" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Withdraw/ })).toBeNull();
    expect(screen.getByText(/An accepted proposal is final/)).toBeTruthy();
    mocks.a.duplicateProposalAction.mockResolvedValue({ ok: true, data: { id: "77777777-7777-4777-8777-777777777777" } });
    fireEvent.click(button("Duplicate"));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/proposals/77777777-7777-4777-8777-777777777777"));
  });

  it("withdraws a sent proposal only after saying the customer's link stops working", async () => {
    mocks.a.withdrawProposalAction.mockResolvedValue({ ok: true, data: detail({ status: "withdrawn" }) });
    actions({ detail: detail({ status: "sent" }) });
    fireEvent.click(button("Withdraw"));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/link stops working at once/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(mocks.a.withdrawProposalAction).toHaveBeenCalledWith(PID));
  });

  it("shows a reviewer's note to the writer, and the status in words", () => {
    actions({ detail: detail({ status: "changes_requested", decisionNote: "Lower the setup fee." }) });
    expect(screen.getByText("Changes requested")).toBeTruthy();
    expect(screen.getByText(/Reviewer's note:/).parentElement?.textContent).toContain("Lower the setup fee.");
  });
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

describe("the delivery tab", () => {
  const share = (over: Partial<NonNullable<ProposalDetail["share"]>> = {}): NonNullable<ProposalDetail["share"]> => ({
    id: "link-1", version: 1, recipientEmail: "maria@example.test", recipientName: "Maria Santos", createdAt: "2026-10-21T10:00:00.000Z", expiresAt: "2026-12-31T10:00:00.000Z", revokedAt: null, active: true,
    seen: "none", openCount: 0, firstOpenedAt: null, lastOpenedAt: null, viewedCount: 0, firstViewedAt: null, verifiedAt: null, downloadedAt: null, canCopy: true, ...over,
  });
  const sent = (s = share(), o: Partial<ProposalDetail> = {}) => detail({ status: "sent", sentVersion: 1, share: s, ...o });

  it("says nothing outside the team can open a proposal that has not been sent", () => {
    render(<DeliveryPanel detail={detail()} canSend tz="UTC" />);
    expect(screen.getByText(/made when the proposal is sent/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /link/i })).toBeNull();
    expect(screen.getByText("No answer has been recorded.")).toBeTruthy();
  });

  it("shows the three levels of 'seen' in their own words, and never calls a request 'read'", () => {
    const { rerender } = render(<DeliveryPanel detail={sent(share({ seen: "opened", openCount: 12, firstOpenedAt: "2026-10-22T09:00:00.000Z", lastOpenedAt: "2026-10-22T09:00:05.000Z" }))} canSend tz="UTC" />);
    expect(screen.getByText("Link opened")).toBeTruthy();
    expect(screen.getByText(/can be an email security scanner or a link preview rather than the customer, so it does not count as read/)).toBeTruthy();
    expect(screen.getByText(/12, first Oct 22, 2026/)).toBeTruthy();
    expect(screen.getAllByText("Not yet", { selector: "dd" }).length).toBeGreaterThan(0);
    rerender(<DeliveryPanel detail={sent(share({ seen: "verified", openCount: 3, viewedCount: 1, firstViewedAt: "2026-10-22T10:00:00.000Z", verifiedAt: "2026-10-22T10:05:00.000Z" }))} canSend tz="UTC" />);
    expect(screen.getByText("Opened by someone with the code")).toBeTruthy();
    expect(screen.getByText(/shows control of that mailbox, not who they are/)).toBeTruthy();
    expect(screen.queryByText(/\bread by\b|has read|signed/i)).toBeNull();
  });

  it("shows the link only on request, only to someone who can send, and never kept in the page's own text", async () => {
    mocks.a.getShareUrlAction.mockResolvedValue({ ok: true, data: { url: "https://app.example.test/proposal/TOKEN-0123456789", expiresAt: "2026-12-31T10:00:00.000Z" } });
    render(<DeliveryPanel detail={sent()} canSend tz="UTC" />);
    expect(screen.queryByDisplayValue(/proposal\/TOKEN/)).toBeNull();
    fireEvent.click(button("Show the customer's link"));
    expect(((await screen.findByLabelText("Link for the customer")) as HTMLInputElement).value).toBe("https://app.example.test/proposal/TOKEN-0123456789");
    expect(screen.getByText(/iAcquire has not sent it to anyone/)).toBeTruthy();
    cleanup();
    render(<DeliveryPanel detail={sent()} canSend={false} tz="UTC" />);
    expect(screen.queryByRole("button", { name: "Show the customer's link" })).toBeNull();
    expect(screen.getByText("Only someone who can send proposals can see the link.")).toBeTruthy();
  });

  it("makes a new link only after saying the old one stops", async () => {
    mocks.a.renewShareLinkAction.mockResolvedValue({ ok: true, data: { url: "https://app.example.test/proposal/NEW-0123456789", expiresAt: "2026-12-31T10:00:00.000Z" } });
    render(<DeliveryPanel detail={sent()} canSend tz="UTC" />);
    fireEvent.click(button("Make a new link"));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/The old link stops working at once/)).toBeTruthy();
    expect(mocks.a.renewShareLinkAction).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole("button", { name: "Make a new link" }));
    await waitFor(() => expect(mocks.a.renewShareLinkAction).toHaveBeenCalledWith(PID));
    expect(((await screen.findByLabelText("Link for the customer")) as HTMLInputElement).value).toContain("NEW-0123456789");
  });

  it("warns that a customer with no email address can't accept online, and offers no link for a closed one", () => {
    const { rerender } = render(<DeliveryPanel detail={sent(share({ recipientEmail: null }))} canSend tz="UTC" />);
    expect(screen.getByText(/cannot accept it online. Record their answer yourself/)).toBeTruthy();
    rerender(<DeliveryPanel detail={detail({ status: "withdrawn", share: share({ active: false, revokedAt: "2026-10-23T10:00:00.000Z" }) })} canSend tz="UTC" />);
    expect(screen.getByText("This link was closed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show the customer's link" })).toBeNull();
  });

  it("lists what the customer answered, labelled by how it was recorded, and is plain about a signature that was not verified", () => {
    const d = detail({
      status: "accepted", requiresSignature: true, signatureState: "recorded_offline",
      decisions: [
        { id: "d1", version: 1, decision: "accepted", method: "recorded_by_staff", decidedName: "Maria Santos", decidedEmail: null, note: "Said yes.", acknowledgementVersion: null, contentHash: "a".repeat(64), recordedByName: "Alex Rivera", decidedAt: "2026-10-23T10:00:00.000Z" },
        { id: "d2", version: 1, decision: "changes_requested", method: "verified_acknowledgement", decidedName: null, decidedEmail: "maria@example.test", note: "Can it be cheaper?", acknowledgementVersion: null, contentHash: "a".repeat(64), recordedByName: null, decidedAt: "2026-10-22T10:00:00.000Z" },
      ],
    });
    render(<DeliveryPanel detail={d} canSend tz="UTC" />);
    expect(screen.getByText("Recorded by Alex Rivera; not verified by the client.")).toBeTruthy();
    expect(screen.getByText(/Accepted online with a verified email address \(not an electronic signature\)/)).toBeTruthy();
    expect(screen.getByText(/signing was recorded as done offline by a person. It was not verified by a signing service/)).toBeTruthy();
    expect(screen.getByText("Asked for changes", { exact: false })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe("versions and activity", () => {
  it("lists saved versions with what each is, and says plainly when none exists yet", () => {
    const { rerender } = render(<VersionsPanel detail={detail()} tz="UTC" />);
    expect(screen.getByText(/No version has been saved yet/)).toBeTruthy();
    rerender(<VersionsPanel tz="UTC" detail={detail({
      version: 2, approvedVersion: 1, sentVersion: 1, status: "draft",
      versions: [
        { version: 2, contentHash: "b".repeat(64), createdAt: "2026-10-23T10:00:00.000Z", createdByName: "Alex Rivera", sentAt: null, supersededAt: null, hasPdf: false, pdfFileId: null, totals: { one_time: 100_000, monthly: 0, yearly: 0 } },
        { version: 1, contentHash: "a".repeat(64), createdAt: "2026-10-21T10:00:00.000Z", createdByName: "Alex Rivera", sentAt: "2026-10-21T11:00:00.000Z", supersededAt: "2026-10-23T10:00:00.000Z", hasPdf: true, pdfFileId: "99999999-9999-4999-8999-999999999999", totals: { one_time: 168_000, monthly: 9_900, yearly: 0 } },
      ],
    })} />);
    const v1 = within(screen.getByRole("heading", { name: "Version 1" }).closest("li") as HTMLElement);
    expect(v1.getByText("Approved")).toBeTruthy();
    expect(v1.getAllByText("Sent").length).toBeGreaterThan(0);
    expect(v1.getByText("Replaced by a newer version")).toBeTruthy();
    expect(v1.getByText("USD 1,680.00 once + USD 99.00 per month")).toBeTruthy();
    expect(v1.getByText("aaaa aaaa aaaa")).toBeTruthy();
    expect(v1.getByText("Stored", { exact: false })).toBeTruthy();
    const pdf = v1.getByRole("link", { name: /Download the PDF of version 1/ });
    expect(pdf.getAttribute("href")).toBe("/api/files/99999999-9999-4999-8999-999999999999");
    expect(pdf.textContent).toBe("Download the PDF of version 1");
    expect(within(screen.getByRole("heading", { name: "Version 2" }).closest("li") as HTMLElement).queryByRole("link")).toBeNull();
    expect(within(screen.getByRole("heading", { name: "Version 2" }).closest("li") as HTMLElement).getByText("Current")).toBeTruthy();
  });

  it("writes the history in sentences, newest first, with no raw codes", () => {
    render(<ActivityPanel tz="UTC" detail={detail({ events: [
      { id: 3, at: "2026-10-23T10:00:00.000Z", kind: "link_opened", version: 1, actorKind: "recipient", actorName: null, detail: {} },
      { id: 2, at: "2026-10-22T10:00:00.000Z", kind: "sent", version: 1, actorKind: "user", actorName: "Alex Rivera", detail: {} },
      { id: 1, at: "2026-10-21T10:00:00.000Z", kind: "ai_drafted", version: 1, actorKind: "ai", actorName: null, detail: {} },
    ] })} />);
    const items = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(items[0]).toMatch(/The link was requested. That can be an email scanner/);
    expect(items[1]).toMatch(/Alex Rivera marked \(version 1\) as sent/);
    expect(items[2]).toMatch(/a person has to read, edit and approve it/);
    expect(screen.getByText("Oct 23, 2026, 10:00 AM")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The workspace of one proposal
// ---------------------------------------------------------------------------

describe("one proposal's workspace", () => {
  const preview = () => {
    const d = detail();
    const frozen = freeze({
      number: "P-0001", title: d.title, currency: "USD", validUntil: d.validUntil, requiresSignature: false, client: { name: d.clientName, company: d.clientCompany, email: d.clientEmail },
      business: { name: "Harbor Home", website: null }, sender: { name: "Alex Rivera" }, dealName: null, doc: d.doc,
    });
    return { snapshot: frozen.snapshot, version: 1, frozen: false, contentHash: null };
  };
  const workspace = (over: Partial<WorkspaceProps> = {}) => {
    const props: WorkspaceProps = { detail: detail({ preview: preview() }), catalog: catalog(), taxRates, can: allCan, twoPerson: false, tz: "UTC", ...over };
    return render(<ProposalWorkspace {...props} />);
  };

  it("keeps what is typed in the editor when you look at another tab and come back", () => {
    workspace();
    change(screen.getByLabelText("Title"), "Half typed");
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getByRole("tabpanel", { name: "Preview" })).toBeTruthy();
    expect(screen.getByText(/This is how the customer will read your last saved changes/)).toBeTruthy();
    expect(screen.getByText(/You have unsaved changes that are not shown here/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Half typed");
  });

  it("shows the preview under the page's own heading, with the real totals", () => {
    workspace({ initialTab: "preview" });
    const panel = within(screen.getByRole("tabpanel", { name: "Preview" }));
    expect(panel.getByRole("heading", { level: 2, name: "Website proposal" })).toBeTruthy();
    expect(panel.queryByRole("heading", { level: 1 })).toBeNull();
    expect(panel.getAllByText("USD 1,680.00").length).toBeGreaterThan(0);
    expect(panel.getByText("Terms")).toBeTruthy();
  });

  it("says a saved version is shown exactly as it was frozen, and that there is no preview when the figures can't be worked out", () => {
    const p = preview();
    const { rerender } = workspace({ detail: detail({ status: "sent", preview: { ...p, frozen: true, contentHash: "c".repeat(64) } }), initialTab: "preview" });
    expect(screen.getByText(/exactly as it was saved \(fingerprint cccc cccc cccc\)/)).toBeTruthy();
    rerender(<ProposalWorkspace detail={detail({ preview: null })} catalog={catalog()} taxRates={taxRates} can={allCan} twoPerson={false} tz="UTC" initialTab="preview" />);
    expect(screen.getByText(/no preview. Check the prices, quantities and discounts/)).toBeTruthy();
  });

  it("calls the first tab 'Details' when nothing can be edited, and counts the saved versions", () => {
    workspace({ detail: detail({ status: "accepted", versions: [{ version: 1, contentHash: "a".repeat(64), createdAt: "2026-10-21T10:00:00.000Z", createdByName: null, sentAt: null, supersededAt: null, hasPdf: false, pdfFileId: null, totals: { one_time: 1, monthly: 0, yearly: 0 } }] }) });
    expect(screen.getByRole("tab", { name: "Details" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Versions/ }).textContent).toContain("1");
  });

  it("says an AI draft is a draft, what was left out and why, and that no price was set by the AI", () => {
    workspace({ detail: detail({ origin: "ai", ai: { droppedCount: 2, rejectedItems: 1, dropped: [
      { field: "scope", reason: "number", text: "The build costs $49.", detail: "49" },
      { field: "intro", reason: "claim", text: "Our award-winning team is ready.", detail: "award-winning" },
    ] } }) });
    const notice = within(screen.getByRole("region", { name: "About this AI draft" }));
    expect(notice.getByText(/The AI wrote this first draft/)).toBeTruthy();
    expect(notice.getByText(/It did not set any price: every price comes from your price book/)).toBeTruthy();
    expect(notice.getByText(/It always needs a person's approval/)).toBeTruthy();
    expect(notice.getByText(/2 sentences were left out, and 1 item it chose was not used/)).toBeTruthy();
    expect(notice.getByText("The build costs $49.")).toBeTruthy();
    expect(notice.getByText(/It stated a number that is not in your price book or approved pricing\. \(49\)/)).toBeTruthy();
    expect(notice.getByText(/makes a claim your approved business knowledge does not back|made a claim/i)).toBeTruthy();
  });

  it("shows no AI notice for a proposal a person started", () => {
    workspace();
    expect(screen.queryByRole("region", { name: "About this AI draft" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tabs, navigation, notices and lists
// ---------------------------------------------------------------------------

describe("tabs", () => {
  it("move with the arrow keys, Home and End, and expose which panel they control", () => {
    const onChange = vi.fn();
    render(<PanelTabs label="Sections" items={[{ id: "a", label: "A" }, { id: "b", label: "B", count: 2 }, { id: "c", label: "C" }]} value="a" onChange={onChange} panels={{ a: <p>One</p>, b: <p>Two</p>, c: <p>Three</p> }} idPrefix="t" />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].getAttribute("aria-controls")).toBe("t-a-panel");
    expect(tabs[1].getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("b");
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("c");
    fireEvent.keyDown(tabs[0], { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("c");
    fireEvent.keyDown(tabs[2], { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("a");
    expect(screen.getByText("Two").closest("[role=tabpanel]")?.hasAttribute("hidden")).toBe(true);
    expect(screen.getByText("One").closest("[role=tabpanel]")?.hasAttribute("hidden")).toBe(false);
    expect(tabs[1].textContent).toContain("2");
  });
});

describe("the Proposals menu entry", () => {
  const shell = (over: { kind?: string; permissions?: Permission[]; features?: string[] } = {}): ShellData => ({
    user: { id: "u1", name: "Bailey Owner", email: "owner@example.test", platformRole: "none" },
    org: { id: "o1", name: "Brightside Roofing", isDemo: false, kind: over.kind ?? "client", onboardingComplete: true, timezone: "UTC", role: "owner" },
    memberships: [], permissions: over.permissions ?? ["proposals.view"], agents: [], unreadNotifications: 0, pendingApprovals: 0, setup: { visible: false, percent: null, needsAttention: 0 },
    projectsAttention: 0, requestsAttention: 0, inboxAttention: 0, crmMode: "native", features: over.features,
  });
  const renderSidebar = (data: ShellData) => render(<ShellProvider value={data}><TooltipProvider><Sidebar /></TooltipProvider></ShellProvider>);

  it("is offered only where the module is switched on, the person may see it and the workspace is a client's", () => {
    renderSidebar(shell({ features: ["proposals"] }));
    expect(screen.getByRole("link", { name: /Proposals/ }).getAttribute("href")).toBe("/proposals");
    cleanup();
    renderSidebar(shell({ features: [] }));
    expect(screen.queryByRole("link", { name: /Proposals/ })).toBeNull();
    cleanup();
    renderSidebar(shell());
    expect(screen.queryByRole("link", { name: /Proposals/ })).toBeNull();
    cleanup();
    renderSidebar(shell({ features: ["esign", "invoices"] }));
    expect(screen.queryByRole("link", { name: /Proposals/ })).toBeNull();
    cleanup();
    renderSidebar(shell({ features: ["proposals"], permissions: [] }));
    expect(screen.queryByRole("link", { name: /Proposals/ })).toBeNull();
    cleanup();
    renderSidebar(shell({ features: ["proposals"], kind: "agency" }));
    expect(screen.queryByRole("link", { name: /Proposals/ })).toBeNull();
  });
});

describe("the sections bar", () => {
  it("marks the current section and counts what is waiting in words", () => {
    mocks.pathname = "/proposals/approvals";
    render(<ProposalsSubnav waiting={3} />);
    expect(screen.getByRole("link", { name: /Approvals/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Proposals" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByText(", 3 waiting")).toBeTruthy();
    cleanup();
    mocks.pathname = "/proposals/55555555-5555-4555-8555-555555555555";
    render(<ProposalsSubnav waiting={0} />);
    expect(screen.getByRole("link", { name: "Proposals" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByText(/waiting/)).toBeNull();
    mocks.pathname = undefined;
  });
});

describe("notices", () => {
  it("says the module is not switched on, and who to ask, without offering anything to change", () => {
    render(<ProposalsNotEnabled isOwner={false} />);
    expect(screen.getByRole("heading", { name: PROPOSALS_NOT_ENABLED_TITLE })).toBeTruthy();
    expect(screen.getByText(/Ask your workspace owner to ask iAcquire/)).toBeTruthy();
    cleanup();
    render(<ProposalsNotEnabled isOwner />);
    expect(screen.getByText(/Ask your iAcquire contact to switch it on/)).toBeTruthy();
  });

  it("says where proposals live for an agency workspace, and offers the clients list only to agency staff", () => {
    render(<ProposalsClientOnly canOpenClients />);
    expect(screen.getByRole("heading", { name: /managed inside each client's workspace/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to clients" }).getAttribute("href")).toBe("/admin/clients");
    cleanup();
    render(<ProposalsClientOnly canOpenClients={false} />);
    expect(screen.queryByRole("link", { name: "Go to clients" })).toBeNull();
  });
});

describe("the list", () => {
  const row = (over: Partial<ProposalSummary> = {}): ProposalSummary => ({
    id: PID, number: "P-0001", title: "Website proposal", status: "pending_approval", origin: "ai", clientName: "Maria Santos", clientCompany: "Santos Dental", currency: "USD",
    totals: { one_time: 168_000, monthly: 9_900, yearly: 0 }, validUntil: "2026-10-25", ownerId: ME, ownerName: "Alex Rivera", version: 2, requiresSignature: true, contactId: null, companyId: null,
    opportunityId: null, sentAt: null, closedAt: null, createdAt: "2026-10-20T10:00:00.000Z", updatedAt: "2026-10-22T10:00:00.000Z", ...over,
  });
  const empty = { title: "No open proposals", description: "Start one." };

  it("shows each proposal as a link with its status, totals in words, what is left of its validity and the next step for this person", () => {
    render(<ProposalList rows={[row()]} today="2026-10-23" tz="UTC" can={{ approve: true, send: true, create: true }} empty={empty} />);
    const link = screen.getByRole("link", { name: /Website proposal/ });
    expect(link.getAttribute("href")).toBe(`/proposals/${PID}`);
    for (const t of ["P-0001", "Waiting for approval", "AI-written draft", "Needs a signature", "Maria Santos, Santos Dental", "USD 1,680.00 once + USD 99.00 per month", "(2 days left)", "Version 2", "Review and decide"]) {
      expect(link.textContent, t).toContain(t);
    }
    cleanup();
    render(<ProposalList rows={[row()]} today="2026-10-23" tz="UTC" can={{ approve: false, send: false, create: false }} empty={empty} />);
    expect(screen.getByRole("link", { name: /Website proposal/ }).textContent).not.toContain("Review and decide");
  });

  it("does not show validity for a proposal that is over, and says when no customer is chosen", () => {
    render(<ProposalList rows={[row({ status: "accepted", validUntil: "2026-10-01", clientName: "", clientCompany: "" })]} today="2026-10-23" tz="UTC" can={{ approve: true, send: true, create: true }} empty={empty} />);
    const text = screen.getByRole("link").textContent ?? "";
    expect(text).not.toContain("Valid until");
    expect(text).toContain("No customer chosen yet");
  });

  it("says what an empty list means", () => {
    render(<ProposalList rows={[]} today="2026-10-23" tz="UTC" can={{ approve: true, send: true, create: true }} empty={empty} />);
    expect(screen.getByText("No open proposals")).toBeTruthy();
  });

  it("filters by links that keep the search, and the search box is labelled", () => {
    render(<ProposalFilters active="waiting" search="santos" />);
    expect(screen.getByRole("link", { name: "Waiting for approval" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/proposals?q=santos");
    expect(screen.getByRole("link", { name: "Answered" }).getAttribute("href")).toBe("/proposals?filter=answered&q=santos");
    expect((screen.getByLabelText("Search proposals by number, title or customer") as HTMLInputElement).value).toBe("santos");
    expect((document.querySelector('input[name="filter"]') as HTMLInputElement).value).toBe("waiting");
  });

  it("lists a contact's or deal's proposals, and offers a new one only to people who may write it", () => {
    render(<ProposalsPanel rows={[row({ status: "sent", origin: "human" })]} newHref="/proposals/new?contact=abc" canCreate />);
    expect(screen.getByRole("link", { name: /P-0001 · Website proposal/ }).getAttribute("href")).toBe(`/proposals/${PID}`);
    expect(screen.getByRole("link", { name: "New proposal" }).getAttribute("href")).toBe("/proposals/new?contact=abc");
    cleanup();
    render(<ProposalsPanel rows={[]} newHref="/proposals/new?deal=abc" canCreate={false} />);
    expect(screen.getByText("No proposals yet")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "New proposal" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Starting a proposal
// ---------------------------------------------------------------------------

describe("starting a proposal", () => {
  const start = (over: Partial<NewProposalProps> = {}) => {
    const props: NewProposalProps = { templates: [{ id: "88888888-8888-4888-8888-888888888888", name: "Standard" }], defaultCurrency: "USD", contact: { id: ME, name: "Maria Santos" }, deal: null, ai: { available: true, reason: null }, ...over };
    return render(<NewProposal {...props} />);
  };

  it("starts a draft with the customer, template and currency chosen, and opens it", async () => {
    mocks.a.createProposalAction.mockResolvedValue({ ok: true, data: { id: PID } });
    start();
    change(screen.getByLabelText("Template"), "88888888-8888-4888-8888-888888888888");
    change(screen.getByLabelText("Currency"), "PHP");
    change(screen.getByLabelText("Title"), "Spring offer");
    fireEvent.click(button("Start a draft"));
    await waitFor(() => expect(mocks.a.createProposalAction).toHaveBeenCalledWith({ contactId: ME, opportunityId: null, templateId: "88888888-8888-4888-8888-888888888888", currency: "PHP", title: "Spring offer" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(`/proposals/${PID}`));
  });

  it("takes the currency of the deal it is started from", () => {
    start({ deal: { id: "99999999-9999-4999-8999-999999999999", name: "Clinic website", currency: "PHP" } });
    expect((screen.getByLabelText("Currency") as HTMLSelectElement).value).toBe("PHP");
  });

  it("asks the AI for a first draft with the brief, says what it will not do, and tells the person what was left out", async () => {
    mocks.a.draftWithAiAction.mockResolvedValue({ ok: true, data: { id: PID, runId: "r", dropped: [], droppedCount: 2, rejectedItems: 0 } });
    start();
    expect(screen.getByText(/never sets a price, a discount or a date/)).toBeTruthy();
    expect(screen.getByText(/always needs a person's approval before it can be sent/)).toBeTruthy();
    expect(screen.getByText(/uses your workspace's AI service credits/)).toBeTruthy();
    change(screen.getByLabelText(/What should the proposal cover/), "A starter website with three pages.");
    fireEvent.click(button("Write a first draft"));
    await waitFor(() => expect(mocks.a.draftWithAiAction).toHaveBeenCalledWith({ contactId: ME, opportunityId: null, templateId: null, currency: "USD", brief: "A starter website with three pages." }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(`/proposals/${PID}`));
    expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/2 sentences were left out because it could not be backed\. Read it carefully/));
  });

  it("says why AI is not available instead of hiding it", () => {
    start({ ai: { available: false, reason: "AI drafting is switched off for this workspace. The business owner can switch it on in Settings." } });
    expect(screen.getByRole("status").textContent).toContain("AI drafting is switched off for this workspace");
    expect(screen.queryByRole("button", { name: "Write a first draft" })).toBeNull();
    expect(button("Start a draft")).toBeTruthy();
  });

  it("shows the server's refusal when the AI cannot answer, and goes nowhere", async () => {
    mocks.a.draftWithAiAction.mockResolvedValue({ ok: false, error: "The AI language model is not connected, so nothing can be drafted yet.", code: "unavailable" });
    start();
    fireEvent.click(button("Write a first draft"));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("The AI language model is not connected, so nothing can be drafted yet."));
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Settings, price book and templates
// ---------------------------------------------------------------------------

describe("the settings", () => {
  const settings = (over: Partial<ProposalSettings> = {}): ProposalSettings => ({
    aiDraftsEnabled: false, approvalMode: "ai_and_discounts", approvalOverMinor: null, discountNeedsApproval: true, twoPerson: false, defaultValidityDays: null, tagOnSendId: null, stageOnSendId: null,
    dealOnAccept: "none", version: 0, ...over,
  });
  const panel = (s = settings(), canEdit = true) => render(<ProposalSettingsPanel settings={s} currency="USD" canEdit={canEdit} tags={[{ id: "tag-1", name: "proposal-sent" }]} stages={[{ id: "stage-1", name: "Proposal Sent", pipelineName: "Sales" }]} />);

  it("starts with everything off and says there is no setting that lets an AI draft go out by itself", () => {
    panel();
    expect((screen.getByLabelText(/Let the AI write first drafts of proposals/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/Ask for a second person to approve every proposal/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/When a proposal is accepted/) as HTMLSelectElement).value).toBe("none");
    expect(screen.getByText(/There is no setting that changes this/)).toBeTruthy();
    expect(button("Save settings").disabled).toBe(true);
  });

  it("saves the whole setting against the version it started from", async () => {
    mocks.a.saveProposalSettingsAction.mockResolvedValue({ ok: true, data: settings({ aiDraftsEnabled: true, approvalOverMinor: 500_000, defaultValidityDays: 30, version: 1 }) });
    panel();
    fireEvent.click(screen.getByLabelText(/Let the AI write first drafts of proposals/));
    change(screen.getByLabelText(/Review a proposal whose total is above/), "5,000");
    change(screen.getByLabelText(/A new proposal is valid for/), "30");
    fireEvent.click(button("Save settings"));
    await waitFor(() => expect(mocks.a.saveProposalSettingsAction).toHaveBeenCalledWith({
      aiDraftsEnabled: true, approvalMode: "ai_and_discounts", approvalOverMinor: 500_000, discountNeedsApproval: true, twoPerson: false, defaultValidityDays: 30, tagOnSendId: null, stageOnSendId: null, dealOnAccept: "none",
    }, 0));
    await waitFor(() => expect(button("Save settings").disabled).toBe(true));
  });

  it("refuses nonsense in words and sends nothing", async () => {
    panel();
    change(screen.getByLabelText(/A new proposal is valid for/), "400");
    expect(screen.getByText("Enter a whole number of days from 1 to 365, or leave it empty.")).toBeTruthy();
    expect(button("Save settings").disabled).toBe(true);
    change(screen.getByLabelText(/A new proposal is valid for/), "");
    change(screen.getByLabelText(/Review a proposal whose total is above/), "lots");
    expect(button("Save settings").disabled).toBe(true);
  });

  it("is read-only for anyone but the owner", () => {
    panel(settings(), false);
    expect((screen.getByLabelText(/Let the AI write first drafts of proposals/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect(screen.getByText("Only the business owner can change these.")).toBeTruthy();
  });

  it("keeps unsaved changes when someone else saved first, and refuses to save over theirs", () => {
    const view = panel();
    fireEvent.click(screen.getByLabelText(/Ask for a second person to approve every proposal/));
    view.rerender(<ProposalSettingsPanel settings={settings({ discountNeedsApproval: false, version: 1 })} currency="USD" canEdit tags={[]} stages={[]} />);
    expect(screen.getByRole("alert").textContent).toMatch(/Someone else changed these settings/);
    expect(button("Save settings").disabled).toBe(true);
    fireEvent.click(button("Load the latest settings"));
    expect((screen.getByLabelText(/Ask for a second person to approve every proposal/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/Review a proposal that gives a discount/) as HTMLInputElement).checked).toBe(false);
  });
});

describe("the price book", () => {
  const item = (over: Partial<CatalogItemView> = {}): CatalogItemView => ({
    id: ITEM, name: "Website build", description: "Five pages", unitLabel: "project", unitPriceMinor: 150_000, currency: "USD", billing: "one_time", taxRateId: TAX, taxRateName: "Sales tax", taxBps: 1200,
    version: 1, archived: false, ...over,
  });
  const rate = (over: Partial<TaxRateView> = {}): TaxRateView => ({ id: TAX, name: "Sales tax", rateBps: 1200, archived: false, createdAt: "2026-10-01T00:00:00.000Z", ...over });

  it("lists items and rates as the business wrote them, and says nothing is pre-filled when empty", () => {
    const { rerender } = render(<CatalogPanel orgId={null} items={[item(), item({ id: "i2", name: "Old package", archived: true, billing: "monthly", taxRateId: null, taxRateName: null, taxBps: null })]} taxRates={[rate()]} canEdit defaultCurrency="USD" />);
    expect(screen.getAllByText("USD 1,500.00")).toHaveLength(2);
    expect(screen.getByText(/Billed once · per project · Sales tax 12%/)).toBeTruthy();
    expect(screen.getByText(/Per month · per project · no tax/)).toBeTruthy();
    expect(screen.getByText("Archived")).toBeTruthy();
    rerender(<CatalogPanel orgId={null} items={[]} taxRates={[]} canEdit defaultCurrency="USD" />);
    expect(screen.getByText("Your price book is empty")).toBeTruthy();
    expect(screen.getByText(/Nothing is pre-filled/)).toBeTruthy();
    expect(screen.getByText(/Without one, no tax is added to any line/)).toBeTruthy();
  });

  it("saves a new item with its price in minor units, and refuses a price that is not an amount", async () => {
    mocks.a.createCatalogItemAction.mockResolvedValue({ ok: true, data: item() });
    render(<CatalogPanel orgId={null} items={[]} taxRates={[rate()]} canEdit defaultCurrency="USD" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Add an item" })[0]);
    const dialog = within(screen.getByRole("dialog"));
    expect((dialog.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    change(dialog.getByLabelText("Name"), "Logo design");
    change(dialog.getByLabelText("Price per unit"), "12.345");
    expect(dialog.getByText(/with at most 2 decimal places/)).toBeTruthy();
    expect((dialog.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    change(dialog.getByLabelText("Price per unit"), "1,250.50");
    change(dialog.getByLabelText("Tax"), TAX);
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.a.createCatalogItemAction).toHaveBeenCalledWith(null, { name: "Logo design", description: "", unitLabel: "each", unitPriceMinor: 125_050, currency: "USD", billing: "one_time", taxRateId: TAX }));
  });

  it("changes an item against its version, and archives it", async () => {
    mocks.a.updateCatalogItemAction.mockResolvedValue({ ok: true, data: item({ version: 2 }) });
    render(<CatalogPanel orgId="org-1" items={[item({ version: 4 })]} taxRates={[rate()]} canEdit defaultCurrency="USD" />);
    fireEvent.click(button("Edit Website build"));
    const dialog = within(screen.getByRole("dialog"));
    expect((dialog.getByLabelText("Price per unit") as HTMLInputElement).value).toBe("1500.00");
    change(dialog.getByLabelText("Price per unit"), "1600");
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.a.updateCatalogItemAction).toHaveBeenCalledWith("org-1", ITEM, expect.objectContaining({ unitPriceMinor: 160_000, name: "Website build" }), 4));
    mocks.a.updateCatalogItemAction.mockClear();
    fireEvent.click(button("Edit Website build"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(mocks.a.updateCatalogItemAction).toHaveBeenCalledWith("org-1", ITEM, { archived: true }, 4));
  });

  it("saves a tax rate in basis points", async () => {
    mocks.a.createTaxRateAction.mockResolvedValue({ ok: true, data: rate() });
    render(<CatalogPanel orgId={null} items={[]} taxRates={[]} canEdit defaultCurrency="USD" />);
    fireEvent.click(button("Add a tax rate"));
    const dialog = within(screen.getByRole("dialog"));
    change(dialog.getByLabelText("Name"), "VAT");
    change(dialog.getByLabelText("Rate (percent)"), "12.5");
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.a.createTaxRateAction).toHaveBeenCalledWith(null, { name: "VAT", rateBps: 1250 }));
  });

  it("offers no way to change anything to someone who cannot", () => {
    render(<CatalogPanel orgId={null} items={[item()]} taxRates={[rate()]} canEdit={false} defaultCurrency="USD" />);
    expect(screen.queryByRole("button", { name: /Add|Edit/ })).toBeNull();
    expect(screen.getByText("The owner or a manager changes the price book and tax rates.")).toBeTruthy();
  });
});

describe("a template", () => {
  const template = (over: Partial<TemplateDetail> = {}): TemplateDetail => ({
    id: "tpl-1", key: "standard", name: "Standard", status: "draft", currentVersion: 2, approvedVersion: 1, approvedAt: "2026-10-22T10:00:00.000Z", approvedByName: "Bailey Owner", updatedAt: "2026-10-22T10:00:00.000Z",
    doc: { v: 1, sections: [{ id: "sec-about01", heading: "About us", body: "We are {{business.name}}." }], lines: [{ id: "line-tpl001", catalogItemId: ITEM, quantityMilli: 1000, note: "" }], terms: "Pay in 14 days." },
    versions: [{ version: 2, contentHash: "b".repeat(64), createdAt: "2026-10-23T10:00:00.000Z", approved: false }, { version: 1, contentHash: "a".repeat(64), createdAt: "2026-10-22T10:00:00.000Z", approved: true }], ...over,
  });
  const items = (): CatalogItemView[] => [{ id: ITEM, name: "Website build", description: "", unitLabel: "project", unitPriceMinor: 150_000, currency: "USD", billing: "one_time", taxRateId: null, taxRateName: null, taxBps: null, version: 1, archived: false }];

  it("says which version is in use and which waits for the owner, and lets only the owner approve the saved one", async () => {
    mocks.a.approveTemplateAction.mockResolvedValue({ ok: true, data: template({ approvedVersion: 2, status: "approved" }) });
    const view = render(<TemplateEditor orgId={null} template={template()} catalog={items()} canEdit canApprove tz="UTC" />);
    expect(screen.getByText(/Version 1 is in use. Version 2 is waiting for the owner to approve it/)).toBeTruthy();
    fireEvent.click(button("Approve version 2"));
    await waitFor(() => expect(mocks.a.approveTemplateAction).toHaveBeenCalledWith("tpl-1", 2));
    cleanup();
    render(<TemplateEditor orgId={null} template={template()} catalog={items()} canEdit canApprove={false} tz="UTC" />);
    expect(screen.queryByRole("button", { name: /Approve version/ })).toBeNull();
    expect(screen.getByText(/Only the business owner approves a template/)).toBeTruthy();
    void view;
  });

  it("holds the approval back while there are unsaved edits, so the owner approves what they see", () => {
    render(<TemplateEditor orgId={null} template={template()} catalog={items()} canEdit canApprove tz="UTC" />);
    change(screen.getByLabelText("Name"), "Standard v2");
    expect(button("Approve version 2").disabled).toBe(true);
    expect(screen.getByText("Save your changes first, so you approve what you see.")).toBeTruthy();
  });

  it("saves wording and items against the version it started from", async () => {
    mocks.a.saveTemplateAction.mockResolvedValue({ ok: true, data: template({ currentVersion: 3 }) });
    render(<TemplateEditor orgId={null} template={template()} catalog={items()} canEdit canApprove={false} tz="UTC" />);
    change(screen.getByLabelText("Terms"), "Pay in 30 days.");
    change(screen.getByLabelText("Quantity"), "2");
    fireEvent.click(button("Save changes"));
    await waitFor(() => expect(mocks.a.saveTemplateAction).toHaveBeenCalledWith(null, "tpl-1", {
      name: "Standard",
      doc: { sections: [{ id: "sec-about01", heading: "About us", body: "We are {{business.name}}." }], lines: [{ id: "line-tpl001", catalogItemId: ITEM, quantityMilli: 2000, note: "" }], terms: "Pay in 30 days." },
    }, 2));
  });

  it("refuses an item that was not chosen and a quantity that is not one", () => {
    render(<TemplateEditor orgId={null} template={template({ doc: { v: 1, sections: [], lines: [], terms: "" } })} catalog={items()} canEdit canApprove={false} tz="UTC" />);
    fireEvent.click(button("Add a starting item"));
    expect(screen.getByText("Choose a price book item.")).toBeTruthy();
    change(screen.getByLabelText("Quantity"), "0");
    expect(screen.getByText("The quantity must be more than zero.")).toBeTruthy();
    expect(screen.getByText(/needs fixing before this can be saved|need fixing before this can be saved/)).toBeTruthy();
  });

  it("is read-only once archived", () => {
    render(<TemplateEditor orgId={null} template={template({ status: "archived" })} catalog={items()} canEdit canApprove tz="UTC" />);
    expect(screen.getByText(/This template is archived/)).toBeTruthy();
    expect(screen.getByLabelText("Name").matches(":disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Approve version/ })).toBeNull();
  });
});

describe("nothing prints a raw value", () => {
  it("shows no 'undefined', 'NaN' or '[object Object]' anywhere in a fully loaded workspace", () => {
    const { container } = render(<ProposalWorkspace
      detail={detail({ status: "sent", sentVersion: 1, approvedVersion: 1, approvedByName: "Bailey Owner", approvedAt: "2026-10-21T10:00:00.000Z", decisions: [], versions: [], events: [{ id: 1, at: "2026-10-21T10:00:00.000Z", kind: "sent", version: 1, actorKind: "user", actorName: null, detail: {} }], share: { id: "l", version: 1, recipientEmail: null, recipientName: null, createdAt: "2026-10-21T10:00:00.000Z", expiresAt: "2026-12-31T10:00:00.000Z", revokedAt: null, active: true, seen: "none", openCount: 0, firstOpenedAt: null, lastOpenedAt: null, viewedCount: 0, firstViewedAt: null, verifiedAt: null, downloadedAt: null, canCopy: true } })}
      catalog={catalog()} taxRates={taxRates} can={allCan} twoPerson={false} tz="UTC" />);
    expect(container.textContent).not.toMatch(/undefined|NaN|\[object Object\]/);
    act(() => undefined);
  });
});
