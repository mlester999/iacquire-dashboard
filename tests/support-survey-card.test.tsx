// @vitest-environment jsdom
// The satisfaction card in a browser-like document: nothing is selected for the customer, the send button waits for both answers, and a
// successful send becomes a thank-you. The service and its authorization are tested in support-surveys.test.ts.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ answer: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/support", () => ({ answerSupportSurveyAction: mocks.answer }));

import { SupportSurveyCard } from "@/components/support/survey-card";
import type { SurveyView } from "@/lib/support/surveys";

const survey: SurveyView = { id: "6f1f0d9e-0000-4000-8000-0000000000a1", rating: null, helpful: null, comment: null, requestedAt: "2026-10-24T10:00:00.000Z", expiresAt: "2026-11-07T10:00:00.000Z" };

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
beforeEach(() => mocks.answer.mockReset());
afterEach(cleanup);

describe("the satisfaction question", () => {
  it("requires a rating and an answer to 'did it help', then records what the customer chose", async () => {
    mocks.answer.mockResolvedValue({ ok: true, data: survey });
    render(<SupportSurveyCard survey={survey} />);
    const send = screen.getByRole("button", { name: "Send my answer" });
    expect((send as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: "5 out of 5" }));
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Yes, it helped" }));
    expect((send as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Quick and clear." } });
    fireEvent.click(send);
    await waitFor(() => expect(mocks.answer).toHaveBeenCalledWith(survey.id, { rating: 5, helpful: true, comment: "Quick and clear." }));
    await screen.findByText(/Thank you/);
  });

  it("keeps the card open and says nothing was recorded when the server refuses", async () => {
    mocks.answer.mockResolvedValue({ ok: false, error: "This survey is no longer open." });
    render(<SupportSurveyCard survey={survey} />);
    fireEvent.click(screen.getByRole("radio", { name: "4 out of 5" }));
    fireEvent.click(screen.getByRole("radio", { name: "Not really" }));
    fireEvent.click(screen.getByRole("button", { name: "Send my answer" }));
    await waitFor(() => expect(mocks.answer).toHaveBeenCalled());
    expect(screen.queryByText(/Thank you/)).toBeNull();
    expect(screen.getByRole("button", { name: "Send my answer" })).not.toBeNull();
  });
});


