// @vitest-environment jsdom
// The launch panel as a person meets it: the six states drawn from the judge's real output, the steps and stages in words, the buttons that run a step and the links that leave, what is
// announced and when, and what the panel does while it waits. The server action is a fake; nothing here reaches a server, a browser or a network.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const actions = vi.hoisted(() => ({
  getLaunchReadinessAction: vi.fn(),
  dismissCalendarNoticeAction: vi.fn(async () => ({ ok: true as const })),
  runLaunchIntentAction: vi.fn(async (_intent: string, _params?: unknown) => ({ ok: true as const, data: { ok: true, message: "Checks started." } })),
}));
vi.mock("@/app/actions/launch-readiness", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/setup" }));
vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a> }));

import { LaunchReadinessPanel, QUESTION_FOR_ITEM, questionnaireHref } from "@/components/setup/launch-readiness-panel";
import { AGENT_BY_KEY, AGENT_ROLE_KEYS } from "@/lib/agents";
import { QUESTION_BY_ID } from "@/lib/onboarding/definitions";
import { deriveLaunchReadiness, fingerprintOf, type EmployeeFact, type LaunchFacts, type LaunchItem, type LaunchReadiness, type LaunchState } from "@/lib/launch-readiness";

const employee = (role: (typeof AGENT_ROLE_KEYS)[number], over: Partial<EmployeeFact> = {}): EmployeeFact => ({
  role, entitled: true, provisioning: "succeeded", provisioningDetail: null, attempts: 1, maxAttempts: 3, nextRetryAt: null, healthFailed: false, healthDetail: null, heldForReview: false, configVersion: 3,
  readiness: { state: "ready", chatAvailable: true, workReady: true, description: "Ready.", blocking: [] }, ...over,
});
const notReady = { state: "pending_setup" as const, chatAvailable: false, workReady: false, description: "Not ready.", blocking: [] as string[] };
const inProgress = (role: (typeof AGENT_ROLE_KEYS)[number], over: Partial<EmployeeFact> = {}) => employee(role, { provisioning: "in_progress", readiness: notReady, ...over });

function facts(over: Partial<LaunchFacts> = {}): LaunchFacts {
  return {
    submitted: true, paymentCleared: true, canOpenBilling: true,
    profile: { companyName: true, industry: true, description: true, timezone: "America/Chicago", timezoneAnswered: true },
    knowledge: { approved: 3, pending: 0 },
    crm: { mode: "native", blueprint: "verified", pipelineReady: true, records: { state: "in_place", tags: 2, contactFields: 1, forms: 1 }, providerConnected: false },
    appointments: { wanted: false, calendar: null, externalCalendarConnected: false },
    channels: [],
    employees: AGENT_ROLE_KEYS.map((role) => employee(role)),
    verification: AGENT_ROLE_KEYS.map((role) => ({ role, state: "passed" as const, configVersion: 3, detail: null })),
    ...over,
  };
}
const profileMissing = { companyName: false, industry: true, description: true, timezone: "America/Chicago", timezoneAnswered: true };
const withHunter = (hunter: EmployeeFact) => AGENT_ROLE_KEYS.map((role) => (role === "lead_hunter" ? hunter : employee(role)));
const judge = (over: Partial<LaunchFacts> = {}) => deriveLaunchReadiness(facts(over));
const answer = (readiness: LaunchReadiness) => ({ readiness, fingerprint: fingerprintOf(readiness) });

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
});
beforeEach(() => {
  actions.getLaunchReadinessAction.mockReset();
  actions.getLaunchReadinessAction.mockImplementation(() => new Promise<never>(() => {}));
  actions.runLaunchIntentAction.mockClear();
  actions.dismissCalendarNoticeAction.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "onLine");
});

