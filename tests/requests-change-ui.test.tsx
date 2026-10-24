// @vitest-environment jsdom
// The Request a Change form in a browser-like document: what it asks, what it requires, what it sends. The server action is replaced; the service is tested in
// requests-change.test.ts.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ submit: vi.fn(), similar: vi.fn(), suggest: vi.fn(), improve: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/support", () => ({
  submitRequestAction: mocks.submit, findSimilarRequestsAction: mocks.similar, suggestForDraftAction: mocks.suggest, improveRequestDraftAction: mocks.improve,
}));

import { RequestForm, type ChangeFormProps } from "@/components/support/request-form";
import { CATEGORIES_BY_TYPE, categoryLabel } from "@/lib/support/lifecycle";

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.similar.mockResolvedValue({ ok: true, data: [] });
  mocks.suggest.mockResolvedValue({ ok: true, data: { suggestion: { category: "general", requestType: "support", reason: "", confidence: "low" }, articles: [] } });
  mocks.submit.mockResolvedValue({ ok: true, data: { id: "t1", ref: "IAQ-1001", status: "new", existing: false, expectation: null, externalNotification: "not_configured", changeOrderRef: null } });
  window.localStorage.clear();
});
afterEach(cleanup);

const PROJECT = "6f1f0d9e-0000-4000-8000-0000000000a1";
const CLOSED = "6f1f0d9e-0000-4000-8000-0000000000a2";
const change = (over: Partial<ChangeFormProps> = {}): ChangeFormProps => ({
  projects: [
    { id: PROJECT, ref: "PRJ-1042", title: "AI receptionist", status: "in_development", canFileAsChange: true },
    { id: CLOSED, ref: "PRJ-1001", title: "Old website", status: "completed", canFileAsChange: false },
  ],
  allowanceNote: null, ...over,
});
const form = (props: Partial<React.ComponentProps<typeof RequestForm>> = {}) =>
  render(<RequestForm kind="change" orgId="org-1" maxMb={10} maxFiles={5} expectation={null} appVersion="test" fromPath={null} change={change()} {...props} />);
const fill = (subject = "Make the greeting warmer", message = "Please change how our AI employee greets new callers on the phone.") => {
  fireEvent.change(screen.getByLabelText(/What should change/), { target: { value: subject } });
  fireEvent.change(screen.getByLabelText(/What would you like different/), { target: { value: message } });
};

