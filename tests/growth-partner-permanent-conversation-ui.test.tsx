// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PermanentGrowthPartnerConversation } from "@/components/growth-partner/permanent-conversation";
import { refreshGrowthPartnerConversationAction } from "@/app/actions/ai-growth-partner-conversation";

vi.mock("@/app/actions/ai-growth-partner-conversation", () => ({
  loadOlderGrowthPartnerMessagesAction: vi.fn(),
  refreshGrowthPartnerConversationAction: vi.fn(),
  searchGrowthPartnerConversationAction: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("permanent Growth Partner conversation UI", () => {
  it("offers no create-conversation control and always sends into the shared thread", async () => {
    vi.mocked(refreshGrowthPartnerConversationAction).mockResolvedValue({
      ok: true,
      data: {
        conversation: {
          id: "shared-thread-id",
          title: "AI Growth Partner",
          lastMessageAt: null,
          createdAt: "2026-11-07T00:00:00.000Z",
        },
        messages: [],
        hasMore: false,
      },
    });
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("10000000-0000-4000-8000-000000000001");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ conversationId: "shared-thread-id", runId: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<PermanentGrowthPartnerConversation initial={{
      conversation: { id: "shared-thread-id", title: "AI Growth Partner", lastMessageAt: null, createdAt: "2026-11-07T00:00:00.000Z" },
      messages: [],
      hasMore: false,
    }} timeZone="America/New_York" nowIso="2026-11-07T01:00:00.000Z" />);

    expect(screen.getByRole("heading", { name: "Permanent conversation" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /new chat|new conversation|create conversation/i })).toBeNull();
    expect(screen.queryByText(/new chat|new conversation|create conversation/i)).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Message the AI Growth Partner" }), { target: { value: "Keep using the shared thread." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      role: "growth_partner",
      conversationId: "shared-thread-id",
      content: "Keep using the shared thread.",
    });
    expect(refreshGrowthPartnerConversationAction).toHaveBeenCalledOnce();
  });
});