const sectionOf = (container: HTMLElement) => container.querySelector('section[aria-labelledby="launch-readiness-title"]') as HTMLElement;
const stepOf = (container: HTMLElement, key: string) => container.querySelector(`details[data-step="${key}"]`) as HTMLDetailsElement;
const itemOf = (container: HTMLElement, key: string) => container.querySelector(`li[data-item="${key}"]`) as HTMLElement;
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** A readiness made of the lines a test needs, for the cases the judge does not produce on its own (a stalled line, a provider link, a read-only view). */
function panelOf(items: LaunchItem[], state: LaunchState = "action_required"): LaunchReadiness {
  return {
    state, label: "Action required", headline: "Action required", detail: "One thing needs you.", percent: 50, passed: 1, total: 2, blocking: [],
    steps: [{ key: "calendar", title: "Calendar and availability", state: "action_required", summary: "0 of 2 checks passed.", items }],
  };
}
const line = (over: Partial<LaunchItem>): LaunchItem => ({ key: "x.line", label: "A line", state: "action_required", required: true, owner: "you", detail: "Detail.", ...over });

describe("the six states, from the judge's real output", () => {
  const CASES: Array<[string, LaunchFacts, LaunchState]> = [
    ["not started", facts({ submitted: false }), "not_started"],
    ["questionnaire submitted", facts({ paymentCleared: false }), "questionnaire_submitted"],
    ["provisioning", facts({ employees: withHunter(inProgress("lead_hunter")) }), "provisioning"],
    ["action required", facts({ profile: profileMissing }), "action_required"],
    ["ready for review", facts({ knowledge: { approved: 0, pending: 2 } }), "ready_for_review"],
    ["ready to launch", facts(), "ready_to_launch"],
  ];

  for (const [name, f, expected] of CASES) {
    it(`${name}: its label, its percent, its state, its progress bar, and every step that needs someone open`, () => {
      const readiness = deriveLaunchReadiness(f);
      expect(readiness.state).toBe(expected);
      const { container } = render(<LaunchReadinessPanel readiness={readiness} />);
      const section = sectionOf(container);
      expect(section.getAttribute("data-state")).toBe(expected);
      expect(within(section).getByRole("heading", { level: 2 }).textContent).toBe(readiness.headline);
      expect(section.textContent).toContain(readiness.label);
      expect(screen.getByText(`${readiness.percent}%`)).toBeTruthy();
      const bar = screen.getByRole("progressbar", { name: "Launch readiness" });
      expect(bar.getAttribute("aria-valuenow")).toBe(String(readiness.percent));
      expect(bar.getAttribute("aria-valuetext")).toBe(`${readiness.percent} percent, ${readiness.passed} of ${readiness.total} checks passed`);
      for (const step of readiness.steps) {
        const details = stepOf(container, step.key);
        expect(details.open, `${step.key} is ${step.state}`).toBe(step.state === "action_required" || step.state === "in_progress" || step.state === "awaiting_review");
      }
    });
  }

  it("shows a ready client as 100% and says nothing changes by itself, because it stops asking", () => {
    render(<LaunchReadinessPanel readiness={judge()} />);
    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.getByTestId("launch-updated").textContent).toContain("Nothing changes by itself from here");
  });
});