describe("the form", () => {
  it("asks what the change is about with the six choices, in plain words, and says nothing is done or promised before a reply", () => {
    form();
    const select = screen.getByLabelText(/What is the change about/) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([...CATEGORIES_BY_TYPE.change]);
    expect([...select.options].map((o) => o.text)).toEqual(CATEGORIES_BY_TYPE.change.map((c) => categoryLabel(c)));
    expect(screen.getByText(/Nothing is done, priced or promised until the team has replied/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Send change request/ })).toBeTruthy();
    expect(screen.queryByLabelText(/Which project/)).toBeNull();
  });

  it("asks which project only for a change to a project, and will not send until one is chosen", async () => {
    form();
    fireEvent.change(screen.getByLabelText(/What is the change about/), { target: { value: "change_project" } });
    const project = screen.getByLabelText(/Which project/) as HTMLSelectElement;
    expect([...project.options].map((o) => o.text)).toEqual(["Choose a project…", "PRJ-1042 · AI receptionist", "PRJ-1001 · Old website"]);
    fill();
    fireEvent.click(screen.getByRole("button", { name: /Send change request/ }));
    expect((await screen.findAllByText("Choose the project the change is about.")).length).toBeGreaterThan(0);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("offers filing as a change to what was agreed only for a project that can take one, and sends the project with the retry key", async () => {
    form();
    fireEvent.change(screen.getByLabelText(/What is the change about/), { target: { value: "change_project" } });
    fireEvent.change(screen.getByLabelText(/Which project/), { target: { value: CLOSED } });
    expect(screen.queryByLabelText(/This changes what we agreed/)).toBeNull();
    expect(screen.getByText(/can't take a change to its agreed scope right now/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Which project/), { target: { value: PROJECT } });
    const tick = screen.getByRole("checkbox") as HTMLInputElement;
    expect(tick.checked).toBe(false);
    fireEvent.click(tick);
    fill();
    fireEvent.click(screen.getByRole("button", { name: /Send change request/ }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    const sent = mocks.submit.mock.calls[0][0];
    expect(sent).toMatchObject({ requestType: "change", category: "change_project", projectId: PROJECT, asChangeOrder: true, subject: "Make the greeting warmer" });
    expect(String(sent.idempotencyKey).length).toBeGreaterThanOrEqual(8);
    expect(sent.message).toMatch(/greets new callers/);
  });

  it("sends no project and no filing for a change about something else, even after a project was picked and the category moved away", async () => {
    form();
    fireEvent.change(screen.getByLabelText(/What is the change about/), { target: { value: "change_project" } });
    fireEvent.change(screen.getByLabelText(/Which project/), { target: { value: PROJECT } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText(/What is the change about/), { target: { value: "change_website" } });
    fill("Change the footer", "Please update the opening hours in the website footer.");
    fireEvent.click(screen.getByRole("button", { name: /Send change request/ }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    const sent = mocks.submit.mock.calls[0][0];
    expect(sent.projectId).toBeUndefined();
    expect(sent.asChangeOrder).toBeUndefined();
    expect(sent.category).toBe("change_website");
  });

  it("starts on the project the person came from", async () => {
    form({ aboutProject: { id: PROJECT, label: "PRJ-1042 · AI receptionist" } });
    expect((screen.getByLabelText(/What is the change about/) as HTMLSelectElement).value).toBe("change_project");
    expect((screen.getByLabelText(/Which project/) as HTMLSelectElement).value).toBe(PROJECT);
  });

  it("shows the maintenance allowance sentence only when it is given", () => {
    const { unmount } = form();
    expect(screen.queryByText(/maintenance plan includes/)).toBeNull();
    unmount();
    form({ change: change({ allowanceNote: "Your maintenance plan includes 4 managed requests a month (3 left this month). Small changes the plan covers are sent from Maintenance." }) });
    expect(screen.getByText(/maintenance plan includes 4 managed requests a month \(3 left this month\)/)).toBeTruthy();
  });

  it("tells the person what was made, including the entry on the project's list when there is one", async () => {
    mocks.submit.mockResolvedValue({ ok: true, data: { id: "t1", ref: "IAQ-1001", status: "new", existing: false, expectation: null, externalNotification: "not_configured", changeOrderRef: "CHG-1007" } });
    form({ aboutProject: { id: PROJECT, label: "PRJ-1042 · AI receptionist" } });
    fill("Add a second calendar", "We now have two front desks and each needs its own calendar.");
    fireEvent.click(screen.getByRole("button", { name: /Send change request/ }));
    expect(await screen.findByText("Your change request has been sent")).toBeTruthy();
    expect(screen.getByText("IAQ-1001")).toBeTruthy();
    expect(screen.getByText("CHG-1007")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Request another change" })).toBeTruthy();
  });

  it("shows a refusal in words and keeps what was typed", async () => {
    mocks.submit.mockResolvedValue({ ok: false, error: "Request a Change isn't switched on for your workspace yet.", code: "not_enabled" });
    form();
    fill();
    fireEvent.click(screen.getByRole("button", { name: /Send change request/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/isn't switched on/);
    expect((screen.getByLabelText(/What should change/) as HTMLInputElement).value).toBe("Make the greeting warmer");
  });

  it("files an issue or feedback against the project it was opened from, and says so", async () => {
    render(<RequestForm kind="issue" orgId="org-1" maxMb={10} maxFiles={5} expectation={null} appVersion="test" fromPath={null} aboutProject={{ id: PROJECT, label: "PRJ-1042 · AI receptionist" }} />);
    expect(screen.getByText("PRJ-1042 · AI receptionist")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Issue title/), { target: { value: "The agent hangs up early" } });
    fireEvent.change(screen.getByLabelText(/What happened/), { target: { value: "It ends the call after the greeting every time." } });
    fireEvent.click(screen.getByRole("button", { name: /Send report/ }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0][0]).toMatchObject({ requestType: "issue", projectId: PROJECT });
    expect(mocks.submit.mock.calls[0][0].asChangeOrder).toBeUndefined();
  });
});
