// @vitest-environment jsdom
// A project's change list and "Before we start" as the client reads them, and the team's panels, in a browser-like document: who is offered which button, that an acceptance
// asks for the acknowledgement first, that a retry key travels with each send, and that nothing is shown the person must not see. The server actions are replaced; the services
// are tested in project-change-orders.test.ts and project-prerequisites.test.ts.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(), success: vi.fn(), error: vi.fn(),
  submit: vi.fn(), withdraw: vi.fn(), post: vi.fn(), decide: vi.fn(),
  start: vi.fn(), classify: vi.fn(), notes: vi.fn(), ask: vi.fn(), revision: vi.fn(), quote: vi.fn(), pull: vi.fn(), decline: vi.fn(), made: vi.fn(), terms: vi.fn(),
  addPre: vi.fn(), satisfy: vi.fn(), waive: vi.fn(), removePre: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/app/actions/projects-changes", () => ({
  submitChangeOrderAction: mocks.submit, withdrawChangeOrderAction: mocks.withdraw, postChangeMessageAction: mocks.post, decideChangeOrderAction: mocks.decide,
}));
vi.mock("@/app/(admin)/admin/projects/actions", () => ({
  startChangeReviewAction: mocks.start, classifyChangeOrderAction: mocks.classify, saveChangeNotesAction: mocks.notes, requestChangeInfoAction: mocks.ask, applyRevisionAction: mocks.revision,
  sendChangeQuoteAction: mocks.quote, pullBackChangeQuoteAction: mocks.pull, declineChangeOrderAction: mocks.decline, markChangeAppliedAction: mocks.made, projectTermsAction: mocks.terms,
  addPrerequisiteAction: mocks.addPre, satisfyPrerequisiteAction: mocks.satisfy, waivePrerequisiteAction: mocks.waive, removePrerequisiteAction: mocks.removePre,
}));

import { ChangeRequestsSection } from "@/components/projects/change-requests";
import { PrerequisitesCard } from "@/components/projects/prerequisites-card";
import { AdminChangePanel, AdminPrerequisitesPanel, AdminTermsCard } from "@/components/admin/admin-change-panel";
import type { AgencyProjectDetail } from "@/server/projects/agency";
import type { ChangeOrderView, PrerequisiteView, ProjectDetail } from "@/server/projects/shared";
import { CHANGE_ACCEPT_ACKNOWLEDGEMENT } from "@/lib/project-change-orders";

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  for (const m of [mocks.submit, mocks.withdraw, mocks.post, mocks.decide, mocks.start, mocks.classify, mocks.notes, mocks.ask, mocks.revision, mocks.quote, mocks.pull, mocks.decline, mocks.made, mocks.terms, mocks.addPre, mocks.satisfy, mocks.waive, mocks.removePre]) {
    m.mockResolvedValue({ ok: true, data: { id: "new", ref: "CHG-1009", existing: false, version: 1, decision: "accepted", requestId: PROJECT } });
  }
});
afterEach(cleanup);

const PROJECT = "6f1f0d9e-0000-4000-8000-0000000000a1";
const CHANGE = "6f1f0d9e-0000-4000-8000-0000000000c1";
const at = "2026-10-20T09:00:00.000Z";

const change = (over: Partial<ChangeOrderView> = {}): ChangeOrderView => ({
  id: CHANGE, ref: "CHG-1001", title: "Add a second calendar", description: "We now have two front desks and each needs its own calendar.", status: "submitted", classification: "undetermined", quoteVersion: 0,
  additionalCents: null, currency: null, weeksMin: null, weeksMax: null, termsText: null, validUntil: null, expired: false, ticketId: null, requestedAt: at, requestedByName: "Olivia Owner",
  quotedAt: null, decidedAt: null, appliedAt: null, decisions: [], ...over,
});
const quoted = (over: Partial<ChangeOrderView> = {}) => change({ status: "quoted", classification: "out_of_scope", quoteVersion: 1, additionalCents: 120000, currency: "USD", weeksMin: 2, weeksMax: 3, termsText: "Adds a second calendar, its confirmation message and one test booking.", validUntil: "2026-12-31", quotedAt: at, ...over });

