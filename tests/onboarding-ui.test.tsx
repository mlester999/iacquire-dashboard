// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdaptiveOnboarding } from "@/components/onboarding/adaptive-onboarding";
import { OnboardingApiProvider, type OnboardingApi } from "@/components/onboarding/onboarding-api";
import { buildReviewModel, computeProgress, type ConnectionFacts } from "@/lib/onboarding/engine";
import type { StoredAnswers, AnswerValue } from "@/lib/onboarding/types";
import type { OnboardingSession, Suggestion } from "@/server/onboarding/service";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/app/actions/onboarding", () => ({}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const row = (value: AnswerValue) => ({ value, source: "user" as const, skipped: false, needsConfirmation: false, updatedAt: "2026-10-21T04:00:00Z" });
const facts: ConnectionFacts = { crmLinked: false, aiEmployeesVerified: 0, aiEmployeesTotal: 6, automationMapped: false, channels: { sms: { enabled: false, registration: "not_started" }, whatsapp: { enabled: false, registration: "not_started" }, email: { enabled: false, registration: "not_started" } }, calendarConnected: false, websiteDomainVerified: false, invitedStaff: 0 };
const draft: Suggestion = { questionId: "a.description", value: "Marko Bar is a real estate business.", reason: "Based on your answers.", basis: "your_answers", source: "ai_suggestion", needsConfirmation: false, limited: true, clarifications: [{ fieldId: "b.services", label: "What services do you primarily provide?", example: "Examples only: property sales or rentals" }] };

function setup(current = "a.description", extra: StoredAnswers = {}) {
  const answers = { "a.business_name": row("Marko Bar"), "a.industry": row("real_estate"), "a.business_model": row("mixed"), ...extra };
  const session: OnboardingSession = { questionnaireVersion: 2, status: "draft", revision: 1, currentQuestionId: current, answers, progress: computeProgress(answers), completedAt: null, submittedAt: null, hasUnsubmittedChanges: false, enabledRoles: [], websiteAnalysis: null };
  let revision = 1;
  const api = {
    save: vi.fn<OnboardingApi["save"]>().mockImplementation(async () => ({ ok: true, data: { revision: ++revision, rejected: {}, staleBase: false } })),
    suggest: vi.fn<OnboardingApi["suggest"]>().mockResolvedValue({ ok: true, data: draft }),
    review: vi.fn<OnboardingApi["review"]>().mockResolvedValue({ ok: true, data: { ...buildReviewModel(answers, facts, []), ...(current === "f.review" ? { blockers: [] } : {}) } }),
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

  const approveWith = async (scheduling?: unknown) => {
    const { api, done } = setup("f.review", { "f.review": row(true) });
    api.review.mockResolvedValue({ ok: true, data: { ...buildReviewModel({}, facts, []), blockers: [] } });
    api.submit.mockResolvedValue({ ok: true, data: scheduling ? { scheduling } as never : {} });
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
});