describe("accessibility", () => {
  it("puts no aria-label on the percent, which a paragraph does not expose, and says the number in words on the bar instead", () => {
    const { container } = render(<LaunchReadinessPanel readiness={judge({ profile: profileMissing })} />);
    const percent = screen.getByText(/^\d+%$/);
    expect(percent.tagName).toBe("P");
    expect(percent.hasAttribute("aria-label")).toBe(false);
    expect(container.querySelectorAll("p[aria-label]")).toHaveLength(0);
  });

  it("hides the browser's own marker on every summary (so Safari draws no second arrow) and gives each a visible focus ring", () => {
    const { container } = render(<LaunchReadinessPanel readiness={judge({ profile: profileMissing })} />);
    const summaries = Array.from(container.querySelectorAll("summary"));
    expect(summaries.length).toBeGreaterThanOrEqual(7);
    for (const s of summaries) {
      expect(s.className).toContain("[&::-webkit-details-marker]:hidden");
      expect(s.className).toContain("list-none");
      expect(s.className).toContain("focus-visible:outline-2");
    }
  });

  it("gives every action its own name: the action and the line it belongs to", () => {
    const f = facts({ verification: AGENT_ROLE_KEYS.map((role) => ({ role, state: "none" as const })) });
    render(<LaunchReadinessPanel readiness={deriveLaunchReadiness(f)} />);
    const buttons = screen.getAllByRole("button").filter((b) => /^Run final checks/.test(b.getAttribute("aria-label") ?? ""));
    // The Appointment Setter is not needed when the client books no appointments.
    expect(buttons).toHaveLength(AGENT_ROLE_KEYS.length - 1);
    const names = buttons.map((b) => b.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain(`Run final checks: ${AGENT_BY_KEY.lead_hunter.shortName}`);
    expect(screen.getByRole("button", { name: "Run final checks: Lead Hunter" })).toBeTruthy();
  });

  it("keeps a pressed button focusable and says it is busy with aria-disabled, so keyboard focus stays where it was and a second press does nothing", async () => {
    let finish!: () => void;
    actions.runLaunchIntentAction.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ ok: true as const, data: { ok: true, message: "Checks started." } }); }));
    const f = facts({ verification: AGENT_ROLE_KEYS.map((role) => ({ role, state: "none" as const })) });
    render(<LaunchReadinessPanel readiness={deriveLaunchReadiness(f)} />);
    const hunter = screen.getByRole("button", { name: "Run final checks: Lead Hunter" });
    const other = screen.getByRole("button", { name: "Run final checks: CRM Manager" });
    hunter.focus();
    fireEvent.click(hunter);
    await waitFor(() => expect(hunter.getAttribute("aria-disabled")).toBe("true"));
    expect(hunter.hasAttribute("disabled")).toBe(false);
    expect(other.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(hunter);
    fireEvent.click(hunter);
    fireEvent.click(other);
    expect(actions.runLaunchIntentAction).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    await waitFor(() => expect(hunter.hasAttribute("aria-disabled")).toBe(false));
  });

  it("keeps a step the person opened open while its state moves, and a step they closed closed only until it changes", async () => {
    vi.useFakeTimers();
    // The employees keep working, so the panel keeps asking; the profile step is what the person is reading.
    const done = judge({ employees: withHunter(inProgress("lead_hunter")) });
    const needsYou = judge({ employees: withHunter(inProgress("lead_hunter")), profile: profileMissing });
    const reads = [needsYou, done, needsYou];
    actions.getLaunchReadinessAction.mockImplementation(async () => answer(reads.shift() ?? done));
    const { container } = render(<LaunchReadinessPanel readiness={done} />);
    const profile = () => stepOf(container, "profile");
    expect(profile().open).toBe(false);
    // The person opens the finished step to read it.
    profile().open = true;
    fireEvent(profile(), new Event("toggle"));
    await tick(5_000);
    expect(profile().getAttribute("data-state")).toBe("action_required");
    await tick(5_000);
    // It is done again, which closes an unattended step; this one was opened by the person, so it stays.
    expect(profile().getAttribute("data-state")).toBe("done");
    expect(profile().open).toBe(true);
    // Another step: closed by the person while it needed them, it is forgotten the moment its state changes, so it opens again when it needs them.
    cleanup();
    reads.splice(0, reads.length, done, needsYou);
    const second = render(<LaunchReadinessPanel readiness={needsYou} />);
    const step = () => stepOf(second.container, "profile");
    expect(step().open).toBe(true);
    step().open = false;
    fireEvent(step(), new Event("toggle"));
    expect(step().open).toBe(false);
    await tick(5_000);
    expect(step().getAttribute("data-state")).toBe("done");
    await tick(5_000);
    expect(step().getAttribute("data-state")).toBe("action_required");
    expect(step().open).toBe(true);
  });
});

