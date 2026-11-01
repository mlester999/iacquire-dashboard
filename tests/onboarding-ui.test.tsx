// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdaptiveOnboarding, OutcomeNotesList } from "@/components/onboarding/adaptive-onboarding";
import { AiPrefsForm, ProfileForms, TeamManager } from "@/components/settings/settings-forms";
import { OnboardingApiProvider, type OnboardingApi } from "@/components/onboarding/onboarding-api";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { buildReviewModel, computeProgress, planScope, type ConnectionFacts } from "@/lib/onboarding/engine";
import type { StoredAnswers, AnswerValue } from "@/lib/onboarding/types";
import type { OnboardingSession, Suggestion } from "@/server/onboarding/service";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/app/actions/onboarding", () => ({}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
// The Settings screens call their server actions through these; each test says what they answer.
const settingsActions = vi.hoisted(() => ({
  teamSuggestionsAction: vi.fn(), inviteMemberAction: vi.fn(), previewAiPreferencesApplyAction: vi.fn(), updateAiPreferencesAction: vi.fn(), updateProfileAction: vi.fn(), revokeMemberAction: vi.fn(),
}));
vi.mock("@/app/actions/settings", () => ({
  ...settingsActions,
  changePasswordAction: vi.fn(), changeRoleAction: vi.fn(), listSessionsAction: vi.fn(), revokeInviteAction: vi.fn(), revokeSessionAction: vi.fn(),
  saveNotificationPrefsAction: vi.fn(), updateUserProfileAction: vi.fn(),
}));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const row = (value: AnswerValue) => ({ value, source: "user" as const, skipped: false, needsConfirmation: false, updatedAt: "2026-10-21T04:00:00Z" });
const facts: ConnectionFacts = { crmLinked: false, aiEmployeesVerified: 0, aiEmployeesTotal: 6, automationMapped: false, channels: { sms: { enabled: false, registration: "not_started" }, whatsapp: { enabled: false, registration: "not_started" }, email: { enabled: false, registration: "not_started" } }, calendarConnected: false, websiteDomainVerified: false, invitedStaff: 0 };
const draft: Suggestion = { questionId: "a.description", value: "Marko Bar is a real estate business.", reason: "Based on your answers.", basis: "your_answers", source: "ai_suggestion", needsConfirmation: false, limited: true, clarifications: [{ fieldId: "b.services", label: "What services do you primarily provide?", example: "Examples only: property sales or rentals" }] };

function setup(current = "a.description", extra: StoredAnswers = {}, enabledRoles: AgentRoleKey[] = []) {
  const answers = { "a.business_name": row("Marko Bar"), "a.industry": row("real_estate"), "a.business_model": row("mixed"), ...extra };
  const session: OnboardingSession = { questionnaireVersion: 2, status: "draft", revision: 1, currentQuestionId: current, answers, progress: computeProgress(answers, planScope(enabledRoles)), completedAt: null, submittedAt: null, hasUnsubmittedChanges: false, enabledRoles, websiteAnalysis: null };
  let revision = 1;
  const api = {
    save: vi.fn<OnboardingApi["save"]>().mockImplementation(async () => ({ ok: true, data: { revision: ++revision, rejected: {}, staleBase: false } })),
    suggest: vi.fn<OnboardingApi["suggest"]>().mockResolvedValue({ ok: true, data: draft }),
    review: vi.fn<OnboardingApi["review"]>().mockResolvedValue({ ok: true, data: { ...buildReviewModel(answers, facts, enabledRoles, planScope(enabledRoles)), ...(current === "f.review" ? { blockers: [] } : {}) } }),
    submit: vi.fn<OnboardingApi["submit"]>().mockResolvedValue({ ok: true, data: {} }),
    readWebsite: vi.fn(), uploadImage: vi.fn(), uploadDocument: vi.fn(), removeAsset: vi.fn(), setAssetVariant: vi.fn(),
  } satisfies OnboardingApi;
  const exit = vi.fn();
  const done = vi.fn();
  const view = render(<OnboardingApiProvider value={api}><div id="onboarding-header-actions" /><AdaptiveOnboarding session={session} assets={[]} documents={[]} onExit={exit} onSubmitted={done} /></OnboardingApiProvider>);
  return { api, exit, done, view };
}
const input = () => document.getElementById("onboarding-input") as HTMLTextAreaElement;
const generate = async () => { fireEvent.click(screen.getByRole("button", { name: "Suggest with AI" })); return screen.findByRole("region", { name: "AI suggestion preview" }); };

