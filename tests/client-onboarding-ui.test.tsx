// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { SetupPaymentLine } from "@/components/setup/setup-payment-line";
import { ReviewPanel } from "@/components/onboarding/review-panel";
import { WorkforceGallery } from "@/components/workforce/gallery";
import { buildReviewModel, type ConnectionFacts } from "@/lib/onboarding/engine";
import { PAYMENT_REQUIRED_SENTENCE } from "@/lib/billing-clearance";
import { SETUP_PAYMENT_CONFIRMED, SETUP_PAYMENT_WAITING, setupPaymentLine } from "@/lib/onboarding/setup-payment-line";
import { SETUP_REQUIRED_LABEL } from "@/lib/agents";
import type { AnswerValue, StoredAnswers } from "@/lib/onboarding/types";

vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@/app/actions/workforce", () => ({ requestSetupAction: vi.fn() }));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(() => cleanup());

describe("the Setup payment line", () => {
  it("says confirmed or waiting from the database's yes or no, and nothing when it was not answered", () => {
    expect(setupPaymentLine(true)).toBe(SETUP_PAYMENT_CONFIRMED);
    expect(setupPaymentLine(false)).toBe(SETUP_PAYMENT_WAITING);
    expect(setupPaymentLine(null)).toBeNull();
    expect(setupPaymentLine(undefined)).toBeNull();
    const { container } = render(<SetupPaymentLine cleared={undefined} billingHref="/settings/billing" />);
    expect(container.innerHTML).toBe("");
  });

  it("waiting: the plain sentence, no claim that anything was detected or paid, and a way to ask", () => {
    render(<SetupPaymentLine cleared={false} />);
    const region = screen.getByRole("region", { name: "Setup payment not confirmed yet" });
    expect(region.getAttribute("data-state")).toBe("waiting");
    expect(region.textContent).toContain(`${PAYMENT_REQUIRED_SENTENCE}.`);
    expect(region.textContent).toContain("help button");
    expect(region.textContent).not.toMatch(/detected|received your|thank you for your payment/i);
    expect(within(region).queryByRole("link")).toBeNull();
  });

  it("confirmed: says so, and gives the billing link only to someone who may see billing", () => {
    const { unmount } = render(<SetupPaymentLine cleared billingHref="/settings/billing" />);
    const region = screen.getByRole("region", { name: "Setup payment confirmed" });
    expect(region.getAttribute("data-state")).toBe("confirmed");
    const link = within(region).getByRole("link", { name: "View billing" });
    expect(link.getAttribute("href")).toBe("/settings/billing");
    expect(link.className).toContain("min-h-11");
    unmount();
    render(<SetupPaymentLine cleared billingHref={null} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("the review's optional connections", () => {
  const answers: StoredAnswers = Object.fromEntries(
    Object.entries({ "a.business_name": "Optional Co", "a.industry": "real_estate", "a.business_model": "mixed" } as Record<string, AnswerValue>).map(([id, value]) => [id, { value, source: "user" as const, skipped: false, needsConfirmation: false, updatedAt: "2026-10-21T04:00:00Z" }]),
  );
  const facts = (extra: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
    crmLinked: false, aiEmployeesVerified: 0, aiEmployeesTotal: 6, automationMapped: false,
    channels: { sms: { enabled: false, registration: "not_started" }, whatsapp: { enabled: false, registration: "not_started" }, email: { enabled: false, registration: "not_started" } },
    calendarConnected: false, websiteDomainVerified: false, invitedStaff: 0, ...extra,
  });
  const panel = (extra: Partial<ConnectionFacts>) =>
    render(<ReviewPanel review={buildReviewModel(answers, facts(extra), [])} loading={false} error={null} confirmed={false} submitting={false} alreadySubmitted={false} onRetry={() => {}} onEdit={() => {}} onConfirmChange={() => {}} onSubmit={() => {}} hideSubmit />);

  it("lists website chat and social media with their honest state, and says none of them is needed", () => {
    panel({ chatWidget: "waiting", socialConnected: false });
    const section = screen.getByRole("region", { name: "Optional connections" });
    const items = within(section).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Website chat is switched on, waiting for its first visit");
    expect(items[0].textContent).toContain("Waiting");
    expect(items[1].textContent).toContain("No social media account is connected");
    expect(items[1].textContent).toContain("Not connected");
    expect(section.textContent).toContain("Approving your setup does not depend on any of them");
  });

  it("shows a connected line as connected and a verified website address", () => {
    panel({ chatWidget: "installed", socialConnected: true, websiteDomainVerified: true });
    const section = screen.getByRole("region", { name: "Optional connections" });
    expect(within(section).getAllByText("Connected")).toHaveLength(3);
    expect(section.textContent).toContain("Website address verified");
  });

  it("shows no section when the server said nothing about any of them", () => {
    panel({});
    expect(screen.queryByRole("region", { name: "Optional connections" })).toBeNull();
  });
});

describe("the employee cards while Setup required", () => {
  const employee = (over: Record<string, unknown>) => ({
    id: String(over.role_key), role_key: "sales_assistant", display_name: "Sam", enabled: true, status: "setup_required", mode: "approval_required", summary: "Sam answers leads.",
    config_version: 1, last_health_check_at: null, last_health_ok: null, credential_ready: true, ...over,
  });
  const show = (agents: Array<Record<string, unknown>>, paymentCleared?: boolean) =>
    render(<WorkforceGallery agents={agents as never} capabilities={{}} companyName="Gallery Co" canConfigure canUse evaluatedAt={Date.parse("2026-10-24T00:00:00Z")} paymentCleared={paymentCleared} />);

  it("says the setup payment while it is unconfirmed", () => {
    show([employee({ role_key: "sales_assistant" }), employee({ role_key: "lead_hunter" })], false);
    expect(screen.getAllByText(`${SETUP_REQUIRED_LABEL}: waiting for setup payment`)).toHaveLength(2);
    expect(screen.queryByText(/Hermes profile not connected/)).toBeNull();
  });

  it("says the Hermes profile once the payment is confirmed, or when the page did not ask", () => {
    show([employee({ role_key: "sales_assistant" })], true);
    expect(screen.getByText(`${SETUP_REQUIRED_LABEL}: Hermes profile not connected`)).toBeTruthy();
    expect(screen.queryByText(/waiting for setup payment/)).toBeNull();
    cleanup();
    show([employee({ role_key: "sales_assistant" })], undefined);
    expect(screen.getByText(`${SETUP_REQUIRED_LABEL}: Hermes profile not connected`)).toBeTruthy();
  });

  it("the pill and the line agree, and a paused employee keeps its own wording", () => {
    show([employee({ role_key: "sales_assistant" }), employee({ role_key: "lead_hunter", enabled: false, status: "disabled" })], false);
    const cards = screen.getAllByRole("article");
    const sam = cards.find((c) => within(c).queryByText(`${SETUP_REQUIRED_LABEL}: waiting for setup payment`));
    expect(sam).toBeTruthy();
    expect(within(sam!).getAllByText(SETUP_REQUIRED_LABEL).length).toBeGreaterThanOrEqual(1);
    const paused = cards.find((c) => within(c).queryByText("Paused"));
    expect(paused).toBeTruthy();
    expect(within(paused!).queryByText(/Setup required:/)).toBeNull();
  });
});