describe("running a step", () => {
  it("runs the step the button names, shows the result in the live region, and asks for the state again", async () => {
    const f = facts({ verification: AGENT_ROLE_KEYS.map((role) => ({ role, state: "none" as const })) });
    const readiness = deriveLaunchReadiness(f);
    actions.getLaunchReadinessAction.mockResolvedValue(answer(readiness));
    render(<LaunchReadinessPanel readiness={readiness} />);
    fireEvent.click(screen.getByRole("button", { name: "Run final checks: Lead Hunter" }));
    await waitFor(() => expect(actions.runLaunchIntentAction).toHaveBeenCalledTimes(1));
    expect(actions.runLaunchIntentAction).toHaveBeenCalledWith("run_checks", undefined);
    const region = await screen.findByRole("status");
    expect(region.textContent).toBe("Checks started.");
    await waitFor(() => expect(actions.getLaunchReadinessAction).toHaveBeenCalled());
  });

  it("shows a refusal from the server as a problem, not as success", async () => {
    actions.runLaunchIntentAction.mockResolvedValueOnce({ ok: false, error: "You can't do that." } as never);
    const f = facts({ verification: AGENT_ROLE_KEYS.map((role) => ({ role, state: "none" as const })) });
    render(<LaunchReadinessPanel readiness={deriveLaunchReadiness(f)} />);
    fireEvent.click(screen.getByRole("button", { name: "Run final checks: Lead Hunter" }));
    const region = await screen.findByText("You can't do that.");
    expect(region.className).toContain("text-warning-ink");
  });

  it("sends the person who has only a link to the screen where it is done, and a questionnaire link comes back to Setup", () => {
    // The company time zone is not answered: its link opens exactly that question and returns to Setup.
    const { container } = render(<LaunchReadinessPanel readiness={judge({ profile: { ...profileMissing, companyName: true, timezoneAnswered: false } })} />);
    const link = within(itemOf(container, "profile.timezone")).getByRole("link", { name: "Confirm time zone: Business time zone" });
    expect(link.getAttribute("href")).toBe("/onboarding?question=a.timezone&return=/setup");
    // A line with no question of its own opens the questionnaire where it was left, still with a way back.
    expect(questionnaireHref("profile.company")).toBe("/onboarding?return=/setup");
  });

  it("knows only questions the questionnaire really has", () => {
    for (const [key, question] of Object.entries(QUESTION_FOR_ITEM)) {
      expect(QUESTION_BY_ID[question], `${key} -> ${question}`).toBeTruthy();
      expect(questionnaireHref(key)).toBe(`/onboarding?question=${question}&return=/setup`);
    }
  });

  it("renders a link to a page as an app link and a provider sign-in as a plain link that says where it goes and that the person comes back", () => {
    const readiness = panelOf([
      line({ key: "calendar.connection", label: "Google connection", action: { label: "Connect Google", href: "/api/crm/calendar-oauth/google/start?return=/setup" } }),
      line({ key: "calendar.types", label: "Appointment types", action: { label: "Open Calendars & Types", href: "/crm/calendars/abc" } }),
    ]);
    render(<LaunchReadinessPanel readiness={readiness} />);
    const signIn = screen.getByRole("link", { name: "Connect Google: Google connection" });
    expect(signIn.getAttribute("href")).toBe("/api/crm/calendar-oauth/google/start?return=/setup");
    const hint = document.getElementById(signIn.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toBe("This opens Google. You come back here afterwards.");
    const page = screen.getByRole("link", { name: "Open Calendars & Types: Appointment types" });
    expect(page.getAttribute("href")).toBe("/crm/calendars/abc");
    expect(page.getAttribute("aria-describedby")).toBeNull();
  });

  it("runs nothing in the design preview, and says so", () => {
    vi.useFakeTimers();
    const f = facts({ verification: AGENT_ROLE_KEYS.map((role) => ({ role, state: "none" as const })), employees: withHunter(inProgress("lead_hunter")) });
    render(<LaunchReadinessPanel readiness={deriveLaunchReadiness(f)} preview />);
    fireEvent.click(screen.getByRole("button", { name: "Run final checks: CRM Manager" }));
    expect(screen.getByRole("status").textContent).toBe("Design preview: nothing runs here.");
    expect(actions.runLaunchIntentAction).not.toHaveBeenCalled();
  });

  it("does not ask the server anything in the design preview, however long it stays open (the same in-progress fixture polls when it is the person's own panel)", async () => {
    vi.useFakeTimers();
    const readiness = deriveLaunchReadiness(facts({ employees: withHunter(inProgress("lead_hunter")) }));
    const { unmount } = render(<LaunchReadinessPanel readiness={readiness} preview />);
    await tick(60_000);
    window.dispatchEvent(new Event("focus"));
    await tick(60_000);
    expect(actions.getLaunchReadinessAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId("launch-updated")).toBeNull();
    unmount();
    // The control: the same readiness, not a preview, does ask.
    render(<LaunchReadinessPanel readiness={readiness} />);
    await tick(60_000);
    expect(actions.getLaunchReadinessAction).toHaveBeenCalled();
  });
});

describe("a line that is not required", () => {
  it("never reads as 'Action required': it says it is the person's choice", () => {
    const readiness = panelOf([line({ key: "crm.region", label: "Currency and phone country", required: false, detail: "It does not hold up launch.", action: { label: "Use USD and +1", intent: "confirm_region_defaults" } })]);
    const { container } = render(<LaunchReadinessPanel readiness={readiness} />);
    const row = itemOf(container, "crm.region");
    expect(row.textContent).toContain("Optional, your choice");
    expect(row.textContent).not.toContain("Action required");
  });

  it("marks a line that is stalled", () => {
    const readiness = panelOf([line({ key: "employees.lead_hunter", label: "Lead Hunter", state: "action_required", owner: "iacquire", stalled: true, detail: "Taking long." })]);
    const { container } = render(<LaunchReadinessPanel readiness={readiness} />);
    expect(itemOf(container, "employees.lead_hunter").textContent).toContain("Taking longer than expected");
    expect(itemOf(container, "employees.lead_hunter").textContent).toContain("Next move: iAcquire");
  });

  it("says an automatic line needs nothing from the person", () => {
    const readiness = panelOf([line({ key: "employees.lead_hunter", label: "Lead Hunter", state: "in_progress", owner: "system", detail: "Working." })]);
    const { container } = render(<LaunchReadinessPanel readiness={readiness} />);
    expect(itemOf(container, "employees.lead_hunter").textContent).toContain("Next move: Automatic, nothing needed from you");
  });
});

describe("each employee's stages", () => {
  it("draws the five stages in words, with what has happened and what has not been reached", () => {
    const hunter = employee("lead_hunter", { provisioning: "requested", readiness: notReady });
    const { container } = render(<LaunchReadinessPanel readiness={judge({ employees: withHunter(hunter) })} />);
    const stages = within(itemOf(container, "employees.lead_hunter")).getByRole("list", { name: "Lead Hunter setup stages" });
    const items = within(stages).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-stage"))).toEqual(["queued", "profile", "verified", "tools", "ready"]);
    expect(items[0].textContent).toBe("Queued: Done");
    expect(items[1].textContent).toBe("Profile created: Waiting");
    expect(items[4].textContent).toBe("Ready for work: Waiting");
    // A queued job is not a created profile: the second stage does not read as done.
    expect(items[1].getAttribute("data-state")).not.toBe("done");
  });

  it("says a profile that failed has failed, and a role that is not part of the plan has no stages", () => {
    const failed = employee("lead_hunter", { provisioning: "failed", attempts: 3, readiness: notReady });
    const notEntitled = employee("sales_assistant", { entitled: false, provisioning: "none", readiness: notReady });
    const { container } = render(<LaunchReadinessPanel readiness={judge({ employees: AGENT_ROLE_KEYS.map((role) => (role === "lead_hunter" ? failed : role === "sales_assistant" ? notEntitled : employee(role))) })} />);
    const stages = within(itemOf(container, "employees.lead_hunter")).getByRole("list", { name: "Lead Hunter setup stages" });
    expect(within(stages).getAllByRole("listitem")[1].textContent).toBe("Profile created: Failed");
    expect(within(itemOf(container, "employees.sales_assistant")).queryByRole("list", { name: /setup stages/ })).toBeNull();
  });
});

describe("the customer-facing switches", () => {
  const controls = [
    { key: "booking.page", label: "Public booking page", on: false, wanted: true, href: "/crm/calendars" },
    { key: "channel.sms", label: "SMS", on: false, wanted: false, href: "/settings/messaging" },
    { key: "channel.email", label: "Email", on: true, wanted: true, href: "/settings/messaging" },
  ];

  it("lists each one with 'Off until you turn it on' and a link to where it is flipped, and nothing on the card is a button", () => {
    const readiness = judge({ launchControls: controls });
    const { container } = render(<LaunchReadinessPanel readiness={readiness} />);
    const card = container.querySelector('section[aria-labelledby="launch-controls-title"]') as HTMLElement;
    expect(within(card).getAllByRole("listitem")).toHaveLength(3);
    expect(within(card).getAllByText("Off until you turn it on")).toHaveLength(2);
    expect(within(card).getByText("On")).toBeTruthy();
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
    expect(within(card).getByRole("link", { name: "Open Public booking page" }).getAttribute("href")).toBe("/crm/calendars");
    expect(within(card).getByRole("link", { name: "Open SMS" }).getAttribute("href")).toBe("/settings/messaging");
  });

  it("never moves the percentage or the checks", () => {
    const without = judge();
    const withControls = judge({ launchControls: controls });
    expect(withControls.percent).toBe(without.percent);
    expect(withControls.passed).toBe(without.passed);
    expect(withControls.total).toBe(without.total);
    expect(withControls.controls?.every((c) => c.required === false)).toBe(true);
  });

  it("shows nothing when the facts carried no switches", () => {
    const { container } = render(<LaunchReadinessPanel readiness={judge()} />);
    expect(container.querySelector('section[aria-labelledby="launch-controls-title"]')).toBeNull();
  });
});

describe("what the staff see", () => {
  it("hides every button that runs a step and the host picker, and keeps only iAcquire's own links", () => {
    const readiness = panelOf([
      line({ key: "calendar.host", label: "Host", action: { label: "Make me the host", intent: "assign_host" }, hostChoices: [{ id: "11111111-1111-4111-8111-111111111111", name: "Dana Reyes" }] }),
      line({ key: "calendar.types", label: "Appointment types", action: { label: "Open Calendars & Types", href: "/crm/calendars/abc" } }),
      line({ key: "employees.lead_hunter", label: "Lead Hunter", action: { label: "Open provisioning", href: "/admin/clients/c1/provisioning" } }),
    ]);
    const { container } = render(<LaunchReadinessPanel readiness={readiness} audience="agency" />);
    expect(sectionOf(container).getAttribute("data-audience")).toBe("agency");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByLabelText("Choose who takes appointments")).toBeNull();
    expect(screen.queryByRole("link", { name: /Open Calendars & Types/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Open provisioning: Lead Hunter" }).getAttribute("href")).toBe("/admin/clients/c1/provisioning");
  });

  it("shows the switches read-only, and does not ask the server about a workspace that is not theirs", async () => {
    vi.useFakeTimers();
    const readiness = judge({ launchControls: [{ key: "booking.page", label: "Public booking page", on: false, wanted: true, href: "/crm/calendars" }], employees: withHunter(inProgress("lead_hunter")) });
    const { container } = render(<LaunchReadinessPanel readiness={readiness} audience="agency" />);
    const card = container.querySelector('section[aria-labelledby="launch-controls-title"]') as HTMLElement;
    expect(within(card).getByText("Off until you turn it on")).toBeTruthy();
    expect(within(card).queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByTestId("launch-updated")).toBeNull();
    await tick(10 * 60_000);
    window.dispatchEvent(new Event("focus"));
    expect(actions.getLaunchReadinessAction).not.toHaveBeenCalled();
  });
});

describe("keeping itself current", () => {
  it("polls while something is running, shows the new state without a page reload, and stops at 100%", async () => {
    vi.useFakeTimers();
    const before = judge({ profile: profileMissing, employees: withHunter(inProgress("lead_hunter")) });
    const after = judge();
    actions.getLaunchReadinessAction.mockResolvedValue(answer(after));
    const { container } = render(<LaunchReadinessPanel readiness={before} />);
    expect(sectionOf(container).getAttribute("data-state")).toBe("action_required");
    await tick(4_999);
    expect(actions.getLaunchReadinessAction).not.toHaveBeenCalled();
    await tick(1);
    expect(actions.getLaunchReadinessAction).toHaveBeenCalledTimes(1);
    expect(sectionOf(container).getAttribute("data-state")).toBe("ready_to_launch");
    expect(screen.getByText("100%")).toBeTruthy();
    await tick(10 * 60_000);
    expect(actions.getLaunchReadinessAction).toHaveBeenCalledTimes(1);
  });

  it("shows how long ago it was read, counting up between reads", async () => {
    vi.useFakeTimers();
    const readiness = judge({ profile: profileMissing });
    actions.getLaunchReadinessAction.mockResolvedValue(answer(readiness));
    render(<LaunchReadinessPanel readiness={readiness} />);
    expect(screen.getByTestId("launch-updated").textContent).toBe("Updated just now");
    await tick(12_000);
    expect(screen.getByTestId("launch-updated").textContent).toBe("Updated 12 s ago");
  });

  it("asks again when the tab regains focus", async () => {
    vi.useFakeTimers();
    const readiness = judge({ profile: profileMissing });
    actions.getLaunchReadinessAction.mockResolvedValue(answer(readiness));
    render(<LaunchReadinessPanel readiness={readiness} />);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(actions.getLaunchReadinessAction).toHaveBeenCalledTimes(1);
  });

  it("says when it could not refresh and when the browser is offline, and keeps showing what it last read", async () => {
    vi.useFakeTimers();
    const readiness = judge({ employees: withHunter(inProgress("lead_hunter")) });
    actions.getLaunchReadinessAction.mockRejectedValue(new Error("down"));
    const { container } = render(<LaunchReadinessPanel readiness={readiness} />);
    expect(screen.queryByTestId("launch-connection")).toBeNull();
    await tick(5_000);
    expect(screen.getByTestId("launch-connection").textContent).toContain("couldn't refresh just now");
    expect(sectionOf(container).getAttribute("data-state")).toBe("provisioning");
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    act(() => { window.dispatchEvent(new Event("offline")); });
    expect(screen.getByTestId("launch-connection").textContent).toContain("You appear to be offline");
  });

  it("announces a change of state out loud, and only a change of state", async () => {
    vi.useFakeTimers();
    const first = judge({ profile: profileMissing, employees: withHunter(inProgress("lead_hunter")) });
    const reworded: LaunchReadiness = { ...first, steps: first.steps.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i, detail: `${i.detail} (reworded)` })) })) };
    const changed = judge({ employees: withHunter(inProgress("lead_hunter")) });
    const reads = [reworded, changed];
    actions.getLaunchReadinessAction.mockImplementation(async () => answer(reads.shift() ?? changed));
    render(<LaunchReadinessPanel readiness={first} />);
    const region = screen.getByTestId("launch-announcement");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
    // Only the wording changed: the screen updates, nothing is announced.
    await tick(5_000);
    expect(region.textContent).toBe("");
    expect(screen.getAllByText(/\(reworded\)/).length).toBeGreaterThan(0);
    // The client has nothing left to do and the setup is still running: announced.
    await tick(5_000);
    expect(region.textContent).toMatch(/^Launch readiness \d+ percent\. Provisioning\.$/);
  });
});

describe("when the page could not read the launch status", () => {
  it("says so in an alert with a way to try again, and claims nothing", () => {
    render(<LaunchReadinessPanel readiness={null} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("We couldn't read your launch status just now");
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("shows the panel once the retry reads the state", async () => {
    const readiness = judge({ profile: profileMissing });
    actions.getLaunchReadinessAction.mockResolvedValue(answer(readiness));
    const { container } = render(<LaunchReadinessPanel readiness={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sectionOf(container)).toBeTruthy());
    expect(sectionOf(container).getAttribute("data-state")).toBe("action_required");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says it tried again and still could not, and the button is busy (not disabled) while it tries", async () => {
    let fail!: (e: Error) => void;
    actions.getLaunchReadinessAction.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    render(<LaunchReadinessPanel readiness={null} />);
    const retry = screen.getByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(retry.getAttribute("aria-disabled")).toBe("true"));
    expect(retry.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    expect(actions.getLaunchReadinessAction).toHaveBeenCalledTimes(1);
    await act(async () => { fail(new Error("down")); });
    expect(screen.getByRole("alert").textContent).toContain("still couldn't read it");
    expect(retry.hasAttribute("aria-disabled")).toBe(false);
  });
});