describe("premium onboarding interaction", () => {
  it("has one header Save & exit and exactly two same-row navigation actions", () => {
    setup();
    expect(screen.getAllByRole("button", { name: "Save & exit" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Save & exit" }).closest("#onboarding-header-actions")).not.toBeNull();
    expect(screen.queryByText("Finish later")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Question navigation" });
    expect(within(nav).getAllByRole("button").map((button) => button.textContent)).toEqual([" Back", "Continue"]);
    expect(within(nav).queryByText(/Save|Skip/)).toBeNull();
  });

  it("retains six adaptive sections and keeps the welcome introduction off subsequent questions", () => {
    setup();
    const progress = screen.getByLabelText("Setup sections");
    expect(within(progress).getAllByRole("button")).toHaveLength(6);
    expect(within(progress).getByRole("button", { name: /Business/ }).getAttribute("aria-current")).toBe("step");
    expect(within(progress).getAllByRole("button").map((button) => button.querySelector(".onboarding-stage-label")?.textContent)).toEqual(["Business", "Goals", "Voice", "Sales", "Knowledge", "Review"]);
    // Named from its own words (not an aria-label that would replace what is drawn: WCAG label-in-name), with the state said once.
    expect(within(progress).getAllByRole("button").every((button) => !button.hasAttribute("aria-label"))).toBe(true);
    expect(within(progress).getByRole("button", { name: /^Business: current section, (in progress|not started), \d+ of \d+ answered$/ })).toBeTruthy();
    expect(screen.queryByText("Let's set up your workspace.")).toBeNull();
    expect(screen.getByRole("progressbar", { name: "Setup progress" }).getAttribute("aria-valuenow")).not.toBeNull();
  });

  it("puts section, position, progress and save state in one navy panel without repeating the question count", () => {
    setup();
    const panel = screen.getByRole("region", { name: "Business profile" });
    expect(panel.classList.contains("onboarding-stages")).toBe(true);
    expect(within(panel).getByText(/^Question \d+ of \d+$/)).toBeTruthy();
    expect(screen.getAllByText(/^Question \d+ of \d+$/)).toHaveLength(1);
    expect(within(panel).getByRole("status").textContent).toContain("Saved as you go");
    expect(within(panel).getByRole("progressbar", { name: "Setup progress" })).toBeTruthy();
    expect(screen.queryByText(/A · Business profile/)).toBeNull();
    expect(screen.getByText("See an example").closest("details")?.open).toBe(false);
  });

  it("skips a question that belongs to an employee the plan leaves out, and asks it on the full plan", async () => {
    const withoutHunter = AGENT_ROLE_KEYS.filter((r) => r !== "lead_hunter");
    const narrow = setup("b.ideal_customer", {}, withoutHunter);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "What services or offers do you sell?" });
    expect(screen.queryByRole("heading", { name: /worth a conversation/ })).toBeNull();
    expect(narrow.api.save.mock.calls.length).toBeLessThanOrEqual(1);
    cleanup();
    setup("b.ideal_customer", {}, [...AGENT_ROLE_KEYS]);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "What makes a lead worth a conversation with your team?" });
  });

  it("counts fewer questions for a plan that leaves an employee out", () => {
    setup("a.business_name", {}, [...AGENT_ROLE_KEYS]);
    const full = Number(screen.getByText(/^Question \d+ of \d+$/).textContent?.match(/of (\d+)/)?.[1]);
    cleanup();
    setup("a.business_name", {}, AGENT_ROLE_KEYS.filter((r) => r !== "lead_hunter" && r !== "performance_analyst"));
    expect(Number(screen.getByText(/^Question \d+ of \d+$/).textContent?.match(/of (\d+)/)?.[1])).toBe(full - 2);
  });

  it("calls opening hours required once replies are limited to them, and optional otherwise", () => {
    setup("a.hours", { "c.response_hours": row("business_hours") });
    expect(screen.getByText("Required")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
    cleanup();
    setup("a.hours", { "c.response_hours": row("always") });
    expect(screen.getByText("Optional")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeTruthy();
  });

  it("will not move past the opening hours while a business-hours-only preference has none", () => {
    const { api } = setup("a.hours", { "c.response_hours": row("business_hours") });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert").textContent).toContain("required");
    expect(api.save).not.toHaveBeenCalled();
  });

  it("validates required answers before advancing", () => {
    const { api } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert").textContent).toContain("required");
    expect(api.save).not.toHaveBeenCalled();
  });

  it("waits for persistence, prevents duplicate navigation and moves to the correct next question", async () => {
    const { api } = setup();
    let release!: (result: Awaited<ReturnType<OnboardingApi["save"]>>) => void;
    api.save.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    fireEvent.change(input(), { target: { value: "We manage rental properties." } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Tell us");
    release({ ok: true, data: { revision: 2, rejected: {}, staleBase: false } });
    await screen.findByRole("heading", { name: "Where can we find you online?" });
    expect(api.save.mock.calls[0][0]).toMatchObject({ currentQuestionId: "a.website", answers: { "a.description": { value: "We manage rental properties." } } });
  });

  it("persists the current answer and exact resume position before exiting", async () => {
    const { api, exit } = setup();
    fireEvent.change(input(), { target: { value: "Keep this saved draft." } });
    fireEvent.click(screen.getByRole("button", { name: "Save & exit" }));
    await waitFor(() => expect(exit).toHaveBeenCalledOnce());
    expect(api.save.mock.calls[0][0]).toMatchObject({ currentQuestionId: "a.description", answers: { "a.description": { value: "Keep this saved draft." } } });
  });

  it("preserves pending edits and blocks exit on failed persistence", async () => {
    const { api, exit } = setup();
    api.save.mockResolvedValue({ ok: false, error: "Offline" });
    fireEvent.change(input(), { target: { value: "Unsaved text stays here." } });
    fireEvent.click(screen.getByRole("button", { name: "Save & exit" }));
    await screen.findByText("Not saved");
    expect(exit).not.toHaveBeenCalled();
    expect(input().value).toBe("Unsaved text stays here.");
  });

  it("does not lose an invalid local edit on exit", async () => {
    const { exit } = setup("a.contact_email", { "a.contact_email": row("old@example.test") });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "half-typed@" } });
    fireEvent.click(screen.getByRole("button", { name: "Save & exit" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/email/));
    expect(exit).not.toHaveBeenCalled();
  });

  it("shows Saved only after the actual write succeeds", async () => {
    const { api } = setup();
    let release!: (result: Awaited<ReturnType<OnboardingApi["save"]>>) => void;
    api.save.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    fireEvent.change(input(), { target: { value: "A business description." } });
    fireEvent.click(screen.getByRole("button", { name: "Save & exit" }));
    await screen.findByText("Saving…");
    expect(screen.queryByText(/^Saved$/)).toBeNull();
    release({ ok: true, data: { revision: 2, rejected: {}, staleBase: false } });
    await screen.findByText(/^Saved$/);
  });

  it("preserves original text while a generated preview is edited and dismissed", async () => {
    setup("a.description", { "a.description": row("My original wording.") });
    const preview = await generate();
    expect(input().value).toBe("My original wording.");
    fireEvent.click(within(preview).getByRole("button", { name: "Edit suggestion" }));
    fireEvent.change(within(preview).getByRole("textbox", { name: "Tell us what your business does." }), { target: { value: "An edited AI draft." } });
    expect(input().value).toBe("My original wording.");
    fireEvent.click(within(preview).getByRole("button", { name: "Dismiss suggestion" }));
    expect(screen.queryByRole("region", { name: "AI suggestion preview" })).toBeNull();
    expect(input().value).toBe("My original wording.");
  });

  it("accepts an edited draft only on explicit Use suggestion", async () => {
    const { api } = setup();
    const preview = await generate();
    fireEvent.click(within(preview).getByRole("button", { name: "Edit suggestion" }));
    fireEvent.change(within(preview).getByRole("textbox", { name: "Tell us what your business does." }), { target: { value: "My reviewed description." } });
    fireEvent.click(within(preview).getByRole("button", { name: "Use suggestion" }));
    expect(input().value).toBe("My reviewed description.");
    fireEvent.click(screen.getByRole("button", { name: "Save & exit" }));
    await waitFor(() => expect(api.save).toHaveBeenCalled());
    expect(api.save.mock.calls[0][0].answers["a.description"]).toMatchObject({ value: "My reviewed description.", source: "ai_suggestion" });
  });

  it("supports optional clarification and explicit regeneration without auto-saving new facts", async () => {
    const { api } = setup();
    const preview = await generate();
    fireEvent.click(within(preview).getByText("Add detail (optional)"));
    fireEvent.change(within(preview).getByRole("textbox", { name: "What services do you primarily provide?" }), { target: { value: "Property management" } });
    fireEvent.click(within(preview).getByRole("button", { name: "Improve draft" }));
    await waitFor(() => expect(api.suggest).toHaveBeenCalledTimes(2));
    expect(api.suggest.mock.calls[1][1]).toEqual({ regenerate: true, clarifications: { "b.services": "Property management" } });
    expect(input().value).toBe("");
    expect(api.save).not.toHaveBeenCalled();
  });

  it("does not request AI against unsaved/rejected answers", async () => {
    const { api } = setup();
    api.save.mockResolvedValue({ ok: false, error: "Offline" });
    fireEvent.change(input(), { target: { value: "Unsaved description" } });
    fireEvent.click(screen.getByRole("button", { name: "Suggest with AI" }));
    await screen.findByText(/Save or correct your latest edits/);
    expect(api.suggest).not.toHaveBeenCalled();
  });

  it("cancels requests and ignores late output after the owner edits their answer", async () => {
    const { api } = setup();
    let release!: (result: Awaited<ReturnType<OnboardingApi["suggest"]>>) => void;
    api.suggest.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Suggest with AI" }));
    await waitFor(() => expect(api.suggest).toHaveBeenCalled());
    fireEvent.change(input(), { target: { value: "Newer owner wording." } });
    expect(api.suggest.mock.calls[0][2]?.aborted).toBe(true);
    release({ ok: true, data: draft });
    await waitFor(() => expect(screen.queryByRole("region", { name: "AI suggestion preview" })).toBeNull());
    expect(input().value).toBe("Newer owner wording.");
  });

  it("shows an actionable recoverable provider error", async () => {
    const { api } = setup();
    api.suggest.mockResolvedValue({ ok: false, error: "Ask your administrator to check Integrations." });
    fireEvent.click(screen.getByRole("button", { name: "Suggest with AI" }));
    await screen.findByText("Ask your administrator to check Integrations.");
    expect(screen.getByRole("button", { name: "Suggest with AI" }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps AI policy wording unconfirmed until the owner checks it", async () => {
    const { api } = setup("d.handoff_rules");
    api.suggest.mockResolvedValue({ ok: true, data: { ...draft, questionId: "d.handoff_rules", value: "Hand complaints to a person.", needsConfirmation: true, clarifications: [] } });
    const preview = await generate();
    fireEvent.click(within(preview).getByRole("button", { name: "Use suggestion" }));
    expect(screen.getByText(/before it can become approved policy/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "I've checked this" }));
    expect(screen.queryByText(/before it can become approved policy/)).toBeNull();
  });

  it("uses the final approval action and prevents duplicate completion", async () => {
    const { api, done } = setup("f.review", { "f.review": row(true) });
    api.review.mockResolvedValue({ ok: true, data: { ...buildReviewModel({}, facts, []), blockers: [] } });
    const approve = await screen.findByRole("button", { name: "Approve setup" });
    await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(false));
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    fireEvent.click(approve);
    fireEvent.click(approve);
    await waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(api.submit).toHaveBeenCalledOnce();
  });

  const approveWith = async (scheduling?: unknown, notes?: Array<{ key: string; message: string }>) => {
    const { api, done } = setup("f.review", { "f.review": row(true) });
    api.review.mockResolvedValue({ ok: true, data: { ...buildReviewModel({}, facts, []), blockers: [] } });
    api.submit.mockResolvedValue({ ok: true, data: { ...(scheduling ? { scheduling } : {}), ...(notes ? { notes } : {}) } as never });
    const approve = await screen.findByRole("button", { name: "Approve setup" });
    await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(false));
    fireEvent.click(approve);
    await waitFor(() => expect(done).toHaveBeenCalledOnce());
  };

  it("says out loud that a booking calendar was drafted from the answers, and that it is not live", async () => {
    const { toast } = await import("sonner");
    await approveWith({ state: "created", typesAdded: 2, skipped: [] });
    expect(toast.success).toHaveBeenCalledWith("Your AI team is being prepared.", expect.objectContaining({ description: expect.stringMatching(/drafted a booking calendar with 2 appointment types.*takes no bookings until you assign a host and activate it/) }));
  });

  it("says nothing about a calendar when none was drafted or the draft was skipped", async () => {
    const { toast } = await import("sonner");
    await approveWith({ state: "skipped", reason: "You already have a calendar.", typesAdded: 0, skipped: [] });
    expect(toast.success).toHaveBeenCalledWith("Your AI team is being prepared.");
  });

  it("lists what a re-submission kept, held, skipped or left unchanged after the calendar sentence", async () => {
    const { toast } = await import("sonner");
    const notes = [
      { key: "knowledge.kept", message: "We kept your own wording in Policies." },
      { key: "employees.held", message: "2 employee updates are waiting for iAcquire's review. Until then, those employees keep the setup already approved." },
      { key: "scheduling.drift", message: "Free inspection: your answers now say a 15-minute gap after appointments, your live calendar has no gap after appointments. Your live calendar was not changed: update it in Calendars & Types." },
    ];
    await approveWith({ state: "unchanged", typesAdded: 0, skipped: [], host: { choice: "owner", state: "assigned" } }, notes);
    const call = vi.mocked(toast.success).mock.calls.at(-1)!;
    expect(call[0]).toBe("Your AI team is being prepared.");
    const view = render(<>{(call[1] as { description: React.ReactNode }).description}</>);
    const list = view.getByTestId("outcome-notes");
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(notes.map((n) => n.message));
    expect(list.textContent).toMatch(/You are now the host of this calendar/);
    // A held update is said as waiting, never as applied.
    expect(within(list).getByText(/waiting for iAcquire's review/)).toBeTruthy();
  });

  it("keeps the earlier toast when a submission has no notes", async () => {
    const { toast } = await import("sonner");
    await approveWith({ state: "created", typesAdded: 2, skipped: [] }, []);
    const call = vi.mocked(toast.success).mock.calls.at(-1)!;
    expect(typeof (call[1] as { description: unknown }).description).toBe("string");
  });

  it("OutcomeNotesList draws one line per note, and only the calendar sentence when there are none", () => {
    const view = render(<OutcomeNotesList drafted="A calendar sentence." notes={[{ key: "a", message: "First." }, { key: "b", message: "Second." }]} />);
    expect(within(view.getByTestId("outcome-notes")).getAllByRole("listitem")).toHaveLength(2);
    view.unmount();
    const bare = render(<OutcomeNotesList notes={[{ message: "Only." }]} />);
    expect(bare.getByText("Only.")).toBeTruthy();
    expect(bare.queryByText("A calendar sentence.")).toBeNull();
  });
});

describe("Settings > Team: suggested from your setup", () => {
  const person = (over: Record<string, unknown> = {}) => ({ name: "Ann Rep", email: "ann@team.test", role: "sales_rep", hosts: true, canInvite: true, ...over });
  const mount = (canManage = true) => render(<TeamManager members={[]} invites={[]} myRole="owner" myId="u1" canManage={canManage} />);

  it("lists the people named in setup and invites one with the same action as any invitation", async () => {
    settingsActions.teamSuggestionsAction.mockResolvedValue({ ok: true, data: [person(), person({ name: "Bo Support", email: "bo@team.test", role: "support", hosts: false })] });
    settingsActions.inviteMemberAction.mockResolvedValue({ ok: true });
    mount();
    const list = await screen.findByRole("list", { name: "Suggested from your setup" });
    expect(screen.getByText("Suggested from your setup")).toBeTruthy();
    expect(within(list).getByText("ann@team.test")).toBeTruthy();
    expect(within(list).getByText("Takes appointments")).toBeTruthy();
    expect(screen.getByText(/Nothing is sent until you press Invite/)).toBeTruthy();
    expect(settingsActions.inviteMemberAction).not.toHaveBeenCalled();

    fireEvent.click(within(list).getAllByRole("button", { name: "Invite" })[0]);
    await waitFor(() => expect(settingsActions.inviteMemberAction).toHaveBeenCalledWith("ann@team.test", "sales_rep"));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Suggested from your setup" })).queryByText("ann@team.test")).toBeNull());
    expect(within(screen.getByRole("list", { name: "Suggested from your setup" })).getByText("bo@team.test")).toBeTruthy();
  });

  it("keeps a person in the list when the invitation fails, and invites everyone with one press", async () => {
    settingsActions.teamSuggestionsAction.mockResolvedValue({ ok: true, data: [person(), person({ name: "Bo Support", email: "bo@team.test", role: "support", hosts: false })] });
    settingsActions.inviteMemberAction.mockResolvedValueOnce({ ok: false, error: "That person is already on your team." });
    mount();
    const list = await screen.findByRole("list", { name: "Suggested from your setup" });
    fireEvent.click(within(list).getAllByRole("button", { name: "Invite" })[0]);
    await waitFor(() => expect(settingsActions.inviteMemberAction).toHaveBeenCalledTimes(1));
    expect(within(screen.getByRole("list", { name: "Suggested from your setup" })).getByText("ann@team.test")).toBeTruthy();

    settingsActions.inviteMemberAction.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Invite everyone" }));
    await waitFor(() => expect(settingsActions.inviteMemberAction).toHaveBeenCalledTimes(3));
    expect(settingsActions.inviteMemberAction).toHaveBeenLastCalledWith("bo@team.test", "support");
    await waitFor(() => expect(screen.queryByText("Suggested from your setup")).toBeNull());
  });

  it("shows nothing when there is nobody to suggest, and asks for nothing when the person cannot manage the team", async () => {
    settingsActions.teamSuggestionsAction.mockResolvedValue({ ok: true, data: [] });
    mount();
    await waitFor(() => expect(settingsActions.teamSuggestionsAction).toHaveBeenCalled());
    expect(screen.queryByText("Suggested from your setup")).toBeNull();
    cleanup();
    settingsActions.teamSuggestionsAction.mockClear();
    mount(false);
    expect(settingsActions.teamSuggestionsAction).not.toHaveBeenCalled();
    expect(screen.queryByText("Suggested from your setup")).toBeNull();
  });

  it("does not let someone invite a person their role cannot grant", async () => {
    settingsActions.teamSuggestionsAction.mockResolvedValue({ ok: true, data: [person({ canInvite: false })] });
    mount();
    const list = await screen.findByRole("list", { name: "Suggested from your setup" });
    expect(within(list).getByRole("button", { name: "Invite" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Invite everyone" })).toBeNull();
  });
});

describe("Settings > Team: removing a person", () => {
  const members = [
    { user_id: "u1", full_name: "Owner One", email: "owner@team.test", role: "owner" as const, last_login_at: null },
    { user_id: "u2", full_name: "Host Two", email: "host@team.test", role: "sales_rep" as const, last_login_at: null },
  ];
  const remove = async () => {
    render(<TeamManager members={members} invites={[]} myRole="owner" myId="u1" canManage />);
    await waitFor(() => expect(settingsActions.teamSuggestionsAction).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Remove Host Two" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove access" }));
    await waitFor(() => expect(settingsActions.revokeMemberAction).toHaveBeenCalledWith("u2"));
  };

  it("says after \"Access removed\" that the person's upcoming bookings need a look, in the server's own words", async () => {
    const { toast } = await import("sonner");
    settingsActions.teamSuggestionsAction.mockResolvedValue({ ok: true, data: [] });
    settingsActions.revokeMemberAction.mockResolvedValue({ ok: true, data: { warning: "2 upcoming bookings are with a host who no longer fits; review them. Nothing was cancelled or moved." } });
    await remove();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Access removed"));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith("2 upcoming bookings are with a host who no longer fits; review them. Nothing was cancelled or moved.", { duration: 12000 }));
  });

  it("shows no warning when nothing needs a look", async () => {
    const { toast } = await import("sonner");
    settingsActions.teamSuggestionsAction.mockResolvedValue({ ok: true, data: [] });
    settingsActions.revokeMemberAction.mockResolvedValue({ ok: true, data: { warning: null } });
    await remove();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Access removed"));
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe("Settings > AI preferences: apply to employees", () => {
  const prefs = { tone: "friendly", replyLength: "concise", language: "English", companyRules: "", neverPromise: "", escalateWhen: "" } as const;
  const preview = { ok: true, data: { employees: [{ role: "lead_hunter", name: "Lead Hunter", changes: [{ field: "replyLength", label: "Reply length" }], replaces: [{ field: "companyRules", label: "Company rules" }] }] } };
  const result = { ok: true, data: { updated: ["lead_hunter"], held: ["appointment_setter", "operations_manager"], skipped: [{ role: "lead_hunter", fields: ["companyRules"], why: "client_edit" }] } };
  const applySwitch = () => screen.getByRole("switch", { name: "Apply to all configured employees" });
  const edit = () => fireEvent.click(screen.getByRole("radio", { name: /Detailed/ }));
  const saveButton = () => screen.getByRole("button", { name: "Save changes" });

  it("is off by default, asks for no preview until it is switched on, and saves without applying", async () => {
    settingsActions.updateAiPreferencesAction.mockResolvedValue({ ok: true, data: { updated: [], held: [], skipped: [] } });
    render(<AiPrefsForm prefs={prefs} retention="forever" canEdit />);
    expect(applySwitch().getAttribute("aria-checked")).toBe("false");
    expect(settingsActions.previewAiPreferencesApplyAction).not.toHaveBeenCalled();
    expect(screen.queryByText(/Some employees have wording of their own/)).toBeNull();
    edit();
    fireEvent.click(saveButton());
    await waitFor(() => expect(settingsActions.updateAiPreferencesAction).toHaveBeenCalledWith(expect.objectContaining({ replyLength: "detailed", applyToEmployees: false, replaceOwnEdits: false })));
  });

  it("previews which employees keep their own wording, applies without replacing it, and says what happened", async () => {
    const { toast } = await import("sonner");
    settingsActions.previewAiPreferencesApplyAction.mockResolvedValue(preview);
    settingsActions.updateAiPreferencesAction.mockResolvedValue(result);
    render(<AiPrefsForm prefs={prefs} retention="forever" canEdit />);
    edit();
    fireEvent.click(applySwitch());
    expect(await screen.findByText(/Some employees have wording of their own/, undefined, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText(/Lead Hunter: Company rules/)).toBeTruthy();
    expect(screen.getByTestId("apply-preview-summary").textContent).toBe("1 employee would get a new version.");
    expect(screen.getByRole("switch", { name: "Also replace the wording I changed on these employees" }).getAttribute("aria-checked")).toBe("false");
    expect(settingsActions.previewAiPreferencesApplyAction).toHaveBeenCalledWith(expect.objectContaining({ replyLength: "detailed" }));

    fireEvent.click(saveButton());
    await waitFor(() => expect(settingsActions.updateAiPreferencesAction).toHaveBeenCalledWith(expect.objectContaining({ applyToEmployees: true, replaceOwnEdits: false })));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("AI preferences saved", { description: "Applied to 1 employee. 2 updates are waiting for iAcquire's review. 1 employee kept its own wording for some fields." }));
  });

  it("counts only the employees that would really get a version: one whose every difference is its own wording gets none unless the client ticks to replace it", async () => {
    const onlyOwn = { ok: true, data: { employees: [{ role: "lead_hunter", name: "Lead Hunter", changes: [], replaces: [{ field: "tone", label: "Tone" }] }] } };
    settingsActions.previewAiPreferencesApplyAction.mockResolvedValue(onlyOwn);
    render(<AiPrefsForm prefs={prefs} retention="forever" canEdit />);
    edit();
    fireEvent.click(applySwitch());
    const summary = async () => screen.getByTestId("apply-preview-summary").textContent;
    expect(await screen.findByText(/Some employees have wording of their own/, undefined, { timeout: 3000 })).toBeTruthy();
    expect(await summary()).toMatch(/^No employee would get a new version/);
    fireEvent.click(screen.getByRole("switch", { name: "Also replace the wording I changed on these employees" }));
    expect(await summary()).toBe("1 employee would get a new version.");
  });

  it("replaces the employee's own wording only when the client ticks to", async () => {
    settingsActions.previewAiPreferencesApplyAction.mockResolvedValue(preview);
    settingsActions.updateAiPreferencesAction.mockResolvedValue({ ok: true, data: { updated: ["lead_hunter"], held: [], skipped: [] } });
    render(<AiPrefsForm prefs={prefs} retention="forever" canEdit />);
    edit();
    fireEvent.click(applySwitch());
    fireEvent.click(await screen.findByRole("switch", { name: "Also replace the wording I changed on these employees" }, { timeout: 3000 }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(settingsActions.updateAiPreferencesAction).toHaveBeenCalledWith(expect.objectContaining({ applyToEmployees: true, replaceOwnEdits: true })));
  });
});

describe("Settings > Business profile: what reached the employees", () => {
  const profile = { name: "Marko Bar", industry: "", website: "", region: "", timezone: "UTC", description: "", services: "", idealCustomers: "", brandColor: "" };
  const user = { fullName: "Marko", email: "marko@example.test", timezone: "UTC" };
  const saveProfile = async (employees: { updated: number; held: number; failed: boolean }) => {
    settingsActions.updateProfileAction.mockResolvedValue({ ok: true, data: { employees } });
    render(<ProfileForms profile={profile} user={user} canEdit walkthroughsEnabled={false} />);
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "Marko Bar & Sons" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save changes" })[0]);
    await waitFor(() => expect(settingsActions.updateProfileAction).toHaveBeenCalled());
  };

  it("says how many employees were updated and how many updates are waiting, and never calls a waiting one applied", async () => {
    const { toast } = await import("sonner");
    await saveProfile({ updated: 3, held: 2, failed: false });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Business profile saved", { description: "3 employees updated. 2 updates are waiting for iAcquire's review." }));
  });

  it("says only what is true when everything is waiting, when nothing needed updating, and when the employees could not be updated", async () => {
    const { toast } = await import("sonner");
    await saveProfile({ updated: 0, held: 5, failed: false });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Business profile saved", { description: "5 updates are waiting for iAcquire's review." }));
    cleanup();
    vi.mocked(toast.success).mockClear();
    await saveProfile({ updated: 0, held: 0, failed: false });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Business profile saved", undefined));
    cleanup();
    await saveProfile({ updated: 0, held: 0, failed: true });
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith("Business profile saved", { description: expect.stringMatching(/could not be updated yet/) }));
  });
});