function project(over: Partial<ProjectDetail> = {}, status: ProjectDetail["request"]["status"] = "in_development"): ProjectDetail {
  return {
    request: { id: PROJECT, ref: "PRJ-1042", orgId: "o", title: "AI receptionist", summary: "", toolsUsed: [], preferredDeadline: null, budgetRange: null, status, statusBeforeHold: null, serviceId: null, serviceName: null, serviceSlug: null, isAssigned: true, cancelReason: null, submittedAt: at, lastActivityAt: at, closedAt: null },
    requirements: [], quotes: [],
    delivery: { agreedPriceCents: 120000, ongoingMonthlyCents: null, currency: "USD", scope: "Voice agent.", deliverables: [], timelineText: "", agreedAt: at, startedAt: at, expectedCompletionOn: null, completedAt: null, handoverNotes: null, warrantyDays: null, warrantyEndsOn: null, revisionsIncluded: null, revisionsUsed: 0 },
    milestones: [], updates: [], files: [], messages: [], tickets: [], changes: [], amendments: [], prerequisites: [], ...over,
  };
}
const section = (p: ProjectDetail, opts: { canRequest?: boolean; canApprove?: boolean; enabled?: boolean } = {}) =>
  render(<ChangeRequestsSection project={p} timeZone="UTC" canRequest={opts.canRequest ?? true} canApprove={opts.canApprove ?? true} changesEnabled={opts.enabled ?? true} />);

describe("asking for a change", () => {
  it("offers an owner or admin the button, needs a title and a sentence, and sends a retry key with the words", async () => {
    section(project());
    expect(screen.getByText("No changes asked for")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Ask for a change/ }));
    const dialog = await screen.findByRole("dialog");
    const send = within(dialog).getByRole("button", { name: "Send request" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/What should change/), { target: { value: "Add a second calendar" } });
    expect(send.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Tell us more/), { target: { value: "Each front desk needs its own calendar." } });
    expect(send.disabled).toBe(false);
    expect(within(dialog).getByText(/Nothing is charged by asking/)).toBeTruthy();
    fireEvent.click(send);
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    const [id, input] = mocks.submit.mock.calls[0];
    expect(id).toBe(PROJECT);
    expect(input).toMatchObject({ title: "Add a second calendar", description: "Each front desk needs its own calendar." });
    expect(String(input.idempotencyKey).length).toBeGreaterThanOrEqual(8);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("does not offer it to a member, or when the workspace has it switched off, or when the project cannot take one, and says why", () => {
    const { unmount } = section(project(), { canRequest: false });
    expect(screen.queryByRole("button", { name: /Ask for a change/ })).toBeNull();
    expect(screen.getByText(/Owners and admins ask for changes/)).toBeTruthy();
    unmount();
    const off = section(project(), { enabled: false });
    expect(screen.queryByRole("button", { name: /Ask for a change/ })).toBeNull();
    expect(screen.getByText(/isn't switched on for your workspace yet/)).toBeTruthy();
    off.unmount();
    section(project({}, "on_hold"));
    expect(screen.queryByRole("button", { name: /Ask for a change/ })).toBeNull();
    expect(screen.getByText(/on hold/)).toBeTruthy();
  });

  it("shows nothing at all for a project that was never agreed and has no changes", () => {
    const { container } = section(project({ delivery: null }), { enabled: true });
    expect(container.textContent).toBe("");
  });

  it("says plainly that asking does not charge, price or promise anything", () => {
    section(project());
    expect(screen.getByText(/Nothing is done, priced or promised until they reply/)).toBeTruthy();
  });
});

describe("a quote for a change", () => {
  it("shows the team's price, weeks and terms, with the weeks called an estimate, and the version", () => {
    section(project({ changes: [quoted()] }));
    expect(screen.getByText("Quote ready for your decision")).toBeTruthy();
    expect(screen.getByText(/\$1,200\.00 and 2 to 3 more weeks \(an estimate, not a delivery date\)/)).toBeTruthy();
    expect(screen.getByText(/Quote, version 1/)).toBeTruthy();
    expect(screen.getByText(/Adds a second calendar, its confirmation message/)).toBeTruthy();
    expect(screen.getByText(/1 quote for your decision/)).toBeTruthy();
    expect(screen.getByText(/Outside what was agreed, so it needs a quote/)).toBeTruthy();
  });

  it("asks the owner to tick the acknowledgement before accepting, then records the answer and refreshes", async () => {
    section(project({ changes: [quoted()] }));
    fireEvent.click(screen.getByRole("button", { name: /Accept this change/ }));
    const dialog = await screen.findByRole("dialog");
    const accept = within(dialog).getByRole("button", { name: "Accept this change" }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect(within(dialog).getByText(CHANGE_ACCEPT_ACKNOWLEDGEMENT)).toBeTruthy();
    expect(within(dialog).getByText(/not an electronic signature/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    expect(accept.disabled).toBe(false);
    fireEvent.click(accept);
    await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith(PROJECT, CHANGE, "accepted", undefined));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.success).toHaveBeenCalledWith(expect.stringMatching(/part of what was agreed/));
  });

  it("lets the owner decline with a reason, and an admin sees no decision buttons, only why", async () => {
    const { unmount } = section(project({ changes: [quoted()] }));
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Too expensive for now." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith(PROJECT, CHANGE, "declined", "Too expensive for now."));
    unmount();
    section(project({ changes: [quoted()] }), { canApprove: false });
    expect(screen.queryByRole("button", { name: /Accept this change/ })).toBeNull();
    expect(screen.getByText(/A workspace owner accepts or declines a quote/)).toBeTruthy();
  });

  it("shows an expired quote as expired and offers no way to accept it", () => {
    section(project({ changes: [quoted({ expired: true, validUntil: "2026-10-01" })] }));
    expect(screen.getAllByText("Quote expired").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Accept this change/ })).toBeNull();
    expect(screen.getByText(/The quote was not decided in time/)).toBeTruthy();
    expect(screen.queryByText(/1 quote for your decision/)).toBeNull();
  });

  it("still lets the owner answer a quote after the workspace switch was turned off, and offers no new request", () => {
    section(project({ changes: [quoted()] }), { enabled: false });
    expect(screen.getByRole("button", { name: /Accept this change/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Ask for a change/ })).toBeNull();
  });

  it("offers no decision on a project that is on hold", () => {
    section(project({ changes: [quoted()] }, "on_hold"));
    expect(screen.queryByRole("button", { name: /Accept this change/ })).toBeNull();
  });
});

describe("the rest of the list", () => {
  it("keeps declined and withdrawn changes on the list with their history and no buttons", () => {
    const declined = change({ id: "d", ref: "CHG-1002", status: "declined", decisions: [{ quoteVersion: 1, decision: "declined", note: "Too expensive.", decidedAt: at, decidedByName: "Olivia Owner" }], quoteVersion: 1, additionalCents: 5000, currency: "USD", termsText: "Terms of the quote.", classification: "out_of_scope" });
    const withdrawn = change({ id: "w", ref: "CHG-1003", status: "withdrawn" });
    section(project({ changes: [declined, withdrawn] }));
    expect(screen.getByText("CHG-1002")).toBeTruthy();
    expect(screen.getByText("CHG-1003")).toBeTruthy();
    // The status and the recorded answer both say declined.
    expect(screen.getAllByText("Declined")).toHaveLength(2);
    expect(screen.getByText("Withdrawn")).toBeTruthy();
    expect(screen.getByText(/“Too expensive\.”/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Withdraw|Accept|Decline/ })).toBeNull();
  });

  it("lists what was added to the agreement, and says the original scope is unchanged", () => {
    section(project({ changes: [change({ status: "accepted" })], amendments: [{ id: "a", changeOrderId: CHANGE, changeRef: "CHG-1001", changeTitle: "Add a second calendar", addedScope: "Add a second calendar\n\nAdds a second calendar and its message.", addedCents: 120000, currency: "USD", weeksMin: 1, weeksMax: 2, agreedAt: at }] }));
    expect(screen.getByText("Added to what was agreed")).toBeTruthy();
    expect(screen.getByText("Adds a second calendar and its message.")).toBeTruthy();
    expect(screen.getByText(/The original scope above is unchanged/)).toBeTruthy();
  });

  it("lets the owner withdraw an open request after confirming, and a member only write", async () => {
    const { unmount } = section(project({ changes: [change({ status: "under_review" })] }));
    fireEvent.click(screen.getByRole("button", { name: "Withdraw this request" }));
    const dialog = await screen.findByRole("dialog");
    expect(mocks.withdraw).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(mocks.withdraw).toHaveBeenCalledWith(PROJECT, CHANGE));
    unmount();
    section(project({ changes: [change({ status: "under_review" })] }), { canRequest: false, canApprove: false });
    expect(screen.queryByRole("button", { name: "Withdraw this request" })).toBeNull();
    expect(screen.queryByLabelText(/Write to the team about/)).toBeNull();
  });

  it("answers the team's question in the change's own thread with a message id that makes a repeat harmless", async () => {
    const question = { id: "m1", authorKind: "agency" as const, authorName: null, kind: "info_request" as const, body: "Which front desk gets the first calendar?", internal: false, createdAt: at, changeOrderId: CHANGE };
    section(project({ changes: [change({ status: "needs_info" })], messages: [question, { ...question, id: "m2", body: "A message on another change", changeOrderId: "other" }] }));
    expect(screen.getByText("Which front desk gets the first calendar?")).toBeTruthy();
    expect(screen.queryByText("A message on another change")).toBeNull();
    expect(screen.getByText("Question from iAcquire")).toBeTruthy();
    const box = screen.getByLabelText("Write to the team about CHG-1001");
    expect((box as HTMLTextAreaElement).placeholder).toMatch(/Answer the team's question/);
    fireEvent.change(box, { target: { value: "The ground floor desk." } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    const [projectId, changeId, body, messageId] = mocks.post.mock.calls[0];
    expect([projectId, changeId, body]).toEqual([PROJECT, CHANGE, "The ground floor desk."]);
    expect(String(messageId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("shows a failed action's reason and does not refresh", async () => {
    mocks.decide.mockResolvedValue({ ok: false, error: "This quote changed after it was sent. Ask iAcquire to resend it." });
    section(project({ changes: [quoted()] }));
    fireEvent.click(screen.getByRole("button", { name: /Accept this change/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Accept this change" }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("This quote changed after it was sent. Ask iAcquire to resend it."));
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

describe("Before we start", () => {
  const item = (over: Partial<PrerequisiteView> = {}): PrerequisiteView => ({ id: "p1", kind: "agreement", label: "Written agreement confirmed", required: true, blocks: "start", status: "pending", satisfiedAt: null, waivedAt: null, changeOrderId: null, changeStatus: null, ...over });

  it("renders nothing when nothing is asked for", () => {
    const { container } = render(<PrerequisitesCard items={[]} timeZone="UTC" />);
    expect(container.textContent).toBe("");
  });

  it("lists what is asked and whether it is done, in plain words, with no evidence, person or payment detail", () => {
    render(<PrerequisitesCard timeZone="UTC" items={[item(), item({ id: "p2", kind: "deposit", label: "Payment confirmed as the quote's payment terms describe", status: "satisfied", satisfiedAt: at }), item({ id: "p3", kind: "access", label: "Access to the booking calendar", status: "waived", waivedAt: at })]} />);
    expect(screen.getByText("Before we start")).toBeTruthy();
    expect(screen.getByText("1 waiting")).toBeTruthy();
    expect(screen.getByText(/Waiting\. Work starts once this is confirmed\./)).toBeTruthy();
    expect(screen.getByText(/Confirmed by the iAcquire team\./)).toBeTruthy();
    expect(screen.getByText(/The team decided this is not needed\./)).toBeTruthy();
    expect(screen.getByText(/Nothing here takes a payment/)).toBeTruthy();
  });

  it("says everything is confirmed once nothing waits", () => {
    render(<PrerequisitesCard timeZone="UTC" items={[item({ status: "satisfied", satisfiedAt: at })]} />);
    expect(screen.getByText("All confirmed")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The team's side
// ---------------------------------------------------------------------------

function agency(over: Partial<AgencyProjectDetail> = {}, status: ProjectDetail["request"]["status"] = "in_development"): AgencyProjectDetail {
  return { ...project({}, status), orgName: "Projects Co", createdByName: "Olivia Owner", internalNotes: null, assignedTo: null, assignable: [], tasks: [], suggestedServices: [], quoteInternalNotes: {}, ...over } as AgencyProjectDetail;
}

describe("the team's change panel", () => {
  it("offers each status its own next steps and nothing else", () => {
    const cases: Array<[Partial<ChangeOrderView>, string[], string[]]> = [
      [{ status: "submitted" }, ["Start review", "It's a revision", "Outside what was agreed", "Ask the client", "Decline"], ["Write the quote", "Take the quote back", "Mark as made"]],
      [{ status: "under_review", classification: "out_of_scope" }, ["Write the quote", "Ask the client", "Decline"], ["Start review", "Take the quote back", "Made as a revision"]],
      [{ status: "under_review", classification: "in_scope_revision" }, ["Made as a revision", "Ask the client", "Decline"], ["Write the quote", "Take the quote back"]],
      [{ status: "needs_info" }, ["Decline"], ["Ask the client", "Write the quote", "Start review"]],
      [{ status: "quoted", classification: "out_of_scope", quoteVersion: 1, additionalCents: 5000, currency: "USD", termsText: "Terms of the quote." }, ["Take the quote back"], ["Decline", "Write the quote", "Ask the client"]],
      [{ status: "accepted", classification: "out_of_scope", quoteVersion: 1, additionalCents: 5000, currency: "USD", termsText: "Terms of the quote." }, ["Mark as made"], ["Decline", "Take the quote back"]],
      [{ status: "applied" }, [], ["Decline", "Mark as made", "Start review", "Ask the client"]],
      [{ status: "declined" }, [], ["Decline", "Start review"]],
      [{ status: "withdrawn" }, [], ["Decline", "Start review"]],
    ];
    for (const [over, wanted, unwanted] of cases) {
      const { unmount } = render(<AdminChangePanel project={agency({ changes: [change(over)] })} />);
      for (const name of wanted) expect(screen.queryAllByRole("button", { name: new RegExp(name.replace(/[']/g, "'")) }).length, `${over.status}: ${name}`).toBeGreaterThan(0);
      for (const name of unwanted) expect(screen.queryAllByRole("button", { name: new RegExp(`^${name}`) }).length, `${over.status}: not ${name}`).toBe(0);
      unmount();
    }
  });

  it("classifies from the buttons, and starts the review of a received change", async () => {
    render(<AdminChangePanel project={agency({ changes: [change()] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(PROJECT, CHANGE));
    fireEvent.click(screen.getByRole("button", { name: "Outside what was agreed" }));
    await waitFor(() => expect(mocks.classify).toHaveBeenCalledWith(PROJECT, CHANGE, { classification: "out_of_scope" }));
  });

  it("writes a quote in minor units from what the person typed, shows a refused price in words, and sends only when it is complete", async () => {
    render(<AdminChangePanel project={agency({ changes: [change({ status: "under_review", classification: "out_of_scope" })] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Write the quote" }));
    const dialog = await screen.findByRole("dialog");
    const send = within(dialog).getByRole("button", { name: "Send quote" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Extra cost \(USD\)/), { target: { value: "twelve hundred" } });
    fireEvent.change(within(dialog).getByLabelText(/What this change includes/), { target: { value: "Adds a second calendar and its message." } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/Enter an amount such as 1500/);
    expect(mocks.quote).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(/Extra cost \(USD\)/), { target: { value: "1,200.50" } });
    fireEvent.change(within(dialog).getByLabelText(/Extra weeks \(from\)/), { target: { value: "2" } });
    fireEvent.change(within(dialog).getByLabelText(/Something a person must confirm first/), { target: { value: "Deposit for this change received" } });
    fireEvent.click(send);
    await waitFor(() => expect(mocks.quote).toHaveBeenCalledTimes(1));
    expect(mocks.quote.mock.calls[0]).toEqual([PROJECT, CHANGE, { additionalMinor: 120050, currency: "USD", weeksMin: 2, weeksMax: null, termsText: "Adds a second calendar and its message.", validUntil: null, prerequisiteLabel: "Deposit for this change received" }]);
  });

  it("will not mark a change as a revision when all the included revisions are used, and says why", () => {
    const p = agency({ changes: [change({ status: "under_review", classification: "in_scope_revision" })] });
    p.delivery = { ...p.delivery!, revisionsIncluded: 2, revisionsUsed: 2 };
    render(<AdminChangePanel project={p} />);
    expect((screen.getByRole("button", { name: /Made as a revision/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/All included revisions are used/)).toBeTruthy();
    expect(screen.getByText(/2 of 2 used \(0 left\)/)).toBeTruthy();
  });

  it("asks the client a question and declines with a reason the client will read, both only once words are written", async () => {
    render(<AdminChangePanel project={agency({ changes: [change({ status: "under_review" })] })} />);
    fireEvent.click(screen.getByRole("button", { name: /Ask the client/ }));
    let dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByRole("button", { name: "Send question" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Your question"), { target: { value: "Which desk first?" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(mocks.ask).toHaveBeenCalledWith(PROJECT, CHANGE, "Which desk first?"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Shown to the client/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Why not?"), { target: { value: "That is a new project." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(mocks.decline).toHaveBeenCalledWith(PROJECT, CHANGE, "That is a new project."));
  });

  it("shows the team's notes only in the team's panel", () => {
    render(<AdminChangePanel project={agency({ changes: [change({ internalNotes: "TEAM-ONLY-NOTE-77" })] })} />);
    fireEvent.click(screen.getByText("Team notes"));
    expect((screen.getByLabelText("Team notes for CHG-1001") as HTMLTextAreaElement).value).toBe("TEAM-ONLY-NOTE-77");
    cleanup();
    section(project({ changes: [change()] }));
    expect(document.body.textContent).not.toContain("TEAM-ONLY-NOTE-77");
  });
});

describe("saving the team's notes", () => {
  const open = (internalNotes: string | null) => {
    const view = render(<AdminChangePanel project={agency({ changes: [change({ internalNotes })] })} />);
    fireEvent.click(screen.getByText("Team notes"));
    return view;
  };

  it("sends the notes as they were read along with the new text, so a colleague's edit is noticed", async () => {
    open("Read this version");
    const area = screen.getByLabelText("Team notes for CHG-1001") as HTMLTextAreaElement;
    const save = screen.getByRole("button", { name: "Save notes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(area, { target: { value: "Read this version, plus mine" } });
    fireEvent.click(save);
    await waitFor(() => expect(mocks.notes).toHaveBeenCalledWith(PROJECT, CHANGE, "Read this version, plus mine", "Read this version"));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Notes saved"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends an empty copy when there were no notes before", async () => {
    open(null);
    fireEvent.change(screen.getByLabelText("Team notes for CHG-1001"), { target: { value: "First note" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await waitFor(() => expect(mocks.notes).toHaveBeenCalledWith(PROJECT, CHANGE, "First note", null));
  });

  it("shows a banner with the colleague's version when the notes changed, keeps the person's text and reloads the page's data", async () => {
    mocks.notes.mockResolvedValue({ ok: false, code: "conflict", error: "Someone else changed these notes while you were editing. Nothing was saved. Their version is shown above your text." });
    const view = open("Read this version");
    fireEvent.change(screen.getByLabelText("Team notes for CHG-1001"), { target: { value: "My edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toMatch(/Someone else changed these notes/);
    expect(mocks.refresh).toHaveBeenCalled();
    expect((screen.getByLabelText("Team notes for CHG-1001") as HTMLTextAreaElement).value).toBe("My edit");
    expect(mocks.error).not.toHaveBeenCalled();
    // The page's data arrives with their version: it is shown, and can be taken instead of the person's own text.
    view.rerender(<AdminChangePanel project={agency({ changes: [change({ internalNotes: "Their newer version" })] })} />);
    const shown = await screen.findByRole("alert");
    expect(within(shown).getByText("Their newer version")).toBeTruthy();
    fireEvent.click(within(shown).getByRole("button", { name: "Use their version" }));
    expect((screen.getByLabelText("Team notes for CHG-1001") as HTMLTextAreaElement).value).toBe("Their newer version");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the banner until the notes are saved from the new copy, and then compares against that copy", async () => {
    mocks.notes.mockResolvedValueOnce({ ok: false, code: "conflict", error: "Someone else changed these notes while you were editing. Nothing was saved. Their version is shown above your text." });
    const view = open("Read this version");
    fireEvent.change(screen.getByLabelText("Team notes for CHG-1001"), { target: { value: "My edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await screen.findByRole("alert");
    view.rerender(<AdminChangePanel project={agency({ changes: [change({ internalNotes: "Their newer version" })] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await waitFor(() => expect(mocks.notes).toHaveBeenLastCalledWith(PROJECT, CHANGE, "My edit", "Their newer version"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("toasts any other failure instead of showing the banner", async () => {
    mocks.notes.mockResolvedValue({ ok: false, code: "forbidden", error: "Your role does not allow this project action." });
    open("Read this version");
    fireEvent.change(screen.getByLabelText("Team notes for CHG-1001"), { target: { value: "My edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("Your role does not allow this project action."));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the team's list of what is confirmed first", () => {
  const item = (over: Partial<PrerequisiteView> = {}): PrerequisiteView => ({ id: "p1", kind: "agreement", label: "Written agreement confirmed", required: true, blocks: "start", status: "pending", satisfiedAt: null, waivedAt: null, changeOrderId: null, changeStatus: null, ...over });

  it("confirms an item with what was checked, refuses a card number in words, and waives with a reason", async () => {
    render(<AdminPrerequisitesPanel project={agency({ prerequisites: [item()] })} />);
    expect(screen.getByText("1 waiting")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm it" }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/What you checked/), { target: { value: "Paid with 4242 4242 4242 4242 today" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/card number/);
    expect(mocks.satisfy).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(/What you checked/), { target: { value: "Signed copy received by email on the 3rd." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(mocks.satisfy).toHaveBeenCalledWith(PROJECT, "p1", "Signed copy received by email on the 3rd."));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Not needed" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Why it isn't needed/), { target: { value: "The client pays at handover." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark as not needed" }));
    await waitFor(() => expect(mocks.waive).toHaveBeenCalledWith(PROJECT, "p1", "The client pays at handover."));
  });

  it("shows a settled item with who recorded it and what they wrote, offers it no buttons, and adds a new item by hand", async () => {
    render(<AdminPrerequisitesPanel project={agency({ prerequisites: [item({ status: "satisfied", satisfiedAt: at, evidenceNote: "Signed copy received.", recordedByName: "Stan Staffer" })] })} />);
    expect(screen.getByText(/Confirmed .* by Stan Staffer: Signed copy received\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm it" })).toBeNull();
    expect(screen.getByText("All settled")).toBeTruthy();
    const add = screen.getByRole("button", { name: /Add/ }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Ask for something/), { target: { value: "Access to the booking calendar" } });
    fireEvent.click(add);
    await waitFor(() => expect(mocks.addPre).toHaveBeenCalledWith(PROJECT, { kind: "access", label: "Access to the booking calendar", blocks: "start", required: true }));
  });

  it("offers nothing to add on a project that is closed", () => {
    render(<AdminPrerequisitesPanel project={agency({}, "cancelled")} />);
    expect(screen.queryByLabelText(/Ask for something/)).toBeNull();
  });
});

describe("revisions and the support period", () => {
  it("saves what the team recorded, empty meaning nothing is assumed, and is not shown once the project is handed over", async () => {
    const p = agency();
    render(<AdminTermsCard project={p} />);
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Revisions included/), { target: { value: "3" } });
    fireEvent.click(save);
    await waitFor(() => expect(mocks.terms).toHaveBeenCalledWith(PROJECT, { revisionsIncluded: 3, warrantyDays: null }));
    cleanup();
    const done = agency();
    done.delivery = { ...done.delivery!, completedAt: at };
    const { container } = render(<AdminTermsCard project={done} />);
    expect(container.textContent).toBe("");
  });
});
